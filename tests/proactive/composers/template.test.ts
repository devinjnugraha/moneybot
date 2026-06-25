import { describe, it, expect } from 'vitest';
import { scheduledSummaryTemplate, budgetThresholdTemplate, loggingGapTemplate, anomalyTemplate, morningGlanceTemplate, templateCompose } from '../../../src/proactive/composers/template.js';
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

const anomalyPayload = (data: Record<string, unknown>): ProactivePayload => ({
  triggerType: 'anomaly',
  dedupKey: 'anomaly:2026-W26',
  channel: 'llm',
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

  it('routes anomaly to the anomaly template', () => {
    const out = templateCompose(anomalyPayload({
      week: '2026-W26',
      flagged: [{ category: 'c', name: 'X', icon: '📌', thisWeek: 50000, avg: 10000 }],
    }));
    expect(out).toContain('50.000');
  });
});

describe('anomalyTemplate', () => {
  it('lists flagged categories with thisWeek vs average', () => {
    const out = anomalyTemplate(anomalyPayload({
      week: '2026-W26',
      flagged: [{ category: 'food.dining', name: 'Makan di Luar', icon: '🍜', thisWeek: 300000, avg: 90000 }],
    }));
    expect(out).toContain('🚨');
    expect(out).toContain('Makan di Luar');
    expect(out).toContain('300.000');
    expect(out).toContain('90.000');
    expect(out).not.toContain('Rp');
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

describe('morningGlanceTemplate', () => {
  const morningPayload = (data: Record<string, unknown>): ProactivePayload => ({
    triggerType: 'morning_glance',
    dedupKey: 'morning-glance:2026-06-22',
    channel: 'llm',
    data,
  });

  it('renders balances, upcoming bills, due-today bills, and yesterday activity', () => {
    const out = templateCompose(morningPayload({
      balances: [{ name: 'BCA', type: 'bank', balance: 5_200_000 }],
      upcoming: [{ name: 'Spotify', amount: 59_900, account: 'BCA CC', dueDate: '2026-06-25' }],
      yesterday: { count: 2, totalSpend: 85_000 },
      todayDueBills: [{ name: 'Netflix', amount: 75_000, account: 'BCA CC' }],
    }));
    expect(out).toContain('BCA');
    expect(out).toContain('5.200.000');
    expect(out).toContain('Spotify');
    expect(out).toContain('Netflix');
    expect(out).toContain('75.000');
    expect(out).toContain('2 catatan');
    expect(out).not.toContain('Rp');
  });

  it('notes the logging gap when yesterday had no expenses', () => {
    const out = morningGlanceTemplate(morningPayload({
      balances: [{ name: 'Cash', type: 'cash', balance: 300_000 }],
      upcoming: [], yesterday: null, todayDueBills: [],
    }));
    expect(out).toContain('belum ada catatan');
  });
});
