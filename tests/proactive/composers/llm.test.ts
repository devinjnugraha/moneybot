import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK's generateText BEFORE importing the module under test.
vi.mock('ai', () => ({ generateText: vi.fn() }));

import { generateText } from 'ai';
import { llmCompose } from '../../../src/proactive/composers/llm.js';
import type { ProactivePayload } from '../../../src/proactive/types.js';
import type { LanguageModel } from 'ai';

const payload: ProactivePayload = {
  triggerType: 'scheduled_summary',
  dedupKey: 'summary:2026-06-22',
  channel: 'llm',
  data: { date: '2026-06-22', totalSpend: 120000, topCategories: [], budgets: [] },
};
const fakeModel = {} as LanguageModel;

describe('llmCompose', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls generateText with the proactive system prompt + serialized payload', async () => {
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'Halo, hari ini...' });
    const out = await llmCompose(payload, fakeModel);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
        system: expect.stringContaining('MoneyBot'),
        prompt: expect.stringContaining('120000'),
      }),
    );
    expect(out).toBe('Halo, hari ini...');
  });

  it('propagates errors (the resolver handles fallback)', async () => {
    (generateText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rate limited'));
    await expect(llmCompose(payload, fakeModel)).rejects.toThrow('rate limited');
  });
});
