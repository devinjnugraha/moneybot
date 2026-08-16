import type { Transaction } from '../entities.js';
import { normalizeDescription } from './normalize.js';

export type BreakdownKey = 'category' | 'budget' | 'description';

export interface CompareGroup {
  key: string;
  current: number;
  countCurrent: number;
  previous?: number;
  countPrevious?: number;
  deltaPct?: number;
  pctOfTotal?: number;
}

export interface PeriodCompareResult {
  currentTotal: number;
  previousTotal?: number;
  deltaPct?: number;
  groups: CompareGroup[];
}

const DELTA_PCT_MULTIPLIER = 100;

/** Expenses only; the caller range-filters. Transfers/income never aggregate (FR-10e). */
function expenses(tx: Transaction[]): Transaction[] {
  return tx.filter((t) => t.type === 'expense');
}

function groupKey(t: Transaction, breakdown: BreakdownKey): string | undefined {
  if (breakdown === 'category') return t.categoryId ?? '__uncategorized__';
  if (breakdown === 'budget') return t.budgetCodeId ?? '__none__';
  const n = normalizeDescription(t.description);
  return n === '' ? undefined : n; // digit-only / empty → skip the group
}

function pctDelta(cur: number, prev: number): number | undefined {
  if (prev <= 0) return undefined;
  return Math.round(((cur - prev) / prev) * DELTA_PCT_MULTIPLIER);
}

/**
 * Aggregate two periods of expenses and diff them (spec §2.1). `previous`
 * undefined → current-only result (no delta fields). Groups sort by |deltaPct|
 * desc when compared (what changed most matters most), else by current desc.
 */
export function periodCompare(
  current: Transaction[],
  previous: Transaction[] | undefined,
  opts: { breakdown: BreakdownKey; topN?: number },
): PeriodCompareResult {
  const topN = opts.topN ?? 10;

  const cur = new Map<string, { total: number; count: number }>();
  for (const t of expenses(current)) {
    const k = groupKey(t, opts.breakdown);
    if (!k) continue;
    const g = cur.get(k) ?? { total: 0, count: 0 };
    g.total += t.amount; g.count += 1;
    cur.set(k, g);
  }
  const prev = new Map<string, { total: number; count: number }>();
  if (previous) {
    for (const t of expenses(previous)) {
      const k = groupKey(t, opts.breakdown);
      if (!k) continue;
      const g = prev.get(k) ?? { total: 0, count: 0 };
      g.total += t.amount; g.count += 1;
      prev.set(k, g);
    }
  }

  // Totals cover ALL expenses, not just grouped ones — a digit-only description
  // is skipped as a group but still counts toward the period total.
  const currentTotal = expenses(current).reduce((s, t) => s + t.amount, 0);
  const result: PeriodCompareResult = { currentTotal, groups: [] };

  if (previous) {
    const previousTotal = expenses(previous).reduce((s, t) => s + t.amount, 0);
    result.previousTotal = previousTotal;
    result.deltaPct = pctDelta(currentTotal, previousTotal);
  }

  const keys = new Set<string>([...cur.keys(), ...prev.keys()]);
  for (const key of keys) {
    const c = cur.get(key);
    const p = prev.get(key);
    const g: CompareGroup = {
      key,
      current: c?.total ?? 0,
      countCurrent: c?.count ?? 0,
    };
    if (c && currentTotal > 0) g.pctOfTotal = Math.round((c.total / currentTotal) * DELTA_PCT_MULTIPLIER);
    if (previous) {
      g.previous = p?.total ?? 0;
      g.countPrevious = p?.count ?? 0;
      g.deltaPct = pctDelta(g.current, g.previous);
    }
    result.groups.push(g);
  }

  result.groups.sort((a, b) =>
    previous
      ? Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0) || b.current - a.current
      : b.current - a.current,
  );
  result.groups = result.groups.slice(0, topN);
  return result;
}
