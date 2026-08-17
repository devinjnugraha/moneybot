import type { BudgetCode, Transaction } from '../entities.js';
import { addDays, lastDayOfMonth } from '../time.js';

export type PacingVerdict = 'on_track' | 'tight' | 'over_pace';

export interface BudgetPacing {
  budgetCodeId: string;
  name: string;
  spent: number;
  alloc: number;
  projected: number;
  verdict: PacingVerdict;
  overrunDate?: string;
  lowConfidence: boolean;
}

export interface PacingResult {
  asOf: string;
  elapsedDays: number;
  daysInMonth: number;
  items: BudgetPacing[];
}

/** Verdict thresholds (spec §2.1): over when projected beats alloc by >15%. */
const OVER_TIGHT_RATIO = 1.15;
/** Projections before this elapsed day are low-confidence (spec §5). */
const MIN_CONFIDENT_DAYS = 5;

/**
 * Run-rate pacing for one month (spec §2.1). `tx` = that month's transactions
 * (any range); `budgets` = that month's budget rows. `spent` is derived from
 * `tx` (self-corrects after soft-deletes/backdating), never from budgets[].spent.
 */
export function pacing(tx: Transaction[], budgets: BudgetCode[], today: string): PacingResult {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const elapsedDays = Number(today.slice(8, 10));
  const daysInMonth = lastDayOfMonth(year, month);
  const monthStart = `${today.slice(0, 7)}-01`;

  const spentByBudget = new Map<string, number>();
  for (const t of tx) {
    if (t.type !== 'expense' || !t.budgetCodeId) continue;
    spentByBudget.set(t.budgetCodeId, (spentByBudget.get(t.budgetCodeId) ?? 0) + t.amount);
  }

  const items: BudgetPacing[] = [];
  for (const b of budgets) {
    if (b.monthlyBudget <= 0) continue;
    const spent = spentByBudget.get(b.budgetCodeId) ?? 0;
    const dailyRate = spent / elapsedDays;
    const projected = Math.round(dailyRate * daysInMonth);

    let verdict: PacingVerdict = 'on_track';
    if (spent > b.monthlyBudget || projected > b.monthlyBudget * OVER_TIGHT_RATIO) verdict = 'over_pace';
    else if (projected > b.monthlyBudget) verdict = 'tight';

    const item: BudgetPacing = {
      budgetCodeId: b.budgetCodeId,
      name: b.name,
      spent,
      alloc: b.monthlyBudget,
      projected,
      verdict,
      lowConfidence: elapsedDays < MIN_CONFIDENT_DAYS,
    };
    if (verdict === 'over_pace' && dailyRate > 0) {
      const daysToOverrun = Math.ceil(b.monthlyBudget / dailyRate);
      const raw = addDays(monthStart, daysToOverrun - 1);
      const monthEnd = `${today.slice(0, 7)}-${String(daysInMonth).padStart(2, '0')}`;
      item.overrunDate = raw > monthEnd ? monthEnd : raw;
    }
    items.push(item);
  }

  return { asOf: today, elapsedDays, daysInMonth, items };
}
