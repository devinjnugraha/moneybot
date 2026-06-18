import { describe, it, expect, vi } from 'vitest';
import type { CoreTool } from 'ai';
import { buildTools } from '../../src/agent/tools.js';
import type { Repos } from '../../src/repositories/interfaces.js';

function mockRepos(overrides: Partial<Repos> = {}): Repos {
  return {
    users: { create: vi.fn(async (i: { telegramChatId: string; name: string }) => ({ userId: 'u1', telegramChatId: i.telegramChatId, name: i.name, language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '' })) } as never,
    accounts: {
      findAllByUserId: vi.fn(async () => []),
      findById: vi.fn(async () => null),
      findByName: vi.fn(async () => null),
      create: vi.fn(async (i: { name: string; type: string; creditLimit?: number }) => ({ accountId: 'a1', userId: 'u1', name: i.name, type: i.type as never, balance: 0, creditLimit: i.creditLimit, isActive: true, createdAt: '', updatedAt: '' })),
      updateBalance: vi.fn(async () => undefined),
      update: vi.fn(async () => ({}) as never),
    } as never,
    transactions: {
      create: vi.fn(async (i: { amount: number; description: string; categoryId?: string }) => ({ transactionId: 't1', userId: 'u1', type: 'expense' as const, amount: i.amount, description: i.description, categoryId: i.categoryId, accountId: 'a1', isRecurringInstance: false, date: '', createdAt: '', updatedAt: '' })),
      createTransfer: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: {
      findByUserAndMonth: vi.fn(),
      findByName: vi.fn(),
      create: vi.fn(),
      incrementSpent: vi.fn(),
      update: vi.fn(),
    } as never,
    recurrings: {
      findAllByUserId: vi.fn(),
      findByDayOfMonth: vi.fn(),
      findById: vi.fn(),
      findByName: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
    } as never,
    ...overrides,
  };
}

type ToolCallResult = {
  status: string;
  missing?: string[];
  field?: string;
  matches?: unknown[];
  data?: { transaction?: { transactionId?: string } };
};

// CoreTool.execute is `(args, options)` and optional in AI SDK v4; route direct
// test calls through here to assert it is defined, supply the options arg, and
// give the result a narrow shape for the assertions.
async function callExec(t: CoreTool | undefined, args: unknown): Promise<ToolCallResult> {
  return t!.execute!(args as never, {} as never) as Promise<ToolCallResult>;
}

describe('buildTools — create_account', () => {
  it('returns missing_fields when a card has no creditLimit', async () => {
    const repos = mockRepos();
    const { create_account } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(create_account, { name: 'BCA CC', type: 'card' });
    expect(res).toEqual({ status: 'missing_fields', missing: ['creditLimit'] });
  });

  it('creates the account on ok', async () => {
    const repos = mockRepos();
    const { create_account } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(create_account, { name: 'BCA', type: 'bank' });
    expect(res.status).toBe('ok');
    expect(repos.accounts.create).toHaveBeenCalled();
  });
});

describe('buildTools — onboarding gating', () => {
  // Read tools (get_accounts) are ALWAYS available, per SRS SP-02 ("Always verify
  // via get_accounts before referencing account names or balances"). Only WRITE
  // tools are gated behind onboarding: if get_accounts were withheld when
  // hasAccount=false, the prompt's unconditional SP-02 rule makes the model call
  // it during onboarding and the AI SDK throws NoSuchToolError (crashes the run).
  it('always exposes create_account + get_accounts; gates create_expense when hasAccount is false', () => {
    const tools = buildTools({ userId: 'u1', repos: mockRepos(), hasAccount: false });
    expect(tools.create_account).toBeDefined();
    expect(tools.get_accounts).toBeDefined();
    expect(tools.create_expense).toBeUndefined();
  });

  it('exposes all tools (incl. create_expense) when hasAccount is true', () => {
    const tools = buildTools({ userId: 'u1', repos: mockRepos(), hasAccount: true });
    expect(tools.get_accounts).toBeDefined();
    expect(tools.create_expense).toBeDefined();
  });
});

describe('buildTools — create_expense (write gate)', () => {
  it('returns ambiguous when the account name matches nothing', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => [
          { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 0, isActive: true, createdAt: '', updatedAt: '' },
          { accountId: 'a2', userId: 'u1', name: 'BCA CC', type: 'card', balance: 0, isActive: true, createdAt: '', updatedAt: '' },
        ]),
        findById: vi.fn(async () => null),
        findByName: vi.fn(async () => null),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_expense } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_expense, {
      description: 'bakso', amount: 20_000, accountId: 'mandiri', categoryId: 'food.dining',
    });
    expect(res.status).toBe('ambiguous');
    expect(res.field).toBe('accountId');
  });

  it('creates the expense + decrements balance on ok, and never throws', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => []),
        findById: vi.fn(async (_u: string, id: string) =>
          id === 'a1' ? { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' } : null,
        ),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(async () => undefined),
        update: vi.fn(),
      } as never,
    });
    const { create_expense } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_expense, {
      description: 'bakso', amount: 20_000, accountId: 'a1', categoryId: 'food.dining',
    });
    expect(res.status).toBe('ok');
    expect(res.data?.transaction?.transactionId).toBe('t1');
    expect(repos.accounts.updateBalance).toHaveBeenCalledWith('u1', 'a1', -20_000);
  });
});
