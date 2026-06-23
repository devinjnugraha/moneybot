const TZ = 'Asia/Jakarta';

/** Today's date in WIB as 'YYYY-MM-DD'. */
export function todayWIB(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** ISO 8601 timestamp for "now" (UTC; TZ-aware consumers interpret). */
export function nowWIB(now: Date = new Date()): string {
  // toISOString is UTC; fine for timestamps (created_at etc.) which are TZ-aware.
  return now.toISOString();
}

/** Last day of the month for a given year/month (month is 1–12). */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate(); // day 0 of next month = last day of this month
}

function wibDateParts(now: Date): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [year, month, day] = fmt.format(now).split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

/** Current month (1–12) in WIB. */
export function wibMonth(now: Date = new Date()): number {
  return wibDateParts(now).month;
}

/** Current year in WIB. */
export function wibYear(now: Date = new Date()): number {
  return wibDateParts(now).year;
}

/** Current day (1–31) in WIB. */
export function wibDay(now: Date = new Date()): number {
  return wibDateParts(now).day;
}

/**
 * Integer day difference (b - a) for two 'YYYY-MM-DD' calendar dates. Both are
 * treated as abstract WIB calendar dates (UTC midnight), so the diff is exact.
 */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Add (possibly negative) days to a 'YYYY-MM-DD' date, returning 'YYYY-MM-DD'. */
export function addDays(s: string, days: number): string {
  return new Date(Date.parse(s) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * ISO-8601 week-of-year and ISO week-numbering year for `now` (WIB). The ISO
 * year can differ from the calendar year near Jan 1 / Dec 31: the week's
 * Thursday owns the year (so 2025-12-31 is ISO 2026-W01).
 */
export function wibISOWeek(now: Date = new Date()): { year: number; week: number } {
  const { year: y, month: m, day: d } = wibDateParts(now);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7; // Mon=1 .. Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // Thursday of this ISO week
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: isoYear, week };
}

/** ISO week label 'YYYY-Www' (e.g. '2026-W26') for `now` (WIB). */
export function wibISOWeekLabel(now: Date = new Date()): string {
  const { year, week } = wibISOWeek(now);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Monday of `now`'s ISO week as a 'YYYY-MM-DD' WIB calendar date. */
export function wibISOWeekMonday(now: Date = new Date()): string {
  const { year: y, month: m, day: d } = wibDateParts(now);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7; // Mon=1 .. Sun=7
  date.setUTCDate(date.getUTCDate() - (dayNum - 1)); // back to Monday
  return date.toISOString().slice(0, 10);
}

/**
 * Next occurrence of `dayOfMonth` on or after today (WIB).
 * A day-31 subscription in February fires on Feb 28 (last-day rule).
 */
export function nextFireDate(dayOfMonth: number, today: Date = new Date()): string {
  const { year, month, day: todayDay } = wibDateParts(today);
  const daysInMonth = lastDayOfMonth(year, month);
  const targetDay = Math.min(dayOfMonth, daysInMonth);

  if (todayDay <= targetDay) {
    return `${year}-${String(month).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
  }

  // Next month
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextDaysInMonth = lastDayOfMonth(nextYear, nextMonth);
  const nextTargetDay = Math.min(dayOfMonth, nextDaysInMonth);
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextTargetDay).padStart(2, '0')}`;
}
