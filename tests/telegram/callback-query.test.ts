import { describe, it, expect, vi } from 'vitest';
import { dispatchRecCallback } from '../../src/telegram/callback-query.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { CallbackActionResult } from '../../src/telegram/callback-query.js';
import type { RecurringPayment, SessionContext } from '../../src/domain/entities.js';
import { logEvent } from '../../src/utils/logger.js';

vi.mock('../../src/utils/logger.js', () => ({
  logEvent: vi.fn(),
}));

/** Narrow a CallbackActionResult to a variant that has `.text` (answer | edit). */
function textOf(a: CallbackActionResult): string {
  return a.kind === 'answer' || a.kind === 'edit' ? a.text : '';
}

function mockRepos(overrides: {
  user?: { userId: string; telegramChatId: string } | null;
  rp?: RecurringPayment | null;
  existingSession?: SessionContext | null;
  transactions?: Partial<Repos['transactions']>;
} = {}): Repos {
  const user = overrides.user === undefined
    ? { userId: 'u1', telegramChatId: '123' }
    : overrides.user;
  const rp = overrides.rp === undefined
    ? {
        recurringId: 'rp-1', userId: 'u1', name: 'Spotify', amount: 59_900,
        accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25,
        isActive: true, nextFireAt: '2026-06-25', createdAt: '', updatedAt: '',
      }
    : overrides.rp;

  return {
    users: {
      findByTelegramChatId: vi.fn(async () => user),
      findById: vi.fn(), create: vi.fn(), update: vi.fn(),
    } as never,
    accounts: {
      findAllByUserId: vi.fn(),
      findById: vi.fn(async () => ({ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 1_000_000, isActive: true, createdAt: '', updatedAt: '' })),
      findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
    } as never,
    transactions: {
      create: vi.fn(async (i: Record<string, unknown>) => ({
        transactionId: 'txn-1', userId: i.userId, type: 'expense' as const, amount: i.amount as number,
        description: i.description as string, categoryId: i.categoryId as string, accountId: i.accountId as string,
        budgetCodeId: (i.budgetCodeId ?? null) as string | null | undefined, date: i.date as string,
        isRecurringInstance: !!(i.isRecurringInstance as boolean | undefined), recurringId: (i.recurringId ?? null) as string | null | undefined,
        createdAt: '', updatedAt: '', toAccountId: null, notes: null, deletedAt: null,
      })),
      createTransfer: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(),
      findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
      ...overrides.transactions,
    } as never,
    sessions: {
      get: vi.fn(async () => overrides.existingSession ?? null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(),
    } as never,
    budgets: {
      findByUserAndMonth: vi.fn(async () => []),
      findByName: vi.fn(async () => null),
      create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn(),
    } as never,
    recurrings: {
      findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(),
      findById: vi.fn(async () => rp),
      findByName: vi.fn(), create: vi.fn(),
      update: vi.fn(async () => ({ ...rp!, lastFiredAt: '2026-06-19' })),
      deactivate: vi.fn(),
    } as never,
    preferences: {
      findAllByUserId: vi.fn(async () => []),
      upsert: vi.fn(),
      delete: vi.fn(),
    } as never,
  };
}

describe('dispatchRecCallback', () => {
  it('confirm: creates expense and updates lastFiredAt', async () => {
    const repos = mockRepos();
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'confirm' }, '123', repos,
    );
    expect(repos.transactions.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Spotify', isRecurringInstance: true }),
    );
    expect(repos.recurrings.update).toHaveBeenCalledWith('u1', 'rp-1', expect.objectContaining({ lastFiredAt: expect.any(String) }));
    expect(actions[0]!.kind).toBe('answer');
    expect(textOf(actions[0]!)).toBe('✅ Dicatat!');
  });

  it('confirm: blocks double-fire same month', async () => {
    const repos = mockRepos({
      rp: {
        recurringId: 'rp-1', userId: 'u1', name: 'Spotify', amount: 59_900,
        accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25,
        isActive: true, nextFireAt: '2026-06-25', lastFiredAt: '2026-06-19',
        createdAt: '', updatedAt: '',
      },
    });
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'confirm' }, '123', repos,
    );
    expect(textOf(actions[0]!)).toBe('Sudah diproses sebelumnya.');
    expect(repos.transactions.create).not.toHaveBeenCalled();
  });

  it('defer: writes pendingRecurringConfirmation to session', async () => {
    const repos = mockRepos();
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'defer' }, '123', repos,
    );
    expect(repos.sessions.set).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingRecurringConfirmation: expect.objectContaining({ recurringId: 'rp-1' }),
      }),
    );
    expect(textOf(actions[0]!)).toContain('Nanti diingatkan lagi');
  });

  it('skip: updates lastFiredAt without creating expense', async () => {
    const repos = mockRepos();
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'skip' }, '123', repos,
    );
    expect(repos.recurrings.update).toHaveBeenCalledWith('u1', 'rp-1', expect.objectContaining({ lastFiredAt: expect.any(String) }));
    expect(repos.transactions.create).not.toHaveBeenCalled();
    expect(textOf(actions[0]!)).toContain('Dilewati');
  });

  it('returns alert when recurring payment is inactive', async () => {
    const repos = mockRepos({
      rp: { recurringId: 'rp-1', userId: 'u1', name: 'Spotify', amount: 59_900, accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25, isActive: false, nextFireAt: '2026-06-25', createdAt: '', updatedAt: '' },
    });
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'confirm' }, '123', repos,
    );
    expect(textOf(actions[0]!)).toBe('Tagihan ini sudah dihapus.');
  });

  it('returns alert when user not found', async () => {
    const repos = mockRepos({ user: null });
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'confirm' }, 'ghost', repos,
    );
    expect(textOf(actions[0]!)).toBe('User tidak ditemukan.');
  });

  it('confirm: returns safe message when createExpenseCore fails (NFR-09)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(async () => { throw new Error('RAW_SQL_CONNECTION_REFUSED'); }),
        createTransfer: vi.fn(), findByDateRange: vi.fn(async () => []),
        findByAccountAndDateRange: vi.fn(async () => []), findLatestByUserId: vi.fn(async () => []),
        findById: vi.fn(async () => null), update: vi.fn(), softDelete: vi.fn(),
      } as never,
    });
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'confirm' }, '123', repos,
    );
    const answerAction = actions.find((a) => a.kind === 'answer');
    expect(answerAction).toBeDefined();
    expect(textOf(answerAction!)).toBe('Gagal memproses. Coba lagi.');
    // Must NOT leak the raw error
    expect(textOf(answerAction!)).not.toContain('RAW_SQL');
    expect(textOf(answerAction!)).not.toContain('CONNECTION_REFUSED');
    expect(logEvent).toHaveBeenCalled();
  });
});
