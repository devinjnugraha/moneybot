import { bot } from './bot.js';
import { createExpenseCore } from '../agent/tools.js';
import { todayWIB } from '../domain/time.js';
import type { Repos } from '../repositories/interfaces.js';
import { logEvent } from '../utils/logger.js';

interface CallbackParts {
  recurringId: string;
  action: 'confirm' | 'defer' | 'skip';
}

function parseCallbackData(callbackData: string): CallbackParts | null {
  const parts = callbackData.split(':');
  if (parts.length !== 3 || parts[0] !== 'rec') return null;
  const action = parts[2];
  if (action !== 'confirm' && action !== 'defer' && action !== 'skip') return null;
  return { recurringId: parts[1]!, action };
}

export type CallbackActionResult =
  | { kind: 'answer'; text: string; alert?: boolean }
  | { kind: 'edit'; text: string }
  | { kind: 'answer_and_edit'; answerText: string; editText: string };

/**
 * Pure dispatch function — testable without grammY wiring.
 * Returns the actions to take; the caller applies them via ctx methods.
 */
export async function dispatchRecCallback(
  parsed: CallbackParts,
  chatId: string,
  repos: Repos,
): Promise<CallbackActionResult[]> {
  const user = await repos.users.findByTelegramChatId(chatId);
  if (!user) return [{ kind: 'answer', text: 'User tidak ditemukan.' }];

  const rp = await repos.recurrings.findById(user.userId, parsed.recurringId);
  if (!rp || !rp.isActive) {
    return [{ kind: 'answer', text: 'Tagihan ini sudah dihapus.', alert: true }];
  }

  switch (parsed.action) {
    case 'confirm': {
      // Idempotency: check lastFiredAt is already in current month
      if (rp.lastFiredAt) {
        const [y, m] = rp.lastFiredAt.split('-').map(Number) as [number, number];
        const today = todayWIB().split('-').map(Number) as [number, number, number];
        if (y === today[0] && m === today[1]) {
          return [{ kind: 'answer', text: 'Sudah diproses sebelumnya.', alert: true }];
        }
      }

      const result = await createExpenseCore({
        userId: user.userId,
        amount: rp.amount,
        description: rp.name,
        categoryId: rp.categoryId,
        accountId: rp.accountId,
        budgetCodeId: rp.budgetCodeId,
        date: todayWIB(),
        isRecurringInstance: true,
        recurringId: rp.recurringId,
        repos,
      });

      if (result.status === 'ok') {
        await repos.recurrings.update(user.userId, rp.recurringId, {
          lastFiredAt: todayWIB(),
        });
        return [
          { kind: 'answer', text: '✅ Dicatat!' },
          { kind: 'edit', text: `✅ ${rp.name} — ${rp.amount.toLocaleString('id-ID')} dicatat.` },
        ];
      }
      logEvent('error', 'callback confirm failed', { chatId, recurringId: rp.recurringId, error: result.status === 'error' ? result.message : 'unknown' });
      return [{ kind: 'answer', text: 'Gagal memproses. Coba lagi.', alert: true }];
    }

    case 'defer': {
      const session = await repos.sessions.get(chatId);
      await repos.sessions.set({
        chatId,
        userId: user.userId,
        turns: session?.turns ?? [],
        pendingRecurringConfirmation: {
          recurringId: rp.recurringId,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        lastActivityAt: new Date().toISOString(),
      });
      return [{ kind: 'answer', text: '⏳ Nanti diingatkan lagi 1 jam lagi.' }];
    }

    case 'skip': {
      await repos.recurrings.update(user.userId, rp.recurringId, {
        lastFiredAt: todayWIB(),
      });
      return [
        { kind: 'answer', text: '⏭️ Dilewati bulan ini.' },
        { kind: 'edit', text: `⏭️ ${rp.name} bulan ini dilewati.` },
      ];
    }
  }
}

export function registerCallbackHandler(repos: Repos): void {
  bot.callbackQuery(/^rec:.+/, async (ctx) => {
    const parsed = parseCallbackData(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCallbackQuery('Data callback tidak valid.');
      return;
    }

    const chatId = String(ctx.callbackQuery.message?.chat?.id ?? '');
    if (!chatId) {
      await ctx.answerCallbackQuery('Chat tidak ditemukan.');
      return;
    }

    const actions = await dispatchRecCallback(parsed, chatId, repos);
    for (const action of actions) {
      switch (action.kind) {
        case 'answer':
          await ctx.answerCallbackQuery({ text: action.text, show_alert: action.alert });
          break;
        case 'edit':
          await ctx.editMessageText(action.text);
          break;
        case 'answer_and_edit':
          await ctx.answerCallbackQuery(action.answerText);
          await ctx.editMessageText(action.editText);
          break;
      }
    }
  });
}
