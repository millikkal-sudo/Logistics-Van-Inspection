import { serviceClient } from './supabaseClients';
import { createRecord, deleteRecord, setActive, updateRecord, type Entity } from './adminRepository';
import { importFleet, previewFleet } from './bulkImport';
import { ValidationError } from './inspectionRepository';
import type { Profile } from './types';

/**
 * Fleet edits from anyone other than an approver are queued rather than
 * applied.
 *
 * The whole proposal is stored, so approving it a day later applies what
 * the reviewer read, not whatever the form has since become.
 */

export type Operation = 'create' | 'update' | 'delete' | 'setActive' | 'bulkImport';

export type PendingChange = {
  id: string;
  entity: string;
  operation: Operation;
  targetId: string | null;
  payload: Record<string, unknown>;
  before: Record<string, unknown> | null;
  summary: string;
  requestedByName: string;
  requestedByEmail: string;
  requestedAt: string;
};

const LABELS: Record<string, string> = {
  areas: 'area',
  vans: 'vehicle',
  drivers: 'person',
  causes: 'cause',
  actions: 'action',
  fleet: 'fleet import',
};

/** Plain English, so the queue reads without decoding JSON. */
const describe = (
  entity: string,
  operation: Operation,
  payload: Record<string, unknown>,
  before: Record<string, unknown> | null,
): string => {
  const noun = LABELS[entity] ?? entity;
  const name =
    (payload.plate as string | undefined) ??
    (payload.fullName as string | undefined) ??
    (payload.name as string | undefined) ??
    (payload.label as string | undefined) ??
    (before?.plate as string | undefined) ??
    (before?.full_name as string | undefined) ??
    (before?.name as string | undefined) ??
    (before?.label as string | undefined) ??
    '';

  if (operation === 'bulkImport') {
    return 'Bulk fleet import';
  }
  if (operation === 'delete') {
    return `Delete ${noun}: ${name}`;
  }
  if (operation === 'setActive') {
    return `${payload.active === true ? 'Reactivate' : 'Deactivate'} ${noun}: ${name}`;
  }
  if (operation === 'create') {
    return `Add ${noun}: ${name}`;
  }
  return `Edit ${noun}: ${name}`;
};

/** Already on the profile, so this costs nothing. */
export const isApprover = (profile: Profile): boolean => profile.isApprover;

/**
 * Tells the approver a change is waiting.
 *
 * Prefers a direct message: an approval request is for one person, and
 * posting it to the operations channel makes everyone else scroll past
 * it. Falls back to a webhook when no bot token is configured.
 *
 * Never throws. A notification that fails must not lose the change, so
 * the failure is recorded and the proposal still stands.
 */
const notifyApprover = async (summary: string, actor: Profile): Promise<void> => {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const approverId = process.env.SLACK_APPROVER_USER_ID;
  const webhook = process.env.SLACK_APPROVAL_WEBHOOK_URL ?? process.env.SLACK_WEBHOOK_URL;
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? '';

  const text = [
    ':pencil: *A fleet change is waiting for review*',
    `*${summary}*`,
    `Requested by ${actor.fullName} (${actor.email})`,
    origin === '' ? '' : `<${origin}/admin|Open the Approvals tab>`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  try {
    if (botToken !== undefined && approverId !== undefined && approverId !== '') {
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: approverId, text }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (body.ok === true) {
        return;
      }
      throw new Error(body.error ?? 'chat.postMessage failed');
    }

    if (webhook === undefined || webhook === '') {
      throw new Error('No Slack destination configured for approvals');
    }

    const mention = process.env.SLACK_APPROVER_USER_ID;
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: mention === undefined || mention === '' ? text : `<@${mention}> ${text}`,
      }),
    });
  } catch (cause: unknown) {
    // Logged, not thrown: the change is already saved, and losing it
    // because Slack was unreachable would be the worse failure.
    await serviceClient().from('alerts').insert({
      inspection_id: null,
      channel: 'slack',
      recipient: 'approver',
      sent_at: new Date().toISOString(),
      delivered: false,
      error: cause instanceof Error ? cause.message : 'Unknown error',
      payload: { summary },
    });
  }
};

export const proposeChange = async (
  entity: string,
  operation: Operation,
  targetId: string | null,
  payload: Record<string, unknown>,
  actor: Profile,
): Promise<{ summary: string }> => {
  const db = serviceClient();

  // Captured now, not at approval time: the reviewer should see the
  // change as it was proposed.
  const before =
    targetId === null || entity === 'fleet'
      ? null
      : ((await db.from(entity).select('*').eq('id', targetId).maybeSingle()).data as Record<
          string,
          unknown
        > | null);

  const summary = describe(entity, operation, payload, before);

  const { error } = await db.from('pending_changes').insert({
    entity,
    operation,
    target_id: targetId,
    payload,
    before,
    summary,
    requested_by: actor.id,
  });

  if (error !== null) {
    throw new Error(`Could not send for review: ${error.message}`);
  }

  await notifyApprover(summary, actor);

  return { summary };
};

type QueueRow = {
  id: string;
  entity: string;
  operation: Operation;
  target_id: string | null;
  payload: Record<string, unknown>;
  before: Record<string, unknown> | null;
  summary: string;
  requested_at: string;
  profiles: { full_name: string; email: string } | { full_name: string; email: string }[] | null;
};

export const listPending = async (): Promise<PendingChange[]> => {
  const { data, error } = await serviceClient()
    .from('pending_changes')
    .select('*, profiles!pending_changes_requested_by_fkey(full_name, email)')
    .eq('status', 'pending')
    .order('requested_at', { ascending: false });

  if (error !== null) {
    throw new Error(`Could not load the review queue: ${error.message}`);
  }

  return ((data ?? []) as unknown as QueueRow[]).map((row) => {
    const person = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    return {
      id: row.id,
      entity: row.entity,
      operation: row.operation,
      targetId: row.target_id,
      payload: row.payload,
      before: row.before,
      summary: row.summary,
      requestedByName: person?.full_name ?? 'Unknown',
      requestedByEmail: person?.email ?? '',
      requestedAt: row.requested_at,
    };
  });
};

/** Applies a proposal. Only reached once an approver has said yes. */
const apply = async (change: PendingChange, approver: Profile): Promise<string | null> => {
  if (change.operation === 'bulkImport') {
    const text = String(change.payload.text ?? '');
    // Re-previewed rather than trusting the stored result: a plate added
    // by someone else since the proposal must still be caught.
    const preview = await previewFleet(text);
    const imported = await importFleet(preview.valid, approver);
    return `${imported} row${imported === 1 ? '' : 's'} imported, ${preview.issues.length} skipped`;
  }

  const entity = change.entity as Entity;

  if (change.operation === 'create') {
    await createRecord(entity, change.payload, approver);
    return null;
  }
  if (change.operation === 'update') {
    if (change.targetId === null) {
      throw new ValidationError('This change has no target');
    }
    await updateRecord(entity, change.targetId, change.payload, approver);
    return null;
  }
  if (change.operation === 'setActive') {
    if (change.targetId === null) {
      throw new ValidationError('This change has no target');
    }
    await setActive(entity, change.targetId, change.payload.active === true, approver);
    return null;
  }
  if (change.operation === 'delete') {
    if (change.targetId === null) {
      throw new ValidationError('This change has no target');
    }
    const result = await deleteRecord(entity, change.targetId, approver);
    return result.note;
  }

  throw new ValidationError(`Unknown operation: ${change.operation}`);
};

export const reviewChange = async (
  id: string,
  decision: 'approved' | 'rejected',
  approver: Profile,
  note: string | null,
): Promise<{ note: string | null }> => {
  const pending = await listPending();
  const change = pending.find((candidate) => candidate.id === id);

  if (change === undefined) {
    throw new ValidationError('That change has already been reviewed');
  }

  let applyNote: string | null = null;

  if (decision === 'approved') {
    // Applied before the status is written: if applying fails, the
    // change stays in the queue rather than being marked done.
    applyNote = await apply(change, approver);
  }

  const { error } = await serviceClient()
    .from('pending_changes')
    .update({
      status: decision,
      reviewed_by: approver.id,
      reviewed_at: new Date().toISOString(),
      review_note: note,
    })
    .eq('id', id);

  if (error !== null) {
    throw new Error(`Applied, but could not close the review: ${error.message}`);
  }

  await serviceClient().from('audit_log').insert({
    actor_id: approver.id,
    action: `change.${decision}`,
    entity: 'pending_changes',
    entity_id: id,
    after: { summary: change.summary, requested_by: change.requestedByEmail },
  });

  return { note: applyNote };
};
