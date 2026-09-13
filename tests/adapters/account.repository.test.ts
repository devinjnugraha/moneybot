import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
import { uniqueChatId } from '../helpers/db.js';

async function seedUser() {
  const users = new NeonUserRepository();
  return users.create({ telegramChatId: uniqueChatId(), name: 'U' });
}

describe('NeonAccountRepository', () => {
  it('creates an account with default balance 0', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    expect(acc.balance).toBe(0);
    expect(acc.isActive).toBe(true);
  });

  it('creates a card with a credit limit', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({
      userId: user.userId,
      name: 'BCA CC',
      type: 'card',
      creditLimit: 20_000_000,
    });
    expect(acc.creditLimit).toBe(20_000_000);
  });

  it('lists only the user accounts and respects active flag', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    await accounts.create({ userId: user.userId, name: 'Cash', type: 'cash' });
    const found = await accounts.findAllByUserId(user.userId);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('Cash');
  });

  it('applies a balance delta (expense decreases balance)', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank', openingBalance: 100_000 });
    await accounts.updateBalance(user.userId, acc.accountId, -20_000);
    const after = await accounts.findById(user.userId, acc.accountId);
    expect(after?.balance).toBe(80_000);
  });

  it('finds by name (case-insensitive)', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    const found = await accounts.findByName(user.userId, 'bca');
    expect(found?.name).toBe('BCA');
  });

  it('persists billing_day and due_in_days on a card and defaults due_in_days to 15', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const card = await accounts.create({
      userId: user.userId, name: 'BCA CC', type: 'card',
      creditLimit: 5_000_000, billingDay: 5,
    });
    expect(card.billingDay).toBe(5);
    expect(card.dueInDays).toBe(15);

    const plain = await accounts.create({
      userId: user.userId, name: 'Cash', type: 'cash',
    });
    expect(plain.billingDay).toBeUndefined();
    expect(plain.dueInDays).toBe(15);
  });

  it('update patches billing_day and due_in_days', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const card = await accounts.create({
      userId: user.userId, name: 'B CC', type: 'card', creditLimit: 1_000_000,
    });
    const updated = await accounts.update(user.userId, card.accountId, { billingDay: 20, dueInDays: 10 });
    expect(updated.billingDay).toBe(20);
    expect(updated.dueInDays).toBe(10);
  });
});

describe('NeonAccountRepository default account (FR-11)', () => {
  it('findDefault is null before ensure, then ensureDefaultAccount creates "Dompet" (cash, default, active)', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    expect(await accounts.findDefault(user.userId)).toBeNull();

    const dompet = await accounts.ensureDefaultAccount(user.userId);
    expect(dompet.name).toBe('Dompet');
    expect(dompet.type).toBe('cash');
    expect(dompet.isDefault).toBe(true);
    expect(dompet.isActive).toBe(true);
    expect((await accounts.findDefault(user.userId))?.accountId).toBe(dompet.accountId);
  });

  it('ensureDefaultAccount is idempotent — same row on repeat calls', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const first = await accounts.ensureDefaultAccount(user.userId);
    const second = await accounts.ensureDefaultAccount(user.userId);
    expect(second.accountId).toBe(first.accountId);
    expect(await accounts.findAllByUserId(user.userId)).toHaveLength(1);
  });

  it('ensureDefaultAccount reactivates a deactivated default (accounts-mode stretch)', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const dompet = await accounts.ensureDefaultAccount(user.userId);
    await accounts.update(user.userId, dompet.accountId, { isActive: false });
    expect((await accounts.findDefault(user.userId))?.isActive).toBe(false); // gate reads inactive rows

    const revived = await accounts.ensureDefaultAccount(user.userId);
    expect(revived.accountId).toBe(dompet.accountId);
    expect(revived.isActive).toBe(true);
  });

  it('keeps defaults per-user (two users, two Dompets, no cross-talk)', async () => {
    const accounts = new NeonAccountRepository();
    const u1 = await seedUser();
    const u2 = await seedUser();
    const d1 = await accounts.ensureDefaultAccount(u1.userId);
    const d2 = await accounts.ensureDefaultAccount(u2.userId);
    expect(d1.accountId).not.toBe(d2.accountId);
    expect((await accounts.findAllByUserId(u1.userId)).map((a) => a.accountId)).toEqual([d1.accountId]);
  });

  it('regular create() stays non-default', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    expect(acc.isDefault).toBe(false);
  });
});
