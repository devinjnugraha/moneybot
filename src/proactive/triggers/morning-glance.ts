import { todayWIB, addDays, wibYear, wibMonth } from '../../domain/time.js';
import type { Detector, ProactivePayload } from '../types.js';

interface DueBill { recurringId: string; name: string; amount: number; account: string }
interface Upcoming { name: string; amount: number; account: string; dueDate: string }

/**
 * Morning glance detector (design §5). Always returns one payload per user with
 * an active account — the day's forward-looking "she's watching" touch. Gathers:
 * active-account balances, recurring bills due tomorrow..+7d (upcoming, text),
 * recurring bills due today & not yet processed this month (todayDueBills → get
 * inline buttons in the composer), and yesterday's expense activity.
 */
export const detectMorningGlance: Detector = async ({ userId, repos, now }) => {
  const today = todayWIB(now);
  const tomorrow = addDays(today, 1);
  const plus7 = addDays(today, 7);
  const year = wibYear(now);
  const month = wibMonth(now);
  const monthTag = `${year}-${String(month).padStart(2, '0')}`;

  const accounts = (await repos.accounts.findAllByUserId(userId)).filter((a) => a.isActive);
  if (accounts.length === 0) return []; // onboarding incomplete — nothing to glance at

  const balances = accounts.map((a) => ({ name: a.name, type: a.type, balance: a.balance }));

  // Resolve recurring bill account names (cache; active accounts are pre-seeded).
  const accName = new Map<string, string>(accounts.map((a) => [a.accountId, a.name]));
  const nameOf = async (accountId: string): Promise<string> => {
    const cached = accName.get(accountId);
    if (cached) return cached;
    const a = await repos.accounts.findById(userId, accountId);
    const n = a?.name ?? accountId;
    accName.set(accountId, n);
    return n;
  };

  const todayDueBills: DueBill[] = [];
  const upcoming: Upcoming[] = [];
  for (const r of await repos.recurrings.findAllByUserId(userId)) {
    if (!r.isActive) continue;
    const firedThisMonth = !!r.lastFiredAt && r.lastFiredAt.startsWith(monthTag);
    if (r.nextFireAt === today && !firedThisMonth) {
      todayDueBills.push({ recurringId: r.recurringId, name: r.name, amount: r.amount, account: await nameOf(r.accountId) });
    } else if (r.nextFireAt >= tomorrow && r.nextFireAt <= plus7) {
      upcoming.push({ name: r.name, amount: r.amount, account: await nameOf(r.accountId), dueDate: r.nextFireAt });
    }
  }
  upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const yesterdayRows = await repos.transactions.findByDateRange(userId, addDays(today, -1), addDays(today, -1));
  const yExp = yesterdayRows.filter((t) => t.type === 'expense');
  const yesterday = yExp.length > 0
    ? { count: yExp.length, totalSpend: yExp.reduce((s, t) => s + t.amount, 0) }
    : null;

  const payload: ProactivePayload = {
    triggerType: 'morning_glance',
    dedupKey: `morning-glance:${today}`,
    channel: 'llm',
    data: { balances, upcoming, yesterday, todayDueBills },
  };
  return [payload];
};
