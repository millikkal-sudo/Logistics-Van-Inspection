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

type Blocker = { reason: string };

const countRows = async (
  table: string,
  column: string,
  id: string,
): Promise<number> => {
  const { count, error } = await serviceClient()
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(column, id);

  if (error !== null) {
    throw new Error(`Could not check ${table}: ${error.message}`);
  }
  return count ?? 0;
};

const findBlockers = async (entity: Entity, id: string): Promise<Blocker[]> => {
  const blockers: Blocker[] = [];

  if (entity === 'vans') {
    const inspections = await countRows('inspections', 'van_id', id);
    if (inspections > 0) {
      blockers.push({
        reason: `${inspections} inspection${inspections === 1 ? ' has' : 's have'} been filed against this van`,
      });
    }
    const assigned = await countRows('drivers', 'default_van', id);
    if (assigned > 0) {
      blockers.push({ reason: 'a driver is still assigned to it' });
    }
  }

  if (entity === 'drivers') {
    const asDriver = await countRows('inspections', 'driver_id', id);
    const asHelper = await countRows('inspections', 'helper_id', id);
    const total = asDriver + asHelper;
    if (total > 0) {
      blockers.push({
        reason: `they appear on ${total} filed inspection${total === 1 ? '' : 's'}`,
      });
    }
    const helpers = await countRows('drivers', 'partner_id', id);
    if (helpers > 0) {
      blockers.push({ reason: 'a helper is paired with them' });
    }
  }

  if (entity === 'actions') {
    const used = await countRows('inspection_results', 'action_id', id);
    if (used > 0) {
      blockers.push({
        reason: `it has been recorded on ${used} failed check${used === 1 ? '' : 's'}`,
      });
    }
  }

  if (entity === 'causes') {
    const used = await countRows('inspection_results', 'cause_id', id);
    if (used > 0) {
      blockers.push({
        reason: `it has been recorded on ${used} failed check${used === 1 ? '' : 's'}`,
      });
    }
  }

  if (entity === 'areas') {
    const inspections = await countRows('inspections', 'area_id', id);
    if (inspections > 0) {
      blockers.push({
        reason: `${inspections} inspection${inspections === 1 ? ' was' : 's were'} recorded here`,
      });
    }
    const vans = await countRows('vans', 'area_id', id);
    const staff = await countRows('drivers', 'area_id', id);
    if (vans > 0) {
      blockers.push({ reason: `${vans} van${vans === 1 ? ' is' : 's are'} assigned to it` });
    }
    if (staff > 0) {
      blockers.push({
        reason: `${staff} driver${staff === 1 ? ' or helper is' : 's or helpers are'} assigned to it`,
      });
    }
  }

  return blockers;
};

const LABELS: Record<Entity, string> = {
  areas: 'area',
  vans: 'van',
  drivers: 'person',
  causes: 'cause',
  actions: 'action',
};

export const deleteRecord = async (
  entity: Entity,
  id: string,
  actor: Profile,
): Promise<void> => {
  const blockers = await findBlockers(entity, id);

  if (blockers.length > 0) {
    throw new ValidationError(
      `This ${LABELS[entity]} cannot be deleted because ${blockers
        .map((blocker) => blocker.reason)
        .join(', and ')}. Deactivate it instead — it will stop appearing in the app but the history stays intact.`,
    );
  }

  const db = serviceClient();

  // Written before the delete: afterwards there is no row to describe.
  const { data: snapshot } = await db.from(entity).select('*').eq('id', id).maybeSingle();

  const { error } = await db.from(entity).delete().eq('id', id);
  if (error !== null) {
    throw new Error(`Could not delete: ${error.message}`);
  }

  await audit(actor, `${entity}.deleted`, entity, id, snapshot as Payload | null);
};
