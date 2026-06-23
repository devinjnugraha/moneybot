import { describe, it, expect, vi } from 'vitest';
import { createLoggingGapDetector } from '../../../src/proactive/triggers/logging-gap.js';
import type { Repos } from '../../../src/repositories/interfaces.js';
import type { Transaction } from '../../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-06-22', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

function mockRepos(opts: { latest?: Transaction[] } = {}): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(),
      findByAccountAndDateRange: vi.fn(),
      findLatestByUserId: vi.fn(async () => opts.latest ?? []),
      findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

// 2026-06-22T14:00:00Z == 2026-06-22 21:00 WIB => todayWIB = 2026-06-22.
const NOW = new Date('2026-06-22T14:00:00Z');
const detect = createLoggingGapDetector(2);

describe('detectLoggingGap', () => {
  it('returns [] when the user has no transactions (no baseline to nag from)', async () => {
    const repos = mockRepos({ latest: [] });
    expect(await detect({ userId: 'u', repos, now: NOW })).toEqual([]);
  });

  it('emits a payload when the gap meets the threshold', async () => {
    const repos = mockRepos({ latest: [mkTxn({ date: '2026-06-19' })] });
    const out = await detect({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.triggerType).toBe('logging_gap');
    expect(out[0]!.channel).toBe('template');
    expect(out[0]!.dedupKey).toBe('gap:2026-06-22');
    expect(out[0]!.data).toMatchObject({ gapDays: 3, lastDate: '2026-06-19' });
  });

  it('returns [] when the gap is below the threshold', async () => {
    const repos = mockRepos({ latest: [mkTxn({ date: '2026-06-21' })] });
    expect(await detect({ userId: 'u', repos, now: NOW })).toEqual([]);
  });

  it('emits when the gap equals the threshold exactly', async () => {
    const repos = mockRepos({ latest: [mkTxn({ date: '2026-06-20' })] });
    const out = await detect({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    expect((out[0]!.data as { gapDays: number }).gapDays).toBe(2);
  });
});
