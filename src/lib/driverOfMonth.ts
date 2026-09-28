import { serviceClient } from './supabaseClients';
import { dubaiDayRange } from './shift';
import { listInspectionsSince } from './inspectionRepository';
import { listComplaints } from './complaints';

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
 * The bar adapts to the zone, and is computed from the people still in
 * the running.
 *
 * Including disqualified drivers was a bug: one disqualified driver with
 * twelve inspections pushed the bar to four and excluded everyone left,
 * so a zone with real inspections produced no winner at all.
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
  complaints: number;
  /** Every vehicle they were inspected on this month. */
  vehicles: string[];
  /** Null when they are still in the running. */
  disqualified: string | null;
  /** True when they cleared the zone's inspection bar. */
  metMinimum: boolean;
};

export type ZoneAward = {
  zone: number;
  zoneName: string;
  /** The bar for this zone, so the panel can explain itself. */
  minimum: number;
  winner: Candidate | null;
  runnersUp: Candidate[];
  /** Everyone, ranked, including those ruled out and why. */
  standings: Candidate[];
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

  const [{ data: areaRows }, records, complaints] = await Promise.all([
    db.from('areas').select('name, award_zone'),
    listInspectionsSince(range.from, { until: range.to }),
    listComplaints(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)),
  ]);

  const complaintsByDriver = new Map<string, number>();
  for (const complaint of complaints) {
    if (complaint.driverId !== null) {
      complaintsByDriver.set(
        complaint.driverId,
        (complaintsByDriver.get(complaint.driverId) ?? 0) + 1,
      );
    }
  }

  const zoneOfArea = new Map<string, number>();
  for (const area of (areaRows ?? []) as AreaZone[]) {
    if (area.award_zone !== null) {
      zoneOfArea.set(area.name, area.award_zone);
    }
  }

  type Tally = Candidate & { zone: number };
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
      complaints: complaintsByDriver.get(record.driverId) ?? 0,
      vehicles: [],
      metMinimum: false,
      zone,
      disqualified: null,
    };

    entry.inspections += 1;
    if (record.status === 'compliant') {
      entry.clean += 1;
    }
    // A plate correction, or a driver moved between vehicles, must not
    // split their record. Grouping is by person; the vehicles are just
    // listed.
    if (!entry.vehicles.includes(record.plate)) {
      entry.vehicles.push(record.plate);
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
    // The two criteria: a clean inspection record and no complaints.
    // A perfect record means nothing if customers are complaining.
    if (entry.complaints > 0) {
      entry.disqualified = entry.disqualified ?? 'customer complaint';
    }
    if (record.status !== 'compliant') {
      entry.disqualified = entry.disqualified ?? 'non-compliant inspection';
    }

    people.set(record.driverId, entry);
  }

  return [1, 2, 3].map((zone) => {
    const inZone = [...people.values()].filter((person) => person.zone === zone);

    // Computed from the people still standing, not everyone in the zone.
    const standing = inZone.filter((person) => person.disqualified === null);
    const minimum = minimumFor(standing.map((person) => person.inspections));

    const excluded = inZone.filter(
      (person) => person.disqualified !== null || person.inspections < minimum,
    );

    const withRate = (person: Tally): Candidate => ({
      ...person,
      cleanPct: Math.round((person.clean / person.inspections) * 100),
      metMinimum: person.inspections >= minimum,
    });

    const eligible = standing
      .filter((person) => person.inspections >= minimum)
      .map(withRate)
      .sort((a, b) =>
        b.cleanPct === a.cleanPct ? b.inspections - a.inspections : b.cleanPct - a.cleanPct,
      );

    // Everyone, so the edge cases can be judged rather than hidden. In
    // the running first, then the rest by how close they came.
    const standings = inZone
      .map(withRate)
      .sort((a, b) => {
        const aIn = a.disqualified === null && a.metMinimum;
        const bIn = b.disqualified === null && b.metMinimum;
        if (aIn !== bIn) {
          return aIn ? -1 : 1;
        }
        return b.cleanPct === a.cleanPct ? b.inspections - a.inspections : b.cleanPct - a.cleanPct;
      });

    return {
      zone,
      zoneName: ZONE_NAMES[zone] ?? `Zone ${zone}`,
      minimum,
      winner: eligible[0] ?? null,
      runnersUp: eligible.slice(1, 4),
      standings,
      note:
        eligible.length > 0
          ? null
          : inZone.length === 0
            ? 'No inspections in this zone this month'
            : 'Everyone in this zone had a complaint, a failure or a training flag',
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
