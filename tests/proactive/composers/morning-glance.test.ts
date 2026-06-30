import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));

const generateText = vi.fn();
vi.mock('ai', () => ({ generateText: (...args: unknown[]) => generateText(...args) }));

import { createMorningGlanceComposer } from '../../../src/proactive/composers/morning-glance.js';
import { buildMorningGlanceSystemPrompt } from '../../../src/proactive/prompt.js';
import type { ProactivePayload } from '../../../src/proactive/types.js';

const model = {} as never;
const payload = (over: {
  balances?: object[];
  upcoming?: object[];
  yesterday?: { count: number; totalSpend: number } | null;
  todayDueBills?: object[];
  budgets?: object[];
} = {}): ProactivePayload => ({
  triggerType: 'morning_glance',
  dedupKey: 'morning-glance:2026-06-22',
  channel: 'llm',
  data: {
    balances: over.balances ?? [],
    upcoming: over.upcoming ?? [],
    yesterday: over.yesterday ?? null,
    todayDueBills: over.todayDueBills ?? [],
    budgets: over.budgets ?? [],
  },
});

describe('createMorningGlanceComposer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('appends the deterministic block + CTA to LLM prose and keeps the keyboard', async () => {
    generateText.mockResolvedValue({ text: '🌅 Pagi, Devin!' });
    const compose = createMorningGlanceComposer(model);
    const out = await compose(payload({
      balances: [{ name: 'BCA', balance: 5_200_000 }],
      yesterday: { count: 2, totalSpend: 85_000 },
      todayDueBills: [{ recurringId: 'r1', name: 'Spotify', amount: 59_900, account: 'BCA CC' }],
    }), { now: new Date('2026-06-22T14:00:00Z') });
    const o = out as { text: string; replyMarkup?: { inline_keyboard: unknown[][] } };
    // prose first
    expect(o.text.startsWith('🌅 Pagi, Devin!')).toBe(true);
    // deterministic block appended
    expect(o.text).toContain('🏦 Saldo\n• BCA 5.200.000');
    // CTA last
    expect(o.text.endsWith('Tagihan hari ini tinggal dipencet di bawah ya 👇')).toBe(true);
    // keyboard still built from todayDueBills
    expect(o.replyMarkup?.inline_keyboard).toHaveLength(1);
  });

  it('omits the CTA and keyboard when there are no due bills', async () => {
    generateText.mockResolvedValue({ text: '🌅 Pagi tenang!' });
    const compose = createMorningGlanceComposer(model);
    const out = await compose(payload({ todayDueBills: [] }), { now: new Date('2026-06-22T14:00:00Z') });
    const o = out as { text: string; replyMarkup?: unknown };
    expect(o.replyMarkup).toBeUndefined();
    expect(o.text).not.toContain('dipencet');
  });

  it('sends only { yesterday } to the model, not balances/budgets', async () => {
    generateText.mockResolvedValue({ text: '🌅 Pagi!' });
    const compose = createMorningGlanceComposer(model);
    await compose(payload({
      balances: [{ name: 'BCA', balance: 5_200_000 }],
      budgets: [{ name: 'Makan', spent: 1, alloc: 2, remaining: 1, pct: 0.5 }],
      yesterday: { count: 1, totalSpend: 10_000 },
      todayDueBills: [],
    }), { now: new Date('2026-06-22T14:00:00Z') });
    expect(generateText).toHaveBeenCalledTimes(1);
    const call = (generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain('Kemarin');
    expect(call.prompt).not.toContain('BCA');
    expect(call.prompt).not.toContain('Makan');
  });

  it('injects today\'s WIB date into the morning-glance system prompt', async () => {
    generateText.mockResolvedValue({ text: '🌅 Pagi!' });
    const compose = createMorningGlanceComposer(model);
    // 2026-06-28T03:00:00Z -> 10:00 WIB, Sunday 28 Jun 2026.
    await compose(payload(), { now: new Date('2026-06-28T03:00:00Z') });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ system: expect.stringContaining('Hari ini (WIB): Minggu, 28 Jun 2026') }),
    );
  });

  it('falls back to the full template when generateText throws', async () => {
    generateText.mockRejectedValue(new Error('model down'));
    const compose = createMorningGlanceComposer(model);
    const out = await compose(payload({
      balances: [{ name: 'BCA', balance: 1_000_000 }],
      yesterday: null,
      todayDueBills: [],
    }), { now: new Date('2026-06-22T14:00:00Z') });
    const o = out as { text: string };
    expect(o.text).toContain('🌅 Pagi!');
    expect(o.text).toContain('🏦 Saldo'); // deterministic block rendered by fallback too
  });
});

describe('buildMorningGlanceSystemPrompt', () => {
  it('keeps the WIB date anchor and scopes the LLM to greeting + yesterday only', () => {
    const p = buildMorningGlanceSystemPrompt('Minggu, 28 Jun 2026');
    expect(p).toContain('Hari ini (WIB): Minggu, 28 Jun 2026');
    expect(p).toContain('sapaan pagi'); // greeting instruction
    expect(p).toContain('kemarin'); // yesterday instruction
    // must NOT instruct the LLM to render saldo/budget/tagihan (deterministic now)
    expect(p).not.toContain('sebutkan saldo');
    expect(p).not.toContain('Sebutkan tagihan');
    // pin the load-bearing NEW scope text (not just the old wording's absence)
    expect(p).toContain('HANYA menulis dua baris');
    expect(p).toContain('Jangan menyebut saldo, budget, atau tagihan');
  });
});
