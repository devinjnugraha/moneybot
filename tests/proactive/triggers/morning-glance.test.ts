import { describe, it, expect, vi } from 'vitest';
import { detectMorningGlance } from '../../../src/proactive/triggers/morning-glance.js';
import type { Repos } from '../../../src/repositories/interfaces.js';
import type { Account, RecurringPayment, Transaction } from '../../../src/domain/entities.js';

// 2026-06-22T14:00:00Z == 21:00 WIB → WIB today = 2026-06-22.
const NOW = new Date('2026-06-22T14:00:00Z');

function mkAccount(over: Partial<Account>): Account {
  return { accountId: 'a', userId: 'u', name: '', type: 'bank', balance: 0, isActive: true, createdAt: '', updatedAt: '', ...over };
}
function mkRecurring(over: Partial<RecurringPayment>): RecurringPayment {
  return { recurringId: 'r', userId: 'u', name: '', amount: 0, accountId: 'a', categoryId: 'c', dayOfMonth: 1, isActive: true, nextFireAt: '2026-06-22', createdAt: '', updatedAt: '', ...over };
}
function mkTxn(over: Partial<Transaction>): Transaction {
  return { transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '', accountId: 'a', date: '2026-06-21', isRecurringInstance: false, createdAt: '', updatedAt: '', ...over };
}

function mockRepos(opts: { accounts?: Account[]; recurrings?: RecurringPayment[]; yesterday?: Transaction[] } = {}): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(async () => opts.accounts ?? []), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(),
      findByDateRange: vi.fn(async () => opts.yesterday ?? []),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(async () => opts.recurrings ?? []), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

describe('detectMorningGlance', () => {
  it('returns [] when the user has no active accounts (nothing to glance at)', async () => {
    const repos = mockRepos({ accounts: [] });
    expect(await detectMorningGlance({ userId: 'u', repos, now: NOW })).toEqual([]);
  });

  it('partitions recurrings into todayDueBills vs upcoming, excluding today from upcoming', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca', name: 'BCA' })],
      recurrings: [
        mkRecurring({ recurringId: 'r1', name: 'Spotify', amount: 59_900, accountId: 'bca', nextFireAt: '2026-06-22' }),
        mkRecurring({ recurringId: 'r2', name: 'Netflix', amount: 75_000, accountId: 'bca', nextFireAt: '2026-06-25' }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    const data = out[0]!.data as { todayDueBills: { recurringId: string }[]; upcoming: { name: string }[] };
    expect(data.todayDueBills.map((b) => b.recurringId)).toEqual(['r1']);
    expect(data.upcoming.map((b) => b.name)).toEqual(['Netflix']);
  });

  it('excludes a bill already processed this month (lastFiredAt this month) from todayDueBills', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca', name: 'BCA' })],
      recurrings: [
        mkRecurring({ recurringId: 'r1', name: 'Spotify', nextFireAt: '2026-06-22', lastFiredAt: '2026-06-22' }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { todayDueBills: unknown[] };
    expect(data.todayDueBills).toEqual([]);
  });

  it('keeps a bill fired in a previous month eligible again', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca', name: 'BCA' })],
      recurrings: [
        mkRecurring({ recurringId: 'r1', name: 'Spotify', nextFireAt: '2026-06-22', lastFiredAt: '2026-05-22' }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { todayDueBills: { recurringId: string }[] };
    expect(data.todayDueBills.map((b) => b.recurringId)).toEqual(['r1']);
  });

  it('builds dedup key from the WIB date and selects the llm channel', async () => {
    const repos = mockRepos({ accounts: [mkAccount({ accountId: 'bca' })] });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    expect(out[0]!.dedupKey).toBe('morning-glance:2026-06-22');
    expect(out[0]!.channel).toBe('llm');
    expect(out[0]!.triggerType).toBe('morning_glance');
  });

  it('sums only expenses for yesterday and nulls when none', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca' })],
      yesterday: [
        mkTxn({ type: 'expense', amount: 30_000 }),
        mkTxn({ type: 'transfer', amount: 500_000 }),
        mkTxn({ type: 'expense', amount: 20_000 }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { yesterday: { count: number; totalSpend: number } | null };
    expect(data.yesterday).toEqual({ count: 2, totalSpend: 50_000 });

    const reposEmpty = mockRepos({ accounts: [mkAccount({ accountId: 'bca' })], yesterday: [] });
    const empty = await detectMorningGlance({ userId: 'u', repos: reposEmpty, now: NOW });
    expect((empty[0]!.data as { yesterday: unknown }).yesterday).toBeNull();
  });
});
