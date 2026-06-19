import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireRecurringPayments } from '../../src/scheduler/recurring-fire.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { RecurringPayment } from '../../src/domain/entities.js';

// Mock bot.api.sendMessage
import { bot } from '../../src/telegram/bot.js';
vi.mock('../../src/telegram/bot.js', () => ({
  bot: { api: { sendMessage: vi.fn() } },
}));

function mockRepos(due: RecurringPayment[] = []): Repos {
  return {
    users: {
      findByTelegramChatId: vi.fn(),
      findById: vi.fn(async (userId: string) => ({
        userId, telegramChatId: `chat-${userId}`, name: 'U', language: 'id' as const,
        timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
      })),
      create: vi.fn(), update: vi.fn(),
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
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: {
      findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(),
      incrementSpent: vi.fn(), update: vi.fn(),
    } as never,
    recurrings: {
      findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(),
      findDueToday: vi.fn(async () => due),
      findById: vi.fn(), findByName: vi.fn(), create: vi.fn(),
      update: vi.fn(), deactivate: vi.fn(),
    } as never,
  };
}

describe('fireRecurringPayments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('sends a prompt for each due payment', async () => {
    const rp: RecurringPayment = {
      recurringId: 'rp-1', userId: 'u1', name: 'Spotify', amount: 59_900,
      accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25,
      isActive: true, nextFireAt: '2026-06-25', createdAt: '', updatedAt: '',
    };
    const repos = mockRepos([rp]);
    await fireRecurringPayments(repos);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      'chat-u1',
      expect.stringContaining('Spotify'),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
  });

  it('caches chatId per user for multiple payments', async () => {
    const rp1: RecurringPayment = {
      recurringId: 'rp-1', userId: 'u1', name: 'Spotify', amount: 59_900,
      accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25,
      isActive: true, nextFireAt: '2026-06-25', createdAt: '', updatedAt: '',
    };
    const rp2: RecurringPayment = {
      recurringId: 'rp-2', userId: 'u1', name: 'Netflix', amount: 159_000,
      accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25,
      isActive: true, nextFireAt: '2026-06-25', createdAt: '', updatedAt: '',
    };
    const repos = mockRepos([rp1, rp2]);
    await fireRecurringPayments(repos);
    expect(repos.users.findById).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('skips payments for unknown users', async () => {
    const repos = mockRepos([{
      recurringId: 'rp-1', userId: 'ghost', name: 'X', amount: 1,
      accountId: 'a1', categoryId: 'other.misc', dayOfMonth: 1, isActive: true,
      nextFireAt: '2026-06-01', createdAt: '', updatedAt: '',
    }]);
    (repos.users.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await fireRecurringPayments(repos);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
