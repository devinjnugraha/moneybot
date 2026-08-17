import { describe, it, expect } from 'vitest';
import { pacing } from '../../src/domain/analytics/pacing.js';
import type { BudgetCode, Transaction } from '../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}
function mkBudget(over: Partial<BudgetCode>): BudgetCode {
  return {
    budgetCodeId: 'b', userId: 'u', name: 'makan', monthlyBudget: 1_000_000,
    month: 8, year: 2026, spent: 0, isRecurring: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

describe('pacing', () => {
  // today = 2026-08-16 → elapsed 16/31 days
  const TODAY = '2026-08-16';

  it('projects month-end from run-rate and marks tight when projection stays under 1.15x', () => {
    // spent 600k by day 16 → daily 37.5k → projected 1.162.500 vs alloc*1.15 = 1.15M → over_pace
    // (1.1625M > 1.15M); overrun day = ceil(1M / 37.5k) = 27 → 2026-08-27
    const b = mkBudget({ monthlyBudget: 1_000_000 });
    const r = pacing([mkTxn({ amount: 600_000, budgetCodeId: 'b' })], [b], TODAY);
    expect(r.elapsedDays).toBe(16);
    expect(r.daysInMonth).toBe(31);
    expect(r.items[0]).toMatchObject({ budgetCodeId: 'b', spent: 600_000, alloc: 1_000_000, projected: 1_162_500, verdict: 'over_pace', overrunDate: '2026-08-27' });
  });

  it('tight when alloc < projected <= alloc * 1.15; no overrunDate', () => {
    // spent 550k by day 16 → daily 34.375k → projected 1.065.625 (1.0M < p <= 1.15M) → tight
    const b = mkBudget({ monthlyBudget: 1_000_000 });
    const r = pacing([mkTxn({ amount: 550_000, budgetCodeId: 'b' })], [b], TODAY);
    expect(r.items[0]!.verdict).toBe('tight');
    expect(r.items[0]!.projected).toBe(1_065_625);
    expect(r.items[0]!.overrunDate).toBeUndefined();
  });

  it('over_pace when projected > alloc * 1.15; overrunDate projected forward', () => {
    // spent 900k by day 16 → daily 56.25k → projected 1.743.750 > 1.15M → over_pace
    // alloc/daily = 1M/56.25k = 17.78 → ceil 18 → 2026-08-18
    const b = mkBudget({ monthlyBudget: 1_000_000 });
    const r = pacing([mkTxn({ amount: 900_000, budgetCodeId: 'b' })], [b], TODAY);
    expect(r.items[0]!.verdict).toBe('over_pace');
    expect(r.items[0]!.overrunDate).toBe('2026-08-18');
  });

  it('already over alloc → over_pace regardless of projection', () => {
    const b = mkBudget({ monthlyBudget: 100_000 });
    const r = pacing([mkTxn({ amount: 150_000, budgetCodeId: 'b' })], [b], TODAY);
    expect(r.items[0]!.verdict).toBe('over_pace');
  });

  it('lowConfidence before day 5', () => {
    const b = mkBudget({});
    const r = pacing([mkTxn({ amount: 10_000, budgetCodeId: 'b' })], [b], '2026-08-02');
    expect(r.items[0]!.lowConfidence).toBe(true);
  });

  it('skips zero-alloc budgets; matches tx to budgets by budgetCodeId; ignores __none__', () => {
    const budgets = [mkBudget({ budgetCodeId: 'b1', monthlyBudget: 0 }), mkBudget({ budgetCodeId: 'b2', monthlyBudget: 500_000 })];
    const r = pacing([mkTxn({ amount: 100_000, budgetCodeId: 'b2' }), mkTxn({ amount: 50_000, budgetCodeId: undefined })], budgets, TODAY);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.spent).toBe(100_000);
  });

  it('income and transfer rows never count', () => {
    const b = mkBudget({});
    const r = pacing([
      mkTxn({ type: 'income', amount: 5_000_000, budgetCodeId: 'b' }),
      mkTxn({ type: 'transfer', amount: 2_000_000, budgetCodeId: 'b' }),
    ], [b], TODAY);
    expect(r.items[0]!.spent).toBe(0);
    expect(r.items[0]!.verdict).toBe('on_track');
  });
});
