import { describe, it, expect } from 'vitest';
import { monthBounds, resolveComparison } from '../../src/domain/analytics/period.js';

describe('monthBounds', () => {
  it('returns first..last day of the month', () => {
    expect(monthBounds(2026, 8)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(monthBounds(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' }); // non-leap
    expect(monthBounds(2024, 2)).toEqual({ from: '2024-02-01', to: '2024-02-29' }); // leap
  });
});

describe('resolveComparison', () => {
  it('previous_period: same-length window immediately before from', () => {
    expect(resolveComparison('2026-08-01', '2026-08-15', 'previous_period'))
      .toEqual({ from: '2026-07-17', to: '2026-07-31' }); // len 15
  });

  it('previous_period: single-day range maps to the day before', () => {
    expect(resolveComparison('2026-08-10', '2026-08-10', 'previous_period'))
      .toEqual({ from: '2026-08-09', to: '2026-08-09' });
  });

  it('previous_month: full calendar month before the month of from', () => {
    expect(resolveComparison('2026-08-05', '2026-08-20', 'previous_month'))
      .toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });

  it('previous_month: crosses the year boundary', () => {
    expect(resolveComparison('2026-01-05', '2026-01-20', 'previous_month'))
      .toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('previous_year: same window one year earlier', () => {
    expect(resolveComparison('2026-08-01', '2026-08-31', 'previous_year'))
      .toEqual({ from: '2025-08-01', to: '2025-08-31' });
  });

  it('previous_year: clamps Feb 29 to Feb 28', () => {
    expect(resolveComparison('2024-02-29', '2024-02-29', 'previous_year'))
      .toEqual({ from: '2023-02-28', to: '2023-02-28' });
  });
});
