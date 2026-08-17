import { todayWIB, addDays } from '../../domain/time.js';
import { monthBounds } from '../../domain/analytics/period.js';
import { cashflowSummary } from '../../domain/analytics/cashflow.js';
import { pacing } from '../../domain/analytics/pacing.js';
import { leakCandidates, DORMANT_DAYS } from '../../domain/analytics/leaks.js';
import { healthVerdict } from '../../domain/analytics/health.js';
import type { HealthVerdict } from '../../domain/analytics/health.js';
import type { Detector, ProactivePayload } from '../types.js';

async function verdictFor(userId: string, deps: Parameters<Detector>[0]['repos'], target: string, today: string): Promise<HealthVerdict> {
  const y = Number(target.slice(0, 4));
  const m = Number(target.slice(5, 7));
  const asOf = target === today.slice(0, 7) ? today : monthBounds(y, m).to;
  const monthOf = (offset: number) => {
    let mm = m + offset, yy = y;
    while (mm < 1) { mm += 12; yy -= 1; }
    while (mm > 12) { mm -= 12; yy += 1; }
    return monthBounds(yy, mm);
  };
  const trailingStart = monthOf(-3).from;
  const allTx = await deps.transactions.findByDateRange(userId, trailingStart, asOf);
  const inMonth = (b: { from: string; to: string }) => allTx.filter((t) => t.date >= b.from && t.date <= b.to);

  const judged = monthOf(0);
  const prev = monthOf(-1);
  const trailing = [-3, -2, -1].map((o) => cashflowSummary(inMonth(monthOf(o))));
  const expenseOf = (b: { from: string; to: string }) =>
    inMonth(b).filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

  const budgets = await deps.budgets.findByUserAndMonth(userId, y, m);
  const accounts = await deps.accounts.findAllByUserId(userId);
  const liquidBalance = accounts
    .filter((a) => a.isActive && (a.type === 'cash' || a.type === 'bank'))
    .reduce((s, a) => s + a.balance, 0);
  const recurrings = await deps.recurrings.findAllByUserId(userId);

  const leaks = leakCandidates({
    currentTx: inMonth(judged), previousTx: inMonth(prev),
    tx60d: allTx.filter((t) => t.date >= addDays(asOf, -DORMANT_DAYS)), recurrings, today: asOf,
  });

  // Past months get no obligations — bill_coverage is forward-looking (spec §3.2).
  return healthVerdict({
    month: target, asOf,
    trailingCashflow: trailing,
    pacing: pacing(inMonth(judged), budgets, asOf),
    liquidBalance,
    currentExpense: expenseOf(judged),
    previousExpense: expenseOf(prev),
    leakCount: leaks.spikes.length + leaks.recurring.length,
  });
}

/**
 * Monthly health digest (advisory spec §4.2): on the 1st, judge the month that
 * just ended with full-month data, plus the month-before's statuses for the
 * composer's delta prose. dedupKey health-digest:<YYYY-MM> fires once per month.
 */
export const detectHealthDigest: Detector = async ({ userId, repos, now }) => {
  const accounts = await repos.accounts.findAllByUserId(userId);
  if (accounts.filter((a) => a.isActive).length === 0) return [];

  const today = todayWIB(now);
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const prevTarget = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;
  const prevPrevTarget = (() => {
    const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
    const ppm = pm === 1 ? 12 : pm - 1, ppy = pm === 1 ? py - 1 : py;
    return `${ppy}-${String(ppm).padStart(2, '0')}`;
  })();

  const verdict = await verdictFor(userId, repos, prevTarget, today);
  const prevVerdict = await verdictFor(userId, repos, prevPrevTarget, today);
  const prevStatuses = Object.fromEntries(prevVerdict.components.map((c) => [c.key, c.status]));

  const payload: ProactivePayload = {
    triggerType: 'health_digest',
    dedupKey: `health-digest:${prevTarget}`,
    channel: 'llm',
    data: {
      month: verdict.month,
      score: verdict.score,
      components: verdict.components,
      prevScore: prevVerdict.score,
      prevStatuses,
    },
  };
  return [payload];
};
