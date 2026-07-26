import { describe, it, expect } from 'vitest';
import { billingCut, lastBillingCutOnOrBefore, previousBillingCut } from '../../src/domain/time.js';

describe('billingCut', () => {
  it('returns the billing day clamped to the month length (day-31 in Feb)', () => {
    expect(billingCut(5, 2026, 7)).toBe('2026-07-05');
    expect(billingCut(31, 2026, 2)).toBe('2026-02-28');
    expect(billingCut(31, 2024, 2)).toBe('2024-02-29'); // leap year
  });
});

describe('lastBillingCutOnOrBefore', () => {
  it('returns this month cut when on/before today, else previous month', () => {
    expect(lastBillingCutOnOrBefore(5, '2026-07-20')).toBe('2026-07-05');
    expect(lastBillingCutOnOrBefore(5, '2026-07-05')).toBe('2026-07-05');
    expect(lastBillingCutOnOrBefore(5, '2026-07-04')).toBe('2026-06-05');
  });
  it('wraps the year in January', () => {
    expect(lastBillingCutOnOrBefore(5, '2026-01-03')).toBe('2025-12-05');
  });
  it('clamps day-31 in a short month', () => {
    expect(lastBillingCutOnOrBefore(31, '2026-02-15')).toBe('2026-01-31');
  });
});

describe('previousBillingCut', () => {
  it('returns the prior month cut', () => {
    expect(previousBillingCut(5, '2026-07-05')).toBe('2026-06-05');
    expect(previousBillingCut(31, '2026-03-31')).toBe('2026-02-28');
  });
  it('wraps the year in January', () => {
    expect(previousBillingCut(5, '2026-01-05')).toBe('2025-12-05');
  });
});
