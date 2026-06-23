import { todayWIB, daysBetween } from '../../domain/time.js';
import type { Detector, ProactivePayload } from '../types.js';

/**
 * Build a logging-gap detector (design §9.3). Emits one nudge per day when the
 * user has logged nothing for at least `gapDays` days. A user with no
 * transactions at all is skipped — there is no baseline to nag from (a brand-new
 * user shouldn't get a "you haven't logged in 2 days" message).
 */
export function createLoggingGapDetector(gapDays: number): Detector {
  return async ({ userId, repos, now }) => {
    const latest = await repos.transactions.findLatestByUserId(userId, 1);
    if (latest.length === 0) return [];

    const today = todayWIB(now);
    const lastDate = latest[0]!.date;
    const gap = daysBetween(lastDate, today);
    if (gap < gapDays) return [];

    const payload: ProactivePayload = {
      triggerType: 'logging_gap',
      dedupKey: `gap:${today}`,
      channel: 'template',
      data: { gapDays: gap, lastDate },
    };
    return [payload];
  };
}
