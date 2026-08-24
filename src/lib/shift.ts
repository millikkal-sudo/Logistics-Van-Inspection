/**
 * Which despatch shift a moment belongs to.
 *
 * Everything is computed in Dubai wall clock, not the server's. Vercel
 * runs UTC, so a check filed at 01:00 Dubai would otherwise be read as
 * 21:00 the previous day and land in the wrong shift. The UAE does not
 * observe daylight saving, so a fixed offset is correct year round.
 */

const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;

export type ShiftSlot = 'early_morning' | 'morning' | 'evening';

export type Shift = {
  slot: ShiftSlot;
  label: string;
  /** Inclusive start of the shift, as a real instant. */
  from: Date;
  /** Exclusive end. */
  to: Date;
};

/**
 * Start hour of each slot in Dubai time. Early morning runs backwards
 * across midnight, which is why it cannot be expressed as a simple
 * range check.
 */
const SLOTS: { slot: ShiftSlot; label: string; startHour: number; endHour: number }[] = [
  { slot: 'early_morning', label: 'Early morning', startHour: 19, endHour: 2 },
  { slot: 'morning', label: 'Morning', startHour: 2, endHour: 12 },
  { slot: 'evening', label: 'Evening', startHour: 12, endHour: 19 },
];

/** Dubai wall clock fields for an instant. */
const dubaiClock = (at: Date): { y: number; m: number; d: number; hour: number } => {
  const shifted = new Date(at.getTime() + DUBAI_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
};

/** Turns a Dubai wall clock time back into a real instant. */
const dubaiInstant = (y: number, m: number, d: number, hour: number): Date =>
  new Date(Date.UTC(y, m, d, hour, 0, 0, 0) - DUBAI_OFFSET_MS);

export const resolveShift = (at: Date = new Date()): Shift => {
  const { y, m, d, hour } = dubaiClock(at);

  // Early morning first: it wraps midnight, so 20:00 and 01:00 are the
  // same shift and 01:00 belongs to the evening before.
  if (hour >= 19) {
    return {
      slot: 'early_morning',
      label: 'Early morning',
      from: dubaiInstant(y, m, d, 19),
      to: dubaiInstant(y, m, d + 1, 2),
    };
  }
  if (hour < 2) {
    return {
      slot: 'early_morning',
      label: 'Early morning',
      from: dubaiInstant(y, m, d - 1, 19),
      to: dubaiInstant(y, m, d, 2),
    };
  }

  const slot = SLOTS.find(
    (candidate) =>
      candidate.slot !== 'early_morning' &&
      hour >= candidate.startHour &&
      hour < candidate.endHour,
  );

  // Unreachable given the slots cover 02:00 to 19:00, but a missing
  // shift would silently hide every check filed in that hour.
  const resolved = slot ?? SLOTS[1];

  return {
    slot: resolved?.slot ?? 'morning',
    label: resolved?.label ?? 'Morning',
    from: dubaiInstant(y, m, d, resolved?.startHour ?? 2),
    to: dubaiInstant(y, m, d, resolved?.endHour ?? 12),
  };
};

/** "Morning report", "Early morning report". */
export const shiftReportTitle = (shift: Shift): string =>
  `${shift.label} report`;

/**
 * "Today" for a shift crossing midnight is the day it started, so an
 * early morning round filed at 01:00 reports under the previous date
 * rather than splitting across two.
 */
export const shiftDateLabel = (shift: Shift): string =>
  shift.from.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Dubai',
  });

/**
 * The shift immediately before a given one.
 *
 * A round worked in the morning but sent at 17:00 would otherwise be
 * labelled evening and show no records. Falling back one shift keeps a
 * late send accurate rather than empty.
 */
export const previousShift = (shift: Shift): Shift =>
  resolveShift(new Date(shift.from.getTime() - 60 * 1000));
