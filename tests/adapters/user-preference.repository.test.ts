import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonUserPreferenceRepository } from '../../src/adapters/neon/user-preference.repository.js';
import { uniqueChatId } from '../helpers/db.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
}

describe('NeonUserPreferenceRepository', () => {
  it('findAllByUserId returns [] when none saved', async () => {
    const user = await seedUser();
    const prefs = new NeonUserPreferenceRepository();
    expect(await prefs.findAllByUserId(user.userId)).toEqual([]);
  });

  it('upsert inserts a new preference', async () => {
    const user = await seedUser();
    const prefs = new NeonUserPreferenceRepository();
    const saved = await prefs.upsert(user.userId, 'default_account', 'BCA');
    expect(saved.key).toBe('default_account');
    expect(saved.value).toBe('BCA');
    expect(saved.userId).toBe(user.userId);
    const all = await prefs.findAllByUserId(user.userId);
    expect(all).toHaveLength(1);
    expect(all[0]!.value).toBe('BCA');
  });

  it('upsert updates the value when the key already exists (no duplicate row)', async () => {
    const user = await seedUser();
    const prefs = new NeonUserPreferenceRepository();
    await prefs.upsert(user.userId, 'default_account', 'BCA');
    await prefs.upsert(user.userId, 'default_account', 'GoPay');
    const all = await prefs.findAllByUserId(user.userId);
    expect(all).toHaveLength(1);
    expect(all[0]!.value).toBe('GoPay');
  });

  it('delete removes a preference', async () => {
    const user = await seedUser();
    const prefs = new NeonUserPreferenceRepository();
    await prefs.upsert(user.userId, 'salary_day', '25');
    await prefs.delete(user.userId, 'salary_day');
    expect(await prefs.findAllByUserId(user.userId)).toEqual([]);
  });

  it('delete is idempotent for a missing key (no error)', async () => {
    const user = await seedUser();
    const prefs = new NeonUserPreferenceRepository();
    await expect(prefs.delete(user.userId, 'never_set')).resolves.toBeUndefined();
  });

  it('isolates preferences per user', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    const prefs = new NeonUserPreferenceRepository();
    await prefs.upsert(u1.userId, 'x', 'one');
    expect(await prefs.findAllByUserId(u2.userId)).toEqual([]);
  });
});
