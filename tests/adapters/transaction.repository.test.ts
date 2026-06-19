import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
import { NeonTransactionRepository } from '../../src/adapters/neon/transaction.repository.js';
import { todayWIB } from '../../src/domain/time.js';
import { uniqueChatId } from '../helpers/db.js';

async function seed() {
  const users = new NeonUserRepository();
  const accounts = new NeonAccountRepository();
  const user = await users.create({ telegramChatId: uniqueChatId(), name: 'U' });
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

describe('soft-delete filtering (NFR-06)', () => {
  it('findById returns null for a soft-deleted transaction', async () => {
    const { user, acc } = await seed();
    const txns = new NeonTransactionRepository();
    const t = await txns.create({
      userId: user.userId, type: 'expense', amount: 5_000,
      description: 'kopi', categoryId: 'food.coffee',
      accountId: acc.accountId, date: todayWIB(),
    });
    await txns.softDelete(user.userId, t.transactionId);
    const found = await txns.findById(user.userId, t.transactionId);
    expect(found).toBeNull();
  });

  it('update throws when transaction is soft-deleted (no rows match)', async () => {
    const { user, acc } = await seed();
    const txns = new NeonTransactionRepository();
    const t = await txns.create({
      userId: user.userId, type: 'expense', amount: 5_000,
      description: 'kopi', categoryId: 'food.coffee',
      accountId: acc.accountId, date: todayWIB(),
    });
    await txns.softDelete(user.userId, t.transactionId);
    await expect(
      txns.update(user.userId, t.transactionId, { amount: 10_000 }),
    ).rejects.toThrow();
  });
});

describe('createTransfer — atomic (NFR-05)', () => {
  async function seedTransfer() {
    const users = new NeonUserRepository();
    const accounts = new NeonAccountRepository();
    const user = await users.create({ telegramChatId: uniqueChatId(), name: 'TF' });
    return { user, accounts };
  }

  it('creates a transfer and moves balances atomically', async () => {
    const { user, accounts } = await seedTransfer();
    const from = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank', openingBalance: 100_000 });
    const to = await accounts.create({ userId: user.userId, name: 'Mandiri', type: 'bank', openingBalance: 50_000 });
    const txns = new NeonTransactionRepository();
    const t = await txns.createTransfer({
      userId: user.userId,
      amount: 30_000,
      fromAccountId: from.accountId,
      toAccountId: to.accountId,
      description: 'transfer ke Mandiri',
      date: '2026-06-18',
    });
    expect(t.type).toBe('transfer');
    expect(t.amount).toBe(30_000);
    expect(t.accountId).toBe(from.accountId);
    expect(t.toAccountId).toBe(to.accountId);
    const fromAfter = await accounts.findById(user.userId, from.accountId);
    const toAfter = await accounts.findById(user.userId, to.accountId);
    expect(fromAfter?.balance).toBe(70_000);
    expect(toAfter?.balance).toBe(80_000);
  });

  it('rolls back both balances when the to-account does not exist', async () => {
    const { user, accounts } = await seedTransfer();
    const from = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank', openingBalance: 100_000 });
    const txns = new NeonTransactionRepository();
    await expect(
      txns.createTransfer({
        userId: user.userId,
        amount: 30_000,
        fromAccountId: from.accountId,
        toAccountId: '00000000-0000-0000-0000-000000000000',
        description: 'bad transfer',
        date: '2026-06-18',
      }),
    ).rejects.toThrow();
    const fromAfter = await accounts.findById(user.userId, from.accountId);
    expect(fromAfter?.balance).toBe(100_000);
  });
});
