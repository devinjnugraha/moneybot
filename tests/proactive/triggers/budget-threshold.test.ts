import { describe, it, expect, vi } from 'vitest';
import { createBudgetThresholdDetector } from '../../../src/proactive/triggers/budget-threshold.js';
import type { Repos } from '../../../src/repositories/interfaces.js';
import type { BudgetCode } from '../../../src/domain/entities.js';

function mkBudget(over: Partial<BudgetCode>): BudgetCode {
  return {
    budgetCodeId: 'b', userId: 'u', name: 'n', monthlyBudget: 0, spent: 0,
    month: 6, year: 2026, createdAt: '', updatedAt: '',
    ...over,
  };
}

function mockRepos(opts: { budgets?: BudgetCode[] } = {}): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: { create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn() } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: {
      findByUserAndMonth: vi.fn(async () => opts.budgets ?? []),
      findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn(),
    } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

// 2026-06-22T14:00:00Z == 2026-06-22 21:00 WIB => month 2026-06.
const NOW = new Date('2026-06-22T14:00:00Z');
const detect = createBudgetThresholdDetector([80, 100]);

describe('detectBudgetThreshold', () => {
  it('returns [] when there are no budgets', async () => {
    const repos = mockRepos({ budgets: [] });
    const out = await detect({ userId: 'u', repos, now: NOW });
    expect(out).toEqual([]);
  });

  it('returns [] when pct is below all thresholds', async () => {
    const repos = mockRepos({
      budgets: [mkBudget({ budgetCodeId: 'b1', name: 'food', monthlyBudget: 100000, spent: 50000 })],
    });
    const out = await detect({ userId: 'u', repos, now: NOW });
    expect(out).toEqual([]);
  });

  it('emits one payload at pct80 when spent reaches 80% but not 100%', async () => {
    const repos = mockRepos({
      budgets: [mkBudget({ budgetCodeId: 'b1', name: 'food', monthlyBudget: 100000, spent: 82000 })],
    });
    const out = await detect({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.dedupKey).toBe('budget:b1:2026-06:pct80');
    expect(out[0]!.channel).toBe('template');
    expect(out[0]!.triggerType).toBe('budget_threshold');
    expect(out[0]!.data).toMatchObject({ codeId: 'b1', name: 'food', spent: 82000, alloc: 100000, level: 80 });
  });

  it('emits both pct80 and pct100 when spent reaches 100%', async () => {
    const repos = mockRepos({
      budgets: [mkBudget({ budgetCodeId: 'b1', name: 'food', monthlyBudget: 100000, spent: 105000 })],
    });
    const out = await detect({ userId: 'u', repos, now: NOW });
    const keys = out.map((p) => p.dedupKey).sort();
    expect(keys).toEqual(['budget:b1:2026-06:pct100', 'budget:b1:2026-06:pct80']);
  });

  it('emits only the crossed code across multiple budgets', async () => {
    const repos = mockRepos({
      budgets: [
        mkBudget({ budgetCodeId: 'b1', name: 'food', monthlyBudget: 100000, spent: 81000 }),
        mkBudget({ budgetCodeId: 'b2', name: 'transport', monthlyBudget: 200000, spent: 40000 }),
      ],
    });
    const out = await detect({ userId: 'u', repos, now: NOW });
    expect(out.map((p) => p.dedupKey)).toEqual(['budget:b1:2026-06:pct80']);
  });

  it('skips budgets with zero monthlyBudget (avoid divide by zero)', async () => {
    const repos = mockRepos({
      budgets: [mkBudget({ budgetCodeId: 'b1', name: 'food', monthlyBudget: 0, spent: 1000 })],
    });
    const out = await detect({ userId: 'u', repos, now: NOW });
    expect(out).toEqual([]);
  });
});
