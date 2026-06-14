import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';

describe('NeonUserRepository', () => {
  it('creates a user and finds them by telegram chat id', async () => {
    const repo = new NeonUserRepository();
    const created = await repo.create({
      telegramChatId: '111',
      name: 'Devin',
    });
    expect(created.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.language).toBe('id');
    expect(created.timezone).toBe('Asia/Jakarta');

    const found = await repo.findByTelegramChatId('111');
    expect(found?.userId).toBe(created.userId);
    expect(found?.name).toBe('Devin');
  });

  it('returns null for an unknown chat id', async () => {
    const repo = new NeonUserRepository();
    expect(await repo.findByTelegramChatId('does-not-exist')).toBeNull();
  });

  it('finds by id and updates name', async () => {
    const repo = new NeonUserRepository();
    const created = await repo.create({ telegramChatId: '222', name: 'Old' });
    const updated = await repo.update(created.userId, { name: 'New' });
    expect(updated.name).toBe('New');
    const found = await repo.findById(created.userId);
    expect(found?.name).toBe('New');
  });
});
