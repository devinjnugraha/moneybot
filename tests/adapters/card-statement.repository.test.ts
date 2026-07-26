import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
import { NeonCardStatementRepository } from '../../src/adapters/neon/card-statement.repository.js';
import { NeonTransactionRepository } from '../../src/adapters/neon/transaction.repository.js';
import { uniqueChatId, pool } from '../helpers/db.js';
import type { Account } from '../../src/domain/entities.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
}

/** Create a card and pin its created_at so cycle math is deterministic (the card's
 *  live created_at is ~now, which would otherwise make lastCut < created → 0 inserts). */
async function createCard(userId: string, opts: { billingDay: number; createdAt: string }): Promise<Account> {
  const accounts = new NeonAccountRepository();
  const card = await accounts.create({
    userId, name: 'CC', type: 'card', creditLimit: 5_000_000, billingDay: opts.billingDay,
  });
  await pool.query('UPDATE accounts SET created_at = $1 WHERE account_id = $2', [opts.createdAt, card.accountId]);
  return card;
}

describe('NeonCardStatementRepository.ensureEndedCycles', () => {
  it('creates a row for the cycle ending on the most recent cut, with cycle_start = previous cut', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 5, createdAt: '2026-06-10' });
    const repo = new NeonCardStatementRepository();
    // asOf 2026-07-20 → last cut 2026-07-05; cycle_start 2026-06-05
    const created = await repo.ensureEndedCycles(
      user.userId, card.accountId, 5, '2026-06-10', new Date('2026-07-20T03:00:00Z'),
    );
    expect(created).toBe(1);
    const { rows } = await pool.query(
      'SELECT cycle_start, cycle_end FROM card_statements WHERE account_id = $1', [card.accountId],
    );
    expect(rows[0]!.cycle_start).toBe('2026-06-05');
    expect(rows[0]!.cycle_end).toBe('2026-07-05');
  });

  it('is idempotent (second call inserts nothing)', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 5, createdAt: '2026-06-10' });
    const repo = new NeonCardStatementRepository();
    const asOf = new Date('2026-07-20T03:00:00Z');
    await repo.ensureEndedCycles(user.userId, card.accountId, 5, '2026-06-10', asOf);
    const second = await repo.ensureEndedCycles(user.userId, card.accountId, 5, '2026-06-10', asOf);
    expect(second).toBe(0);
  });

  it('returns 0 when the most recent cut predates the card creation', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 5, createdAt: '2026-07-10' });
    const repo = new NeonCardStatementRepository();
    // asOf 2026-07-20 → last cut 2026-07-05 < created 2026-07-10 → nothing to freeze yet.
    const created = await repo.ensureEndedCycles(
      user.userId, card.accountId, 5, '2026-07-10', new Date('2026-07-20T03:00:00Z'),
    );
    expect(created).toBe(0);
    const { rows } = await pool.query(
      'SELECT cycle_end FROM card_statements WHERE account_id = $1', [card.accountId],
    );
    expect(rows).toHaveLength(0);
  });

  it('self-heals multi-month gaps (inserts each missed cycle up to the last cut)', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 5, createdAt: '2026-04-10' });
    const repo = new NeonCardStatementRepository();
    // First run to 2026-05-20 → last cut 2026-05-05 (one row: cycle 2026-04-05..2026-05-05).
    await repo.ensureEndedCycles(user.userId, card.accountId, 5, '2026-04-10', new Date('2026-05-20T03:00:00Z'));
    // Second run to 2026-07-20 → must backfill cuts 2026-06-05 and 2026-07-05.
    const created = await repo.ensureEndedCycles(user.userId, card.accountId, 5, '2026-04-10', new Date('2026-07-20T03:00:00Z'));
    expect(created).toBe(2);
    const { rows } = await pool.query(
      'SELECT cycle_end FROM card_statements WHERE account_id = $1 ORDER BY cycle_end', [card.accountId],
    );
    expect(rows.map((r) => String(r.cycle_end))).toEqual(['2026-05-05', '2026-06-05', '2026-07-05']);
  });

  it('clamps a day-31 billing day to month length', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 31, createdAt: '2026-01-10' });
    const repo = new NeonCardStatementRepository();
    await repo.ensureEndedCycles(user.userId, card.accountId, 31, '2026-01-10', new Date('2026-03-15T03:00:00Z'));
    const { rows } = await pool.query(
      'SELECT cycle_end FROM card_statements WHERE account_id = $1', [card.accountId],
    );
    expect(rows.map((r) => String(r.cycle_end))).toContain('2026-02-28');
  });
});

describe('NeonCardStatementRepository.getWithFigures', () => {
  async function setupCardWithCycle(opts: { billingDay: number; asOf: string; created: string }) {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const card = await accounts.create({
      userId: user.userId, name: 'CC', type: 'card', creditLimit: 5_000_000, billingDay: opts.billingDay, dueInDays: 15,
    });
    // Pin the card's creation date so cycle math is deterministic.
    await pool.query('UPDATE accounts SET created_at = $1 WHERE account_id = $2', [opts.created, card.accountId]);
    const stmts = new NeonCardStatementRepository();
    await stmts.ensureEndedCycles(user.userId, card.accountId, opts.billingDay, opts.created, new Date(opts.asOf));
    return { user, card, stmts };
  }
  // `getWithFigures` computes figures from transactions, not from accounts.balance, so the
  // tests below do not manually adjust the card balance (raw repo.create does not either).

  it('derives newCharges from expenses in the cycle window, status open, dueDate', async () => {
    const { user, card, stmts } = await setupCardWithCycle({ billingDay: 5, created: '2026-05-01', asOf: '2026-07-20T03:00:00Z' });
    const txns = new NeonTransactionRepository();
    // Expense in the 2026-06-05..2026-07-05 cycle window.
    await txns.create({ userId: user.userId, type: 'expense', amount: 300_000, description: 'x', accountId: card.accountId, categoryId: 'food.dining', date: '2026-06-20' });
    const figures = await stmts.getWithFigures(user.userId, card.accountId, new Date('2026-07-10T03:00:00Z'));
    const july = figures.find((s) => s.cycleEnd === '2026-07-05')!;
    expect(july.newCharges).toBe(300_000);
    expect(july.amountPaid).toBe(0);
    expect(july.remainingDue).toBe(300_000);
    expect(july.status).toBe('open');
    expect(july.dueDate).toBe('2026-07-20');
  });

  it('allocates a payment FIFO to the oldest open statement and marks it paid with paidAt', async () => {
    const { user, card, stmts } = await setupCardWithCycle({ billingDay: 5, created: '2026-05-01', asOf: '2026-07-20T03:00:00Z' });
    const accounts = new NeonAccountRepository();
    const fund = await accounts.create({ userId: user.userId, name: 'Bank', type: 'bank', openingBalance: 1_000_000 });
    const txns = new NeonTransactionRepository();
    await txns.create({ userId: user.userId, type: 'expense', amount: 100_000, description: 'a', accountId: card.accountId, categoryId: 'food.dining', date: '2026-05-10' });
    await txns.create({ userId: user.userId, type: 'expense', amount: 200_000, description: 'b', accountId: card.accountId, categoryId: 'food.dining', date: '2026-06-20' });
    // Pay 100_000 after the 07-05 cut → FIFO-settles the oldest (2026-06-05) statement.
    await txns.createTransfer({ userId: user.userId, amount: 100_000, fromAccountId: fund.accountId, toAccountId: card.accountId, description: 'pay', date: '2026-07-10' });
    const figures = await stmts.getWithFigures(user.userId, card.accountId, new Date('2026-07-12T03:00:00Z'));
    const oldest = figures.find((s) => s.cycleEnd === '2026-06-05')!;
    expect(oldest.remainingDue).toBe(0);
    expect(oldest.status).toBe('paid');
    expect(oldest.paidAt).toBeTruthy();
    const next = figures.find((s) => s.cycleEnd === '2026-07-05')!;
    expect(next.remainingDue).toBe(200_000);
    expect(next.status).toBe('open');
  });

  it('splits an over-paying single payment across two statements FIFO', async () => {
    const { user, card, stmts } = await setupCardWithCycle({ billingDay: 5, created: '2026-05-01', asOf: '2026-07-20T03:00:00Z' });
    const accounts = new NeonAccountRepository();
    const fund = await accounts.create({ userId: user.userId, name: 'Bank', type: 'bank', openingBalance: 1_000_000 });
    const txns = new NeonTransactionRepository();
    await txns.create({ userId: user.userId, type: 'expense', amount: 100_000, description: 'a', accountId: card.accountId, categoryId: 'food.dining', date: '2026-05-10' });
    await txns.create({ userId: user.userId, type: 'expense', amount: 100_000, description: 'b', accountId: card.accountId, categoryId: 'food.dining', date: '2026-06-20' });
    // One 150_000 payment settles the oldest (100k) + 50k of the next.
    await txns.createTransfer({ userId: user.userId, amount: 150_000, fromAccountId: fund.accountId, toAccountId: card.accountId, description: 'pay', date: '2026-07-10' });
    const figures = await stmts.getWithFigures(user.userId, card.accountId, new Date('2026-07-12T03:00:00Z'));
    const oldest = figures.find((s) => s.cycleEnd === '2026-06-05')!;
    const next = figures.find((s) => s.cycleEnd === '2026-07-05')!;
    expect(oldest.status).toBe('paid');
    expect(next.amountPaid).toBe(50_000);
    expect(next.remainingDue).toBe(50_000);
    expect(next.status).toBe('partially_paid');
  });

  it('updates figures when an expense is backdated into a paid cycle (un-pays it)', async () => {
    const { user, card, stmts } = await setupCardWithCycle({ billingDay: 5, created: '2026-05-01', asOf: '2026-07-20T03:00:00Z' });
    const accounts = new NeonAccountRepository();
    const fund = await accounts.create({ userId: user.userId, name: 'Bank', type: 'bank', openingBalance: 1_000_000 });
    const txns = new NeonTransactionRepository();
    const asOf = new Date('2026-07-12T03:00:00Z');
    await txns.create({ userId: user.userId, type: 'expense', amount: 100_000, description: 'a', accountId: card.accountId, categoryId: 'food.dining', date: '2026-05-10' });
    await txns.createTransfer({ userId: user.userId, amount: 100_000, fromAccountId: fund.accountId, toAccountId: card.accountId, description: 'pay', date: '2026-07-10' });
    // Before backdate: oldest is paid.
    expect((await stmts.getWithFigures(user.userId, card.accountId, asOf)).find((s) => s.cycleEnd === '2026-06-05')!.status).toBe('paid');
    // Backdate another charge into that same oldest cycle window.
    await txns.create({ userId: user.userId, type: 'expense', amount: 50_000, description: 'late', accountId: card.accountId, categoryId: 'food.dining', date: '2026-05-15' });
    const oldest = (await stmts.getWithFigures(user.userId, card.accountId, asOf)).find((s) => s.cycleEnd === '2026-06-05')!;
    expect(oldest.newCharges).toBe(150_000);
    expect(oldest.remainingDue).toBe(50_000);
    expect(oldest.status).toBe('partially_paid');
    expect(oldest.paidAt).toBeUndefined();
  });

  it('marks overdue when dueDate < asOf and still owed', async () => {
    const { user, card, stmts } = await setupCardWithCycle({ billingDay: 5, created: '2026-04-01', asOf: '2026-09-20T03:00:00Z' });
    const txns = new NeonTransactionRepository();
    await txns.create({ userId: user.userId, type: 'expense', amount: 100_000, description: 'a', accountId: card.accountId, categoryId: 'food.dining', date: '2026-06-10' });
    const figures = await stmts.getWithFigures(user.userId, card.accountId, new Date('2026-08-01T03:00:00Z'));
    const old = figures.find((s) => s.cycleEnd === '2026-07-05')!;
    expect(old.overdue).toBe(true);
    expect(old.dueDate).toBe('2026-07-20');
  });
});
