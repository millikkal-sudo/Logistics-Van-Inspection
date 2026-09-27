import { serviceClient } from './supabaseClients';
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
