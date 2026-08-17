import type { RecurringPayment, Transaction } from '../entities.js';
import { normalizeDescription } from './normalize.js';

export interface LeakSpike {
  label: string;
  current: number;
  previous: number;
  deltaPct: number;
  countCurrent: number;
  countPrevious: number;
}

export interface LeakRecurring {
  name: string;
  amount: number;
  kind: 'new' | 'dormant';
}

export interface LeakCandidates {
  spikes: LeakSpike[];
  recurring: LeakRecurring[];
  recurringTotal: number;
  baselineTotal?: number;
}

/** Spike gates (spec §2.3): growth, occurrences each side, total floor, cap. */
const SPIKE_GROWTH_PCT = 50;
const SPIKE_MIN_COUNT = 2;
const SPIKE_MIN_CURRENT_TOTAL = 50_000;
const SPIKE_TOP_N = 5;
/** A subscription is "new" within this many days of creation (recurring creep). */
const NEW_SUBSCRIPTION_DAYS = 90;
/**
 * No matching instance in this window → dormant (spec §2.1c). Exported: the
 * caller fetches the transaction window with this span (see leak-alert trigger).
 */
export const DORMANT_DAYS = 60;

interface Group { total: number; count: number }
function groupByDescription(tx: Transaction[]): Map<string, Group> {
  const m = new Map<string, Group>();
  for (const t of tx) {
    if (t.type !== 'expense') continue;
    const key = normalizeDescription(t.description);
    if (key === '') continue;
    const g = m.get(key) ?? { total: 0, count: 0 };
    g.total += t.amount; g.count += 1;
    m.set(key, g);
  }
  return m;
}

/**
 * Leak candidates (spec §2.1): (a) description-group MoM spikes, (b) recurring
 * creep — new subscriptions (< 90d) vs an older baseline, (c) dormant
 * subscriptions (active but no instance transaction in 60d).
 * Deterministic: `today` is injected; `Date.parse` on it is not a clock read.
 */
export function leakCandidates(input: {
  currentTx: Transaction[];
  previousTx: Transaction[];
  tx60d: Transaction[];
  recurrings: RecurringPayment[];
  today: string;
}): LeakCandidates {
  const cur = groupByDescription(input.currentTx);
  const prev = groupByDescription(input.previousTx);

  const spikes: LeakSpike[] = [];
  for (const [label, c] of cur) {
    const p = prev.get(label);
    if (!p || p.total <= 0) continue; // needs an established baseline
    if (c.count < SPIKE_MIN_COUNT || p.count < SPIKE_MIN_COUNT) continue;
    if (c.total < SPIKE_MIN_CURRENT_TOTAL) continue;
    const deltaPct = Math.round(((c.total - p.total) / p.total) * 100);
    if (deltaPct <= SPIKE_GROWTH_PCT) continue;
    spikes.push({ label, current: c.total, previous: p.total, deltaPct, countCurrent: c.count, countPrevious: p.count });
  }
  spikes.sort((a, b) => b.deltaPct - a.deltaPct);

  const active = input.recurrings.filter((r) => r.isActive);
  const seenRecurringIds = new Set<string>();
  for (const t of input.tx60d) {
    if (t.isRecurringInstance && t.recurringId) seenRecurringIds.add(t.recurringId);
  }
  const nowMs = Date.parse(`${input.today}T00:00:00Z`);

  const recurring: LeakRecurring[] = [];
  let recurringTotal = 0;
  let baselineTotal = 0;
  let hasBaseline = false;
  for (const r of active) {
    recurringTotal += r.amount;
    const ageDays = (nowMs - Date.parse(r.createdAt)) / 86_400_000;
    if (ageDays < NEW_SUBSCRIPTION_DAYS) {
      recurring.push({ name: r.name, amount: r.amount, kind: 'new' });
    } else {
      baselineTotal += r.amount;
      hasBaseline = true;
      if (!seenRecurringIds.has(r.recurringId)) {
        recurring.push({ name: r.name, amount: r.amount, kind: 'dormant' });
      }
    }
  }

  return {
    spikes: spikes.slice(0, SPIKE_TOP_N),
    recurring,
    recurringTotal,
    baselineTotal: hasBaseline ? baselineTotal : undefined,
  };
}
