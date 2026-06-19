import type { RecurringPayment } from '../domain/entities.js';
import type { InlineKeyboardMarkup } from '@grammyjs/types';

/** Format a number as IDR locale: dot as thousands separator, no currency symbol. */
export function formatIDR(n: number): string {
  return n.toLocaleString('id-ID');
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
