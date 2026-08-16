import { addDays, daysBetween, lastDayOfMonth } from '../time.js';

export type CompareWith = 'previous_period' | 'previous_month' | 'previous_year';

/** 'YYYY-MM-DD' first..last day of a calendar month (month is 1–12). */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, '0');
  const last = String(lastDayOfMonth(year, month)).padStart(2, '0');
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${last}` };
}

/** Same month/day one year earlier, clamped to that month's length (Feb 29 → 28). */
function sameDatePrevYear(d: string): string {
  const y = Number(d.slice(0, 4)) - 1;
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  const max = lastDayOfMonth(y, m);
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, max)).padStart(2, '0')}`;
}

/**
 * Resolve the comparison window for a requested range (spec §3.1):
 * - previous_period: the same-length window immediately preceding `from`
 * - previous_month:  the full calendar month before the month of `from`
 * - previous_year:   the same window one year earlier (Feb-29 clamped)
 */
export function resolveComparison(
  from: string,
  to: string,
  compareWith: CompareWith,
): { from: string; to: string } {
  if (compareWith === 'previous_period') {
    const len = daysBetween(from, to) + 1;
    return { from: addDays(from, -len), to: addDays(from, -1) };
  }
  if (compareWith === 'previous_month') {
    const y = Number(from.slice(0, 4));
    const m = Number(from.slice(5, 7));
    return monthBounds(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1);
  }
  return { from: sameDatePrevYear(from), to: sameDatePrevYear(to) };
}
