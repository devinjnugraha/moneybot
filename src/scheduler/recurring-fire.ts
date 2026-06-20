import { bot } from '../telegram/bot.js';
import { recurringPrompt } from '../telegram/formatter.js';
import { wibYear, wibMonth, wibDay } from '../domain/time.js';
import type { Repos } from '../repositories/interfaces.js';
import { logEvent } from '../utils/logger.js';

/** Fire recurring payment prompts for all due payments today (WIB). */
export async function fireRecurringPayments(repos: Repos): Promise<void> {
  const year = wibYear();
  const month = wibMonth();
  const day = wibDay();
  const due = await repos.recurrings.findDueToday(year, month, day);

  const chatIdCache = new Map<string, string>();

  for (const rp of due) {
    try {
      let chatId = chatIdCache.get(rp.userId);
      if (!chatId) {
        const user = await repos.users.findById(rp.userId);
        if (!user) {
          logEvent('error', 'user not found for recurring payment', { userId: rp.userId, recurringId: rp.recurringId });
          continue;
        }
        chatId = user.telegramChatId;
        chatIdCache.set(rp.userId, chatId);
      }

      const account = await repos.accounts.findById(rp.userId, rp.accountId);
      const accountName = account?.name ?? rp.accountId;

      const { text, keyboard } = recurringPrompt(rp, accountName);
      await bot.api.sendMessage(chatId, text, { reply_markup: keyboard, parse_mode: 'HTML' });
      logEvent('info', 'recurring prompt sent', { userId: rp.userId, recurringId: rp.recurringId, chatId });
    } catch (err) {
      logEvent('error', 'recurring prompt failed', { userId: rp.userId, recurringId: rp.recurringId, error: (err as Error).message });
    }
  }
}
