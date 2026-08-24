import { serviceClient } from './supabaseClients';
import {
  isDispatchBlocked,
  resolveStatus,
  type CheckItem,
  type InspectionStatus,
  type InspectionSubmission,
  type InspectionSummary,
  type Profile,
} from './types';

/**
 * All inspection persistence. The SQL is plain Postgres; only the client
 * call style is Supabase-flavoured, so an AWS port swaps the client and
 * keeps the logic.
 */

type CheckItemRow = {
  id: string;
  code: string;
  label: string;
  help_text: string | null;
  input_type: 'boolean' | 'temperature';
  critical: boolean;
  sort_order: number;
  vehicle_types: string[];
};

const toCheckItem = (row: CheckItemRow): CheckItem => ({
  id: row.id,
  code: row.code,
  label: row.label,
  helpText: row.help_text,
  inputType: row.input_type,
  critical: row.critical,
  sortOrder: row.sort_order,
  vehicleTypes: (row.vehicle_types ?? ['van', 'truck']) as ('van' | 'truck')[],
});

export const listCheckItems = async (): Promise<CheckItem[]> => {
  const { data, error } = await serviceClient()
    .from('check_items')
    .select('id, code, label, help_text, input_type, critical, sort_order, vehicle_types')
    .eq('active', true)
    .order('sort_order');

  if (error !== null) {
    throw new Error(`Could not load the checklist: ${error.message}`);
  }
  return (data ?? []).map(toCheckItem);
};

export class ValidationError extends Error {}

/**
 * Rejected here as well as in the UI, because the UI is not a security
 * boundary.
 */
const assertEvidenceComplete = (
  submission: InspectionSubmission,
  causeRequiredFor: Set<string>,
): void => {
  for (const answer of submission.answers) {
    if (answer.passed) {
      continue;
    }
    // Photo, note and action are optional by choice: requiring them cost
    // more in adoption than they returned. The cause is what the reports
    // depend on, so it stays required, but only where the check actually
    // has options configured.
    if (causeRequiredFor.has(answer.checkItemCode) && (answer.causeId ?? '') === '') {
      throw new ValidationError(`${answer.checkItemCode} failed without a cause`);
    }
  }
};

export type SubmitResult = {
  inspectionId: string;
  status: InspectionStatus;
  dispatchBlocked: boolean;
};

export const submitInspection = async (
  submission: InspectionSubmission,
  inspector: Profile,
): Promise<SubmitResult> => {
  const allItems = await listCheckItems();

  // A truck has no plastic curtains or floor mats. Requiring every
  // active check would make a truck impossible to submit.
  const { data: vanRow } = await serviceClient()
    .from('vans')
    .select('vehicle_type')
    .eq('id', submission.vanId)
    .maybeSingle<{ vehicle_type: 'van' | 'truck' }>();

  const vehicleType = vanRow?.vehicle_type ?? 'van';
  const checkItems = allItems.filter((item) => item.vehicleTypes.includes(vehicleType));

  const { data: causeRows } = await serviceClient()
    .from('check_causes')
    .select('check_item_id')
    .eq('active', true);

  const itemsWithCauses = new Set(
    (causeRows ?? []).map((row: { check_item_id: string }) => row.check_item_id),
  );
  const codesWithCauses = new Set(
    checkItems.filter((item) => itemsWithCauses.has(item.id)).map((item) => item.code),
  );

  assertEvidenceComplete(submission, codesWithCauses);
  const itemsByCode = new Map(checkItems.map((item) => [item.code, item]));

  const missing = checkItems.filter(
    (item) => !submission.answers.some((a) => a.checkItemCode === item.code),
  );
  if (missing.length > 0) {
    throw new ValidationError(
      `Incomplete check. Missing: ${missing.map((m) => m.label).join(', ')}`,
    );
  }

  const status = resolveStatus(submission.answers, checkItems);
  const blocked = isDispatchBlocked(status);
  const db = serviceClient();

  const { data: inspection, error: inspectionError } = await db
    .from('inspections')
    .insert({
      van_id: submission.vanId,
      driver_id: submission.driverId,
      helper_id: submission.helperId ?? null,
      training_flag: submission.trainingFlag ?? 'none',
      area_id: submission.areaId ?? null,
      inspector_id: inspector.id,
      status,
      dispatch_blocked: blocked,
      latitude: submission.latitude ?? null,
      longitude: submission.longitude ?? null,
      notes: submission.notes ?? null,
      supersedes_id: submission.supersedesId ?? null,
    })
    .select('id')
    .single();

  if (inspectionError !== null || inspection === null) {
    throw new Error(`Could not save the check: ${inspectionError?.message ?? 'unknown'}`);
  }

  const resultRows = submission.answers.map((answer) => {
    const item = itemsByCode.get(answer.checkItemCode);
    if (item === undefined) {
      throw new ValidationError(`Unknown check item: ${answer.checkItemCode}`);
    }
    return {
      inspection_id: inspection.id,
      check_item_id: item.id,
      passed: answer.passed,
      numeric_value: answer.numericValue ?? null,
      note: answer.note ?? null,
      cause_id: answer.causeId ?? null,
      action_id: answer.actionId ?? null,
    };
  });

  const { data: results, error: resultsError } = await db
    .from('inspection_results')
    .insert(resultRows)
    .select('id, check_item_id');

  if (resultsError !== null || results === null) {
    // The inspection row is immutable and cannot be deleted, so an
    // orphan is surfaced loudly rather than silently swallowed.
    throw new Error(
      `Check ${inspection.id} saved but results failed: ${resultsError?.message ?? 'unknown'}`,
    );
  }

  const photoRows = submission.answers
    .filter((answer) => answer.photoKey !== undefined)
    .map((answer) => {
      const item = itemsByCode.get(answer.checkItemCode);
      const result = results.find((r) => r.check_item_id === item?.id);
      return { result_id: result?.id, storage_key: answer.photoKey };
    })
    .filter((row): row is { result_id: string; storage_key: string } =>
      row.result_id !== undefined && row.storage_key !== undefined,
    );

  if (photoRows.length > 0) {
    const { error: photoError } = await db.from('inspection_photos').insert(photoRows);
    if (photoError !== null) {
      throw new Error(`Could not attach photos: ${photoError.message}`);
    }
  }

  await db.from('audit_log').insert({
    actor_id: inspector.id,
    action: 'inspection.submitted',
    entity: 'inspections',
    entity_id: inspection.id,
    after: { status, dispatch_blocked: blocked },
  });

  return { inspectionId: inspection.id, status, dispatchBlocked: blocked };
};

type SummaryRow = {
  id: string;
  performed_at: string;
  plate: string;
  area_name: string;
  area_id: string | null;
  driver_name: string;
  driver_id: string;
  helper_name: string | null;
  helper_id: string | null;
  inspector_name: string;
  notes: string | null;
  training_flag: 'none' | 'driver' | 'helper' | 'both';
  status: InspectionStatus;
  dispatch_blocked: boolean;
  failed_count: number;
  temp_reading_c: number | null;
};

export const listInspectionsSince = async (
  since: Date,
  options: { until?: Date; areaId?: string } = {},
): Promise<InspectionSummary[]> => {
  let query = serviceClient()
    .from('v_inspection_summary')
    .select('*')
    .gte('performed_at', since.toISOString())
    .order('performed_at', { ascending: false });

  if (options.until !== undefined) {
    query = query.lte('performed_at', options.until.toISOString());
  }
  if (options.areaId !== undefined) {
    query = query.eq('area_id', options.areaId);
  }

  const { data, error } = await query;

  if (error !== null) {
    throw new Error(`Could not load the report: ${error.message}`);
  }

  return (data ?? []).map((row: SummaryRow) => ({
    id: row.id,
    performedAt: row.performed_at,
    plate: row.plate,
    areaName: row.area_name,
    driverName: row.driver_name,
    driverId: row.driver_id,
    helperName: row.helper_name,
    helperId: row.helper_id,
    inspectorName: row.inspector_name,
    notes: row.notes,
    trainingFlag: row.training_flag,
    status: row.status,
    dispatchBlocked: row.dispatch_blocked,
    failedCount: row.failed_count,
    tempReadingC: row.temp_reading_c,
  }));
};

/* ---------------------------- detail view ---------------------------- */

export type InspectionResultDetail = {
  label: string;
  critical: boolean;
  passed: boolean;
  numericValue: number | null;
  note: string | null;
  causeLabel: string | null;
  actionLabel: string | null;
  /** Signed, short-lived. The bucket is private. */
  photoUrls: string[];
  /** Raw storage keys, for server-side use such as embedding into a PDF. */
  photoKeys: string[];
};

export type InspectionDetail = {
  id: string;
  performedAt: string;
  plate: string;
  areaName: string;
  driverName: string;
  helperName: string | null;
  inspectorName: string;
  status: InspectionStatus;
  dispatchBlocked: boolean;
  notes: string | null;
  trainingFlag: string;
  failures: InspectionResultDetail[];
  passedCount: number;
};

const PHOTO_URL_TTL_SECONDS = 3600;

type ResultDetailRow = {
  passed: boolean;
  numeric_value: number | null;
  note: string | null;
  check_items: { label: string; critical: boolean } | { label: string; critical: boolean }[] | null;
  check_causes: { label: string } | { label: string }[] | null;
  check_actions: { label: string } | { label: string }[] | null;
  inspection_photos: { storage_key: string }[] | null;
};

const firstOf = <T,>(value: T | T[] | null): T | null => {
  if (value === null) {
    return null;
  }
  return Array.isArray(value) ? (value[0] ?? null) : value;
};

/**
 * Everything an auditor needs about one check: which items failed, what
 * the supervisor wrote, and the evidence photos.
 */
export const getInspectionDetail = async (id: string): Promise<InspectionDetail | null> => {
  const db = serviceClient();

  const { data: summary, error: summaryError } = await db
    .from('v_inspection_summary')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (summaryError !== null) {
    throw new Error(`Could not load the inspection: ${summaryError.message}`);
  }
  if (summary === null) {
    return null;
  }

  const { data: results, error: resultsError } = await db
    .from('inspection_results')
    .select(
      'passed, numeric_value, note, check_items(label, critical), check_causes(label), check_actions(label), inspection_photos(storage_key)',
    )
    .eq('inspection_id', id);

  if (resultsError !== null) {
    throw new Error(`Could not load the check results: ${resultsError.message}`);
  }

  const rows: ResultDetailRow[] = results ?? [];
  const failures: InspectionResultDetail[] = [];
  let passedCount = 0;

  for (const row of rows) {
    if (row.passed) {
      passedCount += 1;
      continue;
    }

    const item = firstOf(row.check_items);
    const keys = (row.inspection_photos ?? []).map((photo) => photo.storage_key);
    const photoUrls: string[] = [];

    for (const key of keys) {
      const { data } = await db
        .storage.from('inspection-photos')
        .createSignedUrl(key, PHOTO_URL_TTL_SECONDS);
      if (data !== null) {
        photoUrls.push(data.signedUrl);
      }
    }

    failures.push({
      label: item?.label ?? 'Unknown check',
      critical: item?.critical ?? false,
      passed: false,
      numericValue: row.numeric_value === null ? null : Number(row.numeric_value),
      note: row.note,
      causeLabel: firstOf(row.check_causes)?.label ?? null,
      actionLabel: firstOf(row.check_actions)?.label ?? null,
      photoUrls,
      photoKeys: keys,
    });
  }

  const record = summary as SummaryRow & { dispatch_blocked: boolean };

  return {
    id: record.id,
    performedAt: record.performed_at,
    plate: record.plate,
    areaName: record.area_name,
    driverName: record.driver_name,
    helperName: record.helper_name,
    inspectorName: record.inspector_name,
    status: record.status,
    dispatchBlocked: record.dispatch_blocked,
    notes: record.notes,
    trainingFlag: record.training_flag,
    failures,
    passedCount,
  };
};

export type ReportStats = {
  checks: number;
  cleared: number;
  nonCompliant: number;
  held: number;
  compliancePct: number;
  /** Distinct vans inspected at least once in the window. */
  vansCovered: number;
  vansActive: number;
  coveragePct: number;
  /** Vans that exist and were never inspected in the window. */
  missedPlates: string[];
  worstTempC: number | null;
};

/**
 * Coverage is the number this dashboard was missing.
 *
 * "20 checks" says nothing without the denominator. If the area runs 25
 * vans, five dispatched unverified, and an uninspected van is a larger
 * unknown than a failed one: the failure at least got caught.
 */
export const getReportStats = async (
  from: Date,
  to: Date,
  areaId?: string,
): Promise<ReportStats> => {
  const db = serviceClient();

  const records = await listInspectionsSince(from, {
    until: to,
    ...(areaId === undefined ? {} : { areaId }),
  });

  let vanQuery = db.from('vans').select('plate').eq('active', true);
  if (areaId !== undefined) {
    vanQuery = vanQuery.eq('area_id', areaId);
  }

  const { data: vans, error } = await vanQuery;
  if (error !== null) {
    throw new Error(`Could not count the fleet: ${error.message}`);
  }

  const activePlates = (vans ?? []).map((van: { plate: string }) => van.plate);
  const coveredPlates = new Set(records.map((record) => record.plate));

  // Only count vans that are still active. A van checked last month and
  // since retired should not inflate coverage past 100%.
  const covered = activePlates.filter((plate) => coveredPlates.has(plate));
  const missed = activePlates.filter((plate) => !coveredPlates.has(plate));

  const cleared = records.filter((record) => record.status === 'compliant').length;
  const held = records.filter((record) => record.dispatchBlocked).length;
  const nonCompliant = records.filter((record) => record.status === 'noncompliant').length;

  const temps = records
    .map((record) => record.tempReadingC)
    .filter((value): value is number => value !== null);

  const pct = (part: number, whole: number): number =>
    whole === 0 ? 0 : Math.round((part / whole) * 100);

  return {
    checks: records.length,
    cleared,
    nonCompliant,
    held,
    compliancePct: pct(cleared, records.length),
    vansCovered: covered.length,
    vansActive: activePlates.length,
    coveragePct: pct(covered.length, activePlates.length),
    missedPlates: missed.sort(),
    worstTempC: temps.length === 0 ? null : Math.max(...temps),
  };
};
