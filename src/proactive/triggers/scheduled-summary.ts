import { CATEGORIES } from '../../domain/categories.js';
import { todayWIB, wibYear, wibMonth } from '../../domain/time.js';
import type { Detector, ProactivePayload } from '../types.js';

// Static taxonomy lookup (categories are system-seeded, not user-editable).
const NAME_BY_ID = new Map(CATEGORIES.map((c) => [c.categoryId, c]));

interface SummaryCategory {
  id: string;
  name: string;
  icon: string;
  amount: number;
}
interface SummaryBudget {
  name: string;
  spent: number;
  alloc: number;
  pct: number;
}

/**
 * Daily spending summary detector (design SS9.1). Returns `[]` when nothing was
 * spent today. Transfers and income are excluded; only expenses are totaled.
 */
export const detectScheduledSummary: Detector = async ({ userId, repos, now }) => {
  const date = todayWIB(now);
  const txns = await repos.transactions.findByDateRange(userId, date, date);
  const expenses = txns.filter((t) => t.type === 'expense');
  if (expenses.length === 0) return [];

  const totalSpend = expenses.reduce((sum, t) => sum + t.amount, 0);

  const byCategory = new Map<string, number>();
  for (const t of expenses) {
    const key = t.categoryId ?? 'other.misc';
    byCategory.set(key, (byCategory.get(key) ?? 0) + t.amount);
  }
  const topCategories: SummaryCategory[] = [...byCategory.entries()]
    .map(([id, amount]) => {
      const cat = NAME_BY_ID.get(id);
      return { id, name: cat?.name ?? id, icon: cat?.icon ?? '📌', amount };
    })
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);

  const codes = await repos.budgets.findByUserAndMonth(userId, wibYear(now), wibMonth(now));
  const budgets: SummaryBudget[] = codes.map((c) => ({
    name: c.name,
    spent: c.spent,
    alloc: c.monthlyBudget,
    pct: c.monthlyBudget > 0 ? c.spent / c.monthlyBudget : 0,
  }));

  const payload: ProactivePayload = {
    triggerType: 'scheduled_summary',
    dedupKey: `summary:${date}`,
    channel: 'llm',
    data: { date, totalSpend, topCategories, budgets },
  };
  return [payload];
};
