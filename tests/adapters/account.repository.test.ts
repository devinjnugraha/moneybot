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
});
