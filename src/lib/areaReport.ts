import { serviceClient } from './supabaseClients';
import { getReportStats, listInspectionsSince } from './inspectionRepository';
import { previousShift, resolveShift, shiftDateLabel } from './shift';
import type { InspectionSummary, Profile } from './types';

/**
 * The end-of-round report a supervisor sends to Slack.
 *
 * One builder, three shapes, chosen by what actually happened rather
 * than by the sender. A clean round gets four lines. A round with one
 * failure collapses the breakdown, because "vans held", "main gaps" and
 * "deviations by driver" would each repeat the same fact. Three or more
 * failures and the sections start earning their space.
 */

const BUCKET = 'inspection-photos';
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Slack caps a message at 50 blocks. Leave room for the summary. */
const MAX_IMAGE_BLOCKS_PER_MESSAGE = 40;

/** Below this, the breakdown sections say the same thing three times. */
const FAILURE_DETAIL_THRESHOLD = 3;

/** Every van runs 0 to 5 degrees. */
const TEMP_MAX_C = 5;

export type AreaReportInput = {
  /** Omitted for a whole-shift report across every area visited. */
  areaId?: string;
  areaName?: string;
  note?: string;
  /** Origin of the deployment, so the report can link back to the record. */
  origin?: string;
};

type Evidence = {
  plate: string;
  driverName: string;
  checkLabel: string;
  causeLabel: string | null;
  storageKey: string;
};

type Deviation = { name: string; count: number; items: string[] };

type SlackBlock =
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'divider' }
  | { type: 'context'; elements: { type: 'mrkdwn'; text: string }[] }
  | { type: 'image'; image_url: string; alt_text: string };

const section = (text: string): SlackBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text },
});

/**
 * Turns a friendly mention list into Slack syntax.
 *
 * A plain "@aflah" posts as literal text through a webhook and notifies
 * nobody, which is the quiet way this feature fails. Slack needs the
 * user id, so that is what the env var holds.
 *
 * Accepts: @here, @channel, U01ABC234 (a person), S01ABC234 (a group).
 */
const formatMentions = (raw: string | undefined): string => {
  if (raw === undefined || raw.trim() === '') {
    return '';
  }

  return raw
    .split(',')
    .map((token) => token.trim().replace(/^@/, ''))
    .filter((token) => token !== '')
    .map((token) => {
      const upper = token.toUpperCase();
      if (upper === 'HERE' || upper === 'CHANNEL') {
        return `<!${upper.toLowerCase()}>`;
      }
      if (/^S[A-Z0-9]{6,}$/.test(upper)) {
        return `<!subteam^${upper}>`;
      }
      if (/^[UW][A-Z0-9]{6,}$/.test(upper)) {
        return `<@${upper}>`;
      }
      // Not an id. Posting it raw at least shows the intent rather than
      // silently dropping it.
      return token;
    })
    .join(' ');
};

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

/** "Dubai", "Dubai and Sharjah", "Dubai, Sharjah and Ajman". */
const nameList = (names: string[]): string => {
  if (names.length <= 1) {
    return names[0] ?? 'No areas';
  }
  const last = names[names.length - 1] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${last}`;
};

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * "vehicle", not "van". The fleet is vans and transfer trucks, and a
 * truck counted as a van makes the numbers untrustworthy to anyone who
 * knows what was actually inspected.
 */
const vehicles = (count: number): string => plural(count, 'vehicle');

type FailureRow = {
  inspection_id: string;
  note: string | null;
  check_items: { label: string } | { label: string }[] | null;
  check_causes: { label: string } | { label: string }[] | null;
  check_actions: { label: string } | { label: string }[] | null;
  inspection_photos: { storage_key: string }[] | null;
};

const causeOf = (relation: FailureRow['check_causes']): string | null => {
  if (relation === null) {
    return null;
  }
  return Array.isArray(relation) ? (relation[0]?.label ?? null) : relation.label;
};

const labelOf = (relation: FailureRow['check_items']): string => {
  if (relation === null) {
    return 'Unknown';
  }
  return Array.isArray(relation) ? (relation[0]?.label ?? 'Unknown') : relation.label;
};

const gather = async (
  records: InspectionSummary[],
): Promise<{
  byCheck: Map<string, number>;
  byCause: Map<string, Map<string, number>>;
  byDriver: Map<string, Deviation>;
  evidence: Evidence[];
  failureCount: number;
}> => {
  const byCheck = new Map<string, number>();
  const byCause = new Map<string, Map<string, number>>();
  const byDriver = new Map<string, Deviation>();
  const evidence: Evidence[] = [];

  const ids = records.filter((record) => record.failedCount > 0).map((record) => record.id);
  if (ids.length === 0) {
    return { byCheck, byCause, byDriver, evidence, failureCount: 0 };
  }

  const db = serviceClient();
  const { data } = await db
    .from('inspection_results')
    .select(
      'inspection_id, note, check_items(label), check_causes(label), check_actions(label), inspection_photos(storage_key)',
    )
    .in('inspection_id', ids)
    .eq('passed', false);

  const rows = (data ?? []) as unknown as FailureRow[];

  for (const raw of rows) {
    const label = labelOf(raw.check_items);
    byCheck.set(label, (byCheck.get(label) ?? 0) + 1);

    // The cause is what turns a number into an instruction. "Uniform, 3
    // vans" is a statistic; "2 missing shoes, 1 torn t-shirt" is a job.
    const cause = causeOf(raw.check_causes);
    if (cause !== null) {
      const forCheck = byCause.get(label) ?? new Map<string, number>();
      forCheck.set(cause, (forCheck.get(cause) ?? 0) + 1);
      byCause.set(label, forCheck);
    }

    const record = records.find((candidate) => candidate.id === raw.inspection_id);
    if (record === undefined) {
      continue;
    }

    const existing = byDriver.get(record.driverName) ?? {
      name: record.driverName,
      count: 0,
      items: [],
    };
    existing.count += 1;
    existing.items.push(label);
    byDriver.set(record.driverName, existing);

    for (const photo of raw.inspection_photos ?? []) {
      evidence.push({
        plate: record.plate,
        driverName: record.driverName,
        checkLabel: label,
        causeLabel: cause,
        storageKey: photo.storage_key,
      });
    }
  }

  return { byCheck, byCause, byDriver, evidence, failureCount: rows.length };
};

/**
 * The most recent earlier day this area was inspected, not simply
 * yesterday. On a fleet that does not run every day, "yesterday" is
 * often zero and the comparison becomes noise.
 */
const previousRound = async (
  areaId: string,
  before: Date,
): Promise<{ label: string; compliancePct: number } | null> => {
  const start = new Date(before);
  start.setDate(start.getDate() - 30);
  start.setHours(0, 0, 0, 0);

  const earlier = await listInspectionsSince(start, { until: new Date(before.getTime() - 1), areaId });
  if (earlier.length === 0) {
    return null;
  }

  const days = new Map<string, InspectionSummary[]>();
  for (const record of earlier) {
    const key = record.performedAt.slice(0, 10);
    days.set(key, [...(days.get(key) ?? []), record]);
  }

  const latestKey = [...days.keys()].sort().pop();
  if (latestKey === undefined) {
    return null;
  }

  const dayRecords = days.get(latestKey) ?? [];
  const cleared = dayRecords.filter((record) => record.status === 'compliant').length;

  const date = new Date(`${latestKey}T12:00:00`);
  const isYesterday =
    new Date(before).setHours(0, 0, 0, 0) - date.setHours(0, 0, 0, 0) === 86_400_000;

  return {
    label: isYesterday
      ? 'yesterday'
      : new Date(`${latestKey}T12:00:00`).toLocaleDateString('en-GB', {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
        }),
    compliancePct: dayRecords.length === 0 ? 0 : Math.round((cleared / dayRecords.length) * 100),
  };
};

type Observation = {
  checkCode: string;
  checkLabel: string;
  causeLabel: string | null;
  actionLabel: string | null;
  numericValue: number | null;
};

type Repeat = { plate: string; driverName: string; checkLabel: string; count: number };

/**
 * What failed on each vehicle, in the inspector's own words: the check,
 * the cause they picked and what they did about it.
 */
const listObservations = async (
  records: InspectionSummary[],
): Promise<Map<string, Observation[]>> => {
  const out = new Map<string, Observation[]>();
  const ids = records.filter((record) => record.failedCount > 0).map((record) => record.id);

  if (ids.length === 0) {
    return out;
  }

  const { data } = await serviceClient()
    .from('inspection_results')
    .select(
      'inspection_id, numeric_value, check_items(code, label), check_causes(label), check_actions(label)',
    )
    .in('inspection_id', ids)
    .eq('passed', false);

  type Row = {
    inspection_id: string;
    numeric_value: number | null;
    check_items: { code: string; label: string } | { code: string; label: string }[] | null;
    check_causes: { label: string } | { label: string }[] | null;
    check_actions: { label: string } | { label: string }[] | null;
  };

  const first = <T,>(value: T | T[] | null): T | null =>
    value === null ? null : Array.isArray(value) ? (value[0] ?? null) : value;

  for (const raw of (data ?? []) as unknown as Row[]) {
    const item = first(raw.check_items);
    const entry: Observation = {
      checkCode: item?.code ?? '',
      checkLabel: item?.label ?? 'Check',
      causeLabel: first(raw.check_causes)?.label ?? null,
      actionLabel: first(raw.check_actions)?.label ?? null,
      numericValue: raw.numeric_value === null ? null : Number(raw.numeric_value),
    };
    out.set(raw.inspection_id, [...(out.get(raw.inspection_id) ?? []), entry]);
  }

  return out;
};

/**
 * The same vehicle failing the same check more than once in 30 days.
 *
 * A single failure is an incident. The same one recurring is a pattern,
 * and a pattern is the thing worth acting on.
 */
const listRepeats = async (records: InspectionSummary[]): Promise<Repeat[]> => {
  const plates = new Set(records.map((record) => record.plate));
  if (plates.size === 0) {
    return [];
  }

  const since = new Date();
  since.setDate(since.getDate() - 30);

  const history = await listInspectionsSince(since);
  const relevant = history.filter(
    (record) => plates.has(record.plate) && record.failedCount > 0,
  );

  if (relevant.length === 0) {
    return [];
  }

  const { data } = await serviceClient()
    .from('inspection_results')
    .select('inspection_id, check_items(label)')
    .in(
      'inspection_id',
      relevant.map((record) => record.id),
    )
    .eq('passed', false);

  type Row = { inspection_id: string; check_items: { label: string } | { label: string }[] | null };

  const tally = new Map<string, Repeat>();

  for (const raw of (data ?? []) as unknown as Row[]) {
    const relation = raw.check_items;
    const label = Array.isArray(relation)
      ? (relation[0]?.label ?? 'Check')
      : (relation?.label ?? 'Check');

    const record = relevant.find((candidate) => candidate.id === raw.inspection_id);
    if (record === undefined) {
      continue;
    }

    const key = `${record.plate}|${label}`;
    const existing = tally.get(key);
    tally.set(key, {
      plate: record.plate,
      driverName: record.driverName,
      checkLabel: label,
      count: (existing?.count ?? 0) + 1,
    });
  }

  return [...tally.values()]
    .filter((entry) => entry.count > 1)
    .sort((a, b) => b.count - a.count);
};

export type BuiltReport = {
  text: string;
  messages: { text: string; blocks: SlackBlock[] }[];
  /** Uploaded together so Slack renders them as one file group. */
  photos: { storageKey: string; title: string }[];
  photoCount: number;
};

export const buildAreaReport = async (
  input: AreaReportInput,
  inspector: Profile,
): Promise<BuiltReport> => {
  const now = new Date();
  const current = resolveShift(now);

  // A round worked in the morning but sent at 17:00 belongs to the
  // morning, not to whichever shift the clock has reached. If the
  // current window is empty, report on the one before it.
  const currentRecords = await listInspectionsSince(current.from, {
    until: current.to,
    ...(input.areaId === undefined ? {} : { areaId: input.areaId }),
  });

  const shift = currentRecords.length > 0 ? current : previousShift(current);
  const records =
    currentRecords.length > 0
      ? currentRecords
      : await listInspectionsSince(shift.from, {
          until: shift.to,
          ...(input.areaId === undefined ? {} : { areaId: input.areaId }),
        });

  const stats = await getReportStats(shift.from, shift.to, input.areaId);

  const noteLine =
    input.note === undefined || input.note.trim() === ''
      ? null
      : `*Inspector's notes:* ${input.note.trim()}`;

  const dateLabel = shiftDateLabel(shift);
  // Named from what was actually inspected, never "All areas": a round
  // covering Sharjah and Ajman is not the whole UAE, and a heading that
  // says otherwise is the one line someone will read wrong.
  const visitedAreas = [...new Set(records.map((record) => record.areaName))].sort();
  const scope = input.areaName ?? nameList(visitedAreas);
  const heading = `${scope}, ${shift.label.toLowerCase()} pre-departure`;

  if (records.length === 0) {
    const lines = [
      `*${shift.label} shift*`,
      `${dateLabel} · ${inspector.fullName}`,
      '',
      ':warning: *No vehicles inspected this shift.*',
    ];
    if (noteLine !== null) {
      lines.push('', noteLine);
    }
    const text = lines.join('\n');
    return { text, messages: [{ text, blocks: [section(text)] }], photos: [], photoCount: 0 };
  }

  const { byCheck, byCause, byDriver, evidence, failureCount } = await gather(records);
  const [observations, repeats] = await Promise.all([
    listObservations(records),
    listRepeats(records),
  ]);

  const cleared = records.filter((record) => record.status === 'compliant').length;
  const nonCompliant = records.length - cleared;

  const previous =
    input.areaId === undefined ? null : await previousRound(input.areaId, shift.from);
  const trend =
    previous === null
      ? ''
      : (() => {
          const delta = stats.compliancePct - previous.compliancePct;
          if (delta === 0) {
            return `, level with ${previous.label}`;
          }
          return `, ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} points on ${previous.label}`;
        })();

  const temps = records
    .map((record) => record.tempReadingC)
    .filter((value): value is number => value !== null);
  const worstTemp = temps.length === 0 ? null : Math.max(...temps);

  // A bare figure invites five readings. Say what it means.
  const tempVerdict =
    worstTemp === null
      ? null
      : worstTemp > TEMP_MAX_C
        ? `*Highest temperature: ${worstTemp.toFixed(1)} °C*, above the ${TEMP_MAX_C} °C limit`
        : worstTemp === TEMP_MAX_C
          ? `*Highest temperature: ${worstTemp.toFixed(1)} °C*, within range but at the limit`
          : `*Highest temperature: ${worstTemp.toFixed(1)} °C*, within range`;

  const vans = records.filter((record) => record.vehicleType !== 'truck');
  const trucks = records.filter((record) => record.vehicleType === 'truck');
  const failingVans = vans.filter((record) => record.status !== 'compliant');
  const failingTrucks = trucks.filter((record) => record.status !== 'compliant');

  /** "4 Vans & 1 Truck", dropping either side when it is zero. */
  const fleetCount = (vanCount: number, truckCount: number): string => {
    const parts: string[] = [];
    if (vanCount > 0) {
      parts.push(`${vanCount} Van${vanCount === 1 ? '' : 's'}`);
    }
    if (truckCount > 0) {
      parts.push(`${truckCount} Truck${truckCount === 1 ? '' : 's'}`);
    }
    return parts.length === 0 ? 'None' : parts.join(' & ');
  };

  const lines: string[] = [
    `*Vehicle Hygiene & Fleet Inspection Report – ${scope} ${shift.label} Fleet*`,
    `Date: ${dateLabel}`,
    '',
    '*Inspection Summary*',
    `• Total Vehicles Inspected: ${fleetCount(vans.length, trucks.length)}`,
    `• Non-Conformities Identified: ${fleetCount(failingVans.length, failingTrucks.length)}`,
    // Vans and trucks scored together: three failures out of ten
    // vehicles is 70%, whichever type they were.
    `• Compliance Rate: ${stats.compliancePct}% of inspected vehicles met Calo standards`,
  ];

  const failing = records.filter((record) => record.status !== 'compliant');

  if (failing.length > 0) {
    lines.push('', '*Key Observations*');

    for (const record of failing) {
      const detail = observations.get(record.id) ?? [];

      // Cause and action come from the inspector's own taps, so the line
      // reads as what they saw rather than a status code.
      const issues = detail
        .map((item) => {
          const parts = [item.checkLabel];
          if (item.causeLabel !== null) {
            parts.push(item.causeLabel.toLowerCase());
          }
          if (item.numericValue !== null && item.checkCode === 'temp') {
            parts[0] = `${item.checkLabel} ${item.numericValue.toFixed(1)} °C`;
          }
          const line = parts.join(', ');
          return item.actionLabel === null ? line : `${line}. ${item.actionLabel}`;
        })
        .join('. ');

      const note =
        record.notes === null || record.notes === '' ? '' : ` _${record.notes}_`;

      lines.push(`• *${record.driverName} – ${record.plate}*: ${issues}.${note}`);
    }
  }

  if (repeats.length > 0) {
    lines.push('', '*Repeated Issues*');
    for (const repeat of repeats) {
      lines.push(
        `• *${repeat.plate} (${repeat.driverName})*: ${repeat.checkLabel} failed ${repeat.count} times in the last 30 days`,
      );
    }
  }

  if (noteLine !== null) {
    lines.push('', noteLine);
  }

  if (input.origin !== undefined && input.origin !== '') {
    lines.push('', `<${input.origin}/admin|View the full record and photos>`);
  }

  // Tagged only when something failed. Pinging a clean round is how a
  // channel gets muted, which costs the alerts that matter.
  const mentions = formatMentions(
    failing.length > 0 ? process.env.SLACK_MENTIONS_ALERT : process.env.SLACK_MENTIONS_ALWAYS,
  );
  if (mentions !== '') {
    lines.push('', mentions);
  }

  const summary = lines.join('\n');

  return {
    text: summary,
    messages: [{ text: summary, blocks: [section(summary)] }],
    photos: evidence.map((item) => ({
      storageKey: item.storageKey,
      title: `${item.plate} ${item.checkLabel}${item.causeLabel === null ? '' : `: ${item.causeLabel}`}`,
    })),
    photoCount: evidence.length,
  };

};

/**
 * Uploads every photo in one call so Slack groups them into a single
 * file attachment, the way a person pasting images does.
 *
 * Image blocks cannot produce that: they render one per row, full width,
 * and a dozen of them buries the report. This needs a bot token, so it
 * falls back to the webhook when one is not configured.
 */
const uploadPhotoGroup = async (
  token: string,
  channel: string,
  photos: { storageKey: string; title: string }[],
  comment: string,
): Promise<void> => {
  const db = serviceClient();
  const uploaded: { id: string; title: string }[] = [];

  for (const photo of photos) {
    const download = await db.storage.from(BUCKET).download(photo.storageKey);
    if (download.error !== null || download.data === null) {
      continue;
    }

    const bytes = await download.data.arrayBuffer();
    const filename = photo.storageKey.split('/').pop() ?? 'evidence.jpg';

    const urlResponse = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ filename, length: String(bytes.byteLength) }),
    });

    const urlBody = (await urlResponse.json()) as {
      ok?: boolean;
      upload_url?: string;
      file_id?: string;
      error?: string;
    };

    if (urlBody.ok !== true || urlBody.upload_url === undefined || urlBody.file_id === undefined) {
      throw new Error(`Slack upload URL failed: ${urlBody.error ?? 'unknown'}`);
    }

    const put = await fetch(urlBody.upload_url, { method: 'POST', body: bytes });
    if (!put.ok) {
      throw new Error(`Slack rejected a photo (${put.status})`);
    }

    uploaded.push({ id: urlBody.file_id, title: photo.title });
  }

  if (uploaded.length === 0) {
    return;
  }

  // One completeUpload call with every file: that is what makes Slack
  // show them as a single grouped attachment rather than separate posts.
  const complete = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: uploaded,
      channel_id: channel,
      initial_comment: comment,
    }),
  });

  const body = (await complete.json()) as { ok?: boolean; error?: string };
  if (body.ok !== true) {
    throw new Error(`Slack completeUpload failed: ${body.error ?? 'unknown'}`);
  }
};

export const postAreaReport = async (
  report: BuiltReport,
  areaId: string | null,
): Promise<void> => {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  const channel = process.env.SLACK_ALERT_CHANNEL ?? '#uae-fleet-ops';
  const db = serviceClient();

  const log = async (delivered: boolean, error: string | null): Promise<void> => {
    await db.from('alerts').insert({
      inspection_id: null,
      channel: 'slack',
      recipient: channel,
      sent_at: new Date().toISOString(),
      delivered,
      error,
      payload: { text: report.text, area_id: areaId, photos: report.photoCount },
    });
  };

  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  // Preferred: the report and its photos as one grouped post.
  if (botToken !== undefined && channelId !== undefined && report.photos.length > 0) {
    try {
      await uploadPhotoGroup(botToken, channelId, report.photos, report.text);
      await log(true, null);
      return;
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : 'Slack upload failed';
      await log(false, message);
      // Falls through to the webhook so the report still arrives.
    }
  }

  if (webhook === undefined || webhook === '') {
    await log(false, 'SLACK_WEBHOOK_URL is not configured');
    throw new Error('Slack is not set up yet. Ask Aflah to add the webhook URL.');
  }

  try {
    for (const message of report.messages) {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        const detail = await response.text();
        await log(false, `Slack returned ${response.status}: ${detail.slice(0, 200)}`);
        throw new Error(`Slack rejected the report (${response.status})`);
      }
    }

    // Without a bot token the photos go as signed links, since image
    // blocks would stack a dozen full-width images under the report.
    if (report.photos.length > 0) {
      const links: string[] = [];
      for (const photo of report.photos) {
        const { data } = await serviceClient()
          .storage.from(BUCKET)
          .createSignedUrl(photo.storageKey, SIGNED_URL_TTL_SECONDS);
        if (data !== null) {
          links.push(`<${data.signedUrl}|${photo.title}>`);
        }
      }

      if (links.length > 0) {
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `*Evidence* (${links.length})\n${links.join('\n')}\n_Links expire in 7 days._`,
          }),
        });
      }
    }

    await log(true, null);
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : 'Network error';
    if (!message.startsWith('Slack rejected')) {
      await log(false, message);
    }
    throw new Error(message);
  }
};
