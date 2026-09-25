import { serviceClient } from './supabaseClients';
import { dubaiDayRange } from './shift';
import { listInspectionsSince } from './inspectionRepository';

/**
 * Driver of the month, one per zone.
 *
 * Ranked on clean rate with a minimum number of inspections to qualify.
 * Without the minimum, a driver checked once scores 100% and beats
 * someone clean across eighteen checks.
 *
 * Ties break on volume: staying clean over more inspections is the
 * harder thing, and rewarding the smaller sample would make this a
 * lottery among whoever happened to be checked twice.
 */

/**
 * The bar adapts to the zone.
 *
 * A fixed minimum cannot serve both Dubai and Fujairah. Dubai vans are
 * inspected daily, so four is nothing; Fujairah is visited fortnightly,
 * so four is impossible and that zone would never produce a winner.
 *
 * Instead: a third of whatever the most-inspected driver in that zone
 * managed, with a floor of two. The winner has to have been checked
 * comparably often to their own zone's busiest driver, and one lucky
 * pass still cannot take it.
 */
const ABSOLUTE_FLOOR = 2;

const minimumFor = (inspectionCounts: number[]): number => {
  const busiest = Math.max(0, ...inspectionCounts);
  return Math.max(ABSOLUTE_FLOOR, Math.ceil(busiest / 3));
};

export const ZONE_NAMES: Record<number, string> = {
  1: 'Dubai',
  2: 'Al Ain and Abu Dhabi',
  3: 'Northern Emirates',
};

export type Candidate = {
  personId: string;
  personName: string;
  areaName: string;
  plate: string;
  inspections: number;
  clean: number;
  cleanPct: number;
};

export type ZoneAward = {
  zone: number;
  zoneName: string;
  /** The bar for this zone, so the panel can explain itself. */
  minimum: number;
  winner: Candidate | null;
  runnersUp: Candidate[];
  /** Why there is no winner, when there isn't one. */
  note: string | null;
  excludedCount: number;
  excludedReasons: string[];
};

type AreaZone = { name: string; award_zone: number | null };

export const getDriverOfMonth = async (month: string): Promise<ZoneAward[]> => {
  const [year, monthIndex] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year ?? 2026, (monthIndex ?? 1) - 1, 1));
  const end = new Date(Date.UTC(year ?? 2026, monthIndex ?? 1, 0));

  const range = dubaiDayRange(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
  const db = serviceClient();

  const [{ data: areaRows }, records] = await Promise.all([
    db.from('areas').select('name, award_zone'),
    listInspectionsSince(range.from, { until: range.to }),
  ]);

  const zoneOfArea = new Map<string, number>();
  for (const area of (areaRows ?? []) as AreaZone[]) {
    if (area.award_zone !== null) {
      zoneOfArea.set(area.name, area.award_zone);
    }
  }

  type Tally = Candidate & { zone: number; disqualified: string | null };
  const people = new Map<string, Tally>();

  for (const record of records) {
    const zone = zoneOfArea.get(record.areaName);
    if (zone === undefined || record.driverId === null) {
      continue;
    }

    const entry: Tally = people.get(record.driverId) ?? {
      personId: record.driverId,
      personName: record.driverName,
      areaName: record.areaName,
      plate: record.plate,
      inspections: 0,
      clean: 0,
      cleanPct: 0,
      zone,
      disqualified: null,
    };

    entry.inspections += 1;
    if (record.status === 'compliant') {
      entry.clean += 1;
    }

    // Two things rule someone out whatever their rate. A temperature
    // breach is the food safety one, and a training flag is the
    // inspector's own judgement that something needs addressing.
    if (record.tempReadingC !== null && record.tempReadingC > 5) {
      entry.disqualified = 'temperature failure';
    }
    if (record.trainingFlag === 'driver' || record.trainingFlag === 'both') {
      entry.disqualified = entry.disqualified ?? 'flagged for training';
    }

    people.set(record.driverId, entry);
  }

  return [1, 2, 3].map((zone) => {
    const inZone = [...people.values()].filter((person) => person.zone === zone);

    const minimum = minimumFor(inZone.map((person) => person.inspections));

    const excluded = inZone.filter(
      (person) => person.disqualified !== null || person.inspections < minimum,
    );

    const eligible = inZone
      .filter((person) => person.disqualified === null && person.inspections >= minimum)
      .map((person) => ({
        ...person,
        cleanPct: Math.round((person.clean / person.inspections) * 100),
      }))
      .sort((a, b) =>
        b.cleanPct === a.cleanPct ? b.inspections - a.inspections : b.cleanPct - a.cleanPct,
      );

    return {
      zone,
      zoneName: ZONE_NAMES[zone] ?? `Zone ${zone}`,
      minimum,
      winner: eligible[0] ?? null,
      runnersUp: eligible.slice(1, 4),
      note:
        eligible.length > 0
          ? null
          : inZone.length === 0
            ? 'No inspections in this zone this month'
            : `Nobody reached ${minimum} inspection${minimum === 1 ? '' : 's'} this month`,
      excludedCount: excluded.length,
      excludedReasons: [
        ...new Set(
          excluded.map(
            (person) => person.disqualified ?? `fewer than ${minimum} inspections`,
          ),
        ),
      ],
    };
  });
};
