import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleMessage } from '../../src/agent/orchestrator.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { AgentRunner } from '../../src/agent/run-agent.js';
import type { CoreMessage } from 'ai';
import { logEvent } from '../../src/utils/logger.js';

vi.mock('../../src/utils/logger.js', () => ({
  logEvent: vi.fn(),
}));

function fakeRunner(reply: string, transactionId?: string): AgentRunner {
  return vi.fn(async () => {
    const responseMessages: CoreMessage[] = [{ role: 'assistant', content: reply }];
    const toolResults = transactionId
      ? [{ toolName: 'create_expense', result: { status: 'ok', data: { transaction: { transactionId } } } }]
      : [];
    return { text: reply, responseMessages, toolResults };
  });
}

function mockRepos(): Repos {
  return {
    users: {
      findByTelegramChatId: vi.fn(async () => null),
      findById: vi.fn(),
      create: vi.fn(async (i: { telegramChatId: string; name: string }) => ({
        userId: 'u1', telegramChatId: i.telegramChatId, name: i.name, language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
      })),
      update: vi.fn(),
    } as never,
    accounts: {
      findAllByUserId: vi.fn(async () => []),
      findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
    } as never,
    transactions: { create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn() } as never,
    sessions: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(),
    } as never,
    budgets: {
      findByUserAndMonth: vi.fn(async () => []),
      findByName: vi.fn(async () => null),
      create: vi.fn(),
      incrementSpent: vi.fn(),
      update: vi.fn(),
    } as never,
    recurrings: {
      findAllByUserId: vi.fn(async () => []),
      findByDayOfMonth: vi.fn(),
      findById: vi.fn(),
      findByName: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
    } as never,
    preferences: {
      findAllByUserId: vi.fn(async () => []),
      upsert: vi.fn(),
      delete: vi.fn(),
    } as never,
  };
}

describe('handleMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('onboards an unknown user and replies with the onboarding prompt', async () => {
    const repos = mockRepos();
    const { reply, onboarded } = await handleMessage({
      text: 'hai',
      chatId: '999',
      repos,
      run: fakeRunner('Halo! Aku MoneyBot. Buat akun pertamamu dulu ya.'),
      system: 'sys',
      contextWindowTurns: 20,
      sessionIdleTimeoutMinutes: 30,
    });
    expect(onboarded).toBe(true);
    // Verify user is created with empty name — the LLM collects it via conversation
    const createCall = (repos.users.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { name: string };
    expect(createCall.name).toBe('');
    expect(repos.users.create).toHaveBeenCalledWith(expect.objectContaining({ telegramChatId: '999' }));
    expect(reply).toContain('MoneyBot');
    // NFR-07: logs incoming message + agent run complete
    expect(logEvent).toHaveBeenCalledWith('info', 'message received', expect.objectContaining({ userId: 'u1', chatId: '999' }));
    expect(logEvent).toHaveBeenCalledWith('info', 'agent run complete', expect.objectContaining({ userId: 'u1', chatId: '999', stepCount: 0 }));
  });

  it('persists session turns and lastTransactionId when a write produced a transaction', async () => {
    const repos = mockRepos();
    // known user + has an account
    (repos.users.findByTelegramChatId as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', telegramChatId: '1', name: 'Devin', language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
    });
    (repos.accounts.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue([
      { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 0, isActive: true, createdAt: '', updatedAt: '' },
    ]);
    const { reply } = await handleMessage({
      text: 'bakso 20000 bca',
      chatId: '1',
      repos,
      run: fakeRunner('✅ Pengeluaran dicatat', 'txn-9'),
      system: 'sys',
      contextWindowTurns: 20,
      sessionIdleTimeoutMinutes: 30,
    });
    expect(reply).toBe('✅ Pengeluaran dicatat');
    expect(repos.sessions.set).toHaveBeenCalledWith(expect.objectContaining({
      chatId: '1',
      lastTransactionId: 'txn-9',
    }));
    expect(logEvent).toHaveBeenCalledWith('info', 'agent run complete', expect.objectContaining({
      stepCount: 1,
      toolNames: ['create_expense'],
    }));
  });

  it('starts a fresh session when the prior one expired', async () => {
    const repos = mockRepos();
    (repos.users.findByTelegramChatId as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', telegramChatId: '1', name: 'Devin', language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
    });
    (repos.sessions.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      chatId: '1', userId: 'u1', turns: [{ role: 'user', content: 'old' }], lastTransactionId: undefined,
      lastActivityAt: new Date('2020-01-01').toISOString(), // ancient
    });
    await handleMessage({
      text: 'halo',
      chatId: '1',
      repos,
      run: fakeRunner('halo balik'),
      system: 'sys',
      contextWindowTurns: 20,
      sessionIdleTimeoutMinutes: 30,
    });
    // The persisted turns must NOT include the ancient 'old' message
    const saved = (repos.sessions.set as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { turns: CoreMessage[] };
    expect(saved.turns.some((m: CoreMessage) => (m as { content?: string }).content === 'old')).toBe(false);
  });

  it('injects the PREFERENSI USER block into the system prompt when prefs exist', async () => {
    const repos = mockRepos();
    (repos.users.findByTelegramChatId as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', telegramChatId: '1', name: 'Devin', language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
    });
    (repos.preferences.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue([
      { userId: 'u1', key: 'default_account', value: 'BCA', updatedAt: '' },
    ]);
    const run = vi.fn(async () => ({
      text: 'ok', responseMessages: [{ role: 'assistant' as const, content: 'ok' }], toolResults: [],
    }));
    await handleMessage({
      text: 'halo', chatId: '1', repos, run, system: 'BASE',
      contextWindowTurns: 20, sessionIdleTimeoutMinutes: 30,
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringContaining('PREFERENSI USER'),
    }));
    const call = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: string };
    expect(call.system).toContain('BASE');
    expect(call.system).toContain('- default_account: BCA');
  });

  it('leaves the system prompt unchanged when the user has no preferences', async () => {
    const repos = mockRepos();
    (repos.users.findByTelegramChatId as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', telegramChatId: '1', name: 'Devin', language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
    });
    (repos.preferences.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const run = vi.fn(async () => ({
      text: 'ok', responseMessages: [{ role: 'assistant' as const, content: 'ok' }], toolResults: [],
    }));
    await handleMessage({
      text: 'halo', chatId: '1', repos, run, system: 'BASE',
      contextWindowTurns: 20, sessionIdleTimeoutMinutes: 30,
    });
    const call = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: string };
    expect(call.system).toBe('BASE');
  });
});
