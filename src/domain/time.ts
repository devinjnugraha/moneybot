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
