import { describe, it, expect } from 'vitest';
import { scheduledSummaryTemplate, budgetThresholdTemplate, loggingGapTemplate, templateCompose } from '../../../src/proactive/composers/template.js';
import type { ProactivePayload } from '../../../src/proactive/types.js';

const summaryPayload = (data: Record<string, unknown>): ProactivePayload => ({
  triggerType: 'scheduled_summary',
  dedupKey: 'summary:2026-06-22',
  channel: 'template',
  data,
});

const budgetPayload = (data: Record<string, unknown>): ProactivePayload => ({
  triggerType: 'budget_threshold',
  dedupKey: 'budget:b1:2026-06:pct80',
  channel: 'template',
  data,
});

const gapPayload = (data: Record<string, unknown>): ProactivePayload => ({
  triggerType: 'logging_gap',
  dedupKey: 'gap:2026-06-22',
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

  it('routes logging_gap to the gap template', () => {
    const out = templateCompose(gapPayload({ gapDays: 3, lastDate: '2026-06-19' }));
    expect(out).toContain('3 hari');
  });
});

describe('loggingGapTemplate', () => {
  it('formats a friendly gap nudge with the day count', () => {
    const out = loggingGapTemplate(gapPayload({ gapDays: 2, lastDate: '2026-06-20' }));
    expect(out).toContain('2 hari');
    expect(out).toContain('ga ada catatan');
    expect(out).not.toContain('Rp');
  });
});

describe('budgetThresholdTemplate', () => {
  it('formats a warning with name, pct, spent/alloc at level 80', () => {
    const out = budgetThresholdTemplate(budgetPayload({
      codeId: 'b1', name: 'food', spent: 1_640_000, alloc: 2_000_000, pct: 0.82, level: 80,
    }));
    expect(out).toContain('⚠️');
    expect(out).toContain('food');
    expect(out).toContain('82%');
    expect(out).toContain('1.640.000');
    expect(out).toContain('2.000.000');
    expect(out).not.toContain('Rp');
  });

  it('escalates to over-budget wording at level 100', () => {
    const out = budgetThresholdTemplate(budgetPayload({
      codeId: 'b1', name: 'food', spent: 2_100_000, alloc: 2_000_000, pct: 1.05, level: 100,
    }));
    expect(out).toContain('🚨');
    expect(out).toContain('105%');
  });
});
