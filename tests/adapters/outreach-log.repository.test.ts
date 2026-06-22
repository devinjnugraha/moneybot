import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonOutreachLogRepository } from '../../src/adapters/neon/outreach-log.repository.js';
import { uniqueChatId } from '../helpers/db.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
}

describe('NeonOutreachLogRepository', () => {
  it('record inserts and reports inserted=true', async () => {
    const user = await seedUser();
    const repo = new NeonOutreachLogRepository();
    const res = await repo.record({
      userId: user.userId, triggerType: 'scheduled_summary',
      dedupKey: 'summary:2026-06-22', payload: { a: 1 }, sentAt: new Date('2026-06-22T14:00:00Z'),
    });
    expect(res.inserted).toBe(true);
  });

  it('record with an existing dedup key returns inserted=false (no duplicate row)', async () => {
    const user = await seedUser();
    const repo = new NeonOutreachLogRepository();
    const input = {
      userId: user.userId, triggerType: 'scheduled_summary' as const,
      dedupKey: 'summary:2026-06-22', payload: { a: 1 }, sentAt: new Date('2026-06-22T14:00:00Z'),
    };
    const first = await repo.record(input);
    const second = await repo.record(input);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
  });

  it('existsKey reflects recorded keys', async () => {
    const user = await seedUser();
    const repo = new NeonOutreachLogRepository();
    expect(await repo.existsKey(user.userId, 'summary:2026-06-22')).toBe(false);
    await repo.record({ userId: user.userId, triggerType: 'scheduled_summary', dedupKey: 'summary:2026-06-22', payload: {}, sentAt: new Date() });
    expect(await repo.existsKey(user.userId, 'summary:2026-06-22')).toBe(true);
  });

  it('countSince counts rows at or after the threshold', async () => {
    const user = await seedUser();
    const repo = new NeonOutreachLogRepository();
    await repo.record({ userId: user.userId, triggerType: 'scheduled_summary', dedupKey: 'k1', payload: {}, sentAt: new Date('2026-06-22T10:00:00Z') });
    await repo.record({ userId: user.userId, triggerType: 'logging_gap', dedupKey: 'k2', payload: {}, sentAt: new Date('2026-06-22T18:00:00Z') });
    expect(await repo.countSince(user.userId, new Date('2026-06-22T00:00:00Z'))).toBe(2);
    expect(await repo.countSince(user.userId, new Date('2026-06-22T12:00:00Z'))).toBe(1);
  });

  it('isolates dedup keys per user', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    const repo = new NeonOutreachLogRepository();
    await repo.record({ userId: u1.userId, triggerType: 'scheduled_summary', dedupKey: 'shared', payload: {}, sentAt: new Date() });
    expect(await repo.existsKey(u2.userId, 'shared')).toBe(false);
  });
});
