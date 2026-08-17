import { describe, it, expect, vi } from 'vitest';
import { generateText } from 'ai';
import { createHealthDigestComposer } from '../../../src/proactive/composers/health-digest.js';

vi.mock('ai', () => ({ generateText: vi.fn(async () => ({ text: 'prose paragraph' })) }));
const model = {} as never;

const payload = {
  triggerType: 'health_digest' as const,
  dedupKey: 'k',
  channel: 'llm' as const,
  data: {
    month: '2026-07',
    score: 78,
    components: [
      { key: 'savings_rate', label: 'Rasio tabungan', value: 24, display: '24%', status: 'good', note: 'rata-rata 3 bulan' },
      { key: 'runway', label: 'Dana darurat', value: 1.2, display: '1.2 bulan', status: 'warn' },
    ],
    prevScore: 71,
    prevStatuses: { savings_rate: 'warn', runway: 'warn' },
  },
};

describe('createHealthDigestComposer', () => {
  it('renders score line + per-component status blocks + LLM prose', async () => {
    const compose = createHealthDigestComposer(model);
    const out = await compose(payload, { now: new Date('2026-08-01T01:30:00Z') });
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('🩺 Skor keuangan Juli 2026: 78/100');
    expect(text).toContain('✅ Rasio tabungan: 24%');
    expect(text).toContain('⚠️ Dana darurat: 1.2 bulan');
    expect(text).toContain('prose paragraph');
  });

  it('LLM failure → blocks only', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error('boom'));
    const compose = createHealthDigestComposer(model);
    const out = await compose(payload, { now: new Date('2026-08-01T01:30:00Z') });
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('78/100');
    expect(text).not.toContain('prose paragraph');
  });
});
