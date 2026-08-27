/**
 * Domain types. Nothing in here mentions Supabase, S3, or any vendor —
 * that is deliberate. These survive the AWS migration untouched.
 */

export type InspectionStatus = 'compliant' | 'noncompliant' | 'action_required';

export type CheckInputType = 'boolean' | 'temperature';

export type UserRole = 'supervisor' | 'manager' | 'admin';

export type Profile = {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  depot: string;
};

export type Area = {
  id: string;
  name: string;
  code: string;
  active: boolean;
  sortOrder: number;
};


export type VehicleType = 'van' | 'truck';

export type Van = {
  id: string;
  plate: string;
  vehicleType: VehicleType;
  areaId: string | null;
  tempMinC: number;
  tempMaxC: number;
  active: boolean;
};

export type StaffRole = 'driver' | 'helper';

/** A driver, or a helper paired to one driver and sharing their van. */
export type Driver = {
  id: string;
  fullName: string;
  staffRole: StaffRole;
  partnerId: string | null;
  areaId: string | null;
  defaultVanId: string | null;
  active: boolean;
};

export type CauseCategory =
  | 'supply'
  | 'standards'
  | 'wear'
  | 'equipment'
  | 'behaviour'
  | 'other';

/**
 * A reason a check failed. The category is never shown to the inspector;
 * it is what lets a report tell a stores problem from a training one.
 */
export type CheckCause = {
  id: string;
  checkItemId: string;
  label: string;
  category: CauseCategory;
  sortOrder: number;
  active: boolean;
};

export type TrainingFlag = 'none' | 'driver' | 'helper' | 'both';

/** What was done about a failure. Global: the same list for every check. */
export type CheckAction = {
  id: string;
  label: string;
  sortOrder: number;
  active: boolean;
};

export type CheckItem = {
  id: string;
  code: string;
  /** Which vehicle types this check applies to. */
  vehicleTypes: VehicleType[];
  label: string;
  helpText: string | null;
  inputType: CheckInputType;
  critical: boolean;
  sortOrder: number;
};

/** One answer as the supervisor entered it on the phone. */
export type CheckAnswer = {
  checkItemCode: string;
  passed: boolean;
  /** The reading itself, e.g. 3.2 for a temperature check. */
  numericValue?: number;
  /** Required whenever passed is false. */
  note?: string;
  /** Storage key returned by uploadPhoto. Required whenever passed is false. */
  photoKey?: string;
  /** Which cause was picked. Required whenever passed is false. */
  causeId?: string;
  /** What was done about it. Optional. */
  actionId?: string;
};

export type InspectionSubmission = {
  vanId: string;
  driverId: string;
  helperId?: string;
  areaId?: string;
  answers: CheckAnswer[];
  latitude?: number;
  longitude?: number;
  notes?: string;
  /** The inspector's call on who needs training, if anyone. */
  trainingFlag?: TrainingFlag;
  /** Set when this check corrects an earlier one. */
  supersedesId?: string;
};

export type InspectionSummary = {
  id: string;
  performedAt: string;
  plate: string;
  areaName: string;
  driverName: string;
  inspectorName: string;
  helperName: string | null;
  driverId: string;
  helperId: string | null;
  status: InspectionStatus;
  dispatchBlocked: boolean;
  failedCount: number;
  tempReadingC: number | null;
  notes: string | null;
  trainingFlag: TrainingFlag;
};


/**
 * The single source of truth for the verdict. Lives here rather than in
 * the UI or the database so the phone, the API, and any future report
 * cannot disagree about whether a van was cleared.
 */
export const resolveStatus = (
  answers: CheckAnswer[],
  checkItems: CheckItem[],
): InspectionStatus => {
  const criticalCodes = new Set(
    checkItems.filter((item) => item.critical).map((item) => item.code),
  );
  const failures = answers.filter((answer) => !answer.passed);

  if (failures.length === 0) {
    return 'compliant';
  }
  if (failures.some((failure) => criticalCodes.has(failure.checkItemCode))) {
    return 'action_required';
  }
  return 'noncompliant';
};

export const isDispatchBlocked = (status: InspectionStatus): boolean =>
  status === 'action_required';
