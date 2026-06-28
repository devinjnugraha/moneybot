import { describe, it, expect } from 'vitest';
import {
  daysBetween,
  addDays,
  wibISOWeek,
  wibISOWeekLabel,
  wibISOWeekMonday,
  todayWibDisplay,
} from '../../src/domain/time.js';

describe('daysBetween', () => {
  it('counts whole days between two YYYY-MM-DD dates', () => {
    expect(daysBetween('2026-06-20', '2026-06-22')).toBe(2);
  });

  it('is zero for the same date', () => {
    expect(daysBetween('2026-06-22', '2026-06-22')).toBe(0);
  });

  it('is negative when the second date is earlier', () => {
    expect(daysBetween('2026-06-22', '2026-06-20')).toBe(-2);
  });

  it('handles month boundaries', () => {
    expect(daysBetween('2026-06-30', '2026-07-01')).toBe(1);
  });
});

describe('addDays', () => {
  it('adds positive days within a month', () => {
    expect(addDays('2026-06-22', 6)).toBe('2026-06-28');
  });

  it('adds across a month boundary', () => {
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01');
  });

  it('subtracts days across a month boundary', () => {
    expect(addDays('2026-06-22', -28)).toBe('2026-05-25');
  });
});

// 2026-06-22 is a Monday and the start of ISO week 2026-W26.
const MON_NOW = new Date('2026-06-22T14:00:00Z'); // 21:00 WIB -> date 2026-06-22
// 2026-06-24 is a Wednesday in the same ISO week.
const WED_NOW = new Date('2026-06-24T14:00:00Z');
// 2025-12-31 is a Wednesday whose ISO week belongs to 2026 (Thursday-of-week rule).
const ROLLOVER_NOW = new Date('2025-12-31T14:00:00Z');

describe('wibISOWeekMonday', () => {
  it('returns the same date when now is already a Monday', () => {
    expect(wibISOWeekMonday(MON_NOW)).toBe('2026-06-22');
  });

  it('returns the Monday of the week for a mid-week date', () => {
    expect(wibISOWeekMonday(WED_NOW)).toBe('2026-06-22');
  });

  it('returns the Monday across a year boundary', () => {
    expect(wibISOWeekMonday(ROLLOVER_NOW)).toBe('2025-12-29');
  });
});

describe('wibISOWeek / wibISOWeekLabel', () => {
  it('computes the ISO week for a Monday', () => {
    expect(wibISOWeek(MON_NOW)).toEqual({ year: 2026, week: 26 });
    expect(wibISOWeekLabel(MON_NOW)).toBe('2026-W26');
  });

  it('keeps a mid-week date in the same ISO week', () => {
    expect(wibISOWeekLabel(WED_NOW)).toBe('2026-W26');
  });

  it('assigns a late-December date to the next year ISO week (rollover)', () => {
    expect(wibISOWeek(ROLLOVER_NOW)).toEqual({ year: 2026, week: 1 });
    expect(wibISOWeekLabel(ROLLOVER_NOW)).toBe('2026-W01');
  });
});

describe('todayWibDisplay', () => {
  // 2026-06-28T03:00:00Z is 10:00 WIB -> same calendar day, a Sunday.
  it('formats as "<Weekday-ID>, DD Mon YYYY" in WIB', () => {
    expect(todayWibDisplay(new Date('2026-06-28T03:00:00Z'))).toBe('Minggu, 28 Jun 2026');
  });

  // 2026-06-22T17:00:00Z is 2026-06-23T00:00 WIB: still the 22nd in UTC but the
  // 23rd (Tuesday) in WIB — proves the formatting honours the timezone.
  it('rolls the calendar day at the WIB midnight boundary', () => {
    expect(todayWibDisplay(new Date('2026-06-22T17:00:00Z'))).toBe('Selasa, 23 Jun 2026');
  });
});

