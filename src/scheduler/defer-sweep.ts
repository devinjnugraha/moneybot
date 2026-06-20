import { bot } from '../telegram/bot.js';
import { recurringPrompt } from '../telegram/formatter.js';
import type { Repos } from '../repositories/interfaces.js';
import { logEvent } from '../utils/logger.js';

/**
 * Sweep expired pendingRecurringConfirmation rows and re-prompt.
 * Each defer re-prompts at most once; a second defer sets a fresh expiresAt.
 * If the user ignores the re-prompt, no further auto-prompts that day.
 */
export async function sweepDeferredPayments(repos: Repos): Promise<void> {
  const expired = await repos.sessions.findExpiredDeferrals();

  for (const session of expired) {
    if (!session.pendingRecurringConfirmation) continue;

    const { recurringId } = session.pendingRecurringConfirmation;

    try {
      const rp = await repos.recurrings.findById(session.userId, recurringId);
      if (!rp || !rp.isActive) {
        // Recurring deleted since defer — just clear the state
        await repos.sessions.set({
          ...session,
          pendingRecurringConfirmation: undefined,
          lastActivityAt: new Date().toISOString(),
        });
        continue;
      }

      const account = await repos.accounts.findById(rp.userId, rp.accountId);
      const accountName = account?.name ?? rp.accountId;

      const { text, keyboard } = recurringPrompt(rp, accountName);
      await bot.api.sendMessage(session.chatId, text, { reply_markup: keyboard, parse_mode: 'HTML' });

      // Clear pending so this defers at most once
      await repos.sessions.set({
        ...session,
        pendingRecurringConfirmation: undefined,
        lastActivityAt: new Date().toISOString(),
      });

      logEvent('info', 'defer re-prompted', { userId: session.userId, chatId: session.chatId, recurringId });
    } catch (err) {
      logEvent('error', 'defer sweep failed', { userId: session.userId, recurringId, error: (err as Error).message });
    }
  }
}
