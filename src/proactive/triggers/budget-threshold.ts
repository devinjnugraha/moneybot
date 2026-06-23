import { wibYear, wibMonth } from '../../domain/time.js';
import type { Detector, ProactivePayload } from '../types.js';

/**
 * Build a budget-threshold detector (design §9.2). `levels` are the pct crossing
 * points (e.g. [80,100]); one payload is emitted per level a code has reached
 * this month. The (user, dedup_key) unique index caps each level at one nudge per
 * code per month, so a code sitting at 105% only notifies at pct80 once and at
 * pct100 once across the whole month.
 */
export function createBudgetThresholdDetector(levels: readonly number[]): Detector {
  const sorted = [...levels].sort((a, b) => a - b);
  return async ({ userId, repos, now }) => {
    const year = wibYear(now);
    const month = wibMonth(now);
    const monthTag = `${year}-${String(month).padStart(2, '0')}`;

    const codes = await repos.budgets.findByUserAndMonth(userId, year, month);
    const payloads: ProactivePayload[] = [];

    for (const code of codes) {
      const alloc = code.monthlyBudget;
      if (alloc <= 0) continue; // no budget set; nothing meaningful to flag
      for (const level of sorted) {
        // Cross-multiply to avoid float error at the exact threshold boundary.
        if (code.spent * 100 < level * alloc) continue;
        payloads.push({
          triggerType: 'budget_threshold',
          dedupKey: `budget:${code.budgetCodeId}:${monthTag}:pct${level}`,
          channel: 'template',
          data: {
            codeId: code.budgetCodeId,
            name: code.name,
            spent: code.spent,
            alloc,
            pct: code.spent / alloc, // actual fraction for display
            level,
          },
        });
      }
    }
    return payloads;
  };
}
