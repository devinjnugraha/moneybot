import { describe, it, expect } from 'vitest';
import { healthVerdict, type HealthInput } from '../../src/domain/analytics/health.js';
import type { CashflowSummary } from '../../src/domain/analytics/cashflow.js';
import type { PacingResult } from '../../src/domain/analytics/pacing.js';

function mkCashflow(i: number, e: number): CashflowSummary {
  return { income: i, expense: e, net: i - e, savingsRate: i > 0 ? Math.round(((i - e) / i) * 100) : undefined };
}
function mkPacing(onTrack: number, total: number): PacingResult {
  return {
    asOf: '2026-08-16', elapsedDays: 16, daysInMonth: 31,
    items: Array.from({ length: total }, (_, i) => ({
      budgetCodeId: `b${i}`, name: `b${i}`, spent: 0, alloc: 100_000, projected: 0,
      verdict: i < onTrack ? ('on_track' as const) : ('over_pace' as const),
      lowConfidence: false,
    })),
  };
}
const BASE: HealthInput = {
  month: '2026-08', asOf: '2026-08-16',
  trailingCashflow: [mkCashflow(5_000_000, 4_000_000), mkCashflow(5_000_000, 3_500_000), mkCashflow(5_000_000, 3_500_000)],
  pacing: mkPacing(4, 5),           // 80% on track → good
  obligations: {
    horizonEnd: '2026-09-15', items: [{ name: 'x', amount: 100_000, dueDate: '2026-08-20', kind: 'recurring' }],
    liquidBalance: 3_800_000, totalDue: 100_000, verdict: 'covered',
  },                                 // covered → good
  liquidBalance: 3_800_000,          // avg expense 3.666.667 → runway 1.04 → warn
  currentExpense: 3_000_000, previousExpense: 3_200_000, // trend -6% → good
  leakCount: 1,                      // warn
};

describe('healthVerdict', () => {
  it('builds all six components and the weighted score', () => {
    const v = healthVerdict(BASE);
    expect(v.month).toBe('2026-08');
    const byKey = Object.fromEntries(v.components.map((c) => [c.key, c]));
    expect(byKey.savings_rate!.status).toBe('good');   // avg (20+30+30)/3 ≈ 27%
    expect(byKey.budget_adherence!.status).toBe('good');
    expect(byKey.bill_coverage!.status).toBe('good');
    expect(byKey.runway!.status).toBe('warn');         // 3.8M / 3.67M ≈ 1.04 bulan
    expect(byKey.leak_flags!.status).toBe('warn');
    expect(byKey.trend!.status).toBe('good');
    // score = .25*100 + .15*100 + .25*100 + .20*50 + .05*50 + .10*100 — exact math
    // 87.5, but the FP sum of inexact weights (0.15/0.05/0.2) lands just below,
    // so Math.round yields 87.
    expect(v.score).toBe(87);
  });

  it('savings_rate insufficient when no trailing month has income', () => {
    // Same expenses as BASE so only savings degrades (a thinner expense base
    // would also lift runway and muddy the assertion).
    const v = healthVerdict({
      ...BASE,
      trailingCashflow: [mkCashflow(0, 4_000_000), mkCashflow(0, 3_500_000), mkCashflow(0, 3_500_000)],
    });
    const c = v.components.find((x) => x.key === 'savings_rate')!;
    expect(c.status).toBe('insufficient_data');
    // (87.5 − 25) / 0.75 = 83.33 → 83: weight redistributed over the rest.
    expect(v.score).toBe(83);
  });

  it('bill_coverage not_applicable when obligations absent (past month)', () => {
    const v = healthVerdict({ ...BASE, obligations: undefined });
    expect(v.components.find((x) => x.key === 'bill_coverage')!.status).toBe('not_applicable');
  });

  it('runway insufficient when no trailing month has expenses', () => {
    const v = healthVerdict({ ...BASE, trailingCashflow: [mkCashflow(5_000_000, 0)] });
    expect(v.components.find((x) => x.key === 'runway')!.status).toBe('insufficient_data');
  });

  it('trend insufficient when either month has zero expense', () => {
    const v = healthVerdict({ ...BASE, previousExpense: 0 });
    expect(v.components.find((x) => x.key === 'trend')!.status).toBe('insufficient_data');
  });

  it('budget_adherence insufficient when there are no budgets', () => {
    const v = healthVerdict({ ...BASE, pacing: mkPacing(0, 0) });
    expect(v.components.find((x) => x.key === 'budget_adherence')!.status).toBe('insufficient_data');
  });

  it('thin data: only leak_flags stays scorable — score redistributes over it', () => {
    // leak_flags has no insufficient branch (0 findings is itself a good verdict),
    // so "every component unscorable" is unreachable by construction; the closest
    // reachable state scores from the single remaining component.
    const v = healthVerdict({
      ...BASE, trailingCashflow: [], pacing: mkPacing(0, 0), obligations: undefined,
      liquidBalance: 0, previousExpense: 0, leakCount: 0,
    });
    const scorable = v.components.filter((c) => c.status === 'good' || c.status === 'warn' || c.status === 'bad');
    expect(scorable.map((c) => c.key)).toEqual(['leak_flags']);
    expect(v.score).toBe(100);
  });
});
