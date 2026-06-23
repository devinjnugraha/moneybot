import { CATEGORIES } from '../../domain/categories.js';
import { wibISOWeekLabel, wibISOWeekMonday, addDays, daysBetween } from '../../domain/time.js';
import type { Detector, ProactivePayload } from '../types.js';

// Static taxonomy lookup (categories are system-seeded, not user-editable).
const NAME_BY_ID = new Map(CATEGORIES.map((c) => [c.categoryId, c]));

interface AnomalyCategory {
  category: string;
  name: string;
  icon: string;
  thisWeek: number;
  avg: number;
}

/**
 * Build a weekly anomaly detector (design §9.4). Compares each category's spend
 * in the current ISO week against its rolling 4-week average; flags categories
 * whose this-week spend exceeds `multiplier` x average. The "avg > floor" gate
 * from the design is implemented as avg > 0: a category needs an established
 * baseline to be flagged (a brand-new spike in a never-used category is noise).
 * dedupKey anomaly:<YYYY-Www> caps at one insight per week.
 */
export function createAnomalyDetector(multiplier: number): Detector {
  return async ({ userId, repos, now }) => {
    const thisMonday = wibISOWeekMonday(now);
    const from = addDays(thisMonday, -28); // start of the 4 baseline weeks
    const to = addDays(thisMonday, 6); // this Sunday

    const txns = await repos.transactions.findByDateRange(userId, from, to);
    const thisWeek = new Map<string, number>();
    const priorTotal = new Map<string, number>();

    for (const t of txns) {
      if (t.type !== 'expense') continue;
      const cat = t.categoryId ?? 'other.misc';
      const off = Math.floor(daysBetween(thisMonday, t.date) / 7); // 0 this week, -1..-4 prior
      if (off === 0) thisWeek.set(cat, (thisWeek.get(cat) ?? 0) + t.amount);
      else if (off >= -4 && off < 0) priorTotal.set(cat, (priorTotal.get(cat) ?? 0) + t.amount);
    }

    const flagged: AnomalyCategory[] = [];
    for (const [cat, tw] of thisWeek) {
      const avg = (priorTotal.get(cat) ?? 0) / 4;
      if (avg <= 0) continue; // floor: no established baseline
      if (tw > multiplier * avg) {
        const meta = NAME_BY_ID.get(cat);
        flagged.push({
          category: cat,
          name: meta?.name ?? cat,
          icon: meta?.icon ?? '📌',
          thisWeek: tw,
          avg: Math.round(avg),
        });
      }
    }
    if (flagged.length === 0) return [];

    const week = wibISOWeekLabel(now);
    const payload: ProactivePayload = {
      triggerType: 'anomaly',
      dedupKey: `anomaly:${week}`,
      channel: 'llm',
      data: { week, flagged },
    };
    return [payload];
  };
}
