import type { Transaction } from '../entities.js';

export interface CashflowSummary {
  income: number;
  expense: number;
  net: number;
  savingsRate?: number; // integer %; undefined when income = 0 (spec §5)
}

/** Income vs expense over an already-range-filtered set. Transfers excluded. */
export function cashflowSummary(tx: Transaction[]): CashflowSummary {
  let income = 0;
  let expense = 0;
  for (const t of tx) {
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'expense') expense += t.amount;
  }
  const net = income - expense;
  return {
    income,
    expense,
    net,
    savingsRate: income > 0 ? Math.round((net / income) * 100) : undefined,
  };
}
