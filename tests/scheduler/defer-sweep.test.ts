import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sweepDeferredPayments } from '../../src/scheduler/defer-sweep.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { SessionContext } from '../../src/domain/entities.js';
import { bot } from '../../src/telegram/bot.js';

vi.mock('../../src/telegram/bot.js', () => ({
  bot: { api: { sendMessage: vi.fn() } },
}));

function mockRepos(expiredSessions: SessionContext[] = []): Repos {
  return {
    users: {
      findByTelegramChatId: vi.fn(), findById: vi.fn(), create: vi.fn(), update: vi.fn(),
    } as never,
    accounts: {
      findAllByUserId: vi.fn(),
      findById: vi.fn(async () => ({
        accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const,
        balance: 0, isActive: true, createdAt: '', updatedAt: '',
      })),
      findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
    } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(),
      update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: {
      get: vi.fn(),
      set: vi.fn(async () => undefined),
      delete: vi.fn(),
      findExpiredDeferrals: vi.fn(async () => expiredSessions),
    } as never,
    budgets: {
      findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(),
      incrementSpent: vi.fn(), update: vi.fn(),
    } as never,
    recurrings: {
      findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(),
      findById: vi.fn(async () => ({
        recurringId: 'rp-1', userId: 'u1', name: 'Spotify', amount: 59_900,
        accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25,
        isActive: true, nextFireAt: '2026-06-25', createdAt: '', updatedAt: '',
      })),
      findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn(),
    } as never,
    preferences: {
      findAllByUserId: vi.fn(async () => []),
      upsert: vi.fn(),
      delete: vi.fn(),
    } as never,
  };
}

describe('sweepDeferredPayments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-prompts for expired deferrals and clears the state', async () => {
    const session: SessionContext = {
      chatId: '123', userId: 'u1', turns: [], lastActivityAt: '',
      pendingRecurringConfirmation: { recurringId: 'rp-1', expiresAt: '2026-06-19T08:00:00Z' },
    };
    const repos = mockRepos([session]);
    await sweepDeferredPayments(repos);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '123', expect.stringContaining('Spotify'), expect.any(Object),
    );
    expect(repos.sessions.set).toHaveBeenCalledWith(
      expect.objectContaining({ pendingRecurringConfirmation: undefined }),
    );
  });

  it('clears state without re-prompting when recurring is inactive', async () => {
    const session: SessionContext = {
      chatId: '123', userId: 'u1', turns: [], lastActivityAt: '',
      pendingRecurringConfirmation: { recurringId: 'rp-1', expiresAt: '2026-06-19T08:00:00Z' },
    };
    const repos = mockRepos([session]);
    (repos.recurrings.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await sweepDeferredPayments(repos);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(repos.sessions.set).toHaveBeenCalledWith(
      expect.objectContaining({ pendingRecurringConfirmation: undefined }),
    );
  });

  it('handles empty sweep (no expired deferrals)', async () => {
    const repos = mockRepos([]);
    await sweepDeferredPayments(repos);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
