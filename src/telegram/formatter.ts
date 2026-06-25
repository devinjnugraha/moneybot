import type { RecurringPayment } from '../domain/entities.js';
import type { InlineKeyboardMarkup } from '@grammyjs/types';
import { formatIDR } from '../utils/format.js';

// Re-exported to preserve this module's public API after formatIDR moved to
// src/utils/format.ts (so the agent layer can use it without a transport import).
export { formatIDR };

/** A markdown table separator row: only `|`, `:`, `-`, and whitespace, with ≥1 `-`. */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  return t.includes('-') && /^[|:\s-]+$/.test(t);
}

/** A line that could be a table row (header or data): non-empty and contains `|`. */
function isTableRow(line: string): boolean {
  return line.trim().length > 0 && line.includes('|');
}

/** Split a table row into trimmed cells, tolerating an optional leading/trailing pipe. */
function parseRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * Convert markdown table blocks into Telegram-readable lines. Telegram's HTML
 * parse-mode has no table support, so a raw table renders as a wall of pipes.
 * Each block becomes a header line + one bullet (`•`) per data row, cells joined
 * by a middle dot (`·`); the separator row is dropped. Runs BEFORE the inline
 * markdown pass so inline bold and HTML escaping still apply to cell contents.
 */
function convertMarkdownTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const headerCells = parseRow(line);
      const rowCells: string[][] = [];
      i += 2; // skip header + separator
      while (i < lines.length && isTableRow(lines[i]!) && !isTableSeparator(lines[i]!)) {
        rowCells.push(parseRow(lines[i]!));
        i += 1;
      }
      out.push(
        [headerCells.join(' · '), ...rowCells.map((r) => '• ' + r.join(' · '))].join('\n'),
      );
    } else {
      out.push(line);
      i += 1;
    }
  }
  return out.join('\n');
}

/**
 * Convert LLM-generated Markdown formatting to Telegram HTML parse-mode tags.
 * Markdown tables are flattened first (Telegram can't render them), then HTML
 * entities are escaped, then inline markup is converted:
 *   **bold**   → <b>bold</b>
 *   *italic*   → <i>italic</i>
 *   `code`     → <code>code</code>
 *   [text](url) → <a href="url">text</a>
 */
export function markdownToTelegramHTML(text: string): string {
  return convertMarkdownTables(text)
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

/**
 * Build an inline keyboard with one row per due bill (morning glance). Each row
 * is [Catat][Tunda][Lewati] using the SAME rec:<id>:<action> format as
 * recurringPrompt, so callback-query.ts handles taps unchanged. When more than
 * one bill is due, each label is prefixed with the bill name to disambiguate.
 * Returns undefined when there are no due bills (plain-text glance, no keyboard).
 */
export function dueBillsKeyboard(
  bills: { recurringId: string; name: string }[],
): InlineKeyboardMarkup | undefined {
  if (bills.length === 0) return undefined;
  const multi = bills.length > 1;
  const rows = bills.map((b) => {
    const lbl = (t: string) => (multi ? `${b.name} ${t}` : t);
    return [
      { text: lbl('✅ Catat'), callback_data: `rec:${b.recurringId}:confirm` },
      { text: lbl('⏳ Tunda'), callback_data: `rec:${b.recurringId}:defer` },
      { text: lbl('⏭️ Lewati'), callback_data: `rec:${b.recurringId}:skip` },
    ];
  });
  return { inline_keyboard: rows };
}
