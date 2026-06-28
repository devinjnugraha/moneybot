import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));

const generateText = vi.fn();
vi.mock('ai', () => ({ generateText: (...args: unknown[]) => generateText(...args) }));

import { createMorningGlanceComposer } from '../../../src/proactive/composers/morning-glance.js';
import type { ProactivePayload } from '../../../src/proactive/types.js';

const model = {} as never;
const payload = (todayDueBills: { recurringId: string; name: string }[]): ProactivePayload => ({
  triggerType: 'morning_glance',
  dedupKey: 'morning-glance:2026-06-22',
  channel: 'llm',
  data: { balances: [], upcoming: [], yesterday: null, todayDueBills },
});

describe('createMorningGlanceComposer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns LLM text plus a keyboard built from todayDueBills', async () => {
    generateText.mockResolvedValue({ text: 'Pagi!' });
    const compose = createMorningGlanceComposer(model);
    const out = await compose(payload([{ recurringId: 'r1', name: 'Spotify' }]), { now: new Date('2026-06-22T14:00:00Z') });
    expect(typeof out).toBe('object');
    const o = out as { text: string; replyMarkup?: { inline_keyboard: unknown[][] } };
    expect(o.text).toBe('Pagi!');
    expect(o.replyMarkup?.inline_keyboard).toHaveLength(1);
  });

  it('omits replyMarkup when there are no due bills', async () => {
    generateText.mockResolvedValue({ text: 'Pagi tenang!' });
    const compose = createMorningGlanceComposer(model);
    const out = await compose(payload([]), { now: new Date('2026-06-22T14:00:00Z') });
    expect((out as { replyMarkup?: unknown }).replyMarkup).toBeUndefined();
  });

  it('injects today\'s WIB date into the morning-glance system prompt', async () => {
    generateText.mockResolvedValue({ text: 'Pagi!' });
    const compose = createMorningGlanceComposer(model);
    // 2026-06-28T03:00:00Z -> 10:00 WIB, Sunday 28 Jun 2026.
    await compose(payload([]), { now: new Date('2026-06-28T03:00:00Z') });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ system: expect.stringContaining('Hari ini (WIB): Minggu, 28 Jun 2026') }),
    );
  });

  it('falls back to the template when generateText throws', async () => {
    generateText.mockRejectedValue(new Error('model down'));
    const compose = createMorningGlanceComposer(model);
    const out = await compose(payload([]), { now: new Date('2026-06-22T14:00:00Z') });
    expect((out as { text: string }).text).toContain('Pagi');
  });
});
