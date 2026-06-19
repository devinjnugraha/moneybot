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
