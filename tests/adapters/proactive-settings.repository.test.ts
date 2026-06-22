import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonProactiveSettingsRepository } from '../../src/adapters/neon/proactive-settings.repository.js';
import { uniqueChatId } from '../helpers/db.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
}

describe('NeonProactiveSettingsRepository', () => {
  it('get returns not-muted defaults when no row exists', async () => {
    const user = await seedUser();
    const repo = new NeonProactiveSettingsRepository();
    const s = await repo.get(user.userId);
    expect(s).toEqual({ userId: user.userId, muted: false });
  });

  it('setMuted(true) persists and resumes undefined => mute forever', async () => {
    const user = await seedUser();
    const repo = new NeonProactiveSettingsRepository();
    await repo.setMuted(user.userId, true);
    const s = await repo.get(user.userId);
    expect(s.muted).toBe(true);
    expect(s.resumeAt).toBeUndefined();
  });

  it('setMuted(true, resumeAt) persists the resume instant', async () => {
    const user = await seedUser();
    const repo = new NeonProactiveSettingsRepository();
    const resumeAt = new Date('2026-06-22T20:00:00Z');
    await repo.setMuted(user.userId, true, resumeAt);
    const s = await repo.get(user.userId);
    expect(s.muted).toBe(true);
    expect(Date.parse(s.resumeAt ?? '')).toBe(resumeAt.getTime());
  });

  it('setMuted(false) unmutes an already-muted user', async () => {
    const user = await seedUser();
    const repo = new NeonProactiveSettingsRepository();
    await repo.setMuted(user.userId, true);
    await repo.setMuted(user.userId, false);
    expect((await repo.get(user.userId)).muted).toBe(false);
  });
});
