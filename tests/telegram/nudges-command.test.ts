import { describe, it, expect, vi } from 'vitest';
import { dispatchNudgesCommand, parseNudgesArgs } from '../../src/telegram/nudges-command.js';
import type { Repos } from '../../src/repositories/interfaces.js';

const NOW = new Date('2026-06-22T14:00:00Z');

function mockRepos(overrides: { user?: { userId: string; telegramChatId: string } | null; muted?: boolean; resumeAt?: string } = {}): Repos {
  const user = overrides.user === undefined ? { userId: 'u1', telegramChatId: 'c1' } : overrides.user;
  return {
    users: {
      findByTelegramChatId: vi.fn(async () => user),
      findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn(),
    } as never,
    accounts: { findAllByUserId: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: { create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn() } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: {
      get: vi.fn(async () => ({ userId: 'u1', muted: overrides.muted ?? false, resumeAt: overrides.resumeAt })),
      setMuted: vi.fn(async () => undefined),
    } as never,
  };
}

describe('parseNudgesArgs', () => {
  it('"status" / "" => status', () => {
    expect(parseNudgesArgs('', NOW)).toMatchObject({ action: 'status' });
    expect(parseNudgesArgs('status', NOW)).toMatchObject({ action: 'status' });
  });
  it('"on" => unmute', () => {
    expect(parseNudgesArgs('on', NOW)).toMatchObject({ action: 'unmute' });
  });
  it('"off" => mute forever (no resumeAt)', () => {
    expect(parseNudgesArgs('off', NOW)).toMatchObject({ action: 'mute' });
    expect((parseNudgesArgs('off', NOW) as { resumeAt?: unknown }).resumeAt).toBeUndefined();
  });
  it('"off 8h" => mute for 8 hours', () => {
    const r = parseNudgesArgs('off 8h', NOW);
    expect(r).toMatchObject({ action: 'mute' });
    expect((r as { resumeAt: Date }).resumeAt.getTime()).toBe(NOW.getTime() + 8 * 3600_000);
  });
  it('"off 2d" => mute for 2 days', () => {
    const r = parseNudgesArgs('off 2d', NOW) as { resumeAt: Date };
    expect(r.resumeAt.getTime()).toBe(NOW.getTime() + 48 * 3600_000);
  });
  it('garbage => unknown', () => {
    expect(parseNudgesArgs('banana', NOW)).toMatchObject({ action: 'unknown' });
  });
});

describe('dispatchNudgesCommand', () => {
  it('status replies with the current mute state (not muted)', async () => {
    const repos = mockRepos({ muted: false });
    const { reply } = await dispatchNudgesCommand('status', 'c1', repos, NOW);
    expect(reply).toContain('aktif');
    expect(repos.proactiveSettings.setMuted).not.toHaveBeenCalled();
  });

  it('off mutes forever and confirms', async () => {
    const repos = mockRepos();
    const { reply } = await dispatchNudgesCommand('off', 'c1', repos, NOW);
    expect(repos.proactiveSettings.setMuted).toHaveBeenCalledWith('u1', true, undefined);
    expect(reply).toContain('berhenti');
  });

  it('off 8h mutes with a resume instant and confirms', async () => {
    const repos = mockRepos();
    const { reply } = await dispatchNudgesCommand('off 8h', 'c1', repos, NOW);
    expect(repos.proactiveSettings.setMuted).toHaveBeenCalledWith('u1', true, new Date(NOW.getTime() + 8 * 3600_000));
    expect(reply).toContain('8 jam');
  });

  it('on unmutes and confirms', async () => {
    const repos = mockRepos({ muted: true });
    const { reply } = await dispatchNudgesCommand('on', 'c1', repos, NOW);
    expect(repos.proactiveSettings.setMuted).toHaveBeenCalledWith('u1', false);
    expect(reply).toContain('aktif');
  });

  it('replies help on unknown args', async () => {
    const repos = mockRepos();
    const { reply } = await dispatchNudgesCommand('banana', 'c1', repos, NOW);
    expect(reply).toContain('/nudges');
  });

  it('rejects unregistered users', async () => {
    const repos = mockRepos({ user: null });
    const { reply } = await dispatchNudgesCommand('off', 'ghost', repos, NOW);
    expect(reply).toContain('belum');
    expect(repos.proactiveSettings.setMuted).not.toHaveBeenCalled();
  });
});
