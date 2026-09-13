import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sweepCardStatements } from '../../src/scheduler/card-statements.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { Account, User } from '../../src/domain/entities.js';

vi.mock('../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));

function mkUser(id: string): User {
  return { userId: id, telegramChatId: `c-${id}`, name: 'U', language: 'id', timezone: 'Asia/Jakarta', accountsEnabled: true, status: 'approved', createdAt: '2026-01-01', updatedAt: '' };
}
function mkCard(over: Partial<Account>): Account {
  return { accountId: 'card', userId: 'u', name: 'CC', type: 'card', balance: 0, billingDay: 5, dueInDays: 15, isDefault: false, isActive: true, createdAt: '2026-01-01', updatedAt: '', ...over };
}

function mockRepos(opts: { users: User[]; cards: Account[]; ensure: ReturnType<typeof vi.fn> }): Repos {
  return {
    users: { findAll: vi.fn(async () => opts.users) } as never,
    accounts: { findAllByUserId: vi.fn(async () => opts.cards) } as never,
    cardStatements: { ensureEndedCycles: opts.ensure, getWithFigures: vi.fn(async () => []) } as never,
  } as never;
}

describe('sweepCardStatements', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ensures ended cycles for every active card with a billing day', async () => {
    const ensure = vi.fn(async () => 1);
    const repos = mockRepos({
      users: [mkUser('u1')],
      cards: [mkCard({ accountId: 'c1', billingDay: 5 })],
      ensure,
    });
    await sweepCardStatements(repos, new Date('2026-07-20T00:05:00Z'));
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith('u1', 'c1', 5, '2026-01-01', new Date('2026-07-20T00:05:00Z'));
  });

  it('skips cards without a billing day and non-card accounts', async () => {
    const ensure = vi.fn(async () => 0);
    const repos = mockRepos({
      users: [mkUser('u1')],
      cards: [mkCard({ accountId: 'c1', billingDay: undefined }), { ...mkCard({ accountId: 'b' }), type: 'bank', billingDay: undefined }],
      ensure,
    });
    await sweepCardStatements(repos, new Date('2026-07-20T00:05:00Z'));
    expect(ensure).not.toHaveBeenCalled();
  });

  it('continues when one user throws', async () => {
    const ensure = vi.fn(async () => 1);
    const reposA = mockRepos({ users: [mkUser('u1')], cards: [mkCard({ accountId: 'c1' })], ensure });
    // Force findAllByUserId to throw for the first call then resolve.
    let call = 0;
    (reposA.accounts.findAllByUserId as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error('boom');
      return [mkCard({ accountId: 'c2' })];
    });
    await expect(sweepCardStatements(reposA, new Date('2026-07-20T00:05:00Z'))).resolves.toBeUndefined();
  });

  it('is a no-op when there are no users', async () => {
    const ensure = vi.fn(async () => 0);
    const repos = mockRepos({ users: [], cards: [], ensure });
    await sweepCardStatements(repos, new Date('2026-07-20T00:05:00Z'));
    expect(ensure).not.toHaveBeenCalled();
  });
});
