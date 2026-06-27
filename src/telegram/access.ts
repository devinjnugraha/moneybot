import type { Repos } from '../repositories/interfaces.js';
import type { AgentRunner } from '../agent/run-agent.js';
import type { User } from '../domain/entities.js';
import { handleMessage } from '../agent/orchestrator.js';
import { logEvent } from '../utils/logger.js';

/** Deterministic reply to any unapproved user (no user content; HTML-safe). */
export const BETA_PENDING_MESSAGE =
  '🚧 MoneyBot masih beta tertutup dan baru bisa dipakai pengguna yang sudah disetujui. ' +
  'Permintaan akses kamu sudah tercatat — mohon tunggu persetujuan ya. Terima kasih! 🙏';

/** First-message preview length sent to admins. */
const ADMIN_PREVIEW_LEN = 100;

/**
 * Plain-text notification sent to each admin when a user first requests access.
 * Plain text (no parse_mode) so a user-typed `<`/`&` cannot break rendering. The
 * embedded UPDATE is the entire approval UX — the operator runs it by hand.
 */
export function formatApprovalRequest(user: User, firstMessage: string): string {
  const preview = firstMessage.slice(0, ADMIN_PREVIEW_LEN);
  return (
    '🆕 Permintaan akses MoneyBot baru\n' +
    `🆔 Chat ID: ${user.telegramChatId}\n` +
    `💬 Pesan: "${preview}"\n\n` +
    'Untuk menyetujui, jalankan di DB:\n' +
    `UPDATE users SET status='approved' WHERE telegram_chat_id='${user.telegramChatId}';`
  );
}

export interface RouteMessageDeps {
  repos: Repos;
  run: AgentRunner;
  buildSystem: () => string;
  contextWindowTurns: number;
  sessionIdleTimeoutMinutes: number;
  adminChatIds: readonly string[];
  /** Wraps bot.api.sendMessage; injected so the gate is unit-testable without grammy. */
  notify: (adminChatId: string, text: string) => Promise<void>;
}

/** Best-effort: notify every admin. One bad admin chat id must not abort the rest. */
async function notifyAdmins(
  adminChatIds: readonly string[],
  user: User,
  firstMessage: string,
  notify: RouteMessageDeps['notify'],
): Promise<void> {
  const text = formatApprovalRequest(user, firstMessage);
  for (const adminChatId of adminChatIds) {
    try {
      await notify(adminChatId, text);
    } catch (err) {
      logEvent('error', 'admin notify failed', { adminChatId, error: (err as Error).message });
    }
  }
}

/**
 * Approval gate. Returns the reply text for a message. Unapproved users (no row,
 * pending, or rejected) get a deterministic canned reply and never reach the LLM.
 * First-touch users are persisted as `pending` and each admin is notified.
 * Approved users are delegated to the moneybot agent unchanged.
 */
export function routeMessage(
  deps: RouteMessageDeps,
): (text: string, chatId: string) => Promise<string> {
  return async (text, chatId) => {
    const user = await deps.repos.users.findByTelegramChatId(chatId);

    if (!user) {
      const created = await deps.repos.users.create({ telegramChatId: chatId, name: '' });
      await notifyAdmins(deps.adminChatIds, created, text, deps.notify);
      logEvent('info', 'access request', { chatId, userId: created.userId });
      return BETA_PENDING_MESSAGE;
    }

    if (user.status === 'approved') {
      const { reply } = await handleMessage({
        text,
        chatId,
        repos: deps.repos,
        run: deps.run,
        system: deps.buildSystem(),
        contextWindowTurns: deps.contextWindowTurns,
        sessionIdleTimeoutMinutes: deps.sessionIdleTimeoutMinutes,
      });
      return reply;
    }

    logEvent('info', 'access denied', { chatId, userId: user.userId, status: user.status });
    return BETA_PENDING_MESSAGE;
  };
}
