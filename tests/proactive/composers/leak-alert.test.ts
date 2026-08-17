import { describe, it, expect, vi } from 'vitest';
import { generateText } from 'ai';
import { createLeakAlertComposer } from '../../../src/proactive/composers/leak-alert.js';

vi.mock('ai', () => ({ generateText: vi.fn(async () => ({ text: 'prose line' })) }));
const model = {} as never;

const payload = {
  triggerType: 'leak_alert' as const,
  dedupKey: 'k',
  channel: 'llm' as const,
  data: {
    week: '2026-W34',
    spikes: [{ label: 'kopi kenangan', current: 250_000, previous: 100_000, deltaPct: 150, countCurrent: 2, countPrevious: 2 }],
    recurring: [{ name: 'spotify', amount: 54_000, kind: 'new' as const }, { name: 'netflix', amount: 100_000, kind: 'dormant' as const }],
    recurringTotal: 154_000,
  },
};

describe('createLeakAlertComposer', () => {
  it('renders deterministic blocks + one LLM prose line', async () => {
    const compose = createLeakAlertComposer(model);
    const out = await compose(payload, { now: new Date('2026-08-18T02:00:00Z') });
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('🔎 Kemungkinan bocoran');
    expect(text).toContain('kopi kenangan: 250.000 (+150% dari 100.000)');
    expect(text).toContain('🆕 Langganan baru: spotify (54.000)');
    expect(text).toContain('💤 Sepertinya nggak kepake: netflix (100.000)');
    expect(text).toContain('prose line');
  });

  it('LLM failure → deterministic blocks only (never throws)', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error('boom'));
    const compose = createLeakAlertComposer(model);
    const out = await compose(payload, { now: new Date('2026-08-18T02:00:00Z') });
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('kopi kenangan');
    expect(text).not.toContain('prose line');
  });
});
