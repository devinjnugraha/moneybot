import { describe, it, expect, beforeEach } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
import { NeonRecurringPaymentRepository } from '../../src/adapters/neon/recurring-payment.repository.js';
import { uniqueChatId, resetDb } from '../helpers/db.js';

async function seed() {
  const users = new NeonUserRepository();
  const accounts = new NeonAccountRepository();
  const user = await users.create({ telegramChatId: uniqueChatId(), name: 'U' });
  const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
  return { user, acc };
}

describe('NeonRecurringPaymentRepository', () => {
  it('creates a recurring payment', async () => {
    const { user, acc } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    const rp = await recurrings.create({
      userId: user.userId,
      name: 'Netflix',
      amount: 159_000,
      accountId: acc.accountId,
      categoryId: 'entertainment.streaming',
      dayOfMonth: 15,
      nextFireAt: '2026-06-15',
    });
    expect(rp.name).toBe('Netflix');
    expect(rp.isActive).toBe(true);
    expect(rp.dayOfMonth).toBe(15);
    expect(rp.nextFireAt).toBe('2026-06-15');
  });

  it('finds all active recurring payments for a user', async () => {
    const { user, acc } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    await recurrings.create({
      userId: user.userId, name: 'Netflix', amount: 159_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    await recurrings.create({
      userId: user.userId, name: 'Spotify', amount: 54_990,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 1, nextFireAt: '2026-07-01',
    });
    const all = await recurrings.findAllByUserId(user.userId);
    expect(all).toHaveLength(2);
  });

  it('finds by day of month', async () => {
    const { user, acc } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    await recurrings.create({
      userId: user.userId, name: 'Netflix', amount: 159_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    await recurrings.create({
      userId: user.userId, name: 'Spotify', amount: 54_990,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 1, nextFireAt: '2026-07-01',
    });
    const day1 = await recurrings.findByDayOfMonth(1);
    // findByDayOfMonth is global (scheduler query); just verify ours is included
    expect(day1.find((r) => r.name === 'Spotify')).toBeTruthy();
  });

  it('finds by id and by name', async () => {
    const { user, acc } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    const rp = await recurrings.create({
      userId: user.userId, name: 'Netflix', amount: 159_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    const byId = await recurrings.findById(user.userId, rp.recurringId);
    expect(byId?.name).toBe('Netflix');
    const byName = await recurrings.findByName(user.userId, 'Netflix');
    expect(byName?.recurringId).toBe(rp.recurringId);
  });

  it('deactivates (sets isActive = false)', async () => {
    const { user, acc } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    const rp = await recurrings.create({
      userId: user.userId, name: 'Netflix', amount: 159_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    await recurrings.deactivate(user.userId, rp.recurringId);
    const byId = await recurrings.findById(user.userId, rp.recurringId);
    expect(byId?.isActive).toBe(false);
    const all = await recurrings.findAllByUserId(user.userId);
    expect(all).toHaveLength(0);
  });

  it('updates a recurring payment field', async () => {
    const { user, acc } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    const rp = await recurrings.create({
      userId: user.userId, name: 'Netflix', amount: 159_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    const updated = await recurrings.update(user.userId, rp.recurringId, { amount: 179_000, nextFireAt: '2026-07-15' });
    expect(updated.amount).toBe(179_000);
    expect(updated.nextFireAt).toBe('2026-07-15');
  });

  it('findById returns null for non-UUID recurringId instead of throwing', async () => {
    const { user } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    // 'rp-x' would cause Postgres error 22P02 — the adapter must guard before querying
    const result = await recurrings.findById(user.userId, 'rp-x');
    expect(result).toBeNull();
  });
});

describe('findDueToday — day-of-month overflow', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedUser() {
    return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
  }

  it('returns a payment when dayOfMonth matches today', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    const recurrings = new NeonRecurringPaymentRepository();
    await recurrings.create({
      userId: user.userId, name: 'Spotify', amount: 54_990,
      accountId: acc.accountId, categoryId: 'entertainment.streaming',
      dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    const due = await recurrings.findDueToday(2026, 6, 15);
    expect(due).toHaveLength(1);
    expect(due[0]!.name).toBe('Spotify');
  });

  it('does not return a payment that already fired this month', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    const recurrings = new NeonRecurringPaymentRepository();
    const rp = await recurrings.create({
      userId: user.userId, name: 'Netflix', amount: 159_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming',
      dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    await recurrings.update(user.userId, rp.recurringId, { lastFiredAt: '2026-06-15' });
    const due = await recurrings.findDueToday(2026, 6, 20);
    expect(due).toHaveLength(0);
  });

  it('fires on last day of month for dayOfMonth=31 in February', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    const recurrings = new NeonRecurringPaymentRepository();
    await recurrings.create({
      userId: user.userId, name: 'Day31Sub', amount: 100_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming',
      dayOfMonth: 31, nextFireAt: '2026-02-28',
    });
    const due = await recurrings.findDueToday(2026, 2, 28);
    expect(due.find((r) => r.name === 'Day31Sub')).toBeTruthy();
  });

  it('does not fire day-31 payment on a normal March 28', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    const recurrings = new NeonRecurringPaymentRepository();
    await recurrings.create({
      userId: user.userId, name: 'Day31Sub', amount: 100_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming',
      dayOfMonth: 31, nextFireAt: '2026-03-31',
    });
    const due = await recurrings.findDueToday(2026, 3, 28);
    expect(due).toHaveLength(0);
  });

  it('excludes inactive payments', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    const recurrings = new NeonRecurringPaymentRepository();
    const rp = await recurrings.create({
      userId: user.userId, name: 'Spotify', amount: 54_990,
      accountId: acc.accountId, categoryId: 'entertainment.streaming',
      dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    await recurrings.deactivate(user.userId, rp.recurringId);
    const due = await recurrings.findDueToday(2026, 6, 15);
    expect(due).toHaveLength(0);
  });
});
