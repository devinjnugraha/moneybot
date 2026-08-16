import { describe, it, expect } from 'vitest';
import { cashflowSummary } from '../../src/domain/analytics/cashflow.js';
import type { Transaction } from '../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

describe('cashflowSummary', () => {
  it('sums income/expense, excludes transfers, computes net + savings rate', () => {
    const r = cashflowSummary([
      mkTxn({ type: 'income', amount: 5_000_000 }),
      mkTxn({ amount: 3_000_000 }),
      mkTxn({ amount: 1_000_000 }),
      mkTxn({ type: 'transfer', amount: 2_000_000 }),
    ]);
    expect(r).toEqual({ income: 5_000_000, expense: 4_000_000, net: 1_000_000, savingsRate: 20 });
  });

  it('savingsRate undefined when income is 0 (never a fake -∞)', () => {
    const r = cashflowSummary([mkTxn({ amount: 500_000 })]);
    expect(r.savingsRate).toBeUndefined();
    expect(r.net).toBe(-500_000);
  });

  it('empty transactions → all zeros', () => {
    expect(cashflowSummary([])).toEqual({ income: 0, expense: 0, net: 0, savingsRate: undefined });
  });
});
