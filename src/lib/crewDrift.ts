import { serviceClient } from './supabaseClients';

/**
 * Vans whose recorded crew keeps differing from the assignment.
 *
 * The inspector records who was there and is never asked whether a swap
 * is cover or a handover, because she cannot know. The pattern answers
 * it instead: one day is a sick day, six out of seven is a handover
 * nobody wrote down.
 */

export type Drift = {
  vanId: string;
  plate: string;
  areaName: string;
  assignedName: string | null;
  actualName: string;
  actualDriverId: string;
  timesSeen: number;
  totalChecks: number;
  lastSeen: string;
};

/** Below this a difference is cover, not a change worth acting on. */
const MIN_SIGHTINGS = 3;

export const listCrewDrift = async (sinceDays = 14): Promise<Drift[]> => {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  const { data, error } = await serviceClient()
    .from('inspections')
    .select(
      'van_id, driver_id, driver_name_text, performed_at, vans(plate, areas(name), drivers(id, full_name))',
    )
    .gte('performed_at', since)
    .not('van_id', 'is', null);

  if (error !== null) {
    throw new Error(`Could not read crew history: ${error.message}`);
  }

  type Row = {
    van_id: string;
    driver_id: string | null;
    driver_name_text: string | null;
    performed_at: string;
    vans: {
      plate: string;
      areas: { name: string } | { name: string }[] | null;
      drivers: { id: string; full_name: string }[] | null;
    } | null;
  };

  const first = <T,>(value: T | T[] | null | undefined): T | null =>
    value === null || value === undefined ? null : Array.isArray(value) ? (value[0] ?? null) : value;

  type Tally = {
    plate: string;
    areaName: string;
    assignedId: string | null;
    assignedName: string | null;
    total: number;
    byDriver: Map<string, { name: string; count: number; last: string }>;
  };

  const vans = new Map<string, Tally>();

  for (const raw of (data ?? []) as unknown as Row[]) {
    if (raw.driver_id === null || raw.vans === null) {
      continue;
    }

    // The driver the van is assigned to, as it stands now.
    const assigned = (raw.vans.drivers ?? [])[0] ?? null;

    const entry: Tally = vans.get(raw.van_id) ?? {
      plate: raw.vans.plate,
      areaName: first(raw.vans.areas)?.name ?? 'Unassigned',
      assignedId: assigned?.id ?? null,
      assignedName: assigned?.full_name ?? null,
      total: 0,
      byDriver: new Map(),
    };

    entry.total += 1;

    const seen = entry.byDriver.get(raw.driver_id);
    entry.byDriver.set(raw.driver_id, {
      name: raw.driver_name_text ?? 'Unknown',
      count: (seen?.count ?? 0) + 1,
      last:
        seen === undefined || raw.performed_at > seen.last ? raw.performed_at : seen.last,
    });

    vans.set(raw.van_id, entry);
  }

  const drift: Drift[] = [];

  for (const [vanId, entry] of vans) {
    for (const [driverId, seen] of entry.byDriver) {
      if (driverId === entry.assignedId || seen.count < MIN_SIGHTINGS) {
        continue;
      }
      drift.push({
        vanId,
        plate: entry.plate,
        areaName: entry.areaName,
        assignedName: entry.assignedName,
        actualName: seen.name,
        actualDriverId: driverId,
        timesSeen: seen.count,
        totalChecks: entry.total,
        lastSeen: seen.last,
      });
    }
  }

  return drift.sort((a, b) => b.timesSeen - a.timesSeen);
};
