import { describe, it, expect, vi } from 'vitest';
import type { CoreTool } from 'ai';
import { buildTools } from '../../src/agent/tools.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import { logEvent } from '../../src/utils/logger.js';

vi.mock('../../src/utils/logger.js', () => ({
  logEvent: vi.fn(),
}));

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
    preferences: {
      findAllByUserId: vi.fn(async () => []),
      upsert: vi.fn(),
      delete: vi.fn(),
    } as never,
    ...overrides,
  };
}

type ToolCallResult = {
  status?: string;
  message?: string;
  missing?: string[];
  field?: string;
  matches?: unknown[];
  options?: Record<string, unknown> | null;
  data?: { transaction?: { transactionId?: string }; budget?: { spent: number; limit: number; exceeded: boolean } };
  // get_report (T15) read-tool fields
  total?: number;
  count?: number;
  groups?: Array<{
    groupKey: string;
    label: string;
    icon?: string;
    total: number;
    percentage: number;
    count: number;
  }>;
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

  it('resolves a budget code by name and returns overspend warning', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => []),
        findById: vi.fn(async (_u: string, id: string) =>
          id === 'a1' ? { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 100_000, isActive: true, createdAt: '', updatedAt: '' } : null,
        ),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(async () => undefined),
        update: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => [
          { budgetCodeId: 'b-jajan', userId: 'u1', name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026, spent: 520_000, createdAt: '', updatedAt: '' },
        ]),
        findByName: vi.fn(async (_uid: string, name: string) =>
          name === 'jajan' ? { budgetCodeId: 'b-jajan', userId: 'u1', name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026, spent: 480_000, createdAt: '', updatedAt: '' } : null,
        ),
        create: vi.fn(),
        incrementSpent: vi.fn(async () => undefined),
        update: vi.fn(),
      } as never,
    });
    const { create_expense } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_expense, {
      description: 'bakso', amount: 40_000, accountId: 'a1', categoryId: 'food.dining', budgetCodeId: 'jajan',
    });
    expect(res.status).toBe('ok');
    // budget code resolved by name + spent incremented
    expect(repos.budgets.incrementSpent).toHaveBeenCalledWith('u1', 'b-jajan', 40_000);
    // data.budget reflects the updated spent (480k + 40k = 520k over 500k limit)
    expect(res.data?.budget).toEqual({ spent: 520_000, limit: 500_000, exceeded: true });
  });

  it('returns missing_fields when budget code name is unknown', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => []),
        findById: vi.fn(async (_u: string, id: string) =>
          id === 'a1' ? { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 100_000, isActive: true, createdAt: '', updatedAt: '' } : null,
        ),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(async () => undefined),
        update: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => []),
        findByName: vi.fn(async () => null), // never matches
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_expense } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_expense, {
      description: 'kopi', amount: 30_000, accountId: 'a1', categoryId: 'food.coffee', budgetCodeId: 'jajan',
    });
    expect(res.status).toBe('missing_fields');
    expect(res.missing).toContain('budgetCodeId');
    expect(res.options).toEqual({ monthlyBudget: null });
  });
});

describe('buildTools — get_categories (T03)', () => {
  it('returns all categories from the static taxonomy', async () => {
    const repos = mockRepos();
    const { get_categories } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_categories, {});
    expect(Array.isArray(res)).toBe(true);
    const arr = res as unknown as Array<{ categoryId: string }>;
    expect(arr.length).toBeGreaterThan(0);
    expect(arr.some((c) => c.categoryId === 'food.dining')).toBe(true);
  });
});

describe('buildTools — get_budget_codes (T04)', () => {
  it('returns budget codes for the user', async () => {
    const repos = mockRepos({
      budgets: {
        findByUserAndMonth: vi.fn(async () => [
          { budgetCodeId: 'b1', userId: 'u1', name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026, spent: 0, createdAt: '', updatedAt: '' },
        ]),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_budget_codes } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_budget_codes, {});
    const arr = res as unknown as Array<{ name: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.name).toBe('Jajan');
  });
});

describe('buildTools — get_transactions (T09)', () => {
  it('returns transactions filtered by date range', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          { transactionId: 't1', userId: 'u1', type: 'expense' as const, amount: 20_000, description: 'bakso', categoryId: 'food.dining', accountId: 'a1', isRecurringInstance: false, date: '2026-06-15', createdAt: '', updatedAt: '' },
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
    });
    const { get_transactions } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_transactions, { fromDate: '2026-06-01', toDate: '2026-06-30' });
    const arr = res as unknown as Array<{ description: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.description).toBe('bakso');
  });
});

describe('buildTools — get_recurring_payments (T13)', () => {
  it('returns active recurring payments', async () => {
    const repos = mockRepos({
      recurrings: {
        findAllByUserId: vi.fn(async () => [
          { recurringId: 'r1', userId: 'u1', name: 'Netflix', amount: 159_000, accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 15, isActive: true, nextFireAt: '2026-06-15', createdAt: '', updatedAt: '' },
        ]),
        findByDayOfMonth: vi.fn(),
        findById: vi.fn(),
        findByName: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        deactivate: vi.fn(),
      } as never,
    });
    const { get_recurring_payments } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_recurring_payments, {});
    const arr = res as unknown as Array<{ name: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.name).toBe('Netflix');
  });
});

describe('buildTools — get_account_balance (T16)', () => {
  it('returns balances for all accounts when no accountId given', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => [
          { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' },
          { accountId: 'a2', userId: 'u1', name: 'Mandiri', type: 'bank', balance: 50_000, isActive: true, createdAt: '', updatedAt: '' },
        ]),
        findById: vi.fn(),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_account_balance } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_account_balance, {});
    const arr = res as unknown as Array<{ name: string; balance: number }>;
    expect(arr).toHaveLength(2);
    expect(arr[0]!.balance).toBe(100_000);
  });

  it('returns balance for a single account by accountId', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => [
          { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' },
        ]),
        findById: vi.fn(async (_u: string, id: string) =>
          id === 'a1' ? { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 100_000, isActive: true, createdAt: '', updatedAt: '' } : null,
        ),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_account_balance } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_account_balance, { accountId: 'a1' });
    const obj = res as unknown as { balance: number };
    expect(obj.balance).toBe(100_000);
  });
});

describe('buildTools — create_income (T07)', () => {
  it('records income and increases balance', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => []),
        findById: vi.fn(async (_u: string, id: string) =>
          id === 'a1' ? { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 50_000, isActive: true, createdAt: '', updatedAt: '' } : null,
        ),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(async () => undefined),
        update: vi.fn(),
      } as never,
    });
    const { create_income } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_income, {
      description: 'Gaji', amount: 5_000_000, accountId: 'a1', categoryId: 'income.salary',
    });
    expect(res.status).toBe('ok');
    expect(res.data?.transaction?.transactionId).toBe('t1');
    expect(repos.accounts.updateBalance).toHaveBeenCalledWith('u1', 'a1', 5_000_000);
  });

  it('returns ambiguous when account not found', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => [
          { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 0, isActive: true, createdAt: '', updatedAt: '' },
        ]),
        findById: vi.fn(async () => null),
        findByName: vi.fn(async () => null),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_income } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_income, {
      description: 'Gaji', amount: 1_000, accountId: 'nonexistent', categoryId: 'income.other',
    });
    expect(res.status).toBe('ambiguous');
    expect(res.field).toBe('accountId');
  });
});

describe('buildTools — create_transfer (T08)', () => {
  it('completes a transfer and returns ok', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => []),
        findById: vi.fn(async (_u: string, id: string) => {
          if (id === 'a1') return { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 100_000, isActive: true, createdAt: '', updatedAt: '' };
          if (id === 'a2') return { accountId: 'a2', userId: 'u1', name: 'Mandiri', type: 'bank' as const, balance: 50_000, isActive: true, createdAt: '', updatedAt: '' };
          return null;
        }),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(async (i: { fromAccountId: string; toAccountId: string; amount: number; description: string }) => ({
          transactionId: 't-transfer', userId: 'u1', type: 'transfer' as const, amount: i.amount, description: i.description,
          accountId: i.fromAccountId, toAccountId: i.toAccountId, isRecurringInstance: false, date: '', createdAt: '', updatedAt: '',
        })),
      } as never,
    });
    const { create_transfer } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_transfer, {
      fromAccountId: 'a1', toAccountId: 'a2', amount: 30_000, description: 'transfer',
    });
    expect(res.status).toBe('ok');
    expect(repos.transactions.createTransfer).toHaveBeenCalled();
  });

  it('returns error when from and to accounts are the same', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => []),
        findById: vi.fn(async () => ({ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 100_000, isActive: true, createdAt: '', updatedAt: '' })),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_transfer } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_transfer, {
      fromAccountId: 'a1', toAccountId: 'a1', amount: 10_000, description: 'same',
    });
    expect(res.status).toBe('error');
  });
});

describe('buildTools — update_transaction (T10)', () => {
  it('updates a transaction using supplied transactionId', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => ({
          transactionId: 't-edit', userId: 'u1', type: 'expense' as const, amount: 20_000,
          description: 'bakso', categoryId: 'food.dining', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '', deletedAt: undefined,
        })),
        update: vi.fn(async () => ({
          transactionId: 't-edit', userId: 'u1', type: 'expense' as const, amount: 25_000,
          description: 'bakso besar', categoryId: 'food.dining', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '',
        })),
      } as never,
    });
    const { update_transaction } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(update_transaction, {
      transactionId: 't-edit', amount: 25_000, description: 'bakso besar',
    });
    expect(res.status).toBe('ok');
    expect(repos.transactions.update).toHaveBeenCalledWith('u1', 't-edit', { amount: 25_000, description: 'bakso besar' });
  });

  it('uses lastTransactionId when transactionId is omitted', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => ({
          transactionId: 't-last', userId: 'u1', type: 'expense' as const, amount: 20_000,
          description: 'bakso', categoryId: 'food.dining', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '', deletedAt: undefined,
        })),
        update: vi.fn(async () => ({
          transactionId: 't-last', userId: 'u1', type: 'expense' as const, amount: 30_000,
          description: 'bakso', categoryId: 'food.dining', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '',
        })),
      } as never,
    });
    const { update_transaction } = buildTools({
      userId: 'u1', repos, hasAccount: true, lastTransactionId: 't-last',
    });
    const res = await callExec(update_transaction, { amount: 30_000 });
    expect(res.status).toBe('ok');
    expect(repos.transactions.update).toHaveBeenCalledWith('u1', 't-last', { amount: 30_000 });
  });

  it('returns missing_fields when no transactionId available', async () => {
    const repos = mockRepos();
    const { update_transaction } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(update_transaction, { amount: 10_000 });
    expect(res.status).toBe('missing_fields');
    expect(res.missing).toContain('transactionId');
  });

  it('returns "tidak ditemukan" when the transaction does not exist (or is soft-deleted)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => null),
        update: vi.fn(),
      } as never,
    });
    const { update_transaction } = buildTools({ userId: 'u1', repos, hasAccount: true, lastTransactionId: 't-x' });
    const res = await callExec(update_transaction, { amount: 10_000 });
    expect(res.status).toBe('error');
    expect(res.message).toBe('Transaksi tidak ditemukan.');
  });

  // FR-08 step 6: balance reconciliation when amount/accountId changes
  it('reverses old balance and applies new when an expense amount changes', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => ({
          transactionId: 't1', userId: 'u1', type: 'expense' as const, amount: 20_000,
          description: 'bakso', categoryId: 'food.dining', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '', deletedAt: undefined,
        })),
        update: vi.fn(async () => ({}) as never),
      } as never,
    });
    const { update_transaction } = buildTools({ userId: 'u1', repos, hasAccount: true, lastTransactionId: 't1' });
    await callExec(update_transaction, { amount: 25_000 });
    // reverse original expense (+20_000 on a1), apply new (-25_000 on a1)
    expect(repos.accounts.updateBalance).toHaveBeenCalledWith('u1', 'a1', 20_000);
    expect(repos.accounts.updateBalance).toHaveBeenCalledWith('u1', 'a1', -25_000);
  });

  it('moves the balance when accountId changes (reverse old, apply new account)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => ({
          transactionId: 't1', userId: 'u1', type: 'expense' as const, amount: 20_000,
          description: 'bakso', categoryId: 'food.dining', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '', deletedAt: undefined,
        })),
        update: vi.fn(async () => ({}) as never),
      } as never,
    });
    const { update_transaction } = buildTools({ userId: 'u1', repos, hasAccount: true, lastTransactionId: 't1' });
    await callExec(update_transaction, { accountId: 'a2' });
    // reverse on old account (+20_000), apply on new account (-20_000)
    expect(repos.accounts.updateBalance).toHaveBeenCalledWith('u1', 'a1', 20_000);
    expect(repos.accounts.updateBalance).toHaveBeenCalledWith('u1', 'a2', -20_000);
  });

  it('reconciles budget spent when a budgeted expense amount changes (FR-08 step 7)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => ({
          transactionId: 't1', userId: 'u1', type: 'expense' as const, amount: 20_000,
          description: 'bakso', categoryId: 'food.dining', accountId: 'a1', budgetCodeId: 'b-jajan',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '', deletedAt: undefined,
        })),
        update: vi.fn(async () => ({}) as never),
      } as never,
    });
    const { update_transaction } = buildTools({ userId: 'u1', repos, hasAccount: true, lastTransactionId: 't1' });
    await callExec(update_transaction, { amount: 25_000 });
    // delta = new - old = 5_000
    expect(repos.budgets.incrementSpent).toHaveBeenCalledWith('u1', 'b-jajan', 5_000);
  });

  it('does NOT touch balance or budget when only description/categoryId changes', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => ({
          transactionId: 't1', userId: 'u1', type: 'expense' as const, amount: 20_000,
          description: 'bakso', categoryId: 'food.dining', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '', deletedAt: undefined,
        })),
        update: vi.fn(async () => ({}) as never),
      } as never,
    });
    const { update_transaction } = buildTools({ userId: 'u1', repos, hasAccount: true, lastTransactionId: 't1' });
    await callExec(update_transaction, { description: 'mie ayam', categoryId: 'food.dining' });
    expect(repos.accounts.updateBalance).not.toHaveBeenCalled();
    expect(repos.budgets.incrementSpent).not.toHaveBeenCalled();
    expect(repos.transactions.update).toHaveBeenCalledWith('u1', 't1', { description: 'mie ayam', categoryId: 'food.dining' });
  });
});

describe('buildTools — soft_delete_transaction (T11)', () => {
  it('soft-deletes and reverses account balance (expense)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => ({
          transactionId: 't-del', userId: 'u1', type: 'expense' as const, amount: 20_000,
          description: 'bakso', categoryId: 'food.dining', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '', deletedAt: undefined,
        })),
        softDelete: vi.fn(async () => undefined),
      } as never,
    });
    const { soft_delete_transaction } = buildTools({
      userId: 'u1', repos, hasAccount: true, lastTransactionId: 't-del',
    });
    const res = await callExec(soft_delete_transaction, {});
    expect(res.status).toBe('ok');
    expect(repos.accounts.updateBalance).toHaveBeenCalledWith('u1', 'a1', 20_000);
  });

  it('reverses balance for income (subtract on delete)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => ({
          transactionId: 't-inc', userId: 'u1', type: 'income' as const, amount: 5_000_000,
          description: 'Gaji', categoryId: 'income.salary', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '', deletedAt: undefined,
        })),
        softDelete: vi.fn(async () => undefined),
      } as never,
    });
    const { soft_delete_transaction } = buildTools({
      userId: 'u1', repos, hasAccount: true, lastTransactionId: 't-inc',
    });
    const res = await callExec(soft_delete_transaction, {});
    expect(res.status).toBe('ok');
    expect(repos.accounts.updateBalance).toHaveBeenCalledWith('u1', 'a1', -5_000_000);
  });

  it('returns "Transaksi tidak ditemukan" for already-deleted transaction (NFR-06)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        // findById now filters deleted_at IS NULL, so a soft-deleted txn
        // returns null — the tool treats it as "not found".
        findById: vi.fn(async () => null),
        softDelete: vi.fn(),
      } as never,
    });
    const { soft_delete_transaction } = buildTools({
      userId: 'u1', repos, hasAccount: true, lastTransactionId: 't-del2',
    });
    const res = await callExec(soft_delete_transaction, {});
    expect(res.status).toBe('error');
    expect(res.message).toBe('Transaksi tidak ditemukan.');
  });
});

describe('buildTools — create_budget_code (T05)', () => {
  it('creates a budget code with defaults for month/year', async () => {
    const repos = mockRepos({
      budgets: {
        findByUserAndMonth: vi.fn(),
        findByName: vi.fn(),
        create: vi.fn(async (i: { name: string; monthlyBudget: number }) => ({
          budgetCodeId: 'b-new', userId: 'u1', name: i.name, monthlyBudget: i.monthlyBudget,
          month: 6, year: 2026, spent: 0, createdAt: '', updatedAt: '',
        })),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_budget_code } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_budget_code, { name: 'Jajan', monthlyBudget: 500_000 });
    expect(res.status).toBe('ok');
    expect(repos.budgets.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jajan', monthlyBudget: 500_000 }));
  });
});

describe('buildTools — create_recurring_payment (T12)', () => {
  it('creates a recurring payment with computed nextFireAt', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(),
        findById: vi.fn(async () => ({ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 0, isActive: true, createdAt: '', updatedAt: '' })),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
      recurrings: {
        findAllByUserId: vi.fn(),
        findByDayOfMonth: vi.fn(),
        findById: vi.fn(),
        findByName: vi.fn(),
        create: vi.fn(async (i: { name: string; amount: number; dayOfMonth: number }) => ({
          recurringId: 'r-new', userId: 'u1', name: i.name, amount: i.amount, accountId: 'a1',
          categoryId: 'entertainment.streaming', dayOfMonth: i.dayOfMonth, isActive: true,
          nextFireAt: '2026-06-15', createdAt: '', updatedAt: '',
        })),
        update: vi.fn(),
        deactivate: vi.fn(),
      } as never,
    });
    const { create_recurring_payment } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_recurring_payment, {
      name: 'Netflix', amount: 159_000, accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 15,
    });
    expect(res.status).toBe('ok');
  });
});

describe('buildTools — deactivate_recurring_payment (T14)', () => {
  it('deactivates a recurring payment', async () => {
    const repos = mockRepos({
      recurrings: {
        findAllByUserId: vi.fn(),
        findByDayOfMonth: vi.fn(),
        findById: vi.fn(async () => ({
          recurringId: 'r1', userId: 'u1', name: 'Netflix', amount: 159_000,
          accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 15,
          isActive: true, nextFireAt: '2026-08-15', createdAt: '', updatedAt: '',
        })),
        findByName: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        deactivate: vi.fn(async () => undefined),
      } as never,
    });
    const { deactivate_recurring_payment } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(deactivate_recurring_payment, { recurringId: 'r1' });
    expect(res.status).toBe('ok');
    expect(repos.recurrings.deactivate).toHaveBeenCalledWith('u1', 'r1');
  });
});

describe('buildTools — get_report (T15)', () => {
  const txn = (overrides: Partial<{
    transactionId: string; type: string; amount: number; description: string;
    categoryId: string; accountId: string; budgetCodeId: string | null; date: string;
  }> = {}) => ({
    transactionId: overrides.transactionId ?? 't1',
    userId: 'u1',
    type: (overrides.type as 'expense' | 'income' | 'transfer') ?? 'expense',
    amount: overrides.amount ?? 20_000,
    description: overrides.description ?? 'bakso',
    categoryId: overrides.categoryId ?? 'food.dining',
    accountId: overrides.accountId ?? 'a1',
    budgetCodeId: overrides.budgetCodeId ?? null,
    date: overrides.date ?? '2026-06-15',
    isRecurringInstance: false,
    createdAt: '', updatedAt: '', notes: null, toAccountId: null, recurringId: null, deletedAt: null,
  });

  it('returns total + count for a date range (no grouping)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          txn({ transactionId: 't1', amount: 20_000, categoryId: 'food.dining' }),
          txn({ transactionId: 't2', amount: 50_000, categoryId: 'transport.ridehail' }),
          txn({ transactionId: 't3', amount: 30_000, categoryId: 'food.dining' }),
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => []),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_report } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_report, { from: '2026-06-01', to: '2026-06-30', type: 'expense' });
    expect(res.total).toBe(100_000);
    expect(res.count).toBe(3);
    expect(res.groups).toBeUndefined();
  });

  it('groups by category and returns percentages sorted descending', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          txn({ transactionId: 't1', amount: 20_000, categoryId: 'food.dining' }),
          txn({ transactionId: 't2', amount: 70_000, categoryId: 'transport.ridehail' }),
          txn({ transactionId: 't3', amount: 30_000, categoryId: 'food.dining' }),
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => []),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_report } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_report, { from: '2026-06-01', to: '2026-06-30', type: 'expense', groupBy: 'category' });
    expect(res.total).toBe(120_000);
    expect(res.groups).toHaveLength(2);
    // Sorted by amount desc: transport.ridehail (70k) then food.dining (50k combined)
    expect(res.groups![0]!.groupKey).toBe('transport.ridehail');
    expect(res.groups![0]!.total).toBe(70_000);
    expect(res.groups![0]!.percentage).toBe(58);
    expect(res.groups![1]!.groupKey).toBe('food.dining');
    expect(res.groups![1]!.total).toBe(50_000);
    expect(res.groups![1]!.percentage).toBe(42);
  });

  it('groups by budget code', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          txn({ transactionId: 't1', amount: 20_000, budgetCodeId: 'b-jajan' }),
          txn({ transactionId: 't2', amount: 80_000, budgetCodeId: 'b-jajan' }),
          txn({ transactionId: 't3', amount: 30_000, budgetCodeId: null }),
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => [
          { budgetCodeId: 'b-jajan', userId: 'u1', name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026, spent: 0, createdAt: '', updatedAt: '' },
        ]),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_report } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_report, { from: '2026-06-01', to: '2026-06-30', type: 'expense', groupBy: 'budget' });
    expect(res.total).toBe(130_000);
    expect(res.groups).toHaveLength(2);
    // "Tanpa Budget" group for null budgetCodeId
    const withoutBudget = res.groups!.find((g: { groupKey: string }) => g.groupKey === '__none__');
    expect(withoutBudget!.total).toBe(30_000);
    expect(withoutBudget!.label).toBe('Tanpa Budget');
    const jajan = res.groups!.find((g: { groupKey: string }) => g.groupKey === 'b-jajan');
    expect(jajan!.total).toBe(100_000);
  });

  it('filters by budgetCodeId for drill-down (FR-10c)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          txn({ transactionId: 't1', amount: 20_000, budgetCodeId: 'b-jajan', categoryId: 'food.dining', description: 'bakso' }),
          txn({ transactionId: 't2', amount: 80_000, budgetCodeId: 'b-jajan', categoryId: 'shopping.online', description: 'belanja' }),
          txn({ transactionId: 't3', amount: 30_000, budgetCodeId: 'b-family', categoryId: 'food.groceries', description: 'sayur' }),
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => [
          { budgetCodeId: 'b-jajan', userId: 'u1', name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026, spent: 100_000, createdAt: '', updatedAt: '' },
        ]),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_report } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_report, {
      from: '2026-06-01', to: '2026-06-30', type: 'expense', budgetCodeId: 'b-jajan',
    });
    // Only the two jajan transactions included
    expect(res.total).toBe(100_000);
    expect(res.count).toBe(2);
    // With budgetCodeId filter, groups are still returned for category breakdown
    expect(res.groups).toHaveLength(2);
  });

  it('excludes transfers (FR-10e)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          txn({ transactionId: 't1', amount: 20_000, type: 'expense' }),
          txn({ transactionId: 't2', amount: 30_000, type: 'transfer' }),
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => []),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_report } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_report, { from: '2026-06-01', to: '2026-06-30', type: 'expense' });
    // Transfer excluded — only the expense counted
    expect(res.total).toBe(20_000);
    expect(res.count).toBe(1);
  });

  it('resolves category icons from CATEGORIES taxonomy', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          txn({ transactionId: 't1', amount: 20_000, categoryId: 'food.dining' }),
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => []),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_report } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_report, { from: '2026-06-01', to: '2026-06-30', type: 'expense', groupBy: 'category' });
    expect(res.groups![0]!.icon).toBe('🍜');
    expect(res.groups![0]!.label).toBe('Makan di Luar');
  });
});

// NFR-09: every catch block returns Bahasa Indonesia, not raw Error.message
describe('buildTools — error messages are Bahasa Indonesia (NFR-09)', () => {
  it('createExpenseCore: returns ID message on error', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(async () => { throw new Error('SQL ERROR: connection refused'); }),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => []),
        findByAccountAndDateRange: vi.fn(async () => []),
        findLatestByUserId: vi.fn(async () => []),
        findById: vi.fn(async () => null),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      accounts: {
        findAllByUserId: vi.fn(async () => [{ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' }]),
        findById: vi.fn(async () => ({ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' })),
        findByName: vi.fn(async () => null),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_expense } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_expense, { description: 'bakso', amount: 20_000, accountId: 'a1', categoryId: 'food.dining' });
    expect(res.status).toBe('error');
    expect(res.message).toBe('Gagal mencatat pengeluaran. Coba lagi.');
    expect(logEvent).toHaveBeenCalledWith('error', expect.any(String), expect.objectContaining({ userId: 'u1' }));
  });

  it('create_account: returns ID message on error', async () => {
    const repos = mockRepos({
      accounts: {
        create: vi.fn(async () => { throw new Error('duplicate key'); }),
      } as never,
    });
    const { create_account } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(create_account, { name: 'BCA', type: 'bank' });
    expect(res).toEqual({ status: 'error', message: 'Gagal membuat akun. Coba lagi.' });
    expect(logEvent).toHaveBeenCalledWith('error', expect.any(String), expect.objectContaining({ userId: 'u1' }));
  });

  it('create_income: returns ID message on error', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(async () => { throw new Error('DB down'); }),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => []),
        findByAccountAndDateRange: vi.fn(async () => []),
        findLatestByUserId: vi.fn(async () => []),
        findById: vi.fn(async () => null),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      accounts: {
        findAllByUserId: vi.fn(async () => [{ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' }]),
        findById: vi.fn(async () => ({ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' })),
        findByName: vi.fn(async () => null),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_income } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_income, { description: 'gaji', amount: 5_000_000, accountId: 'a1', categoryId: 'income.salary' });
    expect(res).toEqual({ status: 'error', message: 'Gagal mencatat pemasukan. Coba lagi.' });
  });

  it('create_transfer: returns ID message on error', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(async () => { throw new Error('transfer failed'); }),
      } as never,
      accounts: {
        findAllByUserId: vi.fn(async () => [
          { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' },
          { accountId: 'a2', userId: 'u1', name: 'Cash', type: 'cash', balance: 50_000, isActive: true, createdAt: '', updatedAt: '' },
        ]),
        findById: vi.fn(async (userId: string, id: string) => {
          if (id === 'a1') return { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' };
          return { accountId: 'a2', userId: 'u1', name: 'Cash', type: 'cash', balance: 50_000, isActive: true, createdAt: '', updatedAt: '' };
        }),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_transfer } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_transfer, { fromAccountId: 'a1', toAccountId: 'a2', amount: 30_000, description: 'pindahin' });
    expect(res).toEqual({ status: 'error', message: 'Gagal mencatat transfer. Coba lagi.' });
  });

  it('update_transaction: returns ID message on error', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        update: vi.fn(async () => { throw new Error('column does not exist'); }),
      } as never,
    });
    const { update_transaction } = buildTools({ userId: 'u1', repos, hasAccount: true, lastTransactionId: 't-last' });
    const res = await callExec(update_transaction, { amount: 25_000 });
    expect(res).toEqual({ status: 'error', message: 'Gagal memperbarui transaksi. Coba lagi.' });
  });

  it('soft_delete_transaction: returns ID message on error', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => ({ transactionId: 't1', userId: 'u1', type: 'expense', amount: 20_000, description: 'bakso', categoryId: 'food.dining', accountId: 'a1', isRecurringInstance: false, date: '', createdAt: '', updatedAt: '', deletedAt: undefined })),
        softDelete: vi.fn(async () => { throw new Error('FK violation'); }),
      } as never,
    });
    const { soft_delete_transaction } = buildTools({ userId: 'u1', repos, hasAccount: true, lastTransactionId: 't-last' });
    const res = await callExec(soft_delete_transaction, {});
    expect(res).toEqual({ status: 'error', message: 'Gagal menghapus transaksi. Coba lagi.' });
  });

  it('create_budget_code: returns ID message on error', async () => {
    const repos = mockRepos({
      budgets: {
        create: vi.fn(async () => { throw new Error('unique constraint'); }),
      } as never,
    });
    const { create_budget_code } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_budget_code, { name: 'Jajan', monthlyBudget: 500_000 });
    expect(res).toEqual({ status: 'error', message: 'Gagal membuat budget code. Coba lagi.' });
  });

  it('create_recurring_payment: returns ID message on error', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
      } as never,
      accounts: {
        findAllByUserId: vi.fn(async () => [{ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' }]),
        findById: vi.fn(async () => ({ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' })),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
      recurrings: {
        create: vi.fn(async () => { throw new Error('schema mismatch'); }),
      } as never,
    });
    const { create_recurring_payment } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_recurring_payment, { name: 'Spotify', amount: 59_900, accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25 });
    expect(res).toEqual({ status: 'error', message: 'Gagal membuat pembayaran rutin. Coba lagi.' });
  });

  it('deactivate_recurring_payment: returns ID message on error', async () => {
    const repos = mockRepos({
      recurrings: {
        deactivate: vi.fn(async () => { throw new Error('not found'); }),
      } as never,
    });
    const { deactivate_recurring_payment } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(deactivate_recurring_payment, { recurringId: 'rp-x' });
    expect(res).toEqual({ status: 'error', message: 'Gagal menonaktifkan pembayaran rutin. Coba lagi.' });
  });
});

describe('buildTools — update_profile', () => {
  it('updates the user name and returns ok', async () => {
    const repos = mockRepos({
      users: {
        create: vi.fn(),
        update: vi.fn(async (_uid: string, patch: Record<string, unknown>) => ({
          userId: 'u1', telegramChatId: '999', name: patch.name ?? '',
          language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
        })),
      } as never,
    });
    const { update_profile } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(update_profile, { name: 'Devin' });
    expect(res.status).toBe('ok');
    expect(res.data).toMatchObject({ name: 'Devin' });
    expect((repos.users.update as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('u1', { name: 'Devin' });
  });

  it('updates language and timezone', async () => {
    const repos = mockRepos({
      users: {
        create: vi.fn(),
        update: vi.fn(async () => ({
          userId: 'u1', telegramChatId: '999', name: 'Devin',
          language: 'en', timezone: 'Asia/Makassar', createdAt: '', updatedAt: '',
        })),
      } as never,
    });
    const { update_profile } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(update_profile, { language: 'en', timezone: 'Asia/Makassar' });
    expect(res.status).toBe('ok');
    expect((repos.users.update as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('u1', { language: 'en', timezone: 'Asia/Makassar' });
  });

  it('returns missing_fields when no fields are provided', async () => {
    const repos = mockRepos();
    const { update_profile } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(update_profile, {});
    expect(res.status).toBe('missing_fields');
    expect(res.missing).toEqual(['name', 'language', 'timezone']);
  });

  it('returns Bahasa error when the repo throws (NFR-09)', async () => {
    const repos = mockRepos({
      users: {
        create: vi.fn(),
        update: vi.fn(async () => { throw new Error('DB DOWN'); }),
      } as never,
    });
    const { update_profile } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(update_profile, { name: 'Devin' });
    expect(res).toEqual({ status: 'error', message: 'Gagal memperbarui profil. Coba lagi.' });
    expect(logEvent).toHaveBeenCalledWith('error', expect.any(String), expect.objectContaining({ userId: 'u1' }));
  });

  it('is always available (not gated by hasAccount)', () => {
    const tools = buildTools({ userId: 'u1', repos: mockRepos(), hasAccount: false });
    expect(tools.update_profile).toBeDefined();
  });
});

describe('buildTools — remember_preference / forget_preference', () => {
  it('remember_preference upserts and returns ok', async () => {
    const repos = mockRepos();
    (repos.preferences.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', key: 'default_account', value: 'BCA', updatedAt: '2026-06-20T00:00:00Z',
    });
    const { remember_preference } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(remember_preference, { key: 'default_account', value: 'BCA' });
    expect(res.status).toBe('ok');
    expect(res.data).toEqual({ key: 'default_account', value: 'BCA', updatedAt: '2026-06-20T00:00:00Z' });
    expect(repos.preferences.upsert).toHaveBeenCalledWith('u1', 'default_account', 'BCA');
  });

  it('remember_preference returns missing_fields for an empty key', async () => {
    const repos = mockRepos();
    const { remember_preference } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(remember_preference, { key: '   ', value: 'x' });
    expect(res.status).toBe('missing_fields');
    expect(res.missing).toContain('key');
    expect(repos.preferences.upsert).not.toHaveBeenCalled();
  });

  it('remember_preference returns Bahasa error when the repo throws (NFR-09)', async () => {
    const repos = mockRepos();
    (repos.preferences.upsert as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SQL CONNECTION LOST'));
    const { remember_preference } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(remember_preference, { key: 'k', value: 'v' });
    expect(res).toEqual({ status: 'error', message: 'Gagal menyimpan preferensi. Coba lagi.' });
    expect(logEvent).toHaveBeenCalledWith('error', expect.any(String), expect.objectContaining({ userId: 'u1' }));
  });

  it('forget_preference deletes and returns ok (idempotent semantics)', async () => {
    const repos = mockRepos();
    const { forget_preference } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(forget_preference, { key: 'default_account' });
    expect(res.status).toBe('ok');
    expect(res.data).toEqual({ key: 'default_account' });
    expect(repos.preferences.delete).toHaveBeenCalledWith('u1', 'default_account');
  });

  it('forget_preference returns Bahasa error when the repo throws (NFR-09)', async () => {
    const repos = mockRepos();
    (repos.preferences.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('BOOM'));
    const { forget_preference } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(forget_preference, { key: 'k' });
    expect(res).toEqual({ status: 'error', message: 'Gagal menghapus preferensi. Coba lagi.' });
  });
});