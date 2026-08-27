import { serviceClient } from './supabaseClients';
import type {
  Area,
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
};
type VanRow = {
  id: string;
  plate: string;
  vehicle_type: VehicleType;
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
});

export const listAreas = async (includeInactive = false): Promise<Area[]> => {
  let query = serviceClient()
    .from('areas')
    .select('id, name, code, active, sort_order')
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
    .select('id, plate, vehicle_type, area_id, temp_min_c, temp_max_c, active')
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
  helperId?: string,
): Promise<{
  plate: string;
  areaName: string;
  driverName: string;
  helperName: string | null;
}> => {
  const db = serviceClient();

  const [van, driver, helper] = await Promise.all([
    db.from('vans').select('plate, areas(name)').eq('id', vanId).maybeSingle(),
    db.from('drivers').select('full_name').eq('id', driverId).maybeSingle(),
    helperId === undefined
      ? Promise.resolve({ data: null })
      : db.from('drivers').select('full_name').eq('id', helperId).maybeSingle(),
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
    helperName: (helper.data as { full_name?: string } | null)?.full_name ?? null,
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


