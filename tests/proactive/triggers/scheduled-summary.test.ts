import { describe, it, expect, vi } from 'vitest';
import { detectScheduledSummary } from '../../../src/proactive/triggers/scheduled-summary.js';
import type { Repos } from '../../../src/repositories/interfaces.js';
import type { Transaction, BudgetCode } from '../../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-06-22', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

function mockRepos(opts: { txns?: Transaction[]; budgets?: BudgetCode[] } = {}): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(),
      findByDateRange: vi.fn(async () => opts.txns ?? []),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: {
      findByUserAndMonth: vi.fn(async () => opts.budgets ?? []),
      findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn(),
    } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

// 2026-06-22T14:00:00Z == 2026-06-22 21:00 WIB (deterministic WIB "today").
const NOW = new Date('2026-06-22T14:00:00Z');

describe('detectScheduledSummary', () => {
  it('returns [] when there are no transactions today (no empty nag)', async () => {
    const repos = mockRepos({ txns: [] });
    const out = await detectScheduledSummary({ userId: 'u', repos, now: NOW });
    expect(out).toEqual([]);
  });

  it('ignores transfer/income and sums only expenses', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ type: 'expense', amount: 30000, categoryId: 'food.dining' }),
        mkTxn({ type: 'transfer', amount: 500000 }),
        mkTxn({ type: 'income', amount: 5_000_000 }),
        mkTxn({ type: 'expense', amount: 20000, categoryId: 'transport.ridehail' }),
      ],
    });
    const out = await detectScheduledSummary({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    const data = out[0]!.data as { totalSpend: number; topCategories: { id: string; amount: number }[] };
    expect(data.totalSpend).toBe(50000);
    expect(data.topCategories[0]).toMatchObject({ id: 'food.dining', amount: 30000 });
    expect(data.topCategories[1]).toMatchObject({ id: 'transport.ridehail', amount: 20000 });
  });

  it('builds the dedup key from the WIB date and selects the llm channel', async () => {
    const repos = mockRepos({ txns: [mkTxn({ type: 'expense', amount: 10000, categoryId: 'food.coffee' })] });
    const out = await detectScheduledSummary({ userId: 'u', repos, now: NOW });
    expect(out[0]!.dedupKey).toBe('summary:2026-06-22');
    expect(out[0]!.channel).toBe('llm');
    expect(out[0]!.triggerType).toBe('scheduled_summary');
  });

  it('resolves category names via the seeded taxonomy', async () => {
    const repos = mockRepos({ txns: [mkTxn({ type: 'expense', amount: 15000, categoryId: 'food.coffee' })] });
    const out = await detectScheduledSummary({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { topCategories: { name: string; icon: string }[] };
    expect(data.topCategories[0]!.name).toBe('Kopi & Minuman');
    expect(data.topCategories[0]!.icon).toBe('☕');
  });

  it('includes budget status for the current WIB month', async () => {
    const repos = mockRepos({
      txns: [mkTxn({ type: 'expense', amount: 10000, categoryId: 'food.dining' })],
      budgets: [{
        budgetCodeId: 'b1', userId: 'u', name: 'food', monthlyBudget: 100000, spent: 80000,
        isRecurring: false, month: 6, year: 2026, createdAt: '', updatedAt: '',
      }],
    });
    const out = await detectScheduledSummary({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { budgets: { name: string; pct: number }[] };
    expect(data.budgets[0]).toMatchObject({ name: 'food', pct: 0.8 });
  });
});
