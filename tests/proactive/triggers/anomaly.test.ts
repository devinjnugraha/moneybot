import { describe, it, expect, vi } from 'vitest';
import { createAnomalyDetector } from '../../../src/proactive/triggers/anomaly.js';
import type { Repos } from '../../../src/repositories/interfaces.js';
import type { Transaction } from '../../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-06-22', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

function mockRepos(opts: { txns?: Transaction[] } = {}): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(),
      findByDateRange: vi.fn(async () => opts.txns ?? []),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

// 2026-06-22T14:00:00Z => WIB date 2026-06-22, a Monday => ISO week 2026-W26.
// thisMonday = 2026-06-22; the 5-week window is [2026-05-25, 2026-06-28].
const NOW = new Date('2026-06-22T14:00:00Z');
const detect = createAnomalyDetector(3);

describe('detectAnomaly', () => {
  it('returns [] when there are no transactions', async () => {
    const repos = mockRepos({ txns: [] });
    expect(await detect({ userId: 'u', repos, now: NOW })).toEqual([]);
  });

  it('flags a category whose this-week spend exceeds multiplier x rolling average', async () => {
    const repos = mockRepos({
      txns: [
        // this week (off 0)
        mkTxn({ date: '2026-06-23', categoryId: 'food.coffee', amount: 300000 }),
        // prior week 1 (off -1): baseline total 90000 => avg 22500
        mkTxn({ date: '2026-06-15', categoryId: 'food.coffee', amount: 90000 }),
      ],
    });
    const out = await detect({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.triggerType).toBe('anomaly');
    expect(out[0]!.channel).toBe('llm');
    expect(out[0]!.dedupKey).toBe('anomaly:2026-W26');
    const data = out[0]!.data as { week: string; flagged: { category: string; name: string; icon: string; thisWeek: number; avg: number }[] };
    expect(data.week).toBe('2026-W26');
    expect(data.flagged).toHaveLength(1);
    expect(data.flagged[0]).toMatchObject({
      category: 'food.coffee', name: 'Kopi & Minuman', icon: '☕', thisWeek: 300000, avg: 22500,
    });
  });

  it('does not flag a category with no prior baseline (avg = 0)', async () => {
    const repos = mockRepos({
      txns: [mkTxn({ date: '2026-06-23', categoryId: 'food.coffee', amount: 300000 })],
    });
    expect(await detect({ userId: 'u', repos, now: NOW })).toEqual([]);
  });

  it('returns [] when spend is within the multiplier of the baseline', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-06-23', categoryId: 'food.coffee', amount: 20000 }),
        mkTxn({ date: '2026-06-15', categoryId: 'food.coffee', amount: 90000 }),
      ],
    });
    expect(await detect({ userId: 'u', repos, now: NOW })).toEqual([]);
  });

  it('flags only the anomalous category among several', async () => {
    const repos = mockRepos({
      txns: [
        // food.coffee: this week 300000 vs avg 22500 => flagged
        mkTxn({ date: '2026-06-23', categoryId: 'food.coffee', amount: 300000 }),
        mkTxn({ date: '2026-06-15', categoryId: 'food.coffee', amount: 90000 }),
        // transport.ridehail: this week 20000 vs avg 20000 => not flagged
        mkTxn({ date: '2026-06-23', categoryId: 'transport.ridehail', amount: 20000 }),
        mkTxn({ date: '2026-06-15', categoryId: 'transport.ridehail', amount: 80000 }),
      ],
    });
    const out = await detect({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { flagged: { category: string }[] };
    expect(data.flagged.map((f) => f.category)).toEqual(['food.coffee']);
  });
});
