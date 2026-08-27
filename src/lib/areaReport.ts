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
  areaId: string;
  areaName: string;
  note?: string;
  /** Origin of the deployment, so the report can link back to the record. */
  origin?: string;
};

type Evidence = {
  plate: string;
  driverName: string;
  checkLabel: string;
  causeLabel: string | null;
  actionLabel: string | null;
  note: string | null;
  url: string;
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

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

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
      const { data: signed } = await db.storage
        .from(BUCKET)
        .createSignedUrl(photo.storage_key, SIGNED_URL_TTL_SECONDS);

      if (signed !== null) {
        evidence.push({
          plate: record.plate,
          driverName: record.driverName,
          checkLabel: label,
          causeLabel: cause,
          actionLabel: causeOf(raw.check_actions),
          note: raw.note,
          url: signed.signedUrl,
        });
      }
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

export type BuiltReport = {
  text: string;
  messages: { text: string; blocks: SlackBlock[] }[];
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
    areaId: input.areaId,
  });

  const shift = currentRecords.length > 0 ? current : previousShift(current);
  const records =
    currentRecords.length > 0
      ? currentRecords
      : await listInspectionsSince(shift.from, { until: shift.to, areaId: input.areaId });

  const stats = await getReportStats(shift.from, shift.to, input.areaId);

  const noteLine =
    input.note === undefined || input.note.trim() === ''
      ? null
      : `*Inspector's notes:* ${input.note.trim()}`;

  const dateLabel = shiftDateLabel(shift);
  const heading = `${input.areaName}, ${shift.label.toLowerCase()} pre-departure`;

  if (records.length === 0) {
    const lines = [
      `*${heading}*`,
      `${dateLabel} · ${inspector.fullName}`,
      '',
      ':warning: *No vans inspected in this area this shift.*',
    ];
    if (noteLine !== null) {
      lines.push('', noteLine);
    }
    const text = lines.join('\n');
    return { text, messages: [{ text, blocks: [section(text)] }], photoCount: 0 };
  }

  const { byCheck, byCause, byDriver, evidence, failureCount } = await gather(records);

  const cleared = records.filter((record) => record.status === 'compliant').length;
  const nonCompliant = records.length - cleared;

  const previous = await previousRound(input.areaId, shift.from);
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

  const icon = failureCount > 0 ? ':warning:' : ':white_check_mark:';

  /** Pads for the monospace blocks. Slack renders those in a fixed font. */
  const pad = (value: string, width: number): string =>
    value.length >= width ? value : value + ' '.repeat(width - value.length);

  const lines: string[] = [
    `${icon} *${input.areaName}*  ·  ${shift.label} shift`,
    `${dateLabel}  ·  ${inspector.fullName}`,
    '',
  ];

  // The one sentence someone reads if they read nothing else.
  const headline: string[] = [
    nonCompliant === 0
      ? `*All ${plural(records.length, 'van')} cleared.*`
      : `*${plural(nonCompliant, 'van')} non-compliant.* ${plural(failureCount, 'failure')} to close out.`,
  ];
  // Tagged only when something needs a person. Pinging the channel on a
  // clean round is how a channel gets muted, which costs the alerts that
  // matter.
  const needsAttention = nonCompliant > 0;
  const mentions = formatMentions(
    needsAttention ? process.env.SLACK_MENTIONS_ALERT : process.env.SLACK_MENTIONS_ALWAYS,
  );

  lines.push(mentions === '' ? headline.join(' ') : `${headline.join(' ')} ${mentions}`, '');

  // Metrics in a code block so the columns line up. A wall of prose
  // numbers is what made the old version hard to scan.
  const metrics: string[] = [
    `${pad('Checked', 14)}${pad(`${records.length} van${records.length === 1 ? '' : 's'}`, 18)}`,
    `${pad('Cleared', 14)}${pad(`${cleared} / ${records.length}`, 18)}${stats.compliancePct}%`,
  ];
  if (nonCompliant > 0) {
    metrics.push(`${pad('Non-compliant', 14)}${nonCompliant}`);
  }
  if (worstTemp !== null) {
    const verdict =
      worstTemp > TEMP_MAX_C
        ? 'over limit'
        : worstTemp === TEMP_MAX_C
          ? 'at the limit'
          : 'within range';
    metrics.push(`${pad('Peak temp', 14)}${pad(`${worstTemp.toFixed(1)} \u00b0C`, 18)}${verdict}`);
  }
  if (previous !== null) {
    const delta = stats.compliancePct - previous.compliancePct;
    metrics.push(
      `${pad('vs ' + previous.label, 14)}${delta === 0 ? 'no change' : `${delta > 0 ? '+' : ''}${delta} points`}`,
    );
  }
  lines.push('```', ...metrics, '```');

  const failing = records.filter((record) => record.status !== 'compliant');

  if (failing.length > 0) {
    const plateWidth = Math.max(...failing.map((record) => record.plate.length)) + 3;
    const nameWidth = Math.max(...failing.map((record) => record.driverName.length)) + 3;

    lines.push('', '*Non-compliant*', '```');
    for (const record of failing) {
      const deviation = byDriver.get(record.driverName);
      const checks = deviation === undefined ? '' : [...new Set(deviation.items)].join(', ');
      lines.push(`${pad(record.plate, plateWidth)}${pad(record.driverName, nameWidth)}${checks}`);
    }
    lines.push('```');
  }

  if (byCheck.size > 0) {
    lines.push('', '*Main gaps*');
    for (const [label, count] of [...byCheck.entries()].sort((a, b) => b[1] - a[1])) {
      const breakdown = byCause.get(label);
      const named =
        breakdown === undefined
          ? []
          : [...breakdown.entries()].filter(([cause]) => cause.toLowerCase() !== 'other');

      if (named.length > 0) {
        const detail = named
          .sort((a, b) => b[1] - a[1])
          .map(([cause, n]) => `${n} ${cause.toLowerCase()}`)
          .join(', ');
        lines.push(`${label}  ${plural(count, 'van')}  _(${detail})_`);
      } else {
        // "4 other" told nobody anything. Say what actually happened.
        lines.push(`${label}  ${plural(count, 'van')}`);
        lines.push('_no cause recorded_');
      }
    }
  }

  const deviations = [...byDriver.values()]
    .filter((entry) => entry.count > 1)
    .sort((a, b) => b.count - a.count);

  if (deviations.length > 0) {
    lines.push('', '*More than one deviation*');
    for (const entry of deviations) {
      lines.push(`${entry.name}  ${entry.count}  _(${[...new Set(entry.items)].join(', ')})_`);
    }
  }


  const flagged = records.filter((record) => record.trainingFlag !== 'none');
  if (flagged.length > 0) {
    lines.push(
      '',
      '*Flagged for training*',
      ...flagged.map((record) => {
        const who =
          record.trainingFlag === 'both'
            ? `${record.driverName} and ${record.helperName ?? 'helper'}`
            : record.trainingFlag === 'helper'
              ? (record.helperName ?? 'helper')
              : record.driverName;
        return `${who}  _(${record.plate})_`;
      }),
    );
  }

  if (noteLine !== null) {
    lines.push('', noteLine);
  }

  if (input.origin !== undefined && input.origin !== '') {
    lines.push('', `<${input.origin}/admin|View the full record and photos>`);
  }

  const summary = lines.join('\n');

  const imageBlocks: SlackBlock[] = evidence.flatMap((item) => [
    {
      type: 'context' as const,
      elements: [
        {
          type: 'mrkdwn' as const,
          text: `*${item.plate}* · ${item.checkLabel}${
            item.causeLabel === null ? '' : `: ${item.causeLabel}`
          } · ${item.driverName}${
            item.actionLabel === null ? '' : ` · ${item.actionLabel}`
          }${item.note === null || item.note === '' ? '' : ` · ${item.note}`}`,
        },
      ],
    },
    { type: 'image' as const, image_url: item.url, alt_text: `${item.plate} ${item.checkLabel}` },
  ]);

  const messages: BuiltReport['messages'] = [];

  if (imageBlocks.length === 0) {
    messages.push({ text: summary, blocks: [section(summary)] });
  } else {
    const chunks: SlackBlock[][] = [];
    for (let i = 0; i < imageBlocks.length; i += MAX_IMAGE_BLOCKS_PER_MESSAGE) {
      chunks.push(imageBlocks.slice(i, i + MAX_IMAGE_BLOCKS_PER_MESSAGE));
    }

    chunks.forEach((chunk, index) => {
      if (index === 0) {
        messages.push({
          text: summary,
          blocks: [
            section(summary),
            { type: 'divider' },
            section(`*Evidence* (${plural(evidence.length, 'photo')})`),
            ...chunk,
          ],
        });
      } else {
        messages.push({
          text: `${input.areaName}, evidence continued`,
          blocks: [section(`*Evidence continued (${index + 1} of ${chunks.length})*`), ...chunk],
        });
      }
    });
  }

  return { text: summary, messages, photoCount: evidence.length };
};

export const postAreaReport = async (report: BuiltReport, areaId: string): Promise<void> => {
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
    await log(true, null);
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : 'Network error';
    if (!message.startsWith('Slack rejected')) {
      await log(false, message);
    }
    throw new Error(message);
  }
};
