import { describe, it, expect } from 'vitest';
import { formatIDR, recurringPrompt, markdownToTelegramHTML, dueBillsKeyboard } from '../../src/telegram/formatter.js';
import type { RecurringPayment } from '../../src/domain/entities.js';
import type { InlineKeyboardButton } from '@grammyjs/types';

describe('formatIDR', () => {
  it('formats using Indonesian thousands separator', () => {
    expect(formatIDR(159_000)).toBe('159.000');
    expect(formatIDR(1_500_000)).toBe('1.500.000');
    expect(formatIDR(0)).toBe('0');
    expect(formatIDR(59_900)).toBe('59.900');
  });
});

describe('recurringPrompt', () => {
  const rp: RecurringPayment = {
    recurringId: 'rp-1',
    userId: 'u1',
    name: 'Spotify',
    amount: 59_900,
    accountId: 'a1',
    categoryId: 'entertainment.streaming',
    dayOfMonth: 25,
    isActive: true,
    nextFireAt: '2026-06-25',
    createdAt: '',
    updatedAt: '',
  };

  it('produces a prompt with name, formatted amount, and account', () => {
    const { text } = recurringPrompt(rp, 'BCA CC');
    expect(text).toContain('Spotify');
    expect(text).toContain('59.900');
    expect(text).toContain('BCA CC');
    expect(text).toContain('Mau aku catat sekarang?');
  });

  it('produces an inline keyboard with 3 buttons in a single row', () => {
    const { keyboard } = recurringPrompt(rp, 'BCA CC');
    const row = keyboard.inline_keyboard[0]!;
    expect(row).toHaveLength(3);
    const b0 = row[0] as InlineKeyboardButton.CallbackButton;
    const b1 = row[1] as InlineKeyboardButton.CallbackButton;
    const b2 = row[2] as InlineKeyboardButton.CallbackButton;
    expect(b0.text).toBe('✅ Ya, catat');
    expect(b0.callback_data).toBe('rec:rp-1:confirm');
    expect(b1.text).toBe('⏳ Tunda 1 jam');
    expect(b1.callback_data).toBe('rec:rp-1:defer');
    expect(b2.text).toBe('⏭️ Lewati bulan ini');
    expect(b2.callback_data).toBe('rec:rp-1:skip');
  });
});

describe('markdownToTelegramHTML', () => {
  it('converts **bold** to <b>bold</b>', () => {
    expect(markdownToTelegramHTML('**Bakso**'))
      .toBe('<b>Bakso</b>');
  });

  it('converts *italic* to <i>italic</i>', () => {
    expect(markdownToTelegramHTML('ini *miring* ya'))
      .toBe('ini <i>miring</i> ya');
  });

  it('handles both bold and italic in one string', () => {
    expect(markdownToTelegramHTML('**Bakso** — *enak*'))
      .toBe('<b>Bakso</b> — <i>enak</i>');
  });

  it('converts `code` to <code>code</code>', () => {
    expect(markdownToTelegramHTML('pakai `get_report` ya'))
      .toBe('pakai <code>get_report</code> ya');
  });

  it('converts [text](url) to <a> link', () => {
    expect(markdownToTelegramHTML('lihat [Google](https://google.com)'))
      .toBe('lihat <a href="https://google.com">Google</a>');
  });

  it('escapes HTML entities', () => {
    expect(markdownToTelegramHTML('a < b & c > d'))
      .toBe('a &lt; b &amp; c &gt; d');
  });

  it('escapes HTML before converting Markdown (no double-escape)', () => {
    expect(markdownToTelegramHTML('**hal < 5**'))
      .toBe('<b>hal &lt; 5</b>');
  });

  it('leaves plain text unchanged', () => {
    expect(markdownToTelegramHTML('Halo, apa kabar?'))
      .toBe('Halo, apa kabar?');
  });

  it('handles real agent output with multiple formats', () => {
    const agentOutput =
      '**Bakso** — 20.000 dibebankan ke akun **BCA** (kategori **Makan di Luar**).\n' +
      'Saldo BCA sekarang: 0 − 20.000 = −20.000.';
    const result = markdownToTelegramHTML(agentOutput);
    expect(result).toContain('<b>Bakso</b>');
    expect(result).toContain('<b>BCA</b>');
    expect(result).toContain('<b>Makan di Luar</b>');
    expect(result).not.toContain('**');
  });

  it('handles ** spanning across words', () => {
    expect(markdownToTelegramHTML('**Catatan Pengeluaran**'))
      .toBe('<b>Catatan Pengeluaran</b>');
  });
});

describe('dueBillsKeyboard', () => {
  it('returns undefined when there are no due bills', () => {
    expect(dueBillsKeyboard([])).toBeUndefined();
  });

  it('builds one row per bill with rec:<id>:<action> callbacks', () => {
    const kb = dueBillsKeyboard([
      { recurringId: 'r1', name: 'Spotify' },
      { recurringId: 'r2', name: 'Netflix' },
    ])!;
    expect(kb.inline_keyboard).toHaveLength(2);
    const row0 = kb.inline_keyboard[0]!.map((b) => (b as InlineKeyboardButton.CallbackButton).callback_data);
    expect(row0).toEqual(['rec:r1:confirm', 'rec:r1:defer', 'rec:r1:skip']);
    const row1 = kb.inline_keyboard[1]!.map((b) => (b as InlineKeyboardButton.CallbackButton).callback_data);
    expect(row1).toEqual(['rec:r2:confirm', 'rec:r2:defer', 'rec:r2:skip']);
  });

  it('prefixes button labels with the bill name when more than one bill is due', () => {
    const kb = dueBillsKeyboard([
      { recurringId: 'r1', name: 'Spotify' },
      { recurringId: 'r2', name: 'Netflix' },
    ])!;
    expect((kb.inline_keyboard[0]![0] as InlineKeyboardButton.CallbackButton).text).toContain('Spotify');
  });

  it('omits the name prefix when exactly one bill is due (matches recurringPrompt style)', () => {
    const kb = dueBillsKeyboard([{ recurringId: 'r1', name: 'Spotify' }])!;
    expect((kb.inline_keyboard[0]![0] as InlineKeyboardButton.CallbackButton).text).toBe('✅ Catat');
  });
});
