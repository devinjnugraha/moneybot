import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
import { NeonRecurringPaymentRepository } from '../../src/adapters/neon/recurring-payment.repository.js';

async function seed() {
  const users = new NeonUserRepository();
  const accounts = new NeonAccountRepository();
  const user = await users.create({ telegramChatId: '1', name: 'U' });
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
    expect(day1).toHaveLength(1);
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
});
