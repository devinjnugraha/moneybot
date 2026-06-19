import { describe, it, expect } from 'vitest';
import { formatIDR, recurringPrompt } from '../../src/telegram/formatter.js';
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
