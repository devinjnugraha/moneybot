import { describe, it, expect } from 'vitest';
import { isMuted, inQuietHours, startOfTodayWIB } from '../../src/proactive/guard.js';
import type { ProactiveSettings } from '../../src/domain/entities.js';

// All `now` values are UTC instants whose WIB (UTC+7) time is known.
// 14:00Z = 21:00 WIB; 16:00Z = 23:00 WIB; 00:00Z = 07:00 WIB; 2026-06-21T23:59Z = 06:59 WIB.

describe('isMuted', () => {
  it('false when not muted', () => {
    const s: ProactiveSettings = { userId: 'u', muted: false };
    expect(isMuted(s, new Date('2026-06-22T14:00:00Z'))).toBe(false);
  });
  it('true when muted forever (no resumeAt)', () => {
    const s: ProactiveSettings = { userId: 'u', muted: true };
    expect(isMuted(s, new Date('2026-06-22T14:00:00Z'))).toBe(true);
  });
  it('true when muted and now is before resumeAt', () => {
    const s: ProactiveSettings = { userId: 'u', muted: true, resumeAt: '2026-06-22T16:00:00Z' };
    expect(isMuted(s, new Date('2026-06-22T14:00:00Z'))).toBe(true);
  });
  it('false when muted but resumeAt has passed (auto-expire)', () => {
    const s: ProactiveSettings = { userId: 'u', muted: true, resumeAt: '2026-06-22T14:00:00Z' };
    expect(isMuted(s, new Date('2026-06-22T16:00:00Z'))).toBe(false);
  });
});

describe('inQuietHours (window 22:00-07:00 WIB, overnight)', () => {
  const window = '22:00-07:00';
  it('not quiet at 21:00 WIB', () => {
    expect(inQuietHours(new Date('2026-06-22T14:00:00Z'), window)).toBe(false);
  });
  it('quiet at 23:00 WIB', () => {
    expect(inQuietHours(new Date('2026-06-22T16:00:00Z'), window)).toBe(true);
  });
  it('quiet at 06:59 WIB', () => {
    expect(inQuietHours(new Date('2026-06-21T23:59:00Z'), window)).toBe(true);
  });
  it('not quiet at exactly 07:00 WIB (end exclusive)', () => {
    expect(inQuietHours(new Date('2026-06-22T00:00:00Z'), window)).toBe(false);
  });
});

describe('inQuietHours (same-day window 09:00-17:00)', () => {
  const window = '09:00-17:00';
  it('quiet at 12:00 WIB', () => {
    expect(inQuietHours(new Date('2026-06-22T05:00:00Z'), window)).toBe(true); // 12:00 WIB
  });
  it('not quiet at 18:00 WIB', () => {
    expect(inQuietHours(new Date('2026-06-22T11:00:00Z'), window)).toBe(false); // 18:00 WIB
  });
});

describe('startOfTodayWIB', () => {
  it('returns the UTC instant of 00:00 WIB on the current WIB day', () => {
    // 2026-06-22 16:00 UTC == 2026-06-22 23:00 WIB => WIB day is 2026-06-22.
    // Midnight WIB that day == 2026-06-21 17:00 UTC.
    const start = startOfTodayWIB(new Date('2026-06-22T16:00:00Z'));
    expect(start.toISOString()).toBe('2026-06-21T17:00:00.000Z');
  });
});
