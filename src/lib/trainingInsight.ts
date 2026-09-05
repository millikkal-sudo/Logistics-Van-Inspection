import { serviceClient } from './supabaseClients';
import { listInspectionsSince } from './inspectionRepository';
import type { CauseCategory } from './types';

/**
 * Turns inspection failures into a training decision.
 *
 * The distinction that matters is not how many times someone failed, but
 * why. Seven uniform failures that are all "missing shoes" is a purchase
 * order. Four hygiene failures by one person is a conversation.
 */

/** Categories a training session can actually change. */
const TRAINABLE: CauseCategory[] = ['standards', 'behaviour'];

export type DefectCount = {
  checkLabel: string;
  causeLabel: string;
  category: CauseCategory;
  count: number;
};

export type QueueEntry = {
  personId: string;
  /** Area of the person's van, so the queue can be cleared area by area. */
  areaName: string;
  /** When they were last trained, if ever. */
  lastTrainedAt: string | null;
  personName: string;
  role: 'driver' | 'helper';
  /** Failures on checks whose cause a session could fix. */
  trainableCount: number;
  /** Failures caused by supply, wear or equipment. */
  nonTrainableCount: number;
  /** Times an inspector explicitly called for training. */
  flaggedCount: number;
  causes: string[];
  lastSeen: string;
  priority: 'session' | 'watch';
  reason: string;
};

export type SystemicIssue = {
  checkLabel: string;
  causeLabel: string;
  category: CauseCategory;
  peopleAffected: number;
  count: number;
  reason: string;
};

/**
 * When each person was last trained.
 *
 * Failures before that date are excluded from the queue: the session
 * addressed them. Anything after it counts, so someone who slips again
 * reappears without anyone having to remember.
 */
const lastTrainedByPerson = async (): Promise<Map<string, string>> => {
  const { data } = await serviceClient()
    .from('training_sessions')
    .select('person_id, completed_at')
    .order('completed_at', { ascending: false });

  const out = new Map<string, string>();
  for (const row of (data ?? []) as { person_id: string; completed_at: string }[]) {
    if (!out.has(row.person_id)) {
      out.set(row.person_id, row.completed_at);
    }
  }
  return out;
};

export type TrainingInsight = {
  defects: DefectCount[];
  queue: QueueEntry[];
  systemic: SystemicIssue[];
};

type FailureRow = {
  inspection_id: string;
  check_items: { label: string } | { label: string }[] | null;
  check_causes: { label: string; category: CauseCategory } | { label: string; category: CauseCategory }[] | null;
};

const firstOf = <T,>(value: T | T[] | null): T | null => {
  if (value === null) {
    return null;
  }
  return Array.isArray(value) ? (value[0] ?? null) : value;
};

export const getTrainingInsight = async (
  from: Date,
  to: Date,
  areaId?: string,
): Promise<TrainingInsight> => {
  const [records, lastTrained] = await Promise.all([
    listInspectionsSince(from, {
      until: to,
      ...(areaId === undefined ? {} : { areaId }),
    }),
    lastTrainedByPerson(),
  ]);

  const failing = records.filter((record) => record.failedCount > 0);
  if (failing.length === 0) {
    return { defects: [], queue: [], systemic: [] };
  }

  const { data } = await serviceClient()
    .from('inspection_results')
    .select('inspection_id, check_items(label), check_causes(label, category)')
    .in(
      'inspection_id',
      failing.map((record) => record.id),
    )
    .eq('passed', false);

  const rows = (data ?? []) as unknown as FailureRow[];

  const defects = new Map<string, DefectCount>();
  const people = new Map<string, QueueEntry>();
  const causeToPeople = new Map<string, Set<string>>();

  for (const row of rows) {
    const checkLabel = firstOf(row.check_items)?.label ?? 'Unknown check';
    const cause = firstOf(row.check_causes);
    const causeLabel = cause?.label ?? 'Not recorded';
    const category = cause?.category ?? 'other';

    const defectKey = `${checkLabel}|${causeLabel}`;
    const existingDefect = defects.get(defectKey);
    defects.set(defectKey, {
      checkLabel,
      causeLabel,
      category,
      count: (existingDefect?.count ?? 0) + 1,
    });

    const record = records.find((candidate) => candidate.id === row.inspection_id);
    if (record === undefined) {
      continue;
    }

    // A uniform failure could be either person on the van. Without the
    // inspector naming one, it is attributed to the driver, who is
    // responsible for the vehicle.
    const attributed: { id: string; name: string; role: 'driver' | 'helper' }[] = [];
    if (record.trainingFlag === 'helper' && record.helperId !== null && record.helperName !== null) {
      attributed.push({ id: record.helperId, name: record.helperName, role: 'helper' });
    } else if (record.trainingFlag === 'both') {
      attributed.push({ id: record.driverId, name: record.driverName, role: 'driver' });
      if (record.helperId !== null && record.helperName !== null) {
        attributed.push({ id: record.helperId, name: record.helperName, role: 'helper' });
      }
    } else {
      attributed.push({ id: record.driverId, name: record.driverName, role: 'driver' });
    }

    for (const person of attributed) {
      // Cleared by a session: anything they were trained on is closed.
      const trainedAt = lastTrained.get(person.id);
      if (trainedAt !== undefined && record.performedAt <= trainedAt) {
        continue;
      }

      const entry: QueueEntry = people.get(person.id) ?? {
        personId: person.id,
        personName: person.name,
        areaName: record.areaName,
        lastTrainedAt: trainedAt ?? null,
        role: person.role,
        trainableCount: 0,
        nonTrainableCount: 0,
        flaggedCount: 0,
        causes: [] as string[],
        lastSeen: record.performedAt,
        priority: 'watch' as const,
        reason: '',
      };

      if (TRAINABLE.includes(category)) {
        entry.trainableCount += 1;
      } else {
        entry.nonTrainableCount += 1;
      }
      if (!entry.causes.includes(causeLabel)) {
        entry.causes.push(causeLabel);
      }
      if (record.performedAt > entry.lastSeen) {
        entry.lastSeen = record.performedAt;
      }
      people.set(person.id, entry);

      const peopleForCause = causeToPeople.get(defectKey) ?? new Set<string>();
      peopleForCause.add(person.id);
      causeToPeople.set(defectKey, peopleForCause);
    }
  }

  // An explicit call from the inspector counts once per inspection, not
  // once per failed check on it.
  for (const record of records) {
    if (record.trainingFlag === 'none') {
      continue;
    }
    const ids = [
      record.trainingFlag === 'helper' || record.trainingFlag === 'both' ? record.helperId : null,
      record.trainingFlag === 'driver' || record.trainingFlag === 'both' ? record.driverId : null,
    ].filter((id): id is string => id !== null);

    for (const id of ids) {
      const trainedAt = lastTrained.get(id);
      if (trainedAt !== undefined && record.performedAt <= trainedAt) {
        continue;
      }
      const entry = people.get(id);
      if (entry !== undefined) {
        entry.flaggedCount += 1;
      }
    }
  }

  const queue = [...people.values()]
    .map((entry) => {
      const flagged = entry.flaggedCount > 0;
      const repeated = entry.trainableCount >= 3;

      return {
        ...entry,
        priority: (flagged || repeated ? 'session' : 'watch') as 'session' | 'watch',
        reason: flagged
          ? `Flagged for training by the inspector ${entry.flaggedCount} time${entry.flaggedCount === 1 ? '' : 's'}.`
          : repeated
            ? `${entry.trainableCount} failures a session could address.`
            : entry.trainableCount === 0
              ? 'All failures were supply or equipment. Training would not change them.'
              : `${entry.trainableCount} failure${entry.trainableCount === 1 ? '' : 's'} so far. No pattern yet.`,
      };
    })
    .filter((entry) => entry.trainableCount > 0 || entry.flaggedCount > 0)
    .sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority === 'session' ? -1 : 1;
      }
      return b.flaggedCount + b.trainableCount - (a.flaggedCount + a.trainableCount);
    });

  // The check that makes the cause field worth capturing: many people,
  // one non-trainable cause, is a supply or maintenance job.
  const systemic: SystemicIssue[] = [...defects.values()]
    .flatMap((defect) => {
      const affected = causeToPeople.get(`${defect.checkLabel}|${defect.causeLabel}`)?.size ?? 0;
      if (affected < 3 || TRAINABLE.includes(defect.category)) {
        return [];
      }
      return [
        {
          checkLabel: defect.checkLabel,
          causeLabel: defect.causeLabel,
          category: defect.category,
          peopleAffected: affected,
          count: defect.count,
          reason:
            defect.category === 'supply'
              ? 'A stores problem. Retraining will not fix it.'
              : defect.category === 'equipment'
                ? 'A maintenance problem. Raise with the workshop.'
                : 'Worn out and needs replacing.',
        },
      ];
    })
    .sort((a, b) => b.count - a.count);

  return {
    defects: [...defects.values()].sort((a, b) => b.count - a.count),
    queue,
    systemic,
  };
};
