import { describe, it, expect } from 'vitest';
import { scheduledSummaryTemplate, budgetThresholdTemplate, loggingGapTemplate, anomalyTemplate, morningGlanceTemplate, templateCompose, renderBudgetBar, renderAccountList, renderBudgetBlock } from '../../../src/proactive/composers/template.js';
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

describe('renderBudgetBar', () => {
  it('wraps the bar in backticks so Telegram renders it monospace', () => {
    expect(renderBudgetBar(0.75)).toMatch(/^`/);
    expect(renderBudgetBar(0.75)).toMatch(/`$/);
  });

  it('places the bullet proportionally and keeps a fixed inner width of 10', () => {
    // 0%   -> bullet at far left
    expect(renderBudgetBar(0)).toBe('`|•——————————|`');
    // 50%  -> 5 dashes, bullet, 5 dashes
    expect(renderBudgetBar(0.5)).toBe('`|—————•—————|`');
    // 100% -> bullet at far right
    expect(renderBudgetBar(1)).toBe('`|——————————•|`');
  });

  it('clamps the bullet at the right edge when over budget', () => {
    expect(renderBudgetBar(1.2)).toBe('`|——————————•|`');
  });

  it('always has exactly 10 inner cells (pipes excluded)', () => {
    for (const pct of [0, 0.12, 0.3, 0.5, 0.75, 0.99, 1, 1.5]) {
      const inner = renderBudgetBar(pct).slice(2, -2); // strip backtick + pipe on each side
      expect(inner).toHaveLength(11); // 10 cells + 1 bullet
      expect([...inner].filter((c) => c === '—').length + 1).toBe(11); // dashes + the bullet
    }
  });
});

describe('renderAccountList', () => {
  it('renders one bullet per account under a Saldo header', () => {
    const out = renderAccountList([
      { name: 'BCA', balance: 5_200_000 },
      { name: 'GoPay', balance: 450_000 },
    ]);
    expect(out).toBe('🏦 Saldo\n• BCA 5.200.000\n• GoPay 450.000');
  });

  it('returns empty string when there are no accounts', () => {
    expect(renderAccountList([])).toBe('');
  });
});

describe('renderBudgetBlock', () => {
  it('renders each code as spent/alloc · remaining · pct + bar', () => {
    const out = renderBudgetBlock([
      { name: 'Makan', spent: 450_000, alloc: 600_000, remaining: 150_000, pct: 0.75 },
    ]);
    expect(out).toContain('📊 Budget');
    expect(out).toContain('Makan 450.000/600.000 · sisa 150.000 · 75%');
    expect(out).toContain('`|————————•——|`'); // 75% bar
  });

  it('flags over-budget codes with 🚨 and the real pct, clamping the bar', () => {
    const out = renderBudgetBlock([
      { name: 'Makan', spent: 720_000, alloc: 600_000, remaining: -120_000, pct: 1.2 },
    ]);
    expect(out).toContain('🚨 Makan');
    expect(out).toContain('120%');
    expect(out).toContain('`|——————————•|`'); // clamped full
  });

  it('caps at 3 codes (sorted by pct desc upstream) and notes the rest', () => {
    const codes = [
      { name: 'A', spent: 90, alloc: 100, remaining: 10, pct: 0.9 },
      { name: 'B', spent: 50, alloc: 100, remaining: 50, pct: 0.5 },
      { name: 'C', spent: 30, alloc: 100, remaining: 70, pct: 0.3 },
      { name: 'D', spent: 10, alloc: 100, remaining: 90, pct: 0.1 },
    ];
    const out = renderBudgetBlock(codes);
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toContain('C');
    expect(out).not.toContain('D 10'); // D omitted from lines
    expect(out).toContain('+1 lainnya');
  });

  it('returns empty string when there are no budgets', () => {
    expect(renderBudgetBlock([])).toBe('');
  });
});
