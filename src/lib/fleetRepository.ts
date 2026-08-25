import { serviceClient } from './supabaseClients';
import type {
  Area,
  AreaRotation,
  CauseCategory,
  CheckAction,
  CheckCause,
  Driver,
  Van,
  VehicleType,
} from './types';

export type FleetEntry = {
  vanId: string;
  plate: string;
  vehicleType: VehicleType;
  shiftSlots: string[];
  areaId: string | null;
  tempMinC: number;
  tempMaxC: number;
  driverId: string;
  driverName: string;
  helperId: string | null;
  helperName: string | null;
};

type AreaRow = {
  id: string;
  name: string;
  code: string;
  active: boolean;
  sort_order: number;
  visit_interval_days: number;
};
type VanRow = {
  id: string;
  plate: string;
  vehicle_type: VehicleType;
  shift_slots: string[] | null;
  area_id: string | null;
  temp_min_c: number;
  temp_max_c: number;
  active: boolean;
};
type DriverRow = {
  id: string;
  full_name: string;
  staff_role: 'driver' | 'helper';
  partner_id: string | null;
  area_id: string | null;
  default_van: string | null;
  active: boolean;
};

const toArea = (row: AreaRow): Area => ({
  id: row.id,
  name: row.name,
  code: row.code,
  active: row.active,
  sortOrder: row.sort_order,
  visitIntervalDays: row.visit_interval_days ?? 7,
});

export const listAreas = async (includeInactive = false): Promise<Area[]> => {
  let query = serviceClient()
    .from('areas')
    .select('id, name, code, active, sort_order, visit_interval_days')
    .order('sort_order');

  if (!includeInactive) {
    query = query.eq('active', true);
  }

  const { data, error } = await query;
  if (error !== null) {
    throw new Error(`Could not load areas: ${error.message}`);
  }
  return (data ?? []).map(toArea);
};

export const listVans = async (includeInactive = false): Promise<Van[]> => {
  let query = serviceClient()
    .from('vans')
    .select('id, plate, vehicle_type, shift_slots, area_id, temp_min_c, temp_max_c, active')
    .order('plate');

  if (!includeInactive) {
    query = query.eq('active', true);
  }

  const { data, error } = await query;
  if (error !== null) {
    throw new Error(`Could not load vans: ${error.message}`);
  }
  return (data ?? []).map((row: VanRow) => ({
    id: row.id,
    plate: row.plate,
    vehicleType: row.vehicle_type,
    shiftSlots: row.shift_slots ?? ['early_morning', 'morning', 'evening'],
    areaId: row.area_id,
    tempMinC: Number(row.temp_min_c),
    tempMaxC: Number(row.temp_max_c),
    active: row.active,
  }));
};

export const listDrivers = async (includeInactive = false): Promise<Driver[]> => {
  let query = serviceClient()
    .from('drivers')
    .select('id, full_name, staff_role, partner_id, area_id, default_van, active')
    .order('full_name');

  if (!includeInactive) {
    query = query.eq('active', true);
  }

  const { data, error } = await query;
  if (error !== null) {
    throw new Error(`Could not load drivers: ${error.message}`);
  }
  return (data ?? []).map((row: DriverRow) => ({
    id: row.id,
    fullName: row.full_name,
    staffRole: row.staff_role,
    partnerId: row.partner_id,
    areaId: row.area_id,
    defaultVanId: row.default_van,
    active: row.active,
  }));
};

/**
 * The van list the supervisor picks from. A van with no assigned driver
 * is omitted — an inspection needs a driver, and an unpickable row on
 * the list is just confusing at 06:30.
 */
export const listFleet = async (): Promise<FleetEntry[]> => {
  const [vans, staff] = await Promise.all([listVans(), listDrivers()]);

  return vans.flatMap((van) => {
    const driver = staff.find(
      (person) => person.staffRole === 'driver' && person.defaultVanId === van.id,
    );
    if (driver === undefined) {
      return [];
    }

    const helper = staff.find(
      (person) => person.staffRole === 'helper' && person.partnerId === driver.id,
    );

    return [
      {
        vanId: van.id,
        plate: van.plate,
        vehicleType: van.vehicleType,
        shiftSlots: van.shiftSlots,
        areaId: van.areaId,
        tempMinC: van.tempMinC,
        tempMaxC: van.tempMaxC,
        driverId: driver.id,
        driverName: driver.fullName,
        helperId: helper?.id ?? null,
        helperName: helper?.fullName ?? null,
      },
    ];
  });
};

/**
 * Resolves a van and driver to human-readable names for an alert.
 * Posting a raw UUID into Slack tells the shift lead nothing.
 */
export const describeInspection = async (
  vanId: string,
  driverId: string,
): Promise<{ plate: string; areaName: string; driverName: string }> => {
  const db = serviceClient();

  const [van, driver] = await Promise.all([
    db.from('vans').select('plate, areas(name)').eq('id', vanId).maybeSingle(),
    db.from('drivers').select('full_name').eq('id', driverId).maybeSingle(),
  ]);

  const areaRelation = (van.data as { areas?: { name?: string } | { name?: string }[] } | null)
    ?.areas;
  const areaName = Array.isArray(areaRelation)
    ? (areaRelation[0]?.name ?? 'Unassigned')
    : (areaRelation?.name ?? 'Unassigned');

  return {
    plate: (van.data as { plate?: string } | null)?.plate ?? vanId,
    areaName,
    driverName: (driver.data as { full_name?: string } | null)?.full_name ?? driverId,
  };
};

type CauseRow = {
  id: string;
  check_item_id: string;
  label: string;
  category: CauseCategory;
  sort_order: number;
  active: boolean;
};

export const listCauses = async (includeInactive = false): Promise<CheckCause[]> => {
  let query = serviceClient()
    .from('check_causes')
    .select('id, check_item_id, label, category, sort_order, active')
    .order('sort_order');

  if (!includeInactive) {
    query = query.eq('active', true);
  }

  const { data, error } = await query;
  if (error !== null) {
    throw new Error(`Could not load the cause options: ${error.message}`);
  }

  return (data ?? []).map((row: CauseRow) => ({
    id: row.id,
    checkItemId: row.check_item_id,
    label: row.label,
    category: row.category,
    sortOrder: row.sort_order,
    active: row.active,
  }));
};

export const listActions = async (includeInactive = false): Promise<CheckAction[]> => {
  let query = serviceClient()
    .from('check_actions')
    .select('id, label, sort_order, active')
    .order('sort_order');

  if (!includeInactive) {
    query = query.eq('active', true);
  }

  const { data, error } = await query;
  if (error !== null) {
    throw new Error(`Could not load the action options: ${error.message}`);
  }

  return (data ?? []).map((row: { id: string; label: string; sort_order: number; active: boolean }) => ({
    id: row.id,
    label: row.label,
    sortOrder: row.sort_order,
    active: row.active,
  }));
};

type RotationRow = {
  area_id: string;
  area_name: string;
  area_code: string;
  visit_interval_days: number;
  last_visited_at: string | null;
  days_since: number | null;
  overdue: boolean;
};

/**
 * Where each area sits against its cadence.
 *
 * Daily coverage across seven emirates with one inspector could never be
 * good, so it said nothing. "When was this last seen, and is that late"
 * is the question that has an answer worth acting on.
 */
export const listAreaRotation = async (): Promise<AreaRotation[]> => {
  const { data, error } = await serviceClient()
    .from('v_area_rotation')
    .select('*')
    .eq('active', true);

  if (error !== null) {
    throw new Error(`Could not load the area rotation: ${error.message}`);
  }

  return (data ?? [])
    .map((row: RotationRow) => ({
      areaId: row.area_id,
      areaName: row.area_name,
      areaCode: row.area_code,
      visitIntervalDays: row.visit_interval_days,
      lastVisitedAt: row.last_visited_at,
      daysSince: row.days_since,
      overdue: row.overdue,
    }))
    // Never visited first, then the most overdue.
    .sort((a, b) => {
      if (a.daysSince === null) {
        return -1;
      }
      if (b.daysSince === null) {
        return 1;
      }
      return b.daysSince - a.daysSince - (b.visitIntervalDays - a.visitIntervalDays);
    });
};
