import { serviceClient } from './supabaseClients';
import { parseDelimited } from './bulkImport';
import { listDrivers } from './fleetRepository';
import { ValidationError } from './inspectionRepository';
import type { Profile } from './types';

/**
 * Customer complaints against a driver.
 *
 * Kept separate from inspections because they are a different kind of
 * evidence: an inspection is what the supervisor saw, a complaint is
 * what the customer experienced. A driver can be clean on one and not
 * the other, which is exactly why the award needs both.
 */

export type Complaint = {
  id: string;
  driverId: string | null;
  driverName: string;
  occurredOn: string;
  source: string | null;
  note: string | null;
  loggedAt: string;
};

type Row = {
  id: string;
  driver_id: string | null;
  driver_name: string;
  occurred_on: string;
  source: string | null;
  note: string | null;
  logged_at: string;
};

const toComplaint = (row: Row): Complaint => ({
  id: row.id,
  driverId: row.driver_id,
  driverName: row.driver_name,
  occurredOn: row.occurred_on,
  source: row.source,
  note: row.note,
  loggedAt: row.logged_at,
});

export const listComplaints = async (from?: string, to?: string): Promise<Complaint[]> => {
  let query = serviceClient()
    .from('complaints')
    .select('*')
    .order('occurred_on', { ascending: false });

  if (from !== undefined) {
    query = query.gte('occurred_on', from);
  }
  if (to !== undefined) {
    query = query.lte('occurred_on', to);
  }

  const { data, error } = await query;
  if (error !== null) {
    throw new Error(`Could not load complaints: ${error.message}`);
  }
  return (data ?? []).map((row: Row) => toComplaint(row));
};

export const addComplaint = async (
  input: { driverId: string; occurredOn: string; source: string; note: string },
  actor: Profile,
): Promise<void> => {
  const db = serviceClient();

  const { data: driver } = await db
    .from('drivers')
    .select('full_name')
    .eq('id', input.driverId)
    .maybeSingle<{ full_name: string }>();

  if (driver === null) {
    throw new ValidationError('That person is not on the system');
  }

  const { error } = await db.from('complaints').insert({
    driver_id: input.driverId,
    driver_name: driver.full_name,
    occurred_on: input.occurredOn,
    source: input.source === '' ? null : input.source,
    note: input.note === '' ? null : input.note,
    logged_by: actor.id,
  });

  if (error !== null) {
    throw new Error(`Could not log the complaint: ${error.message}`);
  }
};

export const removeComplaint = async (id: string): Promise<void> => {
  const { error } = await serviceClient().from('complaints').delete().eq('id', id);
  if (error !== null) {
    throw new Error(`Could not remove the complaint: ${error.message}`);
  }
};

/* --------------------------- bulk import --------------------------- */

export type ComplaintDraft = {
  line: number;
  driverId: string;
  driverName: string;
  occurredOn: string;
  source: string;
  note: string;
};

export type ComplaintPreview = {
  valid: ComplaintDraft[];
  issues: { line: number; input: string; reason: string }[];
};

const normalise = (value: string): string => value.trim().toLowerCase();

/**
 * Accepts what a spreadsheet actually produces: an ISO date, or the
 * day-first format everyone here writes by hand. A month-end upload is
 * not the moment to be strict about separators.
 */
const parseDate = (value: string, fallback: string): string | null => {
  const text = value.trim();
  if (text === '') {
    return fallback;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(text);
  if (dayFirst !== null) {
    const [, day, month, year] = dayFirst;
    const fullYear = (year ?? '').length === 2 ? `20${year}` : year;
    return `${fullYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
};

const ALIASES: Record<string, string[]> = {
  name: ['name', 'driver', 'driver name', 'full name', 'person'],
  date: ['date', 'when', 'occurred on', 'complaint date'],
  source: ['source', 'channel', 'raised by', 'via'],
  note: ['note', 'notes', 'detail', 'details', 'what happened', 'description', 'complaint'],
};

export const previewComplaints = async (
  text: string,
  defaultDate: string,
): Promise<ComplaintPreview> => {
  const staff = await listDrivers(true);
  const parsed = parseDelimited(text);

  const columns: Record<string, number> = {};
  const header = parsed[0];

  if (header !== undefined) {
    header.cells.forEach((cell, index) => {
      for (const [field, names] of Object.entries(ALIASES)) {
        if (columns[field] === undefined && names.includes(normalise(cell))) {
          columns[field] = index;
        }
      }
    });
  }

  const hasHeader = Object.keys(columns).length >= 2;
  const rows = hasHeader ? parsed.slice(1) : parsed;
  const map = hasHeader ? columns : { name: 0, date: 1, source: 2, note: 3 };

  const cell = (cells: string[], field: string): string => {
    const index = map[field];
    return index === undefined ? '' : (cells[index] ?? '').trim();
  };

  const valid: ComplaintDraft[] = [];
  const issues: ComplaintPreview['issues'] = [];

  for (const row of rows) {
    const raw = row.cells.join(', ');
    const name = cell(row.cells, 'name');

    if (name === '') {
      issues.push({ line: row.line, input: raw, reason: 'No name' });
      continue;
    }

    const matches = staff.filter((person) => normalise(person.fullName) === normalise(name));

    if (matches.length === 0) {
      issues.push({
        line: row.line,
        input: raw,
        reason: `No driver or helper called "${name}". Check the spelling against the Drivers tab.`,
      });
      continue;
    }
    // Two people with the same name cannot be told apart from a
    // spreadsheet, and guessing would put a complaint on the wrong
    // person and cost them the award.
    if (matches.length > 1) {
      issues.push({
        line: row.line,
        input: raw,
        reason: `More than one person called "${name}". Log this one by hand.`,
      });
      continue;
    }

    const occurredOn = parseDate(cell(row.cells, 'date'), defaultDate);
    if (occurredOn === null) {
      issues.push({
        line: row.line,
        input: raw,
        reason: `Could not read the date "${cell(row.cells, 'date')}". Use 2026-09-30 or 30/09/2026.`,
      });
      continue;
    }

    valid.push({
      line: row.line,
      driverId: matches[0]?.id ?? '',
      driverName: matches[0]?.fullName ?? name,
      occurredOn,
      source: cell(row.cells, 'source'),
      note: cell(row.cells, 'note'),
    });
  }

  return { valid, issues };
};

export const importComplaints = async (
  drafts: ComplaintDraft[],
  actor: Profile,
): Promise<number> => {
  if (drafts.length === 0) {
    return 0;
  }

  const { error } = await serviceClient()
    .from('complaints')
    .insert(
      drafts.map((draft) => ({
        driver_id: draft.driverId,
        driver_name: draft.driverName,
        occurred_on: draft.occurredOn,
        source: draft.source === '' ? null : draft.source,
        note: draft.note === '' ? null : draft.note,
        logged_by: actor.id,
      })),
    );

  if (error !== null) {
    throw new Error(`Could not import the complaints: ${error.message}`);
  }

  await serviceClient().from('audit_log').insert({
    actor_id: actor.id,
    action: 'complaints.imported',
    entity: 'complaints',
    after: { rows: drafts.length },
  });

  return drafts.length;
};
