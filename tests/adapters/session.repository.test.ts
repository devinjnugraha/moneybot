import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonSessionRepository } from '../../src/adapters/neon/session.repository.js';
import type { CoreMessage } from 'ai';
import { uniqueChatId } from '../helpers/db.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
}

describe('NeonSessionRepository', () => {
  it('returns null when no session exists', async () => {
    const sessions = new NeonSessionRepository();
    expect(await sessions.get('nope')).toBeNull();
  });

  it('persists and reloads turns (CoreMessage[])', async () => {
    const user = await seedUser();
    const sessions = new NeonSessionRepository();
    const turns: CoreMessage[] = [
      { role: 'user', content: 'bakso 20000 bca' },
      { role: 'assistant', content: '✅ dicatat' },
    ];
    await sessions.set({
      chatId: '1',
      userId: user.userId,
      turns,
      lastTransactionId: undefined,
      lastActivityAt: new Date().toISOString(),
    });
    const loaded = await sessions.get('1');
    expect(loaded?.turns).toHaveLength(2);
    expect(loaded?.turns[0]).toMatchObject({ role: 'user', content: 'bakso 20000 bca' });
  });

  it('upserts (set twice replaces, not appends)', async () => {
    const user = await seedUser();
    const sessions = new NeonSessionRepository();
    await sessions.set({ chatId: '1', userId: user.userId, turns: [{ role: 'user', content: 'a' }], lastActivityAt: new Date().toISOString() });
    await sessions.set({ chatId: '1', userId: user.userId, turns: [{ role: 'user', content: 'b' }], lastActivityAt: new Date().toISOString() });
    const loaded = await sessions.get('1');
    expect(loaded?.turns).toHaveLength(1);
    expect((loaded!.turns[0] as { content: string }).content).toBe('b');
  });

  it('persists lastTransactionId and pendingRecurringConfirmation', async () => {
    const user = await seedUser();
    const sessions = new NeonSessionRepository();
    await sessions.set({
      chatId: '1',
      userId: user.userId,
      turns: [],
      lastTransactionId: '11111111-1111-1111-1111-111111111111',
      pendingRecurringConfirmation: { recurringId: '22222222-2222-2222-2222-222222222222', expiresAt: '2026-06-14T09:00:00Z' },
      lastActivityAt: new Date().toISOString(),
    });
    const loaded = await sessions.get('1');
    expect(loaded?.lastTransactionId).toBe('11111111-1111-1111-1111-111111111111');
    expect(loaded?.pendingRecurringConfirmation?.recurringId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('deletes a session', async () => {
    const user = await seedUser();
    const sessions = new NeonSessionRepository();
    await sessions.set({ chatId: '1', userId: user.userId, turns: [], lastActivityAt: new Date().toISOString() });
    await sessions.delete('1');
    expect(await sessions.get('1')).toBeNull();
  });
});
