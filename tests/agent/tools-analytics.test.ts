import { describe, it, expect, vi } from 'vitest';
import { buildTools } from '../../src/agent/tools.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { Transaction } from '../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

function mockRepos(opts: { txns?: Transaction[] } = {}): Repos {
  const findByDateRange = vi.fn(async (_userId: string, from: string, _to: string) =>
    (opts.txns ?? []).filter((t) => t.date >= from && t.date <= _to),
  );
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(async () => []), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(), findByDateRange,
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(async () => []), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn(), rollRecurringIntoMonth: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(async () => []), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    cardStatements: {} as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

// Narrow result shape for assertions (mirrors tools.test.ts's ToolCallResult).
type AnalyticsResult = {
  currentTotal?: number;
  previousTotal?: number;
  deltaPct?: number;
  comparison?: { label: string; from: string; to: string };
  groups?: Array<{ key: string; label: string; icon?: string }>;
  cashflow?: { income: number; expense: number; net: number; savingsRate?: number };
};

describe('buildTools — get_analytics', () => {
  it('is registered as a read tool even before onboarding (hasAccount=false)', () => {
    const tools = buildTools({ userId: 'u1', repos: mockRepos(), hasAccount: false });
    expect(tools.get_analytics).toBeDefined();
  });

  it('current + previous month compare with category labels and deltas', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-08-05', categoryId: 'food.coffee', amount: 200_000 }),
        mkTxn({ date: '2026-07-10', categoryId: 'food.coffee', amount: 100_000 }),
      ],
    });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics!.execute!(
      { from: '2026-08-01', to: '2026-08-31', compareWith: 'previous_month', breakdown: 'category' },
      { toolCallId: 'c', messages: [] as never },
    ) as AnalyticsResult;
    expect(out.currentTotal).toBe(200_000);
    expect(out.previousTotal).toBe(100_000);
    expect(out.deltaPct).toBe(100);
    expect(out.comparison).toEqual({ label: 'previous_month', from: '2026-07-01', to: '2026-07-31' });
    const coffee = out.groups!.find((g) => g.key === 'food.coffee');
    expect(coffee?.label).toBe('Kopi & Minuman'); // CATEGORIES label decoration
    expect(coffee?.icon).toBe('☕');
  });

  it('includes cashflow + savingsRate when the range spans >= 28 days', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-08-02', type: 'income', amount: 5_000_000 }),
        mkTxn({ date: '2026-08-03', amount: 4_000_000 }),
      ],
    });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics!.execute!(
      { from: '2026-08-01', to: '2026-08-31' },
      { toolCallId: 'c', messages: [] as never },
    ) as AnalyticsResult;
    expect(out.cashflow).toEqual({ income: 5_000_000, expense: 4_000_000, net: 1_000_000, savingsRate: 20 });
  });

  it('omits cashflow for short ranges', async () => {
    const repos = mockRepos({ txns: [mkTxn({ date: '2026-08-02', amount: 10_000 })] });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics!.execute!(
      { from: '2026-08-01', to: '2026-08-07' },
      { toolCallId: 'c', messages: [] as never },
    ) as AnalyticsResult;
    expect(out.cashflow).toBeUndefined();
  });

  it('drill-down: categoryId filter restricts groups', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-08-05', categoryId: 'food.coffee', amount: 50_000 }),
        mkTxn({ date: '2026-08-06', categoryId: 'transport.fuel', amount: 60_000 }),
      ],
    });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics!.execute!(
      { from: '2026-08-01', to: '2026-08-31', categoryId: 'food.coffee' },
      { toolCallId: 'c', messages: [] as never },
    ) as AnalyticsResult;
    expect(out.currentTotal).toBe(50_000);
    expect(out.groups).toHaveLength(1);
  });

  it('description breakdown labels groups by normalized key', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-08-05', description: 'Kopi Kenangan', amount: 50_000 }),
        mkTxn({ date: '2026-08-06', description: 'kopi kenangan 2x', amount: 25_000 }),
      ],
    });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics!.execute!(
      { from: '2026-08-01', to: '2026-08-31', breakdown: 'description' },
      { toolCallId: 'c', messages: [] as never },
    ) as AnalyticsResult;
    expect(out.groups).toHaveLength(1);
    expect(out.groups![0]!.label).toBe('kopi kenangan');
  });
});
