import { describe, it, expect, vi } from 'vitest';
import { detectLeakAlert } from '../../../src/proactive/triggers/leak-alert.js';
import { wibISOWeekLabel } from '../../../src/domain/time.js';
import type { Repos } from '../../../src/repositories/interfaces.js';
import type { Transaction } from '../../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}
function mockRepos(opts: { txns?: Transaction[] } = {}): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(async () => []), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
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

// 2026-08-18T02:00:00Z → WIB 2026-08-18 (a Tuesday).
const NOW = new Date('2026-08-18T02:00:00Z');

describe('detectLeakAlert', () => {
  it('returns [] when nothing leaks', async () => {
    const repos = mockRepos({ txns: [mkTxn({ date: '2026-08-05', description: ' stabil ', amount: 100_000 })] });
    expect(await detectLeakAlert({ userId: 'u', repos, now: NOW })).toEqual([]);
  });

  it('fires with dedupKey leak-alert:<ISO week> when a spike clears the gates', async () => {
    const repos = mockRepos({
      txns: [
        // current month (2026-08): 2x 'kopi kenangan' totalling 250k
        mkTxn({ date: '2026-08-05', description: 'kopi kenangan', amount: 150_000 }),
        mkTxn({ date: '2026-08-06', description: 'Kopi Kenangan', amount: 100_000 }),
        // previous month (2026-07): 2x totalling 100k → +150%
        mkTxn({ date: '2026-07-05', description: 'kopi kenangan', amount: 50_000 }),
        mkTxn({ date: '2026-07-06', description: 'kopi kenangan', amount: 50_000 }),
      ],
    });
    const out = await detectLeakAlert({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.triggerType).toBe('leak_alert');
    expect(out[0]!.channel).toBe('llm');
    expect(out[0]!.dedupKey).toBe(`leak-alert:${wibISOWeekLabel(NOW)}`); // self-verifying, no hardcoded week
    const data = out[0]!.data as { spikes: { label: string }[] };
    expect(data.spikes[0]!.label).toBe('kopi kenangan');
  });
});
