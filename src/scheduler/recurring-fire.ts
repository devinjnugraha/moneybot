import { bot } from '../telegram/bot.js';
import { recurringPrompt } from '../telegram/formatter.js';
import { wibYear, wibMonth, wibDay } from '../domain/time.js';
import type { Repos } from '../repositories/interfaces.js';

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
          console.error(`[recurring-fire] user not found for userId=${rp.userId}`);
          continue;
        }
        chatId = user.telegramChatId;
        chatIdCache.set(rp.userId, chatId);
      }

      const account = await repos.accounts.findById(rp.userId, rp.accountId);
      const accountName = account?.name ?? rp.accountId;

      const { text, keyboard } = recurringPrompt(rp, accountName);
      await bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
      console.log(`[recurring-fire] sent prompt for recurringId=${rp.recurringId} userId=${rp.userId}`);
    } catch (err) {
      console.error(`[recurring-fire] failed for recurringId=${rp.recurringId}`, err);
    }
  }
}
