import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', () => ({ generateText: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));

import { generateText } from 'ai';
import { logEvent } from '../../../src/utils/logger.js';
import { createComposer } from '../../../src/proactive/composers/resolve.js';
import type { LanguageModel } from 'ai';

const fakeModel = {} as LanguageModel;

describe('createComposer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the template composer for channel "template"', async () => {
    const composer = createComposer(fakeModel);
    const out = await composer(
      {
        triggerType: 'scheduled_summary', dedupKey: 'summary:2026-06-22', channel: 'template',
        data: { date: '2026-06-22', totalSpend: 9000, topCategories: [], budgets: [] },
      },
      { now: new Date('2026-06-22T14:00:00Z') },
    );
    expect(out).toContain('9.000');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('uses the LLM composer for channel "llm" when it succeeds', async () => {
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'LLM compose OK' });
    const composer = createComposer(fakeModel);
    const out = await composer(
      { triggerType: 'scheduled_summary', dedupKey: 'x', channel: 'llm', data: {} },
      { now: new Date('2026-06-22T14:00:00Z') },
    );
    expect(out).toBe('LLM compose OK');
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('falls back to the template composer when the LLM call throws', async () => {
    (generateText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const composer = createComposer(fakeModel);
    const out = await composer(
      {
        triggerType: 'scheduled_summary', dedupKey: 'x', channel: 'llm',
        data: { date: '2026-06-22', totalSpend: 7000, topCategories: [], budgets: [] },
      },
      { now: new Date('2026-06-22T14:00:00Z') },
    );
    expect(out).toContain('7.000'); // template fallback ran
    expect(logEvent).toHaveBeenCalledWith('warn', expect.any(String), expect.objectContaining({ error: 'boom' }));
  });
});
