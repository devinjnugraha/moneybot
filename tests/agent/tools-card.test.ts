import { describe, it, expect, vi } from 'vitest';
import type { CoreTool } from 'ai';
import { buildTools } from '../../src/agent/tools.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { Account, Transaction } from '../../src/domain/entities.js';

vi.mock('../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));

function card(over: Partial<Account> = {}): Account {
  return {
    accountId: 'card1', userId: 'u', name: 'BCA CC', type: 'card',
    balance: -300_000, creditLimit: 5_000_000, billingDay: 5, dueInDays: 15,
    isActive: true, createdAt: '', updatedAt: '', ...over,
  };
}
function fund(): Account {
  return {
    accountId: 'bank1', userId: 'u', name: 'BCA', type: 'bank',
    balance: 1_000_000, isActive: true, createdAt: '', updatedAt: '',
  };
}

type ToolResult = {
  status?: string;
  field?: string;
  data?: { card?: { paidAmount?: number; remainingOwed?: number } };
};

function mockRepos(over: Partial<Repos> = {}): Repos {
  const accountsById = new Map<string, Account>([['card1', card()], ['bank1', fund()]]);
  return {
    users: {} as never,
    accounts: {
      findById: vi.fn(async (_u: string, id: string) => accountsById.get(id) ?? null),
      findByName: vi.fn(async (_u: string, name: string) =>
        [...accountsById.values()].find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null),
      findAllByUserId: vi.fn(async () => [...accountsById.values()]),
      create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
    } as never,
    transactions: {
      createTransfer: vi.fn(async (i: { amount: number; fromAccountId: string; toAccountId: string }) => ({
        transactionId: 't1', userId: 'u', type: 'transfer' as const, amount: i.amount,
        description: '', accountId: i.fromAccountId, toAccountId: i.toAccountId,
        date: '', createdAt: '', updatedAt: '', isRecurringInstance: false,
      }) as Transaction),
      create: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(),
      findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    cardStatements: {
      ensureEndedCycles: vi.fn(),
      getWithFigures: vi.fn(async () => []),
    } as never,
    sessions: {} as never, budgets: {} as never, recurrings: {} as never,
    preferences: {} as never, outreach: {} as never, proactiveSettings: {} as never,
    ...over,
  } as never;
}

async function callExec(t: CoreTool | undefined, args: unknown): Promise<ToolResult> {
  return t!.execute!(args as never, {} as never) as Promise<ToolResult>;
}

describe('pay_card_bill', () => {
  it('defaults amount to the full outstanding and returns ok', async () => {
    const repos = mockRepos();
    const { pay_card_bill } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(pay_card_bill, { cardAccountId: 'card1', fromAccountId: 'bank1' });
    expect(res.status).toBe('ok');
    expect(repos.transactions.createTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 300_000, toAccountId: 'card1' }));
    expect(res.data?.card?.paidAmount).toBe(300_000);
    expect(res.data?.card?.remainingOwed).toBe(0);
  });

  it('rejects a non-card / no-billing-day target with error', async () => {
    const accountsById = new Map<string, Account>([
      ['card1', card({ billingDay: undefined })],
      ['bank1', fund()],
    ]);
    const repos = mockRepos({
      accounts: {
        findById: vi.fn(async (_u: string, id: string) => accountsById.get(id) ?? null),
        findByName: vi.fn(),
        findAllByUserId: vi.fn(async () => [...accountsById.values()]),
        create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
      } as never,
    });
    const { pay_card_bill } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(pay_card_bill, { cardAccountId: 'card1', fromAccountId: 'bank1' });
    expect(res.status).toBe('error');
    expect(repos.transactions.createTransfer).not.toHaveBeenCalled();
  });

  it('rejects overpayment (> totalOwed) with error and never throws', async () => {
    const repos = mockRepos();
    const { pay_card_bill } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(pay_card_bill, { cardAccountId: 'card1', fromAccountId: 'bank1', amount: 999_999 });
    expect(res.status).toBe('error');
  });

  it('returns error when nothing is owed', async () => {
    const accountsById = new Map<string, Account>([
      ['card1', card({ balance: 0 })],
      ['bank1', fund()],
    ]);
    const repos = mockRepos({
      accounts: {
        findById: vi.fn(async (_u: string, id: string) => accountsById.get(id) ?? null),
        findByName: vi.fn(),
        findAllByUserId: vi.fn(async () => [...accountsById.values()]),
        create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
      } as never,
    });
    const { pay_card_bill } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(pay_card_bill, { cardAccountId: 'card1', fromAccountId: 'bank1' });
    expect(res.status).toBe('error');
  });

  it('returns ambiguous when the from-account is unknown', async () => {
    const repos = mockRepos();
    const { pay_card_bill } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(pay_card_bill, { cardAccountId: 'card1', fromAccountId: 'nope' });
    expect(res.status).toBe('ambiguous');
    expect(res.field).toBe('fromAccountId');
  });
});

describe('get_card_statements', () => {
  it('returns derived statements for cards, excluding paid by default', async () => {
    const repos = mockRepos({
      cardStatements: {
        ensureEndedCycles: vi.fn(),
        getWithFigures: vi.fn(async () => [
          { statementId: 's1', userId: 'u', accountId: 'card1', cycleStart: '2026-06-05', cycleEnd: '2026-07-05', createdAt: '', updatedAt: '', newCharges: 300_000, amountPaid: 0, remainingDue: 300_000, status: 'open', dueDate: '2026-07-20', overdue: false },
          { statementId: 's2', userId: 'u', accountId: 'card1', cycleStart: '2026-05-05', cycleEnd: '2026-06-05', createdAt: '', updatedAt: '', newCharges: 100_000, amountPaid: 100_000, remainingDue: 0, status: 'paid', dueDate: '2026-06-20', overdue: false },
        ]),
      } as never,
    });
    const { get_card_statements } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(get_card_statements, {}) as unknown as Array<{ remainingDue: number }>;
    expect(res).toHaveLength(1);
    expect(res[0]!.remainingDue).toBe(300_000);
    const withPaid = await callExec(get_card_statements, { includePaid: true }) as unknown as Array<{ remainingDue: number }>;
    expect(withPaid).toHaveLength(2);
  });
});

describe('update_account', () => {
  it('patches billingDay/dueInDays and returns ok', async () => {
    const update = vi.fn(async (_u: string, _id: string, patch: Record<string, unknown>) => ({ accountId: 'card1', billingDay: patch.billingDay, dueInDays: patch.dueInDays })) as never;
    const repos = mockRepos({
      accounts: {
        findById: vi.fn(async () => card()),
        findByName: vi.fn(),
        findAllByUserId: vi.fn(async () => []),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update,
      } as never,
    });
    const { update_account } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(update_account, { accountId: 'card1', billingDay: 10, dueInDays: 20 });
    expect(res.status).toBe('ok');
    expect(update).toHaveBeenCalled();
  });

  it('returns missing_fields when no field is given', async () => {
    const repos = mockRepos();
    const { update_account } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(update_account, { accountId: 'card1' });
    expect(res.status).toBe('missing_fields');
  });
});

describe('get_accounts enrichment', () => {
  it('exposes billingDay/dueInDays/availableLimit/owed for cards only', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => [card(), fund()]),
        findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
      } as never,
    });
    const { get_accounts } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(get_accounts, {}) as unknown as Array<{
      type: string;
      billingDay?: number;
      availableLimit?: number;
      owed?: number;
    }>;
    const c = res.find((a) => a.type === 'card');
    expect(c!.billingDay).toBe(5);
    expect(c!.availableLimit).toBe(4_700_000);
    expect(c!.owed).toBe(300_000);
    const b = res.find((a) => a.type === 'bank');
    expect(b!.billingDay).toBeUndefined();
  });
});
