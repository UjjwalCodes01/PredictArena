/**
 * ISO-8601 week assignment, UTC only.
 *
 * The league resets Monday 00:00 UTC. A week id is the week of the window's
 * CLOSE time, not its placement time: a call made at 23:59 Sunday on a window
 * that closes 00:01 Monday belongs to the new week, which is the boundary the
 * UI states.
 *
 * ISO weeks start Monday, and week 1 is the week containing 4 January. That is
 * why 1 January can fall in week 52/53 of the previous year and 31 December in
 * week 1 of the next -- the reason this is a function and not an inline
 * expression.
 */

const MS_PER_DAY = 86_400_000;
const WEEK_ID = /^(\d{4})-W(\d{2})$/;

/** ISO week id for an instant, e.g. "2026-W35". Lexicographically sortable. */
export function isoWeekId(date: Date): string {
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new RangeError("isoWeekId: invalid date");

  // Midnight UTC on the given day.
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  // Shift to the Thursday of this week: the ISO year is whichever year that
  // Thursday lands in. Sunday is 0 from getUTCDay, so map it to 7.
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);

  const isoYear = day.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((day.getTime() - jan1) / MS_PER_DAY + 1) / 7);

  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Week id for a window close time given in unix seconds. */
export function weekIdForClose(closesAtSec: number): string {
  return isoWeekId(new Date(closesAtSec * 1000));
}

/** Monday 00:00:00 UTC that begins a week id. Inverse of `isoWeekId`. */
export function weekStartUtc(weekId: string): Date {
  const match = WEEK_ID.exec(weekId);
  if (!match) throw new RangeError(`Malformed week id: "${weekId}" (expected e.g. 2026-W35)`);
  const isoYear = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) throw new RangeError(`Week out of range in "${weekId}"`);

  // 4 January is always in week 1; walk back to that week's Monday, then add weeks.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Weekday = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Weekday - 1) * MS_PER_DAY);
  const start = new Date(week1Monday.getTime() + (week - 1) * 7 * MS_PER_DAY);

  // Week 53 does not exist in every ISO year; reject rather than silently
  // returning a date in the following year.
  if (isoWeekId(start) !== weekId) throw new RangeError(`Week ${week} does not exist in ISO year ${isoYear}`);
  return start;
}

/** The week id currently in progress. */
export const currentWeekId = (now: Date = new Date()): string => isoWeekId(now);
