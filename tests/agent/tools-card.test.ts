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
