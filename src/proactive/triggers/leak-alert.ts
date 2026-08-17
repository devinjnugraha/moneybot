import { addDays, todayWIB, wibISOWeekLabel } from '../../domain/time.js';
import { monthBounds } from '../../domain/analytics/period.js';
import { leakCandidates, DORMANT_DAYS } from '../../domain/analytics/leaks.js';
import type { Detector, ProactivePayload } from '../types.js';

/**
 * Weekly leak detector (advisory spec §4.1): current month-to-date vs previous
 * full month. Fires only when a spike clears the gates or a subscription is
 * new/dormant. dedupKey leak-alert:<YYYY-Www> caps at one alert per week.
 */
export const detectLeakAlert: Detector = async ({ userId, repos, now }) => {
  const today = todayWIB(now);
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const currentMonth = monthBounds(y, m);
  const prevMonth = monthBounds(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1);
  const from60 = addDays(today, -DORMANT_DAYS);

  const [currentTx, previousTx, tx60d, recurrings] = await Promise.all([
    repos.transactions.findByDateRange(userId, currentMonth.from, today),
    repos.transactions.findByDateRange(userId, prevMonth.from, prevMonth.to),
    repos.transactions.findByDateRange(userId, from60, today),
    repos.recurrings.findAllByUserId(userId),
  ]);

  const candidates = leakCandidates({ currentTx, previousTx, tx60d, recurrings, today });
  if (candidates.spikes.length === 0 && candidates.recurring.length === 0) return [];

  const payload: ProactivePayload = {
    triggerType: 'leak_alert',
    dedupKey: `leak-alert:${wibISOWeekLabel(now)}`,
    channel: 'llm',
    data: {
      week: wibISOWeekLabel(now),
      spikes: candidates.spikes,
      recurring: candidates.recurring,
      recurringTotal: candidates.recurringTotal,
      ...(candidates.baselineTotal != null ? { baselineTotal: candidates.baselineTotal } : {}),
    },
  };
  return [payload];
};
