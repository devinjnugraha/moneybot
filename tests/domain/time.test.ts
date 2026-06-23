import { describe, it, expect } from 'vitest';
import { daysBetween } from '../../src/domain/time.js';

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
