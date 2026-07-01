import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sweepBudgetRollover } from '../../src/scheduler/budget-rollover.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { User } from '../../src/domain/entities.js';

vi.mock('../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));

function mkUser(id: string): User {
  return {
    userId: id, telegramChatId: `c-${id}`, name: 'U', language: 'id', timezone: 'Asia/Jakarta',
    status: 'approved', createdAt: '', updatedAt: '',
  };
}

function mockRepos(users: User[], roll: ReturnType<typeof vi.fn>): Repos {
  return {
    users: { findAll: vi.fn(async () => users) } as never,
    budgets: { rollRecurringIntoMonth: roll } as never,
  } as never;
}

describe('sweepBudgetRollover', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rolls every user into the current WIB month', async () => {
    const roll = vi.fn<(userId: string, year: number, month: number) => Promise<number>>()
      .mockResolvedValue(1);
    const repos = mockRepos([mkUser('u1'), mkUser('u2')], roll);
    await sweepBudgetRollover(repos, new Date('2026-07-01T00:05:00Z'));
    expect(repos.users.findAll).toHaveBeenCalled();
    expect(roll).toHaveBeenCalledTimes(2);
    const args = roll.mock.calls[0]!;
    expect(args[0]).toBe('u1');
    expect(args[1]).toBe(2026);
    expect(args[2]).toBe(7);
  });

  it('continues when one user throws', async () => {
    const roll = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(1);
    const repos = mockRepos([mkUser('u1'), mkUser('u2')], roll);
    await expect(sweepBudgetRollover(repos, new Date('2026-07-01T00:05:00Z'))).resolves.toBeUndefined();
    expect(roll).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when there are no users', async () => {
    const roll = vi.fn(async () => 0);
    const repos = mockRepos([], roll);
    await sweepBudgetRollover(repos, new Date('2026-07-01T00:05:00Z'));
    expect(roll).not.toHaveBeenCalled();
  });
});
