import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
import { NeonTransactionRepository } from '../../src/adapters/neon/transaction.repository.js';
import { todayWIB } from '../../src/domain/time.js';

async function seed() {
  const users = new NeonUserRepository();
  const accounts = new NeonAccountRepository();
  const user = await users.create({ telegramChatId: '1', name: 'U' });
  const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
  return { user, acc };
}

describe('NeonTransactionRepository', () => {
  it('creates an expense', async () => {
    const { user, acc } = await seed();
    const txns = new NeonTransactionRepository();
    const t = await txns.create({
      userId: user.userId,
      type: 'expense',
      amount: 20_000,
      description: 'bakso',
      categoryId: 'food.dining',
      accountId: acc.accountId,
      date: todayWIB(),
    });
    expect(t.amount).toBe(20_000);
    expect(t.categoryId).toBe('food.dining');
    expect(t.deletedAt).toBeUndefined();
  });

  it('filters out soft-deleted transactions in date-range queries', async () => {
    const { user, acc } = await seed();
    const txns = new NeonTransactionRepository();
    const t = await txns.create({
      userId: user.userId,
      type: 'expense',
      amount: 5_000,
      description: 'kopi',
      categoryId: 'food.coffee',
      accountId: acc.accountId,
      date: todayWIB(),
    });
    await txns.softDelete(user.userId, t.transactionId);
    const found = await txns.findByDateRange(user.userId, todayWIB(), todayWIB());
    expect(found).toHaveLength(0);
  });

  it('finds latest by user, newest first', async () => {
    const { user, acc } = await seed();
    const txns = new NeonTransactionRepository();
    await txns.create({ userId: user.userId, type: 'expense', amount: 1_000, description: 'a', categoryId: 'other.misc', accountId: acc.accountId, date: '2026-06-01' });
    await txns.create({ userId: user.userId, type: 'expense', amount: 2_000, description: 'b', categoryId: 'other.misc', accountId: acc.accountId, date: '2026-06-02' });
    const latest = await txns.findLatestByUserId(user.userId, 1);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.description).toBe('b');
  });

  it('updates a transaction field', async () => {
    const { user, acc } = await seed();
    const txns = new NeonTransactionRepository();
    const t = await txns.create({ userId: user.userId, type: 'expense', amount: 10_000, description: 'x', categoryId: 'other.misc', accountId: acc.accountId, date: todayWIB() });
    const updated = await txns.update(user.userId, t.transactionId, { amount: 25_000 });
    expect(updated.amount).toBe(25_000);
  });
});
