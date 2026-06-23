import type { RecurringPayment } from '../domain/entities.js';
import type { InlineKeyboardMarkup } from '@grammyjs/types';
import { formatIDR } from '../utils/format.js';

// Re-exported to preserve this module's public API after formatIDR moved to
// src/utils/format.ts (so the agent layer can use it without a transport import).
export { formatIDR };

/**
 * Convert LLM-generated Markdown formatting to Telegram HTML parse-mode tags.
 * Escapes bare HTML entities first, then converts:
 *   **bold**   → <b>bold</b>
 *   *italic*   → <i>italic</i>
 *   `code`     → <code>code</code>
 *   [text](url) → <a href="url">text</a>
 */
export function markdownToTelegramHTML(text: string): string {
  return text
    // Escape HTML entities first so literal <, >, & don't break parsing
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // **bold** → <b>bold</b>
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    // *italic* → <i>italic</i> (single-asterisk, after ** is already consumed)
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    // `code` → <code>code</code>
    .replace(/`(.+?)`/g, '<code>$1</code>')
    // [text](url) → <a href="url">text</a>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

/** Build the recurring-payment due prompt + inline keyboard (FR-09b). */
export function recurringPrompt(
  rp: RecurringPayment,
  accountName: string,
): { text: string; keyboard: InlineKeyboardMarkup } {
  const text =
    `🔔 Tagihan rutin jatuh tempo hari ini:\n` +
    `${rp.name} — ${formatIDR(rp.amount)} via ${accountName}\n\n` +
    `Mau aku catat sekarang?`;

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: '✅ Ya, catat', callback_data: `rec:${rp.recurringId}:confirm` },
        { text: '⏳ Tunda 1 jam', callback_data: `rec:${rp.recurringId}:defer` },
        { text: '⏭️ Lewati bulan ini', callback_data: `rec:${rp.recurringId}:skip` },
      ],
    ],
  };

  return { text, keyboard };
}
