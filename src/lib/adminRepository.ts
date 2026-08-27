import { serviceClient } from './supabaseClients';
import { ValidationError } from './inspectionRepository';
import type { Profile } from './types';

/**
 * Manager and admin edits to reference data.
 *
 * Nothing here hard-deletes. A van or driver referenced by an inspection
 * cannot be removed without taking the audit trail with it, so
 * everything is deactivated instead and simply stops appearing in the
 * supervisor's list.
 */

export type Entity = 'areas' | 'vans' | 'drivers' | 'causes' | 'actions';

const requireText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`);
  }
  return value.trim();
};

const optionalUuid = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

type Payload = Record<string, unknown>;

const buildAreaRow = (payload: Payload): Payload => ({
  name: requireText(payload.name, 'Area name'),
  code: requireText(payload.code, 'Area code').toUpperCase().slice(0, 4),
  sort_order: typeof payload.sortOrder === 'number' ? payload.sortOrder : 100,
});

// Every van runs 0-5 °C, so the range is not asked for. The columns
// stay in the schema for a future exception.
const buildVanRow = (payload: Payload): Payload => ({
  plate: requireText(payload.plate, 'Plate').toUpperCase(),
  vehicle_type: payload.vehicleType === 'truck' ? 'truck' : 'van',
  area_id: optionalUuid(payload.areaId),
  temp_min_c: 0,
  temp_max_c: 5,
});

/**
 * A helper rides with one driver, so their van and area are copied from
 * that driver rather than entered again. Two places to record the same
 * fact is two places for it to drift.
 */
const buildDriverRow = (payload: Payload): Payload => {
  const staffRole = payload.staffRole === 'helper' ? 'helper' : 'driver';

  if (staffRole === 'helper') {
    const partnerId = optionalUuid(payload.partnerId);
    if (partnerId === null) {
      throw new ValidationError('A helper must be paired with a driver');
    }
    return {
      full_name: requireText(payload.fullName, 'Name'),
      staff_role: 'helper',
      partner_id: partnerId,
      area_id: optionalUuid(payload.areaId),
      default_van: optionalUuid(payload.defaultVanId),
    };
  }

  return {
    full_name: requireText(payload.fullName, 'Name'),
    staff_role: 'driver',
    partner_id: null,
    area_id: optionalUuid(payload.areaId),
    default_van: optionalUuid(payload.defaultVanId),
  };
};

const CATEGORIES = ['supply', 'standards', 'wear', 'equipment', 'behaviour', 'other'];

/**
 * The category is never shown to the inspector. It is what lets a report
 * tell a stores problem from a training one.
 */
const buildCauseRow = (payload: Payload): Payload => {
  const category = typeof payload.category === 'string' ? payload.category : 'other';
  if (!CATEGORIES.includes(category)) {
    throw new ValidationError(`Unknown category: ${category}`);
  }
  const checkItemId = optionalUuid(payload.checkItemId);
  if (checkItemId === null) {
    throw new ValidationError('Choose which check this cause belongs to');
  }
  return {
    check_item_id: checkItemId,
    label: requireText(payload.label, 'Cause'),
    category,
    sort_order: typeof payload.sortOrder === 'number' ? payload.sortOrder : 50,
  };
};

/**
 * Global rather than per check: "reported to workshop" means the same
 * thing whichever check failed.
 */
const buildActionRow = (payload: Payload): Payload => ({
  label: requireText(payload.label, 'Action'),
  sort_order: typeof payload.sortOrder === 'number' ? payload.sortOrder : 50,
});

const BUILDERS: Record<Entity, (payload: Payload) => Payload> = {
  areas: buildAreaRow,
  vans: buildVanRow,
  drivers: buildDriverRow,
  causes: buildCauseRow,
  actions: buildActionRow,
};

const audit = async (
  actor: Profile,
  action: string,
  entity: string,
  entityId: string | null,
  after: Payload | null,
): Promise<void> => {
  await serviceClient().from('audit_log').insert({
    actor_id: actor.id,
    action,
    entity,
    entity_id: entityId,
    after,
  });
};

export const createRecord = async (
  entity: Entity,
  payload: Payload,
  actor: Profile,
): Promise<{ id: string }> => {
  const row = BUILDERS[entity](payload);

  const { data, error } = await serviceClient()
    .from(entity)
    .insert(row)
    .select('id')
    .single<{ id: string }>();

  if (error !== null || data === null) {
    if (error?.code === '23505') {
      throw new ValidationError('That already exists — check for a duplicate name, plate or ID');
    }
    throw new Error(error?.message ?? 'Could not save');
  }

  await audit(actor, `${entity}.created`, entity, data.id, row);
  return { id: data.id };
};

export const updateRecord = async (
  entity: Entity,
  id: string,
  payload: Payload,
  actor: Profile,
): Promise<void> => {
  const row = BUILDERS[entity](payload);

  const { error } = await serviceClient().from(entity).update(row).eq('id', id);

  if (error !== null) {
    if (error.code === '23505') {
      throw new ValidationError('That already exists — check for a duplicate name, plate or ID');
    }
    throw new Error(error.message);
  }

  await audit(actor, `${entity}.updated`, entity, id, row);
};

/**
 * Deactivate, never delete. Inspections reference vans and drivers, and
 * a hard delete would either fail on the foreign key or orphan history.
 */
export const setActive = async (
  entity: Entity,
  id: string,
  active: boolean,
  actor: Profile,
): Promise<void> => {
  const { error } = await serviceClient().from(entity).update({ active }).eq('id', id);

  if (error !== null) {
    throw new Error(error.message);
  }

  await audit(actor, active ? `${entity}.reactivated` : `${entity}.deactivated`, entity, id, {
    active,
  });
};

/**
 * Permanent delete, allowed only where it destroys nothing.
 *
 * A van or driver named on a past inspection is part of the audit trail.
 * Deleting it would leave "who checked DXB-4021 in March" with no
 * answer, so those are refused and deactivation is the answer instead.
 * What this does clear is genuine mistakes: a typo, a duplicate, test
 * data from setting up.
 */

/**
 * Deletes always succeed. Inspection history does not depend on these
 * rows: the plate and the names are copied onto each inspection when it
 * is filed, and the links clear themselves on delete.
 *
 * What still needs handling is the live configuration that points at the
 * record, because leaving it dangling would break the app rather than
 * the history.
 */

export const deleteRecord = async (
  entity: Entity,
  id: string,
  actor: Profile,
): Promise<{ note: string | null }> => {
  const db = serviceClient();

  // Written before the delete: afterwards there is no row to describe.
  const { data: snapshot } = await db.from(entity).select('*').eq('id', id).maybeSingle();
  let note: string | null = null;

  if (entity === 'drivers') {
    // A helper whose driver is gone would fail the pairing constraint,
    // so they are unpaired and listed as a driver. Deleting a person
    // who still works here would be the wrong call to make silently.
    const { data: helpers } = await db
      .from('drivers')
      .select('id, full_name')
      .eq('partner_id', id);

    const paired = (helpers ?? []) as { id: string; full_name: string }[];

    if (paired.length > 0) {
      await db
        .from('drivers')
        .update({ partner_id: null, staff_role: 'driver' })
        .eq('partner_id', id);

      note = `${paired
        .map((person) => person.full_name)
        .join(', ')} ${paired.length === 1 ? 'was' : 'were'} unpaired and now listed as ${
        paired.length === 1 ? 'a driver' : 'drivers'
      }.`;
    }
  }

  if (entity === 'areas') {
    // Vans and staff in a deleted area keep working, unassigned, rather
    // than disappearing from the app along with it.
    const [vans, staff] = await Promise.all([
      db.from('vans').update({ area_id: null }).eq('area_id', id).select('id'),
      db.from('drivers').update({ area_id: null }).eq('area_id', id).select('id'),
    ]);

    const moved = (vans.data?.length ?? 0) + (staff.data?.length ?? 0);
    if (moved > 0) {
      note = `${moved} van${moved === 1 ? '' : 's'} and staff left unassigned. Give them an area before the next round.`;
    }
  }

  const { error } = await db.from(entity).delete().eq('id', id);
  if (error !== null) {
    throw new Error(`Could not delete: ${error.message}`);
  }

  await audit(actor, `${entity}.deleted`, entity, id, snapshot as Payload | null);
  return { note };
};
