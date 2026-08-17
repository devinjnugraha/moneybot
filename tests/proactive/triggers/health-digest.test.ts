import { describe, it, expect, vi } from 'vitest';
import { detectHealthDigest } from '../../../src/proactive/triggers/health-digest.js';
import type { Repos } from '../../../src/repositories/interfaces.js';
import type { Transaction } from '../../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-07-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}
function mockRepos(opts: { txns?: Transaction[] } = {}): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(async () => [{ accountId: 'a', userId: 'u', name: 'bca', type: 'bank', balance: 10_000_000, isActive: true, createdAt: '', updatedAt: '' }]), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(),
      findByDateRange: vi.fn(async (_u: string, from: string, to: string) =>
        (opts.txns ?? []).filter((t) => t.date >= from && t.date <= to)),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), findExpiredDeferrals: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(async () => []), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn(), rollRecurringIntoMonth: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(async () => []), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    cardStatements: {} as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

// 2026-08-01T01:30:00Z → WIB 2026-08-01; judged month = 2026-07.
const NOW = new Date('2026-08-01T01:30:00Z');

describe('detectHealthDigest', () => {
  it('judges the month that just ended; dedupKey carries that month', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-07-05', type: 'income', amount: 5_000_000 }),
        mkTxn({ date: '2026-07-15', amount: 3_000_000 }),
      ],
    });
    const out = await detectHealthDigest({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.triggerType).toBe('health_digest');
    expect(out[0]!.dedupKey).toBe('health-digest:2026-07');
    const data = out[0]!.data as { month: string; components: unknown[] };
    expect(data.month).toBe('2026-07');
    expect(data.components.length).toBe(6);
  });

  it('returns [] when the user has no active accounts', async () => {
    const repos = mockRepos();
    (repos.accounts.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    expect(await detectHealthDigest({ userId: 'u', repos, now: NOW })).toEqual([]);
  });
});
