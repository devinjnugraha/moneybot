import { describe, it, expect } from 'vitest';
import { scheduledSummaryTemplate, templateCompose } from '../../../src/proactive/composers/template.js';
import type { ProactivePayload } from '../../../src/proactive/types.js';

const summaryPayload = (data: Record<string, unknown>): ProactivePayload => ({
  triggerType: 'scheduled_summary',
  dedupKey: 'summary:2026-06-22',
  channel: 'template',
  data,
});

describe('scheduledSummaryTemplate', () => {
  it('formats total + top categories + budgets', () => {
    const out = scheduledSummaryTemplate(summaryPayload({
      date: '2026-06-22',
      totalSpend: 120000,
      topCategories: [
        { id: 'food.dining', name: 'Makan di Luar', icon: '🍜', amount: 80000 },
        { id: 'transport.ridehail', name: 'Ojek / Ride-hailing', icon: '🛵', amount: 40000 },
      ],
      budgets: [{ name: 'food', spent: 80000, alloc: 100000, pct: 0.8 }],
    }));
    expect(out).toContain('📊');
    expect(out).toContain('120.000');
    expect(out).toContain('Makan di Luar');
    expect(out).toContain('80.000');
    expect(out).toContain('food');
    // no currency symbol
    expect(out).not.toContain('Rp');
  });

  it('omits the budget block when there are no budgets', () => {
    const out = scheduledSummaryTemplate(summaryPayload({
      date: '2026-06-22', totalSpend: 50000,
      topCategories: [{ id: 'food.coffee', name: 'Kopi & Minuman', icon: '☕', amount: 50000 }],
      budgets: [],
    }));
    expect(out).toContain('50.000');
    expect(out).not.toContain('Budget');
  });
});

describe('templateCompose', () => {
  it('routes scheduled_summary to the summary template', () => {
    const out = templateCompose(summaryPayload({ date: '2026-06-22', totalSpend: 10000, topCategories: [], budgets: [] }));
    expect(out).toContain('10.000');
  });
});
