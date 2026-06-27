import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));
vi.mock('../../src/agent/orchestrator.js', () => ({
  handleMessage: vi.fn(async () => ({ reply: 'MONEYBOT_REPLY' })),
}));

import { routeMessage, BETA_PENDING_MESSAGE, formatApprovalRequest } from '../../src/telegram/access.js';
import { handleMessage } from '../../src/agent/orchestrator.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { User } from '../../src/domain/entities.js';

function user(chatId: string, status: User['status']): User {
  return {
    userId: 'u-' + chatId,
    telegramChatId: chatId,
    name: 'A',
    language: 'id',
    timezone: 'Asia/Jakarta',
    status,
    createdAt: '',
    updatedAt: '',
  };
}

function mockRepos(opts: { found?: User | null } = {}): Repos {
  return {
    users: {
      findByTelegramChatId: vi.fn(async () => opts.found ?? null),
      findById: vi.fn(),
      findAll: vi.fn(),
      create: vi.fn(async (i: { telegramChatId: string }) => user(i.telegramChatId, 'pending')),
      update: vi.fn(),
    } as never,
    accounts: { findAllByUserId: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: { create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn() } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  } as never;
}

function makeRoute(repos: Repos, adminChatIds: readonly string[] = ['admin-1']) {
  const notify = vi.fn(async () => undefined);
  const route = routeMessage({
    repos,
    run: vi.fn() as never,
    buildSystem: () => 'SYS',
    contextWindowTurns: 20,
    sessionIdleTimeoutMinutes: 30,
    adminChatIds,
    notify,
  });
  return { route, notify };
}

describe('routeMessage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to the moneybot agent for an approved user', async () => {
    const repos = mockRepos({ found: user('c1', 'approved') });
    const { route, notify } = makeRoute(repos);
    const reply = await route('halo', 'c1');
    expect(reply).toBe('MONEYBOT_REPLY');
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('replies canned and skips the agent for a pending user', async () => {
    const repos = mockRepos({ found: user('c1', 'pending') });
    const { route, notify } = makeRoute(repos);
    const reply = await route('halo', 'c1');
    expect(reply).toBe(BETA_PENDING_MESSAGE);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('replies canned and skips the agent for a rejected user', async () => {
    const repos = mockRepos({ found: user('c1', 'rejected') });
    const { route } = makeRoute(repos);
    const reply = await route('halo', 'c1');
    expect(reply).toBe(BETA_PENDING_MESSAGE);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('on first touch creates a pending user, notifies admins, replies canned, skips the agent', async () => {
    const repos = mockRepos({ found: null });
    const { route, notify } = makeRoute(repos, ['a1', 'a2']);
    const reply = await route('halo', 'c1');
    expect(reply).toBe(BETA_PENDING_MESSAGE);
    expect(repos.users.create).toHaveBeenCalledWith({ telegramChatId: 'c1', name: '' });
    expect(handleMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith('a1', expect.any(String));
    expect(notify).toHaveBeenCalledWith('a2', expect.any(String));
  });

  it('does not re-notify on subsequent pending messages', async () => {
    const repos = mockRepos({ found: user('c1', 'pending') });
    const { route, notify } = makeRoute(repos, ['a1']);
    await route('halo', 'c1');
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies no one when adminChatIds is empty (user still persisted)', async () => {
    const repos = mockRepos({ found: null });
    const { route, notify } = makeRoute(repos, []);
    const reply = await route('halo', 'c1');
    expect(reply).toBe(BETA_PENDING_MESSAGE);
    expect(repos.users.create).toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('one admin notify failure does not abort the others', async () => {
    const repos = mockRepos({ found: null });
    const notify = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('blocked');
    });
    const route = routeMessage({
      repos,
      run: vi.fn() as never,
      buildSystem: () => 'SYS',
      contextWindowTurns: 20,
      sessionIdleTimeoutMinutes: 30,
      adminChatIds: ['bad', 'good'],
      notify,
    });
    const reply = await route('halo', 'c1');
    expect(reply).toBe(BETA_PENDING_MESSAGE);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe('formatApprovalRequest', () => {
  it('includes the chat id and a copy-paste approve UPDATE', () => {
    const msg = formatApprovalRequest(user('12345', 'pending'), 'hai');
    expect(msg).toContain('12345');
    expect(msg).toContain("UPDATE users SET status='approved' WHERE telegram_chat_id='12345';");
    expect(msg).toContain('hai');
  });

  it('truncates the first message preview to 100 chars', () => {
    const long = 'x'.repeat(500);
    const msg = formatApprovalRequest(user('9', 'pending'), long);
    expect(msg).toContain('x'.repeat(100));
    expect(msg).not.toContain('x'.repeat(101));
  });
});
