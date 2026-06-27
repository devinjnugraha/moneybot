import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { uniqueChatId } from '../helpers/db.js';

describe('NeonUserRepository', () => {
  it('creates a user and finds them by telegram chat id', async () => {
    const repo = new NeonUserRepository();
    const chatId = uniqueChatId();
    const created = await repo.create({ telegramChatId: chatId, name: 'Devin' });
    expect(created.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.language).toBe('id');
    expect(created.timezone).toBe('Asia/Jakarta');

    const found = await repo.findByTelegramChatId(chatId);
    expect(found?.userId).toBe(created.userId);
    expect(found?.name).toBe('Devin');
  });

  it('returns null for an unknown chat id', async () => {
    const repo = new NeonUserRepository();
    expect(await repo.findByTelegramChatId('does-not-exist')).toBeNull();
  });

  it('finds by id and updates name', async () => {
    const repo = new NeonUserRepository();
    const created = await repo.create({ telegramChatId: uniqueChatId(), name: 'Old' });
    const updated = await repo.update(created.userId, { name: 'New' });
    expect(updated.name).toBe('New');
    const found = await repo.findById(created.userId);
    expect(found?.name).toBe('New');
  });

  it('creates a user with default pending status and maps it back', async () => {
    const repo = new NeonUserRepository();
    const chatId = uniqueChatId();
    const created = await repo.create({ telegramChatId: chatId, name: 'Devin' });
    expect(created.status).toBe('pending');
    const found = await repo.findByTelegramChatId(chatId);
    expect(found?.status).toBe('pending');
  });
});

describe('NeonUserRepository.findAll', () => {
  it('includes created users', async () => {
    const repo = new NeonUserRepository();
    const u1 = await repo.create({ telegramChatId: uniqueChatId(), name: 'A' });
    const u2 = await repo.create({ telegramChatId: uniqueChatId(), name: 'B' });
    const all = await repo.findAll();
    const ids = all.map((u) => u.userId);
    expect(ids).toContain(u1.userId);
    expect(ids).toContain(u2.userId);
  });
});
