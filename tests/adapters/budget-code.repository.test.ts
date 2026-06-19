import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonBudgetCodeRepository } from '../../src/adapters/neon/budget-code.repository.js';
import { uniqueChatId } from '../helpers/db.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
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

  it('updates a budget code field', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const bc = await budgets.create({ userId: user.userId, name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026 });
    const updated = await budgets.update(user.userId, bc.budgetCodeId, { monthlyBudget: 750_000 });
    expect(updated.monthlyBudget).toBe(750_000);
  });
});
