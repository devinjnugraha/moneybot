import type { Repos } from '../repositories/interfaces.js';
import { wibYear, wibMonth } from '../domain/time.js';
import { logEvent } from '../utils/logger.js';

/**
 * Roll every user's recurring budgets into the current WIB month. Per-user
 * errors are logged and skipped so one failure never blocks the rest. Driven by
 * the daily BUDGET_ROLLOVER_CRON and by a one-shot reconcile on boot.
 */
export async function sweepBudgetRollover(repos: Repos, now: Date = new Date()): Promise<void> {
  const year = wibYear(now);
  const month = wibMonth(now);
  const users = await repos.users.findAll();
  let totalCreated = 0;
  for (const user of users) {
    try {
      const created = await repos.budgets.rollRecurringIntoMonth(user.userId, year, month);
      if (created > 0) {
        logEvent('info', 'budget rollover created', { userId: user.userId, year, month, created });
      }
      totalCreated += created;
    } catch (err) {
      logEvent('error', 'budget rollover failed for user', {
        userId: user.userId, year, month, error: (err as Error).message,
      });
    }
  }
  if (totalCreated > 0) {
    logEvent('info', 'budget rollover sweep complete', { year, month, users: users.length, totalCreated });
  }
}
