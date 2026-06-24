import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/index.js', () => ({
  config: { PROACTIVE_INSIGHT_ENABLED: false },
}));

import { buildTools } from '../../src/agent/tools.js';
import type { Repos } from '../../src/repositories/interfaces.js';

function mockRepos(): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: {
      findAllByUserId: vi.fn(async () => []),
      findById: vi.fn(async () => ({ accountId: 'a1', name: 'BCA', balance: 0 })),
      findByName: vi.fn(async () => ({ accountId: 'a1', name: 'BCA', balance: 0 })) as never,
      create: vi.fn(), updateBalance: vi.fn(async () => undefined), update: vi.fn(),
    } as never,
    transactions: {
      create: vi.fn(async (i: { userId: string }) => ({ transactionId: 't1', userId: i.userId, type: 'expense', amount: 0, description: '', accountId: 'a1', date: '2026-06-22', isRecurringInstance: false, createdAt: '', updatedAt: '' })),
      createTransfer: vi.fn(), findByDateRange: vi.fn(async () => []),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(async () => []), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

describe('insightContext disabled (PROACTIVE_INSIGHT_ENABLED=false)', () => {
  it('omits insightContext and does not query category history', async () => {
    const repos = mockRepos();
    const tools = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await (tools.create_expense!.execute as (a: unknown) => unknown)({
      description: 'kopi', amount: 25_000, accountId: 'a1', categoryId: 'food.coffee',
    });
    const ok = res as { status: string; data: { insightContext?: unknown } };
    expect(ok.status).toBe('ok');
    expect(ok.data.insightContext).toBeUndefined();
    expect(repos.transactions.findByDateRange).not.toHaveBeenCalled();
  });
});
