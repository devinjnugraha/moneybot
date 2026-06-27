import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));

import { runProactivePass } from '../../src/proactive/dispatcher.js';
import { logEvent } from '../../src/utils/logger.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { ProactivePayload, ProactivePolicy } from '../../src/proactive/types.js';

// 2026-06-22T14:00:00Z == 21:00 WIB (outside the 22:00-07:00 quiet window).
const NOW = new Date('2026-06-22T14:00:00Z');
const POLICY: ProactivePolicy = {
  enabled: true, maxPerDay: 5, quietHours: '22:00-07:00', contextWindowTurns: 20,
};

function mockRepos(overrides: {
  users?: { userId: string; telegramChatId: string; status?: 'pending' | 'approved' | 'rejected' }[];
  muted?: boolean;
  existsKey?: boolean;
  countSince?: number;
  existingSession?: { chatId: string; userId: string; turns: unknown[]; lastActivityAt: string } | null;
} = {}): Repos {
  const users = overrides.users ?? [{ userId: 'u1', telegramChatId: 'c1', status: 'approved' }];
  return {
    users: {
      findByTelegramChatId: vi.fn(), findById: vi.fn(),
      findAll: vi.fn(async () => users),
      create: vi.fn(), update: vi.fn(),
    } as never,
    accounts: { findAllByUserId: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: { create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn() } as never,
    sessions: {
      get: vi.fn(async () => overrides.existingSession ?? null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(),
    } as never,
    budgets: { findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: {
      record: vi.fn(async () => ({ inserted: true })),
      existsKey: vi.fn(async () => overrides.existsKey ?? false),
      countSince: vi.fn(async () => overrides.countSince ?? 0),
    } as never,
    proactiveSettings: {
      get: vi.fn(async () => ({ userId: 'u1', muted: overrides.muted ?? false })),
      setMuted: vi.fn(async () => undefined),
    } as never,
  };
}

const summaryPayload: ProactivePayload = {
  triggerType: 'scheduled_summary', dedupKey: 'summary:2026-06-22', channel: 'llm', data: {},
};

describe('runProactivePass', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends, records, and seeds an assistant turn for an actionable user', async () => {
    const repos = mockRepos();
    const send = vi.fn(async () => undefined);
    const detector = vi.fn(async () => [summaryPayload]);
    const composer = vi.fn(async () => 'COMPOSED');

    await runProactivePass({ detector, composer, repos, policy: POLICY, now: NOW, send });

    expect(send).toHaveBeenCalledWith('c1', 'COMPOSED', undefined);
    expect(repos.outreach.record).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', dedupKey: 'summary:2026-06-22', sentAt: NOW }));
    expect(repos.sessions.set).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'c1', lastActivityAt: NOW.toISOString() }));
    const setArg = (repos.sessions.set as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { turns: { role: string; content: string }[] };
    expect(setArg.turns.at(-1)).toMatchObject({ role: 'assistant', content: 'COMPOSED' });
  });

  it('skips a muted user (no detector, no send)', async () => {
    const repos = mockRepos({ muted: true });
    const send = vi.fn();
    const detector = vi.fn(async () => [summaryPayload]);
    await runProactivePass({ detector, composer: vi.fn(), repos, policy: POLICY, now: NOW, send });
    expect(detector).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('skips when in quiet hours', async () => {
    const repos = mockRepos();
    const send = vi.fn();
    const detector = vi.fn(async () => [summaryPayload]);
    // 23:00 WIB == inside 22:00-07:00
    await runProactivePass({ detector, composer: vi.fn(), repos, policy: POLICY, now: new Date('2026-06-22T16:00:00Z'), send });
    expect(detector).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('skips composing when the dedup key already exists', async () => {
    const repos = mockRepos({ existsKey: true });
    const send = vi.fn();
    const composer = vi.fn(async () => 'SHOULD NOT RUN');
    const detector = vi.fn(async () => [summaryPayload]);
    await runProactivePass({ detector, composer, repos, policy: POLICY, now: NOW, send });
    expect(composer).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('skips when the daily rate limit is reached', async () => {
    const repos = mockRepos({ countSince: 5 });
    const send = vi.fn();
    const composer = vi.fn();
    const detector = vi.fn(async () => [summaryPayload]);
    await runProactivePass({ detector, composer, repos, policy: POLICY, now: NOW, send });
    expect(composer).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('kill-switch off: fetches no users, sends nothing', async () => {
    const repos = mockRepos();
    const send = vi.fn();
    const detector = vi.fn();
    await runProactivePass({ detector, composer: vi.fn(), repos, policy: { ...POLICY, enabled: false }, now: NOW, send });
    expect(repos.users.findAll).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('skips non-approved users (only approved users are sent to)', async () => {
    const repos = mockRepos({ users: [
      { userId: 'u1', telegramChatId: 'c1', status: 'pending' },
      { userId: 'u2', telegramChatId: 'c2', status: 'approved' },
    ] });
    const send = vi.fn(async () => undefined);
    const detector = vi.fn(async () => [summaryPayload]);
    const composer = vi.fn(async () => 'OK');
    await runProactivePass({ detector, composer, repos, policy: POLICY, now: NOW, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('c2', 'OK', undefined);
  });

  it('catches a detector error, logs it, and continues to the next user', async () => {
    const repos = mockRepos({ users: [
      { userId: 'u1', telegramChatId: 'c1', status: 'approved' },
      { userId: 'u2', telegramChatId: 'c2', status: 'approved' },
    ] });
    const send = vi.fn(async () => undefined);
    const detector = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([summaryPayload]);
    const composer = vi.fn(async () => 'OK');
    await runProactivePass({ detector, composer, repos, policy: POLICY, now: NOW, send });
    expect(logEvent).toHaveBeenCalledWith('error', expect.any(String), expect.objectContaining({ userId: 'u1', error: 'boom' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('c2', 'OK', undefined);
  });

  it('records [] payload (nothing to say) without sending', async () => {
    const repos = mockRepos();
    const send = vi.fn();
    const detector = vi.fn(async () => []);
    await runProactivePass({ detector, composer: vi.fn(), repos, policy: POLICY, now: NOW, send });
    expect(send).not.toHaveBeenCalled();
    expect(repos.outreach.record).not.toHaveBeenCalled();
  });

  it('forwards a composer replyMarkup to send (button-bearing messages)', async () => {
    const repos = mockRepos();
    const send = vi.fn(async () => undefined);
    const kb = { inline_keyboard: [[{ text: '✅', callback_data: 'rec:x:confirm' }]] };
    const detector = vi.fn(async () => [summaryPayload]);
    const composer = vi.fn(async () => ({ text: 'GLANCE', replyMarkup: kb }));
    await runProactivePass({ detector, composer, repos, policy: POLICY, now: NOW, send });
    expect(send).toHaveBeenCalledWith('c1', 'GLANCE', kb);
  });
});
