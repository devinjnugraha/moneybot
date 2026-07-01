import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonBudgetCodeRepository } from '../../src/adapters/neon/budget-code.repository.js';
import { uniqueChatId } from '../helpers/db.js';
import { wibYear, wibMonth } from '../../src/domain/time.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
}

function priorMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

describe('NeonBudgetCodeRepository', () => {
  it('creates a budget code and finds it by user + month + year', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const bc = await budgets.create({ userId: user.userId, name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026 });
    expect(bc.name).toBe('Jajan');
    expect(bc.spent).toBe(0);
    const found = await budgets.findByUserAndMonth(user.userId, 2026, 6);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('Jajan');
    expect(bc.isRecurring).toBe(false); // default for a manual create
    expect(bc.oldBudgetId).toBeUndefined();
    expect(found[0]!.isRecurring).toBe(false);
  });

  it('finds by name (case-insensitive) within a month/year', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    await budgets.create({ userId: user.userId, name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026 });
    const found = await budgets.findByName(user.userId, 'jajan', 2026, 6);
    expect(found?.monthlyBudget).toBe(500_000);
  });

  it('increments spent', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const bc = await budgets.create({ userId: user.userId, name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026 });
    await budgets.incrementSpent(user.userId, bc.budgetCodeId, 50_000);
    await budgets.incrementSpent(user.userId, bc.budgetCodeId, 25_000);
    const found = await budgets.findByName(user.userId, 'Jajan', 2026, 6);
    expect(found?.spent).toBe(75_000);
  });

  it('scopes budget codes per user + month + year (isolation)', async () => {
    const userA = await seedUser();
    const userB = await new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'B' });
    const budgets = new NeonBudgetCodeRepository();
    await budgets.create({ userId: userA.userId, name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026 });
    await budgets.create({ userId: userB.userId, name: 'Jajan', monthlyBudget: 300_000, month: 6, year: 2026 });
    const aBudgets = await budgets.findByUserAndMonth(userA.userId, 2026, 6);
    expect(aBudgets).toHaveLength(1);
    await budgets.create({ userId: userA.userId, name: 'Jajan', monthlyBudget: 600_000, month: 7, year: 2026 });
    const aJune = await budgets.findByUserAndMonth(userA.userId, 2026, 6);
    expect(aJune).toHaveLength(1);
    const aJuly = await budgets.findByUserAndMonth(userA.userId, 2026, 7);
    expect(aJuly).toHaveLength(1);
  });

  it('persists isRecurring on create (defaults false when omitted)', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const recurring = await budgets.create({
      userId: user.userId, name: 'Terea', monthlyBudget: 300_000, month: 6, year: 2026, isRecurring: true,
    });
    expect(recurring.isRecurring).toBe(true);

    const oneTime = await budgets.create({
      userId: user.userId, name: 'Trip', monthlyBudget: 1_000_000, month: 6, year: 2026,
    });
    expect(oneTime.isRecurring).toBe(false);
  });

  it('updates a budget code field', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const bc = await budgets.create({ userId: user.userId, name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026 });
    const updated = await budgets.update(user.userId, bc.budgetCodeId, { monthlyBudget: 750_000 });
    expect(updated.monthlyBudget).toBe(750_000);
  });

  it('rolls a prior-month recurring budget into the current month (spent reset, lineage set)', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const cur = { year: wibYear(), month: wibMonth() };
    const prev = priorMonth(cur.year, cur.month);
    const src = await budgets.create({
      userId: user.userId, name: 'Terea', monthlyBudget: 300_000, month: prev.month, year: prev.year, isRecurring: true,
    });
    await budgets.incrementSpent(user.userId, src.budgetCodeId, 120_000);

    const created = await budgets.rollRecurringIntoMonth(user.userId, cur.year, cur.month);
    expect(created).toBe(1);

    const current = await budgets.findByUserAndMonth(user.userId, cur.year, cur.month);
    expect(current).toHaveLength(1);
    expect(current[0]!.name).toBe('Terea');
    expect(current[0]!.monthlyBudget).toBe(300_000);
    expect(current[0]!.spent).toBe(0);
    expect(current[0]!.isRecurring).toBe(true);
    expect(current[0]!.oldBudgetId).toBe(src.budgetCodeId);
  });

  it('is idempotent (second call creates nothing)', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const cur = { year: wibYear(), month: wibMonth() };
    const prev = priorMonth(cur.year, cur.month);
    await budgets.create({
      userId: user.userId, name: 'Terea', monthlyBudget: 300_000, month: prev.month, year: prev.year, isRecurring: true,
    });
    await budgets.rollRecurringIntoMonth(user.userId, cur.year, cur.month);
    const second = await budgets.rollRecurringIntoMonth(user.userId, cur.year, cur.month);
    expect(second).toBe(0);
    const current = await budgets.findByUserAndMonth(user.userId, cur.year, cur.month);
    expect(current).toHaveLength(1);
  });

  it('ignores one-time prior budgets', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const cur = { year: wibYear(), month: wibMonth() };
    const prev = priorMonth(cur.year, cur.month);
    await budgets.create({
      userId: user.userId, name: 'Trip', monthlyBudget: 1_000_000, month: prev.month, year: prev.year, isRecurring: false,
    });
    const created = await budgets.rollRecurringIntoMonth(user.userId, cur.year, cur.month);
    expect(created).toBe(0);
    expect(await budgets.findByUserAndMonth(user.userId, cur.year, cur.month)).toHaveLength(0);
  });

  it('copies the most recent prior allocation when several months exist', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const cur = { year: wibYear(), month: wibMonth() };
    const prev1 = priorMonth(cur.year, cur.month);
    const prev2 = priorMonth(prev1.year, prev1.month);
    await budgets.create({ userId: user.userId, name: 'Food', monthlyBudget: 100_000, month: prev2.month, year: prev2.year, isRecurring: true });
    const newer = await budgets.create({ userId: user.userId, name: 'Food', monthlyBudget: 200_000, month: prev1.month, year: prev1.year, isRecurring: true });

    await budgets.rollRecurringIntoMonth(user.userId, cur.year, cur.month);
    const current = await budgets.findByUserAndMonth(user.userId, cur.year, cur.month);
    expect(current).toHaveLength(1);
    expect(current[0]!.monthlyBudget).toBe(200_000);
    expect(current[0]!.oldBudgetId).toBe(newer.budgetCodeId);
  });

  it('leaves an already-present current-month budget untouched', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const cur = { year: wibYear(), month: wibMonth() };
    const prev = priorMonth(cur.year, cur.month);
    await budgets.create({ userId: user.userId, name: 'Terea', monthlyBudget: 300_000, month: prev.month, year: prev.year, isRecurring: true });
    const existing = await budgets.create({ userId: user.userId, name: 'Terea', monthlyBudget: 999_000, month: cur.month, year: cur.year, isRecurring: true });
    await budgets.incrementSpent(user.userId, existing.budgetCodeId, 50_000);

    const created = await budgets.rollRecurringIntoMonth(user.userId, cur.year, cur.month);
    expect(created).toBe(0);
    const current = await budgets.findByUserAndMonth(user.userId, cur.year, cur.month);
    expect(current).toHaveLength(1);
    expect(current[0]!.monthlyBudget).toBe(999_000);
    expect(current[0]!.spent).toBe(50_000);
  });
});
