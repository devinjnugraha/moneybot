import { describe, it, expect, vi } from 'vitest';
import { detectMorningGlance } from '../../../src/proactive/triggers/morning-glance.js';
import type { Repos } from '../../../src/repositories/interfaces.js';
import type { Account, BudgetCode, RecurringPayment, Transaction } from '../../../src/domain/entities.js';

// 2026-06-22T14:00:00Z == 21:00 WIB → WIB today = 2026-06-22.
const NOW = new Date('2026-06-22T14:00:00Z');

function mkAccount(over: Partial<Account>): Account {
  return { accountId: 'a', userId: 'u', name: '', type: 'bank', balance: 0, isActive: true, createdAt: '', updatedAt: '', ...over };
}
function mkRecurring(over: Partial<RecurringPayment>): RecurringPayment {
  return { recurringId: 'r', userId: 'u', name: '', amount: 0, accountId: 'a', categoryId: 'c', dayOfMonth: 1, isActive: true, nextFireAt: '2026-06-22', createdAt: '', updatedAt: '', ...over };
}
function mkTxn(over: Partial<Transaction>): Transaction {
  return { transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '', accountId: 'a', date: '2026-06-21', isRecurringInstance: false, createdAt: '', updatedAt: '', ...over };
}
function mkBudget(over: Partial<BudgetCode>): BudgetCode {
  return { budgetCodeId: 'b', userId: 'u', name: '', monthlyBudget: 0, month: 6, year: 2026, spent: 0, isRecurring: false, createdAt: '', updatedAt: '', ...over };
}

function mockRepos(opts: { accounts?: Account[]; recurrings?: RecurringPayment[]; yesterday?: Transaction[]; txns?: Transaction[]; budgets?: BudgetCode[] } = {}): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(async () => opts.accounts ?? []), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(),
      // Range-aware like the real repo: serves both the yesterday slice and the
      // month-to-date fetch pacing consumes.
      findByDateRange: vi.fn(async (_u: string, from: string, to: string) =>
        [...(opts.yesterday ?? []), ...(opts.txns ?? [])].filter((t) => t.date >= from && t.date <= to)),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(async () => opts.budgets ?? []), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(async () => opts.recurrings ?? []), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    cardStatements: { ensureEndedCycles: vi.fn(), getWithFigures: vi.fn(async () => []) } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

describe('detectMorningGlance', () => {
  it('returns [] when the user has no active accounts (nothing to glance at)', async () => {
    const repos = mockRepos({ accounts: [] });
    expect(await detectMorningGlance({ userId: 'u', repos, now: NOW })).toEqual([]);
  });

  it('partitions recurrings into todayDueBills vs upcoming, excluding today from upcoming', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca', name: 'BCA' })],
      recurrings: [
        mkRecurring({ recurringId: 'r1', name: 'Spotify', amount: 59_900, accountId: 'bca', nextFireAt: '2026-06-22' }),
        mkRecurring({ recurringId: 'r2', name: 'Netflix', amount: 75_000, accountId: 'bca', nextFireAt: '2026-06-25' }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    const data = out[0]!.data as { todayDueBills: { recurringId: string }[]; upcoming: { name: string }[] };
    expect(data.todayDueBills.map((b) => b.recurringId)).toEqual(['r1']);
    expect(data.upcoming.map((b) => b.name)).toEqual(['Netflix']);
  });

  it('excludes a bill already processed this month (lastFiredAt this month) from todayDueBills', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca', name: 'BCA' })],
      recurrings: [
        mkRecurring({ recurringId: 'r1', name: 'Spotify', nextFireAt: '2026-06-22', lastFiredAt: '2026-06-22' }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { todayDueBills: unknown[] };
    expect(data.todayDueBills).toEqual([]);
  });

  it('keeps a bill fired in a previous month eligible again', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca', name: 'BCA' })],
      recurrings: [
        mkRecurring({ recurringId: 'r1', name: 'Spotify', nextFireAt: '2026-06-22', lastFiredAt: '2026-05-22' }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { todayDueBills: { recurringId: string }[] };
    expect(data.todayDueBills.map((b) => b.recurringId)).toEqual(['r1']);
  });

  it('builds dedup key from the WIB date and selects the llm channel', async () => {
    const repos = mockRepos({ accounts: [mkAccount({ accountId: 'bca' })] });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    expect(out[0]!.dedupKey).toBe('morning-glance:2026-06-22');
    expect(out[0]!.channel).toBe('llm');
    expect(out[0]!.triggerType).toBe('morning_glance');
  });

  it('sums only expenses for yesterday and nulls when none', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca' })],
      yesterday: [
        mkTxn({ type: 'expense', amount: 30_000 }),
        mkTxn({ type: 'transfer', amount: 500_000 }),
        mkTxn({ type: 'expense', amount: 20_000 }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { yesterday: { count: number; totalSpend: number } | null };
    expect(data.yesterday).toEqual({ count: 2, totalSpend: 50_000 });

    const reposEmpty = mockRepos({ accounts: [mkAccount({ accountId: 'bca' })], yesterday: [] });
    const empty = await detectMorningGlance({ userId: 'u', repos: reposEmpty, now: NOW });
    expect((empty[0]!.data as { yesterday: unknown }).yesterday).toBeNull();
  });

  it('adds month budgets sorted by pct desc with remaining, excluding zero-alloc codes', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca' })],
      budgets: [
        mkBudget({ budgetCodeId: 'b1', name: 'Makan', monthlyBudget: 600_000, spent: 450_000 }),
        mkBudget({ budgetCodeId: 'b2', name: 'Transport', monthlyBudget: 400_000, spent: 120_000 }),
        mkBudget({ budgetCodeId: 'b3', name: 'Hiburan', monthlyBudget: 0, spent: 0 }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { budgets: { name: string; pct: number; remaining: number; alloc: number; spent: number }[] };
    expect(data.budgets.map((b) => b.name)).toEqual(['Makan', 'Transport']); // 75% before 30%
    expect(data.budgets[0]).toMatchObject({ spent: 450_000, alloc: 600_000, remaining: 150_000, pct: 0.75 });
    expect(data.budgets.map((b) => b.name)).not.toContain('Hiburan'); // monthlyBudget 0 filtered
  });

  it('surfaces unpaid card statements due within 7 days or overdue as cardDue', async () => {
    const due = { statementId: 's', userId: 'u', accountId: 'cc', cycleStart: '', cycleEnd: '2026-07-05', createdAt: '', updatedAt: '', newCharges: 300_000, amountPaid: 0, remainingDue: 300_000, status: 'open', dueDate: '2026-06-25', overdue: true };
    // mkAccount doesn't model card billing fields, so use a card literal.
    const card: Account = { accountId: 'cc', userId: 'u', name: 'BCA CC', type: 'card', balance: -300_000, creditLimit: 5_000_000, billingDay: 5, dueInDays: 15, isActive: true, createdAt: '', updatedAt: '' };
    const repos = mockRepos({ accounts: [card] });
    ;(repos.cardStatements as { getWithFigures: (u: string, a: string, t?: Date) => Promise<unknown[]> }).getWithFigures =
      vi.fn(async () => [due]);
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { cardDue: { account: string; remainingDue: number; overdue: boolean }[] };
    expect(data.cardDue).toHaveLength(1);
    expect(data.cardDue[0]).toMatchObject({ account: 'BCA CC', remainingDue: 300_000, overdue: true });
  });

  it('adds pacing items for tight/over_pace budgets (cap 3, over_pace first)', async () => {
    // NOW = 2026-06-22 → elapsed 22/30 (≥ 5, so lowConfidence is false and moot).
    // makan: 900k spent of 1M → projected round(900k/22*30) = 1,227,273 > 1.15M → over_pace.
    // jajan: 700k of 1M → projected ~954,545 ≤ 1M → on_track (must be excluded).
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca' })],
      txns: [
        mkTxn({ type: 'expense', amount: 900_000, budgetCodeId: 'b1', date: '2026-06-20' }),
        mkTxn({ type: 'expense', amount: 700_000, budgetCodeId: 'b2', date: '2026-06-21' }),
      ],
      budgets: [
        mkBudget({ budgetCodeId: 'b1', name: 'makan', monthlyBudget: 1_000_000 }),
        mkBudget({ budgetCodeId: 'b2', name: 'jajan', monthlyBudget: 1_000_000 }),
      ],
    });
    const [payload] = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = payload!.data as { pacing?: { name: string; projected: number; alloc: number; verdict: 'tight' | 'over_pace' }[] };
    expect(data.pacing).toBeDefined();
    expect(data.pacing![0]).toMatchObject({ name: 'makan', verdict: 'over_pace', projected: 1_227_273, alloc: 1_000_000 });
    expect(data.pacing!.map((p) => p.name)).toEqual(['makan']); // on_track 'jajan' excluded
  });

  it('caps pacing at 3 with over_pace first, then tight by projected desc', async () => {
    // elapsed 22/30. over: a (spent 900k/1M → 1,227,273 > 1.15M), b (950k/1M → 1,295,455).
    // tight: c (800k/1M → 1,090,909 ∈ (1M, 1.15M]), d (750k/1M → 1,022,727 tight).
    // over_pace first (b, a by projected desc), then tight (c, d) — cap 3 keeps b, a, c.
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca' })],
      txns: [
        mkTxn({ type: 'expense', amount: 900_000, budgetCodeId: 'b1', date: '2026-06-20' }),
        mkTxn({ type: 'expense', amount: 950_000, budgetCodeId: 'b2', date: '2026-06-21' }),
        mkTxn({ type: 'expense', amount: 800_000, budgetCodeId: 'b3', date: '2026-06-21' }),
        mkTxn({ type: 'expense', amount: 750_000, budgetCodeId: 'b4', date: '2026-06-21' }),
      ],
      budgets: [
        mkBudget({ budgetCodeId: 'b1', name: 'a', monthlyBudget: 1_000_000 }),
        mkBudget({ budgetCodeId: 'b2', name: 'b', monthlyBudget: 1_000_000 }),
        mkBudget({ budgetCodeId: 'b3', name: 'c', monthlyBudget: 1_000_000 }),
        mkBudget({ budgetCodeId: 'b4', name: 'd', monthlyBudget: 1_000_000 }),
      ],
    });
    const [payload] = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = payload!.data as { pacing?: { name: string; verdict: string }[] };
    expect(data.pacing!.map((p) => p.name)).toEqual(['b', 'a', 'c']);
    expect(data.pacing!.every((p) => p.verdict !== 'on_track')).toBe(true);
  });

  it('omits data.pacing entirely when every budget is on_track', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca' })],
      txns: [mkTxn({ type: 'expense', amount: 300_000, budgetCodeId: 'b1', date: '2026-06-21' })],
      budgets: [mkBudget({ budgetCodeId: 'b1', name: 'makan', monthlyBudget: 1_000_000 })],
    });
    const [payload] = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    expect((payload!.data as Record<string, unknown>).pacing).toBeUndefined();
  });
});
