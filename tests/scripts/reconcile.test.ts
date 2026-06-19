import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
import { NeonTransactionRepository } from '../../src/adapters/neon/transaction.repository.js';
import { todayWIB } from '../../src/domain/time.js';
import { uniqueChatId } from '../helpers/db.js';
import { pool } from '../../src/adapters/neon/pool.js';
import { reconcile } from '../../scripts/reconcile.js';

async function seed() {
  const users = new NeonUserRepository();
  const accounts = new NeonAccountRepository();
  const txns = new NeonTransactionRepository();
  const user = await users.create({ telegramChatId: uniqueChatId(), name: 'R' });
  const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank', openingBalance: 0 });
  return { user, acc, accounts, txns };
}

describe('reconcile', () => {
  it('corrects a drifted balance (expense recorded, balance not updated)', async () => {
    const { user, acc, txns } = await seed();

    // Create an expense then corrupt the balance to simulate drift.
    await txns.create({
      userId: user.userId, type: 'expense', amount: 20_000,
      description: 'bakso', categoryId: 'food.dining',
      accountId: acc.accountId, date: todayWIB(),
    });
    await pool.query('UPDATE accounts SET balance = 100_000 WHERE account_id = $1', [acc.accountId]);

    const corrections = await reconcile();

    // Our corrupted account must be among the corrections
    const ours = corrections.find((c) => c.accountId === acc.accountId);
    expect(ours).toBeDefined();
    expect(ours!.name).toBe('BCA');
    expect(ours!.oldBalance).toBe(100_000);
    expect(ours!.newBalance).toBe(-20_000);

    // Verify the balance was actually corrected in the DB
    const { rows } = await pool.query('SELECT balance FROM accounts WHERE account_id = $1', [acc.accountId]);
    expect(Number(rows[0]!.balance)).toBe(-20_000);
  });

  it('reports no corrections when balances are correct', async () => {
    const { user, acc, txns, accounts } = await seed();

    // Record expense AND update balance correctly
    await txns.create({
      userId: user.userId, type: 'expense', amount: 30_000,
      description: 'kopi', categoryId: 'food.coffee',
      accountId: acc.accountId, date: todayWIB(),
    });
    await accounts.updateBalance(user.userId, acc.accountId, -30_000);

    const corrections = await reconcile();
    // Our correctly-balanced account must NOT appear in corrections
    const ours = corrections.find((c) => c.accountId === acc.accountId);
    expect(ours).toBeUndefined();
  });

  it('accounts for income, expense, and transfers correctly', async () => {
    const { user, acc, accounts, txns } = await seed();
    const acc2 = await accounts.create({ userId: user.userId, name: 'Cash', type: 'cash', openingBalance: 0 });

    // Income +100_000
    await txns.create({
      userId: user.userId, type: 'income', amount: 100_000,
      description: 'gaji', categoryId: 'income.salary',
      accountId: acc.accountId, date: todayWIB(),
    });
    // Expense -30_000
    await txns.create({
      userId: user.userId, type: 'expense', amount: 30_000,
      description: 'makan', categoryId: 'food.dining',
      accountId: acc.accountId, date: todayWIB(),
    });
    // Transfer 20_000 from BCA to Cash
    await txns.createTransfer({
      userId: user.userId, amount: 20_000,
      fromAccountId: acc.accountId, toAccountId: acc2.accountId,
      description: 'pindahin', date: todayWIB(),
    });

    // Corrupt both balances
    await pool.query('UPDATE accounts SET balance = 999 WHERE account_id = $1', [acc.accountId]);
    await pool.query('UPDATE accounts SET balance = 999 WHERE account_id = $1', [acc2.accountId]);

    const corrections = await reconcile();
    const bca = corrections.find((c) => c.accountId === acc.accountId);
    expect(bca).toBeDefined();
    expect(bca!.oldBalance).toBe(999);
    // BCA: 100_000 (income) - 30_000 (expense) - 20_000 (transfer out) = 50_000
    expect(bca!.newBalance).toBe(50_000);

    const cash = corrections.find((c) => c.accountId === acc2.accountId);
    expect(cash).toBeDefined();
    expect(cash!.oldBalance).toBe(999);
    // Cash: 20_000 (transfer in)
    expect(cash!.newBalance).toBe(20_000);
  });

  it('excludes soft-deleted transactions from the calculation', async () => {
    const { user, acc, txns } = await seed();

    // Create an expense
    const t = await txns.create({
      userId: user.userId, type: 'expense', amount: 50_000,
      description: 'barang', categoryId: 'shopping.online',
      accountId: acc.accountId, date: todayWIB(),
    });
    // Soft delete it
    await txns.softDelete(user.userId, t.transactionId);
    // Corrupt balance to non-zero
    await pool.query('UPDATE accounts SET balance = 50_000 WHERE account_id = $1', [acc.accountId]);

    // Since transaction is soft-deleted, correct balance should be 0
    const corrections = await reconcile();
    const ours = corrections.find((c) => c.accountId === acc.accountId);
    expect(ours).toBeDefined();
    expect(ours!.newBalance).toBe(0);
  });
});
