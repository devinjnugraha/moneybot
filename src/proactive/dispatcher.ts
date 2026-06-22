import type { CoreMessage } from 'ai';
import type { Repos } from '../repositories/interfaces.js';
import type { Detector, Composer, ProactivePolicy } from './types.js';
import { freshSession, trimTurns } from '../agent/orchestrator-helpers.js';
import { isMuted, inQuietHours, startOfTodayWIB } from './guard.js';
import { logEvent } from '../utils/logger.js';

export interface RunProactivePassOptions {
  detector: Detector;
  composer: Composer;
  repos: Repos;
  policy: ProactivePolicy;
  now: Date;
  send: (chatId: string, text: string) => Promise<void>;
}

/** Append the composed message as an assistant turn so the user can reply & drill in. */
async function seedAssistantTurn(
  repos: Repos,
  chatId: string,
  userId: string,
  text: string,
  nowIso: string,
  maxTurns: number,
): Promise<void> {
  const existing = await repos.sessions.get(chatId);
  const ctx = existing ?? freshSession(chatId, userId, nowIso);
  const turns = trimTurns(
    [...ctx.turns, { role: 'assistant', content: text } as CoreMessage],
    maxTurns,
  );
  await repos.sessions.set({ ...ctx, turns, lastActivityAt: nowIso });
}

/**
 * Run one proactive trigger for all users. Per-user try/catch guarantees a
 * single user's failure never stops others or throws to cron (design §11).
 */
export async function runProactivePass(o: RunProactivePassOptions): Promise<void> {
  if (!o.policy.enabled) return;

  const users = await o.repos.users.findAll();
  for (const user of users) {
    try {
      const settings = await o.repos.proactiveSettings.get(user.userId);
      if (isMuted(settings, o.now)) continue;
      if (inQuietHours(o.now, o.policy.quietHours)) continue;

      const payloads = await o.detector({ userId: user.userId, repos: o.repos, now: o.now });
      for (const payload of payloads) {
        // Cheap guards before any LLM call (design §10).
        if (await o.repos.outreach.existsKey(user.userId, payload.dedupKey)) continue;
        const sentToday = await o.repos.outreach.countSince(user.userId, startOfTodayWIB(o.now));
        if (sentToday >= o.policy.maxPerDay) continue;

        const text = await o.composer(payload, { now: o.now });
        await o.send(user.telegramChatId, text);

        // Atomic dedup backstop for any race between existsKey and record.
        await o.repos.outreach.record({
          userId: user.userId,
          triggerType: payload.triggerType,
          dedupKey: payload.dedupKey,
          payload: payload.data,
          sentAt: o.now,
        });
        await seedAssistantTurn(o.repos, user.telegramChatId, user.userId, text, o.now.toISOString(), o.policy.contextWindowTurns);
      }
    } catch (err) {
      logEvent('error', 'proactive trigger failed', { userId: user.userId, error: (err as Error).message });
    }
  }
}
