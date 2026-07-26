import type { Repos } from '../repositories/interfaces.js';
import { logEvent } from '../utils/logger.js';

/**
 * Ensure every user's active card (with a billing day) has statement rows for
 * all ended billing cycles up to `now`. Per-user and per-account errors are
 * logged and skipped so one failure never blocks the rest. Driven by the daily
 * BUDGET_ROLLOVER_CRON and a one-shot reconcile on boot (mirrors budget rollover).
 */
export async function sweepCardStatements(repos: Repos, now: Date = new Date()): Promise<void> {
  const users = await repos.users.findAll();
  for (const user of users) {
    try {
      const accounts = await repos.accounts.findAllByUserId(user.userId);
      const cards = accounts.filter((a) => a.type === 'card' && a.billingDay != null);
      for (const card of cards) {
        try {
          const created = await repos.cardStatements.ensureEndedCycles(
            user.userId, card.accountId, card.billingDay as number, card.createdAt, now,
          );
          if (created > 0) {
            logEvent('info', 'card statements ensured', { userId: user.userId, accountId: card.accountId, created });
          }
        } catch (err) {
          logEvent('error', 'card statement ensure failed for account', {
            userId: user.userId, accountId: card.accountId, error: (err as Error).message,
          });
        }
      }
    } catch (err) {
      logEvent('error', 'card statement sweep failed for user', {
        userId: user.userId, error: (err as Error).message,
      });
    }
  }
}
