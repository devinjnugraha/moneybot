import type { Account, RecurringPayment } from '../entities.js';
import { addDays } from '../time.js';

export interface ObligationItem {
  name: string;
  amount: number;
  dueDate: string;
  kind: 'recurring' | 'card';
}

export type CoverageVerdict = 'covered' | 'tight' | 'short';

export interface ObligationsResult {
  horizonEnd: string;
  items: ObligationItem[];
  liquidBalance: number;
  totalDue: number;
  verdict: CoverageVerdict;
  shortfall?: number;
}

/** Default lookahead (spec §2.1): next 30 days of bills. */
const DEFAULT_HORIZON_DAYS = 30;
/** tight = liquid still covers >= this fraction of totalDue (spec §2.1). */
const TIGHT_FLOOR = 0.5;

/** Next-`horizonDays` obligations vs liquid (cash+bank) balance (spec §2.1). */
export function obligations(input: {
  recurrings: RecurringPayment[];
  accounts: Account[];
  cardDues: { name: string; amount: number; dueDate: string }[];
  today: string;
  horizonDays?: number;
}): ObligationsResult {
  const horizonDays = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const horizonEnd = addDays(input.today, horizonDays);

  const items: ObligationItem[] = [];
  for (const r of input.recurrings) {
    if (!r.isActive) continue;
    if (r.nextFireAt > input.today && r.nextFireAt <= horizonEnd) {
      items.push({ name: r.name, amount: r.amount, dueDate: r.nextFireAt, kind: 'recurring' });
    }
  }
  for (const c of input.cardDues) {
    if (c.amount > 0 && c.dueDate <= horizonEnd) {
      items.push({ name: c.name, amount: c.amount, dueDate: c.dueDate, kind: 'card' });
    }
  }
  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const liquidBalance = input.accounts
    .filter((a) => a.isActive && (a.type === 'cash' || a.type === 'bank'))
    .reduce((s, a) => s + a.balance, 0);
  const totalDue = items.reduce((s, i) => s + i.amount, 0);

  let verdict: CoverageVerdict = 'covered';
  if (totalDue > 0 && liquidBalance < totalDue) {
    verdict = liquidBalance >= totalDue * TIGHT_FLOOR ? 'tight' : 'short';
  }

  return {
    horizonEnd,
    items,
    liquidBalance,
    totalDue,
    verdict,
    shortfall: Math.max(0, totalDue - liquidBalance) || undefined,
  };
}
