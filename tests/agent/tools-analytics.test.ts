import { describe, it, expect, vi } from 'vitest';
import { buildTools } from '../../src/agent/tools.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { Account, RecurringPayment, Transaction } from '../../src/domain/entities.js';
import type { PacingResult } from '../../src/domain/analytics/pacing.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

function mockRepos(opts: { txns?: Transaction[] } = {}): Repos {
  const findByDateRange = vi.fn(async (_userId: string, from: string, _to: string) =>
    (opts.txns ?? []).filter((t) => t.date >= from && t.date <= _to),
  );
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(async () => []), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(), findByDateRange,
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(async () => []), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn(), rollRecurringIntoMonth: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(async () => []), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    cardStatements: {} as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

// Narrow result shape for assertions (mirrors tools.test.ts's ToolCallResult).
type AnalyticsResult = {
  currentTotal?: number;
  previousTotal?: number;
  deltaPct?: number;
  comparison?: { label: string; from: string; to: string };
  groups?: Array<{ key: string; label: string; icon?: string }>;
  cashflow?: { income: number; expense: number; net: number; savingsRate?: number };
  pacing?: PacingResult;
};

describe('buildTools — get_analytics', () => {
  it('is registered as a read tool even before onboarding (hasAccount=false)', () => {
    const tools = buildTools({ userId: 'u1', repos: mockRepos(), hasAccount: false });
    expect(tools.get_analytics).toBeDefined();
  });

  it('current + previous month compare with category labels and deltas', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-08-05', categoryId: 'food.coffee', amount: 200_000 }),
        mkTxn({ date: '2026-07-10', categoryId: 'food.coffee', amount: 100_000 }),
      ],
    });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics!.execute!(
      { from: '2026-08-01', to: '2026-08-31', compareWith: 'previous_month', breakdown: 'category' },
      { toolCallId: 'c', messages: [] as never },
    ) as AnalyticsResult;
    expect(out.currentTotal).toBe(200_000);
    expect(out.previousTotal).toBe(100_000);
    expect(out.deltaPct).toBe(100);
    expect(out.comparison).toEqual({ label: 'previous_month', from: '2026-07-01', to: '2026-07-31' });
    const coffee = out.groups!.find((g) => g.key === 'food.coffee');
    expect(coffee?.label).toBe('Kopi & Minuman'); // CATEGORIES label decoration
    expect(coffee?.icon).toBe('☕');
  });

  it('includes cashflow + savingsRate when the range spans >= 28 days', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-08-02', type: 'income', amount: 5_000_000 }),
        mkTxn({ date: '2026-08-03', amount: 4_000_000 }),
      ],
    });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics!.execute!(
      { from: '2026-08-01', to: '2026-08-31' },
      { toolCallId: 'c', messages: [] as never },
    ) as AnalyticsResult;
    expect(out.cashflow).toEqual({ income: 5_000_000, expense: 4_000_000, net: 1_000_000, savingsRate: 20 });
  });

  it('omits cashflow for short ranges', async () => {
    const repos = mockRepos({ txns: [mkTxn({ date: '2026-08-02', amount: 10_000 })] });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics!.execute!(
      { from: '2026-08-01', to: '2026-08-07' },
      { toolCallId: 'c', messages: [] as never },
    ) as AnalyticsResult;
    expect(out.cashflow).toBeUndefined();
  });

  it('drill-down: categoryId filter restricts groups', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-08-05', categoryId: 'food.coffee', amount: 50_000 }),
        mkTxn({ date: '2026-08-06', categoryId: 'transport.fuel', amount: 60_000 }),
      ],
    });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics!.execute!(
      { from: '2026-08-01', to: '2026-08-31', categoryId: 'food.coffee' },
      { toolCallId: 'c', messages: [] as never },
    ) as AnalyticsResult;
    expect(out.currentTotal).toBe(50_000);
    expect(out.groups).toHaveLength(1);
  });

  it('description breakdown labels groups by normalized key', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-08-05', description: 'Kopi Kenangan', amount: 50_000 }),
        mkTxn({ date: '2026-08-06', description: 'kopi kenangan 2x', amount: 25_000 }),
      ],
    });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics!.execute!(
      { from: '2026-08-01', to: '2026-08-31', breakdown: 'description' },
      { toolCallId: 'c', messages: [] as never },
    ) as AnalyticsResult;
    expect(out.groups).toHaveLength(1);
    expect(out.groups![0]!.label).toBe('kopi kenangan');
  });
});

describe('buildTools — get_analytics pacing', () => {
  it('includes pacing when the range covers the current WIB month', async () => {
    vi.setSystemTime(new Date('2026-08-16T03:00:00Z')); // WIB 2026-08-16
    try {
      const repos = mockRepos({ txns: [mkTxn({ date: '2026-08-10', amount: 600_000, budgetCodeId: 'b1' })] });
      (repos.budgets.findByUserAndMonth as ReturnType<typeof vi.fn>)
        .mockResolvedValue([{ budgetCodeId: 'b1', userId: 'u', name: 'makan', monthlyBudget: 1_000_000, month: 8, year: 2026, spent: 600_000, isRecurring: false, createdAt: '', updatedAt: '' }]);
      const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
      const out = await get_analytics!.execute!(
        { from: '2026-08-01', to: '2026-08-31' },
        { toolCallId: 'c', messages: [] as never },
      ) as AnalyticsResult;
      expect(out.pacing).toBeDefined();
      // 600k spent by day 16 of 31 → projected 1.162.500 > 1M×1.15 → over_pace
      expect(out.pacing!.items[0]).toMatchObject({ name: 'makan', verdict: 'over_pace' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits pacing for past ranges', async () => {
    const repos = mockRepos({ txns: [] });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics!.execute!(
      { from: '2026-06-01', to: '2026-06-30' },
      { toolCallId: 'c', messages: [] as never },
    ) as AnalyticsResult;
    expect(out.pacing).toBeUndefined();
  });

  const B1_ROW = {
    budgetCodeId: 'b1', userId: 'u', name: 'makan', monthlyBudget: 1_000_000,
    month: 8, year: 2026, spent: 0, isRecurring: false, createdAt: '', updatedAt: '',
  };

  it('wide range spanning months: pacing counts only the current month', async () => {
    vi.setSystemTime(new Date('2026-08-16T03:00:00Z')); // WIB 2026-08-16
    try {
      const repos = mockRepos({
        txns: [
          mkTxn({ date: '2026-07-15', amount: 900_000, budgetCodeId: 'b1' }), // July — must not count
          mkTxn({ date: '2026-08-10', amount: 600_000, budgetCodeId: 'b1' }),
        ],
      });
      (repos.budgets.findByUserAndMonth as ReturnType<typeof vi.fn>).mockResolvedValue([B1_ROW]);
      const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
      const out = await get_analytics!.execute!(
        { from: '2026-07-01', to: '2026-09-30' }, // Q3-style wide range covering today
        { toolCallId: 'c', messages: [] as never },
      ) as AnalyticsResult;
      expect(out.pacing).toBeDefined();
      expect(out.pacing!.items[0]!.spent).toBe(600_000);   // not 1_500_000
      expect(out.currentTotal).toBe(1_500_000);            // groups still span the full range
    } finally {
      vi.useRealTimers();
    }
  });

  it('range starting mid-month: pacing still reads the month from day 1', async () => {
    vi.setSystemTime(new Date('2026-08-16T03:00:00Z'));
    try {
      const repos = mockRepos({ txns: [mkTxn({ date: '2026-08-05', amount: 600_000, budgetCodeId: 'b1' })] });
      (repos.budgets.findByUserAndMonth as ReturnType<typeof vi.fn>).mockResolvedValue([B1_ROW]);
      const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
      const out = await get_analytics!.execute!(
        { from: '2026-08-10', to: '2026-08-31' }, // covers today, excludes Aug 1–9
        { toolCallId: 'c', messages: [] as never },
      ) as AnalyticsResult;
      expect(out.pacing).toBeDefined();
      expect(out.pacing!.items[0]!.spent).toBe(600_000);   // currentRows would give 0
    } finally {
      vi.useRealTimers();
    }
  });

  it('drill-down: pacing keeps full-month spend for every budget', async () => {
    vi.setSystemTime(new Date('2026-08-16T03:00:00Z'));
    try {
      const repos = mockRepos({
        txns: [
          mkTxn({ date: '2026-08-05', categoryId: 'food.coffee', amount: 50_000, budgetCodeId: 'b1' }),
          mkTxn({ date: '2026-08-06', categoryId: 'transport.fuel', amount: 600_000, budgetCodeId: 'b1' }),
        ],
      });
      (repos.budgets.findByUserAndMonth as ReturnType<typeof vi.fn>).mockResolvedValue([B1_ROW]);
      const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
      const out = await get_analytics!.execute!(
        { from: '2026-08-01', to: '2026-08-31', categoryId: 'food.coffee' },
        { toolCallId: 'c', messages: [] as never },
      ) as AnalyticsResult;
      expect(out.currentTotal).toBe(50_000);              // groups stay drilled
      expect(out.pacing!.items[0]!.spent).toBe(650_000);  // pacing sees both budgets' spend
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildTools — get_financial_health', () => {
  type HealthResult = {
    month?: string;
    asOf?: string;
    score?: number;
    error?: string;
    components?: Array<{ key: string; status: string; display: string }>;
  };

  const budgetRows = [
    { budgetCodeId: 'b1', userId: 'u1', name: 'makan', monthlyBudget: 1_000_000, month: 8, year: 2026, spent: 400_000, isRecurring: false, createdAt: '', updatedAt: '' },
  ];

  function healthRepos(txns: Transaction[], opts: { accounts?: Account[]; recurrings?: RecurringPayment[] } = {}): Repos {
    const base = mockRepos({ txns });
    (base.accounts.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue(opts.accounts ?? []);
    (base.recurrings.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue(opts.recurrings ?? []);
    (base.budgets.findByUserAndMonth as ReturnType<typeof vi.fn>).mockResolvedValue(budgetRows);
    return base;
  }

  it('is a read tool (registered before onboarding)', () => {
    expect(buildTools({ userId: 'u1', repos: mockRepos(), hasAccount: false }).get_financial_health).toBeDefined();
  });

  it('returns score + components for a healthy current month', async () => {
    vi.setSystemTime(new Date('2026-08-16T03:00:00Z')); // WIB 2026-08-16
    try {
      const txns: Transaction[] = [
        // trailing months: 5.0M income, ~3.5M expense each
        ...([['2026-05', 3_500_000], ['2026-06', 3_500_000], ['2026-07', 3_600_000]] as const).flatMap(([mo, exp]) => [
          mkTxn({ date: `${mo}-10`, type: 'income', amount: 5_000_000 }),
          mkTxn({ date: `${mo}-15`, amount: exp }),
        ]),
        // current month
        mkTxn({ date: '2026-08-05', type: 'income', amount: 5_000_000 }),
        mkTxn({ date: '2026-08-10', amount: 1_000_000, budgetCodeId: 'b1' }),
      ];
      const accounts: Account[] = [{ accountId: 'a1', userId: 'u1', name: 'bca', type: 'bank', balance: 15_000_000, isDefault: false, isActive: true, createdAt: '', updatedAt: '' }];
      const { get_financial_health } = buildTools({ userId: 'u1', repos: healthRepos(txns, { accounts }), hasAccount: true });
      const out = await get_financial_health!.execute!(
        {},
        { toolCallId: 'c', messages: [] as never },
      ) as HealthResult;
      expect(out.month).toBe('2026-08');
      expect(out.score).toEqual(expect.any(Number));
      expect(out.components!.map((c) => c.key)).toEqual(['savings_rate', 'budget_adherence', 'bill_coverage', 'runway', 'leak_flags', 'trend']);
      const runway = out.components!.find((c) => c.key === 'runway')!;
      expect(runway.status).toBe('good'); // 15M / ~3.53M ≈ 4.2 bulan
    } finally {
      vi.useRealTimers();
    }
  });

  it('past month: bill_coverage not_applicable, no obligations fetch needed', async () => {
    const txns: Transaction[] = [mkTxn({ date: '2026-07-10', type: 'income', amount: 5_000_000 }), mkTxn({ date: '2026-07-15', amount: 3_000_000 })];
    const accounts: Account[] = [{ accountId: 'a1', userId: 'u1', name: 'bca', type: 'bank', balance: 10_000_000, isDefault: false, isActive: true, createdAt: '', updatedAt: '' }];
    const { get_financial_health } = buildTools({ userId: 'u1', repos: healthRepos(txns, { accounts }), hasAccount: true });
    const out = await get_financial_health!.execute!(
      { month: '2026-07' },
      { toolCallId: 'c', messages: [] as never },
    ) as HealthResult;
    expect(out.asOf).toBe('2026-07-31');
    const coverage = out.components!.find((c) => c.key === 'bill_coverage')!;
    expect(coverage.status).toBe('not_applicable');
  });

  it('thin history: components degrade, tool never errors', async () => {
    vi.setSystemTime(new Date('2026-08-16T03:00:00Z'));
    try {
      const { get_financial_health } = buildTools({ userId: 'u1', repos: healthRepos([]), hasAccount: true });
      const out = await get_financial_health!.execute!(
        {},
        { toolCallId: 'c', messages: [] as never },
      ) as HealthResult;
      const statuses = out.components!.map((c) => c.status);
      expect(statuses).toContain('insufficient_data');
      expect(out.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
