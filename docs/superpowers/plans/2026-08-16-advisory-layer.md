# Advisory Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the advisory layer per `docs/superpowers/specs/2026-08-16-advisory-layer-design.md` — a pure analytics module in `src/domain/analytics/`, `get_analytics` + `get_financial_health` read-tools, a Tuesday leak alert, and a monthly health digest.

**Architecture:** All derived metrics are pure functions in `src/domain/analytics/` (no I/O, `today` always injected as a parameter). Read-tools and proactive triggers/composers fetch domain objects via `repos` and feed the module. Deterministic blocks render in code; the LLM only writes prose.

**Tech Stack:** TypeScript (strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`), zod, Vercel AI SDK `tool()`, vitest, existing proactive engine (Detector/Composer/guard/dispatcher).

## Global Constraints

- **NFR-02:** `pg`/db drivers importable ONLY inside `src/adapters/neon/`. The analytics module is pure `domain/` code — it may import only `../entities.js`, `../time.js`, `../categories.js` (and sibling analytics files).
- **Every task passes:** `npx tsc --noEmit` AND `npm run lint` AND its `npx vitest run <files>`. Vitest strips types and can pass while tsc fails — always run tsc too.
- **`verbatimModuleSyntax`:** type-only imports MUST use `import type { … } from '…js'`. All relative imports carry the `.js` extension.
- **`noUncheckedIndexedAccess`:** array indexing yields `T | undefined` — use `!` only where provably safe; prefer `??` and optional chaining.
- **Dates:** all calendar dates are `'YYYY-MM-DD'` WIB strings. Reuse `src/domain/time.ts` (`addDays`, `daysBetween`, `lastDayOfMonth`) — never `Date.now()` inside analytics functions.
- **Money:** whole-IDR numbers; user-facing formatting uses the existing `idr()` helper in `src/proactive/composers/template.ts`.
- **Bahasa Indonesia** for all user-facing copy; IDR format without "Rp" (e.g. `20.000`).
- **Thresholds are named constants** with a doc comment — no magic numbers in logic.
- **Known pre-existing failure:** `tests/agent/system-prompt.test.ts` has drifted and may fail before this work starts. Do NOT fix it in these tasks (scope creep); new prompt assertions go in a NEW test file. If it fails identically before and after your change, that is pre-existing.

## File Structure

New (all under `src/domain/analytics/`, one responsibility each):

| File | Responsibility |
|---|---|
| `period.ts` | WIB period math: month bounds, comparison-window resolution |
| `normalize.ts` | description normalization for grouping |
| `compare.ts` | `periodCompare` — two-period totals + per-group deltas |
| `cashflow.ts` | `cashflowSummary` — income/expense/net/savings-rate |
| `pacing.ts` | `pacing` — run-rate projection per budget |
| `obligations.ts` | `obligations` — next-30d bills vs liquid balance |
| `leaks.ts` | `leakCandidates` — spikes, new/dormant subscriptions |
| `health.ts` | `healthVerdict` — components + weighted score |

Modified: `src/agent/tools.ts` (2 tools), `src/agent/system-prompt.ts` (advice rules), `src/domain/entities.ts` (2 trigger types), `src/config/index.ts` (2 crons), `src/scheduler/cron.ts` (2 jobs), `src/proactive/triggers/morning-glance.ts` + `composers/morning-glance.ts` (pacing slice), `src/proactive/prompt.ts` (2 prompts), `src/proactive/composers/template.ts` (2 fallback templates), `.env.example`.

New outside analytics: `src/proactive/triggers/leak-alert.ts`, `src/proactive/composers/leak-alert.ts`, `src/proactive/triggers/health-digest.ts`, `src/proactive/composers/health-digest.ts`, plus test files mirroring them.

Slices: Tasks 1–4 = trends foundation · 5–8 = forward-looking · 9–10 = leak detection · 11–13 = financial health.

---

### Task 1: `period.ts` + `normalize.ts` (pure period/description helpers)

**Files:**
- Create: `src/domain/analytics/period.ts`
- Create: `src/domain/analytics/normalize.ts`
- Test: `tests/domain/analytics-period.test.ts`, `tests/domain/analytics-normalize.test.ts`

**Interfaces (produced — later tasks import these):**
```ts
// period.ts
export function monthBounds(year: number, month: number): { from: string; to: string }
export function resolveComparison(
  from: string, to: string,
  compareWith: 'previous_period' | 'previous_month' | 'previous_year',
): { from: string; to: string }
// normalize.ts
export function normalizeDescription(raw: string): string
```

- [ ] **Step 1: Write the failing tests**

`tests/domain/analytics-period.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { monthBounds, resolveComparison } from '../../src/domain/analytics/period.js';

describe('monthBounds', () => {
  it('returns first..last day of the month', () => {
    expect(monthBounds(2026, 8)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(monthBounds(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' }); // non-leap
    expect(monthBounds(2024, 2)).toEqual({ from: '2024-02-01', to: '2024-02-29' }); // leap
  });
});

describe('resolveComparison', () => {
  it('previous_period: same-length window immediately before from', () => {
    expect(resolveComparison('2026-08-01', '2026-08-15', 'previous_period'))
      .toEqual({ from: '2026-07-17', to: '2026-07-31' }); // len 15
  });

  it('previous_period: single-day range maps to the day before', () => {
    expect(resolveComparison('2026-08-10', '2026-08-10', 'previous_period'))
      .toEqual({ from: '2026-08-09', to: '2026-08-09' });
  });

  it('previous_month: full calendar month before the month of from', () => {
    expect(resolveComparison('2026-08-05', '2026-08-20', 'previous_month'))
      .toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });

  it('previous_month: crosses the year boundary', () => {
    expect(resolveComparison('2026-01-05', '2026-01-20', 'previous_month'))
      .toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('previous_year: same window one year earlier', () => {
    expect(resolveComparison('2026-08-01', '2026-08-31', 'previous_year'))
      .toEqual({ from: '2025-08-01', to: '2025-08-31' });
  });

  it('previous_year: clamps Feb 29 to Feb 28', () => {
    expect(resolveComparison('2024-02-29', '2024-02-29', 'previous_year'))
      .toEqual({ from: '2023-02-28', to: '2023-02-28' });
  });
});
```

`tests/domain/analytics-normalize.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { normalizeDescription } from '../../src/domain/analytics/normalize.js';

describe('normalizeDescription', () => {
  it('trims, lowercases, collapses whitespace', () => {
    expect(normalizeDescription('  Kopi   Kenangan  ')).toBe('kopi kenangan');
  });

  it('truncates at punctuation (parenthetical notes dropped)', () => {
    expect(normalizeDescription('Kopi Kenangan (diskon gofood)')).toBe('kopi kenangan');
    expect(normalizeDescription('makan siang - warteg')).toBe('makan siang');
  });

  it('strips digits and qty markers', () => {
    expect(normalizeDescription('kopi 2 x')).toBe('kopi');
    expect(normalizeDescription('kopi x2')).toBe('kopi');
    expect(normalizeDescription('susu 3pcs')).toBe('susu');
    expect(normalizeDescription('bakso 2 porsi')).toBe('bakso');
  });

  it('returns empty string for digit-only or empty input', () => {
    expect(normalizeDescription('123')).toBe('');
    expect(normalizeDescription('   ')).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/domain/analytics-period.test.ts tests/domain/analytics-normalize.test.ts`
Expected: FAIL — cannot resolve `../../src/domain/analytics/period.js` / `normalize.js`.

- [ ] **Step 3: Implement**

`src/domain/analytics/period.ts`:
```ts
import { addDays, daysBetween, lastDayOfMonth } from '../time.js';

export type CompareWith = 'previous_period' | 'previous_month' | 'previous_year';

/** 'YYYY-MM-DD' first..last day of a calendar month (month is 1–12). */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, '0');
  const last = String(lastDayOfMonth(year, month)).padStart(2, '0');
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${last}` };
}

/** Same month/day one year earlier, clamped to that month's length (Feb 29 → 28). */
function sameDatePrevYear(d: string): string {
  const y = Number(d.slice(0, 4)) - 1;
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  const max = lastDayOfMonth(y, m);
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, max)).padStart(2, '0')}`;
}

/**
 * Resolve the comparison window for a requested range (spec §3.1):
 * - previous_period: the same-length window immediately preceding `from`
 * - previous_month:  the full calendar month before the month of `from`
 * - previous_year:   the same window one year earlier (Feb-29 clamped)
 */
export function resolveComparison(
  from: string,
  to: string,
  compareWith: CompareWith,
): { from: string; to: string } {
  if (compareWith === 'previous_period') {
    const len = daysBetween(from, to) + 1;
    return { from: addDays(from, -len), to: addDays(from, -1) };
  }
  if (compareWith === 'previous_month') {
    const y = Number(from.slice(0, 4));
    const m = Number(from.slice(5, 7));
    return monthBounds(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1);
  }
  return { from: sameDatePrevYear(from), to: sameDatePrevYear(to) };
}
```

`src/domain/analytics/normalize.ts`:
```ts
/**
 * Normalize a free-text transaction description into a stable grouping key
 * (spec §2.3): trim → lowercase → truncate at the first punctuation → strip
 * digits & qty markers (2x, x2, 3pcs, 2 porsi …) → collapse whitespace.
 * Returns '' when nothing survives (digit-only / empty) — callers skip it.
 */
export function normalizeDescription(raw: string): string {
  let s = raw.trim().toLowerCase();
  const punct = s.search(/[.,;:!?)(-]/);
  if (punct > 0) s = s.slice(0, punct);
  s = s
    .replace(/\b\d+\s*(x|pcs|buah|cup|porsi|bks)\b/g, ' ')
    .replace(/\bx\s*\d+\b/g, ' ')
    .replace(/\d+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/domain/analytics-period.test.ts tests/domain/analytics-normalize.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/domain/analytics/period.ts src/domain/analytics/normalize.ts tests/domain/analytics-period.test.ts tests/domain/analytics-normalize.test.ts
git commit -m "feat: analytics period + description-normalization helpers"
```

---

### Task 2: `compare.ts` + `cashflow.ts`

**Files:**
- Create: `src/domain/analytics/compare.ts`
- Create: `src/domain/analytics/cashflow.ts`
- Test: `tests/domain/analytics-compare.test.ts`, `tests/domain/analytics-cashflow.test.ts`

**Interfaces:**
- Consumes: `normalizeDescription` (Task 1); `Transaction` from `../entities.js`.
- Produces (exact shapes later tasks and tools rely on):
```ts
export type BreakdownKey = 'category' | 'budget' | 'description';
export interface CompareGroup {
  key: string;          // categoryId | budgetCodeId | normalized description
  current: number; countCurrent: number;
  previous?: number; countPrevious?: number;
  deltaPct?: number;    // integer %, undefined when previous is 0/absent
  pctOfTotal?: number;  // integer % share of current total
}
export interface PeriodCompareResult {
  currentTotal: number;
  previousTotal?: number;
  deltaPct?: number;
  groups: CompareGroup[]; // sorted by |deltaPct| desc when compared, else by current desc
}
export function periodCompare(
  current: Transaction[], previous: Transaction[] | undefined,
  opts: { breakdown: BreakdownKey; topN?: number },
): PeriodCompareResult

export interface CashflowSummary {
  income: number; expense: number; net: number;
  savingsRate?: number; // integer % of income; undefined when income = 0
}
export function cashflowSummary(tx: Transaction[]): CashflowSummary
```

- [ ] **Step 1: Write the failing tests**

`tests/domain/analytics-compare.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { periodCompare } from '../../src/domain/analytics/compare.js';
import type { Transaction } from '../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

describe('periodCompare — category breakdown', () => {
  const current = [
    mkTxn({ categoryId: 'food.coffee', amount: 150_000 }),
    mkTxn({ categoryId: 'food.coffee', amount: 50_000 }),
    mkTxn({ categoryId: 'transport.fuel', amount: 100_000 }),
    mkTxn({ type: 'transfer', amount: 500_000 }), // excluded everywhere
    mkTxn({ type: 'income', amount: 5_000_000 }), // excluded from expense totals
  ];
  const previous = [
    mkTxn({ categoryId: 'food.coffee', amount: 100_000 }),
    mkTxn({ categoryId: 'transport.fuel', amount: 100_000 }),
  ];

  it('totals only expenses; overall delta is rounded integer %', () => {
    const r = periodCompare(current, previous, { breakdown: 'category' });
    expect(r.currentTotal).toBe(300_000);
    expect(r.previousTotal).toBe(200_000);
    expect(r.deltaPct).toBe(50);
  });

  it('per-group deltas: coffee +100%, fuel 0%; sorted by |delta| desc', () => {
    const r = periodCompare(current, previous, { breakdown: 'category' });
    expect(r.groups[0]).toMatchObject({ key: 'food.coffee', current: 200_000, previous: 100_000, deltaPct: 100, pctOfTotal: 67 });
    expect(r.groups[1]).toMatchObject({ key: 'transport.fuel', current: 100_000, previous: 100_000, deltaPct: 0 });
  });

  it('deltaPct undefined when previous is 0 (new group)', () => {
    const r = periodCompare([mkTxn({ categoryId: 'other.misc', amount: 10_000 })], [], { breakdown: 'category' });
    expect(r.groups[0]!.deltaPct).toBeUndefined();
    expect(r.currentTotal).toBe(10_000);
  });

  it('current-only call (no previous) sorts by current desc, no delta fields', () => {
    const r = periodCompare(current, undefined, { breakdown: 'category' });
    expect(r.previousTotal).toBeUndefined();
    expect(r.deltaPct).toBeUndefined();
    expect(r.groups.map((g) => g.key)).toEqual(['food.coffee', 'transport.fuel']);
  });

  it('topN caps the group list', () => {
    const many = Array.from({ length: 5 }, (_, i) => mkTxn({ categoryId: `c${i}`, amount: (i + 1) * 1000 }));
    const r = periodCompare(many, undefined, { breakdown: 'category', topN: 3 });
    expect(r.groups).toHaveLength(3);
  });

  it('uncategorized expenses group under __uncategorized__', () => {
    const r = periodCompare([mkTxn({ amount: 5_000 })], undefined, { breakdown: 'category' });
    expect(r.groups[0]!.key).toBe('__uncategorized__');
  });
});

describe('periodCompare — description breakdown uses normalizeDescription', () => {
  it('groups variants of the same merchant-ish string', () => {
    const current = [
      mkTxn({ description: 'Kopi Kenangan', amount: 100_000 }),
      mkTxn({ description: 'kopi kenangan (diskon)', amount: 50_000 }),
      mkTxn({ description: 'kopi kenangan 2x', amount: 50_000 }),
    ];
    const previous = [mkTxn({ description: 'Kopi Kenangan', amount: 100_000 })];
    const r = periodCompare(current, previous, { breakdown: 'description' });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.key).toBe('kopi kenangan');
    expect(r.groups[0]!.current).toBe(200_000);
  });

  it('empty normalized keys are skipped', () => {
    const r = periodCompare([mkTxn({ description: '123', amount: 5_000 })], undefined, { breakdown: 'description' });
    expect(r.groups).toHaveLength(0);
    expect(r.currentTotal).toBe(5_000); // total still counted
  });
});
```

`tests/domain/analytics-cashflow.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { cashflowSummary } from '../../src/domain/analytics/cashflow.js';
import type { Transaction } from '../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

describe('cashflowSummary', () => {
  it('sums income/expense, excludes transfers, computes net + savings rate', () => {
    const r = cashflowSummary([
      mkTxn({ type: 'income', amount: 5_000_000 }),
      mkTxn({ amount: 3_000_000 }),
      mkTxn({ amount: 1_000_000 }),
      mkTxn({ type: 'transfer', amount: 2_000_000 }),
    ]);
    expect(r).toEqual({ income: 5_000_000, expense: 4_000_000, net: 1_000_000, savingsRate: 20 });
  });

  it('savingsRate undefined when income is 0 (never a fake -∞)', () => {
    const r = cashflowSummary([mkTxn({ amount: 500_000 })]);
    expect(r.savingsRate).toBeUndefined();
    expect(r.net).toBe(-500_000);
  });

  it('empty transactions → all zeros', () => {
    expect(cashflowSummary([])).toEqual({ income: 0, expense: 0, net: 0, savingsRate: undefined });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/domain/analytics-compare.test.ts tests/domain/analytics-cashflow.test.ts`
Expected: FAIL — cannot resolve the new modules.

- [ ] **Step 3: Implement**

`src/domain/analytics/compare.ts`:
```ts
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

  const currentTotal = Array.from(cur.values()).reduce((s, g) => s + g.total, 0);
  const result: PeriodCompareResult = { currentTotal, groups: [] };

  if (previous) {
    const previousTotal = Array.from(prev.values()).reduce((s, g) => s + g.total, 0);
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
```

`src/domain/analytics/cashflow.ts`:
```ts
import type { Transaction } from '../entities.js';

export interface CashflowSummary {
  income: number;
  expense: number;
  net: number;
  savingsRate?: number; // integer %; undefined when income = 0 (spec §5)
}

/** Income vs expense over an already-range-filtered set. Transfers excluded. */
export function cashflowSummary(tx: Transaction[]): CashflowSummary {
  let income = 0;
  let expense = 0;
  for (const t of tx) {
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'expense') expense += t.amount;
  }
  const net = income - expense;
  return {
    income,
    expense,
    net,
    savingsRate: income > 0 ? Math.round((net / income) * 100) : undefined,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/domain/analytics-compare.test.ts tests/domain/analytics-cashflow.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/domain/analytics/compare.ts src/domain/analytics/cashflow.ts tests/domain/analytics-compare.test.ts tests/domain/analytics-cashflow.test.ts
git commit -m "feat: analytics periodCompare + cashflowSummary"
```

---

### Task 3: `get_analytics` tool (read layer)

**Files:**
- Modify: `src/agent/tools.ts` — insert after the `tools.get_report = tool({ … });` block (ends ~line 562, before `// Gate only WRITE tools…`)
- Test: `tests/agent/tools-analytics.test.ts` (new self-contained file, following `tests/agent/tools.test.ts` mock pattern)

**Interfaces:**
- Consumes: `periodCompare`, `cashflowSummary`, `resolveComparison`, `CATEGORIES`, `repos.transactions.findByDateRange`, `repos.budgets.findByUserAndMonth`.
- Produces: agent tool `get_analytics` registered un-gated (read tool) with the JSON response shape asserted below.

- [ ] **Step 1: Write the failing test**

`tests/agent/tools-analytics.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { buildTools } from '../../src/agent/tools.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { Transaction } from '../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

function mockRepos(opts: { txns?: Transaction[] } = {}): Repos {
  const findByDateRange = vi.fn(async (_userId: string, from: string, _to: string) =>
    (opts.txns ?? []).filter((t) => t.date >= from && t.date <= _to),
  );
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(async () => []), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(), findByDateRange,
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(async () => []), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn(), rollRecurringIntoMonth: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(async () => []), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    cardStatements: {} as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

const NOW = new Date('2026-08-16T03:00:00Z'); // WIB 2026-08-16

describe('buildTools — get_analytics', () => {
  it('is registered as a read tool even before onboarding (hasAccount=false)', () => {
    const tools = buildTools({ userId: 'u1', repos: mockRepos(), hasAccount: false });
    expect(tools.get_analytics).toBeDefined();
  });

  it('current + previous month compare with category labels and deltas', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-08-05', categoryId: 'food.coffee', amount: 200_000 }),
        mkTxn({ date: '2026-07-10', categoryId: 'food.coffee', amount: 100_000 }),
      ],
    });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics.execute!(
      { from: '2026-08-01', to: '2026-08-31', compareWith: 'previous_month', breakdown: 'category' },
      { toolCallId: 'c', messages: [] as never },
    ) as Record<string, never>;
    expect(out.currentTotal).toBe(200_000);
    expect(out.previousTotal).toBe(100_000);
    expect(out.deltaPct).toBe(100);
    expect(out.comparison).toEqual({ label: 'previous_month', from: '2026-07-01', to: '2026-07-31' });
    const coffee = (out.groups as { key: string; label: string; icon?: string }[]).find((g) => g.key === 'food.coffee');
    expect(coffee?.label).toBe('Kopi & Minuman'); // CATEGORIES label decoration
    expect(coffee?.icon).toBe('☕');
  });

  it('includes cashflow + savingsRate when the range spans >= 28 days', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-08-02', type: 'income', amount: 5_000_000 }),
        mkTxn({ date: '2026-08-03', amount: 4_000_000 }),
      ],
    });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics.execute!(
      { from: '2026-08-01', to: '2026-08-31' },
      { toolCallId: 'c', messages: [] as never },
    ) as Record<string, never>;
    expect(out.cashflow).toEqual({ income: 5_000_000, expense: 4_000_000, net: 1_000_000, savingsRate: 20 });
  });

  it('omits cashflow for short ranges', async () => {
    const repos = mockRepos({ txns: [mkTxn({ date: '2026-08-02', amount: 10_000 })] });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics.execute!(
      { from: '2026-08-01', to: '2026-08-07' },
      { toolCallId: 'c', messages: [] as never },
    ) as Record<string, never>;
    expect(out.cashflow).toBeUndefined();
  });

  it('drill-down: categoryId filter restricts groups', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-08-05', categoryId: 'food.coffee', amount: 50_000 }),
        mkTxn({ date: '2026-08-06', categoryId: 'transport.fuel', amount: 60_000 }),
      ],
    });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics.execute!(
      { from: '2026-08-01', to: '2026-08-31', categoryId: 'food.coffee' },
      { toolCallId: 'c', messages: [] as never },
    ) as Record<string, never>;
    expect(out.currentTotal).toBe(50_000);
    expect(out.groups).toHaveLength(1);
  });

  it('description breakdown labels groups by normalized key', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-08-05', description: 'Kopi Kenangan', amount: 50_000 }),
        mkTxn({ date: '2026-08-06', description: 'kopi kenangan 2x', amount: 25_000 }),
      ],
    });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics.execute!(
      { from: '2026-08-01', to: '2026-08-31', breakdown: 'description' },
      { toolCallId: 'c', messages: [] as never },
    ) as Record<string, never>;
    expect(out.groups).toHaveLength(1);
    expect((out.groups as { label: string }[])[0].label).toBe('kopi kenangan');
  });
});
```

Note: the exact `execute` second-arg shape varies by AI SDK version — if the call signature errors, invoke `get_analytics.execute!(params as never, {} as never)`; the assertions are on the returned object only. `vi.setSystemTime` is NOT needed — the tool takes explicit from/to.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/agent/tools-analytics.test.ts`
Expected: FAIL — `tools.get_analytics` undefined.

- [ ] **Step 3: Implement — insert into `src/agent/tools.ts`**

Add to the existing import from `'../domain/time.js'` (line 6): `daysBetween`. Add new imports near the other domain imports:
```ts
import { periodCompare, type BreakdownKey } from '../domain/analytics/compare.js';
import { cashflowSummary } from '../domain/analytics/cashflow.js';
import { resolveComparison } from '../domain/analytics/period.js';
```
Insert AFTER the closing of `tools.get_report` and BEFORE `// Gate only WRITE tools behind onboarding`:
```ts
  tools.get_analytics = tool({
    description:
      'Analitik pengeluaran dengan perbandingan periode: total + delta%, breakdown per kategori/budget/deskripsi, ' +
      'cashflow & savings rate untuk rentang panjang. Untuk pertanyaan analisis/tren ("boros apa?", "naik dari mana?"). ' +
      'Transfer SELALU dikecualikan (FR-10e).',
    parameters: z.object({
      from: z.string().describe('YYYY-MM-DD (WIB), inklusif.'),
      to: z.string().describe('YYYY-MM-DD (WIB), inklusif.'),
      compareWith: z.enum(['previous_period', 'previous_month', 'previous_year']).optional()
        .describe('Periode pembanding; tanpa ini hanya periode current.'),
      breakdown: z.enum(['category', 'budget', 'description']).optional().default('category'),
      categoryId: z.string().optional().describe('Drill-down ke satu kategori.'),
      budgetCodeId: z.string().optional().describe('Drill-down ke satu budget code.'),
      topN: z.number().int().positive().optional().default(10),
    }),
    execute: async ({ from, to, compareWith, breakdown, categoryId, budgetCodeId, topN }) => {
      try {
        const rangeFilter = (t: Transaction) =>
          (!categoryId || t.categoryId === categoryId) &&
          (!budgetCodeId || t.budgetCodeId === budgetCodeId);

        const currentRows = (await repos.transactions.findByDateRange(userId, from, to)).filter(rangeFilter);
        const comparison = compareWith
          ? { label: compareWith, ...resolveComparison(from, to, compareWith) }
          : undefined;
        const previousRows = comparison
          ? (await repos.transactions.findByDateRange(userId, comparison.from, comparison.to)).filter(rangeFilter)
          : undefined;

        const result = periodCompare(currentRows, previousRows, {
          breakdown: breakdown as BreakdownKey,
          topN,
        });

        // Decorate group labels (module returns raw keys; it stays pure).
        const categoryMap = new Map(CATEGORIES.map((c) => [c.categoryId, c]));
        const budgetMap = breakdown === 'budget'
          ? new Map(
              (await repos.budgets.findByUserAndMonth(
                userId, Number(from.slice(0, 4)), Number(from.slice(5, 7)),
              )).map((b) => [b.budgetCodeId, b]),
            )
          : new Map();
        const groups = result.groups.map((g) => {
          let label = g.key;
          let icon: string | undefined;
          if (breakdown === 'category') {
            const cat = g.key !== '__uncategorized__' ? categoryMap.get(g.key) : undefined;
            label = cat?.name ?? 'Tanpa Kategori';
            icon = cat?.icon;
          } else if (breakdown === 'budget') {
            const bc = g.key !== '__none__' ? budgetMap.get(g.key) : undefined;
            label = bc?.name ?? 'Tanpa Budget';
          } // 'description': normalized key is already the readable label
          return { ...g, label, icon };
        });

        // Cashflow for ranges spanning >= 28 days (spec §3.1 "spans ≥ 1 month").
        const cashflow = daysBetween(from, to) + 1 >= 28
          ? cashflowSummary(currentRows)
          : undefined;

        return {
          range: { from, to },
          comparison,
          currentTotal: result.currentTotal,
          previousTotal: result.previousTotal,
          deltaPct: result.deltaPct,
          groups,
          ...(cashflow ? { cashflow, savingsRate: cashflow.savingsRate } : {}),
        };
      } catch (e) {
        logEvent('error', 'get_analytics failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal menghitung analitik. Coba lagi.' };
      }
    },
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/agent/tools-analytics.test.ts`
Expected: PASS. (If the `food.coffee` label/icon assertion fails, check the seeded name in `src/domain/categories.ts` and adjust the assertion to the actual seed value — do NOT change the seed.)

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/agent/tools.ts tests/agent/tools-analytics.test.ts
git commit -m "feat: get_analytics read tool (period compare, breakdowns, cashflow)"
```

---

### Task 4: System-prompt advice rules

**Files:**
- Modify: `src/agent/system-prompt.ts` — new section after the `LAPORAN:` block (ends ~line 84)
- Test: `tests/agent/system-prompt-advisory.test.ts` (NEW file — see Global Constraints re: the pre-broken `system-prompt.test.ts`)

**Interfaces:**
- Produces: prompt copy governing advice-style questions; consumed by every later slice's prose behavior (no code imports).

- [ ] **Step 1: Write the failing test**

`tests/agent/system-prompt-advisory.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../src/agent/system-prompt.js';

describe('system prompt — advisory rules', () => {
  const prompt = buildSystemPrompt();

  it('mentions get_analytics and get_financial_health in the advisory section', () => {
    expect(prompt).toContain('ANALISIS & SARAN');
    expect(prompt).toContain('get_analytics');
  });

  it('forbids inventing figures and requires grounding in tool metrics', () => {
    expect(prompt).toContain('Jangan mengarang');
    expect(prompt).toContain('insufficient_data');
  });

  it('keeps prose interpretation-only (no table restating)', () => {
    expect(prompt).toContain('interpretasi');
  });
});
```
If `buildSystemPrompt`'s exported name differs, check the actual export in `src/agent/system-prompt.ts` (top of file) and use that — the assertions stay the same.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/agent/system-prompt-advisory.test.ts`
Expected: FAIL — `ANALISIS & SARAN` not present.

- [ ] **Step 3: Implement — insert after the LAPORAN block in `buildSystemPrompt`**

```
ANALISIS & SARAN:
- Untuk pertanyaan analisis/saran keuangan ("boros apa?", "sehat nggak keuangan aku?", "sisa bulan ini aman?"), PANGGIL dulu get_analytics / get_financial_health — jangan hitung sendiri dari get_transactions.
- Setiap angka yang kamu sebut HARUS berasal dari hasil tool. Jangan mengarang atau menghitung ulang angka.
- Kalau ada bagian insufficient_data, sebutkan apa yang belum bisa dinilai — jangan dipaksakan.
- Jawaban saran = interpretasi (apa artinya, kenapa, apa langkahnya), BUKAN mengulang tabel angka. Ringkas.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/agent/system-prompt-advisory.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/agent/system-prompt.ts tests/agent/system-prompt-advisory.test.ts
git commit -m "feat: system-prompt advisory rules (tool-grounded, no invented figures)"
```

---

### Task 5: `pacing.ts` (run-rate projection)

**Files:**
- Create: `src/domain/analytics/pacing.ts`
- Test: `tests/domain/analytics-pacing.test.ts`

**Interfaces:**
- Consumes: `Transaction`, `BudgetCode` from `../entities.js`; `addDays`, `lastDayOfMonth` from `../time.js`.
- Produces (exact — morning-glance, get_analytics, and health consume this):
```ts
export type PacingVerdict = 'on_track' | 'tight' | 'over_pace';
export interface BudgetPacing {
  budgetCodeId: string; name: string;
  spent: number; alloc: number; projected: number;
  verdict: PacingVerdict;
  overrunDate?: string;   // 'YYYY-MM-DD', only when over_pace and dailyRate > 0
  lowConfidence: boolean; // elapsedDays < 5 (spec §5)
}
export interface PacingResult {
  asOf: string; elapsedDays: number; daysInMonth: number; items: BudgetPacing[];
}
export function pacing(tx: Transaction[], budgets: BudgetCode[], today: string): PacingResult
```

Semantics (spec §2.1): `spent` is derived from `tx` (self-corrects after soft-deletes/backdating — never read `budgets[].spent`). `elapsedDays` = day-of-month of `today`. `projected` = `spent / elapsedDays × daysInMonth`. Verdict: `spent > alloc` → over_pace; else `projected > alloc × 1.15` → over_pace; `projected > alloc` → tight; else on_track. Budgets with `monthlyBudget <= 0` are skipped. `tx` must already be filtered to the month being paced (the caller filters by range); pacing filters to expenses per budgetCodeId.

- [ ] **Step 1: Write the failing test**

`tests/domain/analytics-pacing.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { pacing } from '../../src/domain/analytics/pacing.js';
import type { BudgetCode, Transaction } from '../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}
function mkBudget(over: Partial<BudgetCode>): BudgetCode {
  return {
    budgetCodeId: 'b', userId: 'u', name: 'makan', monthlyBudget: 1_000_000,
    month: 8, year: 2026, spent: 0, isRecurring: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

describe('pacing', () => {
  // today = 2026-08-16 → elapsed 16/31 days
  const TODAY = '2026-08-16';

  it('projects month-end from run-rate and marks over_pace with overrun date', () => {
    // spent 600k by day 16 → daily 37.5k → projected 1.162.500 > 1M*1.15? no (1.15M) → tight
    const b = mkBudget({ monthlyBudget: 1_000_000 });
    const r = pacing([mkTxn({ amount: 600_000, budgetCodeId: 'b' })], [b], TODAY);
    expect(r.elapsedDays).toBe(16);
    expect(r.daysInMonth).toBe(31);
    expect(r.items[0]).toMatchObject({ budgetCodeId: 'b', spent: 600_000, alloc: 1_000_000, projected: 1_162_500, verdict: 'tight' });
  });

  it('over_pace when projected > alloc * 1.15; overrunDate projected forward', () => {
    // spent 900k by day 16 → daily 56.25k → projected 1.743.750 > 1.15M → over_pace
    // alloc/daily = 1M/56.25k = 17.78 → ceil 18 → 2026-08-18
    const b = mkBudget({ monthlyBudget: 1_000_000 });
    const r = pacing([mkTxn({ amount: 900_000, budgetCodeId: 'b' })], [b], TODAY);
    expect(r.items[0]!.verdict).toBe('over_pace');
    expect(r.items[0]!.overrunDate).toBe('2026-08-18');
  });

  it('already over alloc → over_pace regardless of projection', () => {
    const b = mkBudget({ monthlyBudget: 100_000 });
    const r = pacing([mkTxn({ amount: 150_000, budgetCodeId: 'b' })], [b], TODAY);
    expect(r.items[0]!.verdict).toBe('over_pace');
  });

  it('lowConfidence before day 5', () => {
    const b = mkBudget({});
    const r = pacing([mkTxn({ amount: 10_000, budgetCodeId: 'b' })], [b], '2026-08-02');
    expect(r.items[0]!.lowConfidence).toBe(true);
  });

  it('skips zero-alloc budgets; matches tx to budgets by budgetCodeId; ignores __none__', () => {
    const budgets = [mkBudget({ budgetCodeId: 'b1', monthlyBudget: 0 }), mkBudget({ budgetCodeId: 'b2', monthlyBudget: 500_000 })];
    const r = pacing([mkTxn({ amount: 100_000, budgetCodeId: 'b2' }), mkTxn({ amount: 50_000, budgetCodeId: undefined })], budgets, TODAY);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.spent).toBe(100_000);
  });

  it('income and transfer rows never count', () => {
    const b = mkBudget({});
    const r = pacing([
      mkTxn({ type: 'income', amount: 5_000_000, budgetCodeId: 'b' }),
      mkTxn({ type: 'transfer', amount: 2_000_000, budgetCodeId: 'b' }),
    ], [b], TODAY);
    expect(r.items[0]!.spent).toBe(0);
    expect(r.items[0]!.verdict).toBe('on_track');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/domain/analytics-pacing.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/domain/analytics/pacing.ts`:
```ts
import type { BudgetCode, Transaction } from '../entities.js';
import { addDays, lastDayOfMonth } from '../time.js';

export type PacingVerdict = 'on_track' | 'tight' | 'over_pace';

export interface BudgetPacing {
  budgetCodeId: string;
  name: string;
  spent: number;
  alloc: number;
  projected: number;
  verdict: PacingVerdict;
  overrunDate?: string;
  lowConfidence: boolean;
}

export interface PacingResult {
  asOf: string;
  elapsedDays: number;
  daysInMonth: number;
  items: BudgetPacing[];
}

/** Verdict thresholds (spec §2.1): over when projected beats alloc by >15%. */
const OVER_TIGHT_RATIO = 1.15;
/** Projections before this elapsed day are low-confidence (spec §5). */
const MIN_CONFIDENT_DAYS = 5;

/**
 * Run-rate pacing for one month (spec §2.1). `tx` = that month's transactions
 * (any range); `budgets` = that month's budget rows. `spent` is derived from
 * `tx` (self-corrects after soft-deletes/backdating), never from budgets[].spent.
 */
export function pacing(tx: Transaction[], budgets: BudgetCode[], today: string): PacingResult {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const elapsedDays = Number(today.slice(8, 10));
  const daysInMonth = lastDayOfMonth(year, month);
  const monthStart = `${today.slice(0, 7)}-01`;

  const spentByBudget = new Map<string, number>();
  for (const t of tx) {
    if (t.type !== 'expense' || !t.budgetCodeId) continue;
    spentByBudget.set(t.budgetCodeId, (spentByBudget.get(t.budgetCodeId) ?? 0) + t.amount);
  }

  const items: BudgetPacing[] = [];
  for (const b of budgets) {
    if (b.monthlyBudget <= 0) continue;
    const spent = spentByBudget.get(b.budgetCodeId) ?? 0;
    const dailyRate = spent / elapsedDays;
    const projected = Math.round(dailyRate * daysInMonth);

    let verdict: PacingVerdict = 'on_track';
    if (spent > b.monthlyBudget || projected > b.monthlyBudget * OVER_TIGHT_RATIO) verdict = 'over_pace';
    else if (projected > b.monthlyBudget) verdict = 'tight';

    const item: BudgetPacing = {
      budgetCodeId: b.budgetCodeId,
      name: b.name,
      spent,
      alloc: b.monthlyBudget,
      projected,
      verdict,
      lowConfidence: elapsedDays < MIN_CONFIDENT_DAYS,
    };
    if (verdict === 'over_pace' && dailyRate > 0) {
      const daysToOverrun = Math.ceil(b.monthlyBudget / dailyRate);
      const raw = addDays(monthStart, daysToOverrun - 1);
      const monthEnd = `${today.slice(0, 7)}-${String(daysInMonth).padStart(2, '0')}`;
      item.overrunDate = raw > monthEnd ? monthEnd : raw;
    }
    items.push(item);
  }

  return { asOf: today, elapsedDays, daysInMonth, items };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/domain/analytics-pacing.test.ts` — Expected: PASS.

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/domain/analytics/pacing.ts tests/domain/analytics-pacing.test.ts
git commit -m "feat: analytics pacing (run-rate projection, overrun ETA)"
```

---

### Task 6: `obligations.ts` (30-day bills vs liquid balance)

**Files:**
- Create: `src/domain/analytics/obligations.ts`
- Test: `tests/domain/analytics-obligations.test.ts`

**Interfaces:**
- Consumes: `Account`, `RecurringPayment` from `../entities.js`; `addDays` from `../time.js`.
- Produces (health + morning-glance + tools consume this):
```ts
export interface ObligationItem {
  name: string; amount: number; dueDate: string; kind: 'recurring' | 'card';
}
export type CoverageVerdict = 'covered' | 'tight' | 'short';
export interface ObligationsResult {
  horizonEnd: string;       // today + horizonDays
  items: ObligationItem[];  // sorted by dueDate asc
  liquidBalance: number;    // Σ balances of active cash+bank accounts
  totalDue: number;
  verdict: CoverageVerdict; // covered ≥ totalDue · tight ≥ 50% · short < 50%
  shortfall?: number;       // max(0, totalDue − liquidBalance)
}
export function obligations(input: {
  recurrings: RecurringPayment[];
  accounts: Account[];
  cardDues: { name: string; amount: number; dueDate: string }[]; // derived by caller (getWithFigures)
  today: string;
  horizonDays?: number;     // default 30 (spec §2.1)
}): ObligationsResult
```
Semantics: recurring items = active rows whose `nextFireAt` is in `(today, horizonEnd]`. Card items = `cardDues` with `amount > 0` and `dueDate <= horizonEnd` (overdue ones included — `dueDate < today` still consumes cash). Liquid = `Σ balance` over `isActive && (type === 'cash' || type === 'bank')`. Verdict: `totalDue <= 0` → covered; `liquid >= totalDue` → covered; `liquid >= totalDue * 0.5` → tight; else short. `shortfall = max(0, totalDue - liquid)`.

- [ ] **Step 1: Write the failing test**

`tests/domain/analytics-obligations.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { obligations } from '../../src/domain/analytics/obligations.js';
import type { Account, RecurringPayment } from '../../src/domain/entities.js';

function mkAccount(over: Partial<Account>): Account {
  return { accountId: 'a', userId: 'u', name: 'acc', type: 'cash', balance: 0, isActive: true, createdAt: '', updatedAt: '', ...over };
}
function mkRecurring(over: Partial<RecurringPayment>): RecurringPayment {
  return { recurringId: 'r', userId: 'u', name: 'netflix', amount: 100_000, accountId: 'a', categoryId: 'other.misc', dayOfMonth: 20, isActive: true, nextFireAt: '2026-08-20', createdAt: '', updatedAt: '', ...over };
}

const TODAY = '2026-08-16'; // horizonEnd default 2026-09-15
const BANK = mkAccount({ type: 'bank', balance: 1_000_000 });

describe('obligations', () => {
  it('collects recurring fires + card dues in (today, horizonEnd], sorted by dueDate', () => {
    const r = obligations({
      recurrings: [
        mkRecurring({ name: 'netflix', amount: 100_000, nextFireAt: '2026-08-20' }),
        mkRecurring({ name: 'listrik', amount: 300_000, nextFireAt: '2026-09-01' }),
        mkRecurring({ name: 'sudah lewat', nextFireAt: '2026-08-10' }), // outside horizon
        mkRecurring({ name: 'mati', isActive: false, nextFireAt: '2026-08-20' }), // inactive
      ],
      accounts: [BANK],
      cardDues: [{ name: 'bca card', amount: 500_000, dueDate: '2026-08-25' }, { name: 'paid card', amount: 0, dueDate: '2026-08-25' }],
      today: TODAY,
    });
    expect(r.items.map((i) => i.name)).toEqual(['netflix', 'bca card', 'listrik']);
    expect(r.items[0]).toMatchObject({ kind: 'recurring', dueDate: '2026-08-20' });
    expect(r.items[1]).toMatchObject({ kind: 'card' });
    expect(r.totalDue).toBe(900_000);
    expect(r.horizonEnd).toBe('2026-09-15');
  });

  it('liquidBalance sums active cash+bank only', () => {
    const r = obligations({
      recurrings: [], accounts: [
        BANK,
        mkAccount({ type: 'cash', balance: 200_000 }),
        mkAccount({ type: 'card', balance: -500_000 }),     // never liquid
        mkAccount({ type: 'bank', balance: 999_999, isActive: false }), // inactive
      ],
      cardDues: [], today: TODAY,
    });
    expect(r.liquidBalance).toBe(1_200_000);
  });

  it('covered when liquid >= totalDue; nothing due → covered', () => {
    const covered = obligations({ recurrings: [mkRecurring({ amount: 500_000 })], accounts: [BANK], cardDues: [], today: TODAY });
    expect(covered.verdict).toBe('covered');
    const none = obligations({ recurrings: [], accounts: [BANK], cardDues: [], today: TODAY });
    expect(none.verdict).toBe('covered');
    expect(none.totalDue).toBe(0);
  });

  it('tight at >= 50% coverage; short below with shortfall', () => {
    const tight = obligations({ recurrings: [mkRecurring({ amount: 1_800_000 })], accounts: [BANK], cardDues: [], today: TODAY });
    expect(tight.verdict).toBe('tight');
    expect(tight.shortfall).toBe(800_000);
    const short = obligations({ recurrings: [mkRecurring({ amount: 4_000_000 })], accounts: [BANK], cardDues: [], today: TODAY });
    expect(short.verdict).toBe('short');
    expect(short.shortfall).toBe(3_000_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/domain/analytics-obligations.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/domain/analytics/obligations.ts`:
```ts
import type { Account, RecurringPayment } from '../entities.js';
import { addDays } from '../time.js';

export interface ObligationItem {
  name: string;
  amount: number;
  dueDate: string;
  kind: 'recurring' | 'card';
}

export type CoverageVerdict = 'covered' | 'tight' | 'short';

export interface ObligationsResult {
  horizonEnd: string;
  items: ObligationItem[];
  liquidBalance: number;
  totalDue: number;
  verdict: CoverageVerdict;
  shortfall?: number;
}

/** Default lookahead (spec §2.1): next 30 days of bills. */
const DEFAULT_HORIZON_DAYS = 30;
/** tight = liquid still covers >= this fraction of totalDue (spec §2.1). */
const TIGHT_FLOOR = 0.5;

/** Next-`horizonDays` obligations vs liquid (cash+bank) balance (spec §2.1). */
export function obligations(input: {
  recurrings: RecurringPayment[];
  accounts: Account[];
  cardDues: { name: string; amount: number; dueDate: string }[];
  today: string;
  horizonDays?: number;
}): ObligationsResult {
  const horizonDays = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const horizonEnd = addDays(input.today, horizonDays);

  const items: ObligationItem[] = [];
  for (const r of input.recurrings) {
    if (!r.isActive) continue;
    if (r.nextFireAt > input.today && r.nextFireAt <= horizonEnd) {
      items.push({ name: r.name, amount: r.amount, dueDate: r.nextFireAt, kind: 'recurring' });
    }
  }
  for (const c of input.cardDues) {
    if (c.amount > 0 && c.dueDate <= horizonEnd) {
      items.push({ name: c.name, amount: c.amount, dueDate: c.dueDate, kind: 'card' });
    }
  }
  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const liquidBalance = input.accounts
    .filter((a) => a.isActive && (a.type === 'cash' || a.type === 'bank'))
    .reduce((s, a) => s + a.balance, 0);
  const totalDue = items.reduce((s, i) => s + i.amount, 0);

  let verdict: CoverageVerdict = 'covered';
  if (totalDue > 0 && liquidBalance < totalDue) {
    verdict = liquidBalance >= totalDue * TIGHT_FLOOR ? 'tight' : 'short';
  }

  return {
    horizonEnd,
    items,
    liquidBalance,
    totalDue,
    verdict,
    shortfall: Math.max(0, totalDue - liquidBalance) || undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/domain/analytics-obligations.test.ts` — Expected: PASS.

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/domain/analytics/obligations.ts tests/domain/analytics-obligations.test.ts
git commit -m "feat: analytics obligations (30-day bills vs liquid balance)"
```

---

### Task 7: `get_analytics` pacing extension

**Files:**
- Modify: `src/agent/tools.ts` — the `get_analytics` execute body from Task 3
- Test: `tests/agent/tools-analytics.test.ts` — extend with pacing cases

**Interfaces:**
- Consumes: `pacing` (Task 5), `monthBounds` (Task 1), `repos.budgets.findByUserAndMonth`, `wibMonth`/`wibYear` (already imported in tools.ts).
- Produces: `get_analytics` response gains `pacing?: PacingResult` — present when `from..to` covers the current WIB month (i.e. `from <= todayWIB() && to >= todayWIB()` … precisely: `from <= today && today <= to` where today = current WIB date). `pacing.items` are budget-labeled already (name comes from BudgetCode).

- [ ] **Step 1: Write the failing test (append to `tests/agent/tools-analytics.test.ts`)**

```ts
import { pacing as pacingFn } from '../../src/domain/analytics/pacing.js'; // top of file

describe('buildTools — get_analytics pacing', () => {
  it('includes pacing when the range covers the current WIB month', async () => {
    vi.setSystemTime(new Date('2026-08-16T03:00:00Z')); // WIB 2026-08-16
    try {
      const repos = mockRepos({ txns: [mkTxn({ date: '2026-08-10', amount: 600_000, budgetCodeId: 'b1' })] });
      (repos.budgets.findByUserAndMonth as ReturnType<typeof vi.fn>)
        .mockResolvedValue([{ budgetCodeId: 'b1', userId: 'u', name: 'makan', monthlyBudget: 1_000_000, month: 8, year: 2026, spent: 600_000, isRecurring: false, createdAt: '', updatedAt: '' }]);
      const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
      const out = await get_analytics.execute!(
        { from: '2026-08-01', to: '2026-08-31' },
        { toolCallId: 'c', messages: [] as never },
      ) as Record<string, never>;
      expect(out.pacing).toBeDefined();
      expect((out.pacing as { items: { name: string; verdict: string }[] }).items[0]).toMatchObject({ name: 'makan', verdict: 'tight' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits pacing for past ranges', async () => {
    const repos = mockRepos({ txns: [] });
    const { get_analytics } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const out = await get_analytics.execute!(
      { from: '2026-06-01', to: '2026-06-30' },
      { toolCallId: 'c', messages: [] as never },
    ) as Record<string, never>;
    expect(out.pacing).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tools-analytics.test.ts` — Expected: new cases FAIL (`pacing` undefined).

- [ ] **Step 3: Implement — in the `get_analytics` execute, after the `cashflow` block**

```ts
        // Pacing rides along when the range covers the current in-progress
        // WIB month (spec §3.1): projection is only meaningful mid-month.
        const today = todayWIB();
        const pacingResult = from <= today && today <= to
          ? pacing(
              currentRows,
              await repos.budgets.findByUserAndMonth(userId, wibYear(), wibMonth()),
              today,
            )
          : undefined;
```
and include it in the return object next to `cashflow`:
```ts
          ...(pacingResult ? { pacing: pacingResult } : {}),
```
Imports to add at the top of `src/agent/tools.ts`: `pacing` from `'../domain/analytics/pacing.js'`; `todayWIB` is already imported from `'../domain/time.js'` (line 6) — verify, add if missing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/tools-analytics.test.ts` — Expected: PASS (all).

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/agent/tools.ts tests/agent/tools-analytics.test.ts
git commit -m "feat: get_analytics carries budget pacing for current-month ranges"
```

---

### Task 8: Morning-glance pacing slice

**Files:**
- Modify: `src/proactive/triggers/morning-glance.ts` — add `pacing` to payload data
- Modify: `src/proactive/composers/template.ts` — render pacing lines in `renderMorningGlanceBlock`
- Test: `tests/proactive/triggers/morning-glance.test.ts` (extend), `tests/proactive/composers/template.test.ts` (extend)

**Interfaces:**
- Consumes: `pacing` (Task 5) — items with `verdict !== 'on_track'`, capped at 3, sorted over_pace first.
- Produces: payload `data.pacing?: { name: string; projected: number; alloc: number; verdict: 'tight' | 'over_pace' }[]`; rendered lines `⚠️/🚨 <name>: proyeksi <idr(projected)> / <idr(alloc)>`.

- [ ] **Step 1: Write the failing tests**

In `tests/proactive/triggers/morning-glance.test.ts`, append (reuse the file's existing helpers/mocks; if its mock of `budgets.findByUserAndMonth` returns `[]`, add a case that returns one over-budget row):
```ts
it('adds pacing items for tight/over_pace budgets (cap 3, over_pace first)', async () => {
  // Arrange per the file's existing mock style: txns for the current WIB month
  // spending past a budget, budgets row(s) with monthlyBudget; NOW from the file.
  // Assert:
  // const [payload] = await detectMorningGlance({ userId: 'u', repos, now: NOW });
  // const data = payload.data as { pacing?: { name: string; verdict: string }[] };
  // expect(data.pacing).toBeDefined();
  // expect(data.pacing![0]).toMatchObject({ name: 'makan', verdict: 'over_pace' });
});
```
**This step requires reading the actual test file first** — mirror its `mockRepos`/`NOW` setup, then write the concrete test with real values (spend 900k of a 1M budget by day ≥ 16 of the month implied by the file's `NOW` — verify elapsed ≥ 5 so `lowConfidence` doesn't matter for rendering). Do not leave the skeleton above in the committed file — it must be a real test with real assertions.

In `tests/proactive/composers/template.test.ts`, append:
```ts
describe('renderMorningGlanceBlock — pacing', () => {
  it('renders a pacing line per tight/over_pace budget', () => {
    const text = renderMorningGlanceBlock({
      triggerType: 'morning_glance',
      dedupKey: 'k',
      channel: 'llm',
      data: {
        balances: [], upcoming: [], yesterday: null, todayDueBills: [], budgets: [], cardDue: [],
        pacing: [
          { name: 'makan', projected: 1_162_500, alloc: 1_000_000, verdict: 'tight' },
          { name: 'jajan', projected: 900_000, alloc: 500_000, verdict: 'over_pace' },
        ],
      },
    });
    expect(text).toContain('⚠️ makan: proyeksi 1.162.500 / 1.000.000');
    expect(text).toContain('🚨 jajan: proyeksi 900.000 / 500.000');
  });

  it('no pacing data → no pacing line', () => {
    const text = renderMorningGlanceBlock({
      triggerType: 'morning_glance', dedupKey: 'k', channel: 'llm',
      data: { balances: [], upcoming: [], yesterday: null, todayDueBills: [], budgets: [], cardDue: [] },
    });
    expect(text).not.toContain('proyeksi');
  });
});
```
(Check the test file's existing imports and reuse them; `renderMorningGlanceBlock` must be imported if not already.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/proactive/triggers/morning-glance.test.ts tests/proactive/composers/template.test.ts` — Expected: new cases FAIL.

- [ ] **Step 3: Implement**

`src/proactive/triggers/morning-glance.ts` — after the `budgets` block (line ~72), before card statements:
```ts
  // Pacing (advisory design §4/slice 2): tight/over_pace projections, cap 3,
  // over_pace first — the glance already shows spent; this shows where it's heading.
  const pacingItems = pacing(
    await repos.transactions.findByDateRange(userId, `${year}-${String(month).padStart(2, '0')}-01`, today),
    budgets,
    today,
  ).items
    .filter((p) => p.verdict !== 'on_track')
    .sort((a, b) => (a.verdict === b.verdict ? b.projected - a.projected : a.verdict === 'over_pace' ? -1 : 1))
    .slice(0, 3)
    .map((p) => ({ name: p.name, projected: p.projected, alloc: p.alloc, verdict: p.verdict }));
```
Note the existing `budgets` const (line 59) maps to a display shape — pacing needs raw `BudgetCode[]`; refactor: keep the raw list first (`const budgetRows = await repos.budgets.findByUserAndMonth(...)`), derive the existing display `budgets` from it, pass `budgetRows` to `pacing`. Add `data: { balances, upcoming, yesterday, todayDueBills, budgets, cardDue, ...(pacingItems.length ? { pacing: pacingItems } : {}) }`. Add import: `import { pacing } from '../../domain/analytics/pacing.js';`.

`src/proactive/composers/template.ts` — inside `renderMorningGlanceBlock` (find the budgets section; append after it), reusing the file's `idr()`:
```ts
  const pacing = d.pacing as { name: string; projected: number; alloc: number; verdict: 'tight' | 'over_pace' }[] | undefined
  if (pacing && pacing.length > 0) {
    lines.push('Proyeksi bulan ini:')
    for (const p of pacing) {
      const icon = p.verdict === 'over_pace' ? '🚨' : '⚠️'
      lines.push(`${icon} ${p.name}: proyeksi ${idr(p.projected)} / ${idr(p.alloc)}`)
    }
  }
```
Adapt `lines`/`d` to the function's actual local names. Update the `data` parameter type of `renderMorningGlanceBlock` to include `pacing?: …`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/proactive/triggers/morning-glance.test.ts tests/proactive/composers/template.test.ts` — Expected: PASS.

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/proactive/triggers/morning-glance.ts src/proactive/composers/template.ts tests/proactive/triggers/morning-glance.test.ts tests/proactive/composers/template.test.ts
git commit -m "feat: morning glance pacing lines (tight/over_pace projections)"
```

---

### Task 9: `leaks.ts` (spike + subscription audit)

**Files:**
- Create: `src/domain/analytics/leaks.ts`
- Test: `tests/domain/analytics-leaks.test.ts`

**Interfaces:**
- Consumes: `normalizeDescription` (Task 1), `Transaction`, `RecurringPayment` from `../entities.js`, `addDays` from `../time.js`.
- Produces (leak-alert trigger + health consume this):
```ts
export interface LeakSpike {
  label: string;          // normalized description (readable)
  current: number; previous: number; deltaPct: number;
  countCurrent: number; countPrevious: number;
}
export interface LeakRecurring { name: string; amount: number; kind: 'new' | 'dormant' }
export interface LeakCandidates {
  spikes: LeakSpike[];    // sorted deltaPct desc, cap 5
  recurring: LeakRecurring[];
  recurringTotal: number;      // Σ active recurring amount
  baselineTotal?: number;      // Σ active recurring amount older than 90 days
}
export function leakCandidates(input: {
  currentTx: Transaction[];   // current month-to-date expenses
  previousTx: Transaction[];  // previous full month expenses
  tx60d: Transaction[];       // last 60 days (dormancy check)
  recurrings: RecurringPayment[];
  today: string;
}): LeakCandidates
```
Thresholds (named constants): `SPIKE_GROWTH_PCT = 50` (current > previous × 1.5), `SPIKE_MIN_COUNT = 2` occurrences each side, `SPIKE_MIN_CURRENT_TOTAL = 50_000` IDR floor, `SPIKE_TOP_N = 5`, `NEW_SUBSCRIPTION_DAYS = 90`, `DORMANT_DAYS = 60`.

- [ ] **Step 1: Write the failing test**

`tests/domain/analytics-leaks.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { leakCandidates } from '../../src/domain/analytics/leaks.js';
import type { RecurringPayment, Transaction } from '../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}
function mkRecurring(over: Partial<RecurringPayment>): RecurringPayment {
  return { recurringId: 'r', userId: 'u', name: 'netflix', amount: 100_000, accountId: 'a', categoryId: 'other.misc', dayOfMonth: 5, isActive: true, nextFireAt: '2026-09-05', createdAt: '2025-01-01T00:00:00Z', updatedAt: '', ...over };
}

const TODAY = '2026-08-16';

describe('leakCandidates — spikes', () => {
  it('flags a description group that grew > 50% with >= 2 occurrences each side and >= 50k total', () => {
    const r = leakCandidates({
      currentTx: [
        mkTxn({ description: 'kopi kenangan', amount: 150_000 }),
        mkTxn({ description: 'Kopi Kenangan (diskon)', amount: 100_000 }),
      ],
      previousTx: [
        mkTxn({ description: 'kopi kenangan', amount: 100_000 }),
        mkTxn({ description: 'kopi kenangan', amount: 50_000 }),
      ],
      tx60d: [], recurrings: [], today: TODAY,
    });
    expect(r.spikes).toHaveLength(1);
    expect(r.spikes[0]).toMatchObject({ label: 'kopi kenangan', current: 250_000, previous: 150_000, deltaPct: 67, countCurrent: 2, countPrevious: 2 });
  });

  it('ignores small-total and single-occurrence groups', () => {
    const r = leakCandidates({
      currentTx: [
        mkTxn({ description: 'parkir', amount: 20_000 }),   // total 40k < 50k floor
        mkTxn({ description: 'parkir', amount: 20_000 }),
        mkTxn({ description: 'sekali ini', amount: 500_000 }), // count 1 < 2
      ],
      previousTx: [mkTxn({ description: 'parkir', amount: 10_000 }), mkTxn({ description: 'sekali ini', amount: 10_000 })],
      tx60d: [], recurrings: [], today: TODAY,
    });
    expect(r.spikes).toHaveLength(0);
  });

  it('steady groups (<= 50% growth) are not leaks', () => {
    const r = leakCandidates({
      currentTx: [mkTxn({ description: 'gonline', amount: 100_000 }), mkTxn({ description: 'gonline', amount: 50_000 })],
      previousTx: [mkTxn({ description: 'gonline', amount: 100_000 }), mkTxn({ description: 'gonline', amount: 50_000 })],
      tx60d: [], recurrings: [], today: TODAY,
    });
    expect(r.spikes).toHaveLength(0);
  });
});

describe('leakCandidates — recurring audit', () => {
  it('marks subscriptions created < 90d ago as new; older ones form baselineTotal', () => {
    const r = leakCandidates({
      currentTx: [], previousTx: [], tx60d: [], today: TODAY,
      recurrings: [
        mkRecurring({ name: 'lama', amount: 100_000, createdAt: '2026-01-01T00:00:00Z' }),
        mkRecurring({ name: 'baru', amount: 50_000, createdAt: '2026-07-01T00:00:00Z' }), // 46 days before TODAY
      ],
    });
    expect(r.recurring).toEqual([{ name: 'baru', amount: 50_000, kind: 'new' }]);
    expect(r.recurringTotal).toBe(150_000);
    expect(r.baselineTotal).toBe(100_000);
  });

  it('flags dormant: active recurring with no instance transaction in 60d', () => {
    const r = leakCandidates({
      currentTx: [], previousTx: [],
      tx60d: [mkTxn({ description: 'x', amount: 1_000, isRecurringInstance: true, recurringId: 'other' })],
      recurrings: [mkRecurring({ name: 'netflix', recurringId: 'dormant-one', createdAt: '2025-01-01T00:00:00Z' })],
      today: TODAY,
    });
    expect(r.recurring).toEqual([{ name: 'netflix', amount: 100_000, kind: 'dormant' }]);
  });

  it('inactive recurrings are excluded entirely', () => {
    const r = leakCandidates({
      currentTx: [], previousTx: [], tx60d: [],
      recurrings: [mkRecurring({ isActive: false })],
      today: TODAY,
    });
    expect(r.recurring).toEqual([]);
    expect(r.recurringTotal).toBe(0);
    expect(r.baselineTotal).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/domain/analytics-leaks.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/domain/analytics/leaks.ts`:
```ts
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
/** No matching instance in this window → dormant (spec §2.1c). */
const DORMANT_DAYS = 60;

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
  const seenRecurringIds = new Set(
    input.tx60d.filter((t) => t.isRecurringInstance && t.recurringId).map((t) => t.recurringId),
  );
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
```
Note: `Date.parse(...)` on an injected date string is NOT `Date.now()` — determinism holds (no real clock read).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/domain/analytics-leaks.test.ts` — Expected: PASS.

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/domain/analytics/leaks.ts tests/domain/analytics-leaks.test.ts
git commit -m "feat: analytics leakCandidates (spikes, recurring creep, dormancy)"
```

---

### Task 10: Weekly leak alert (trigger + composer + config + cron)

**Files:**
- Create: `src/proactive/triggers/leak-alert.ts`, `src/proactive/composers/leak-alert.ts`
- Modify: `src/domain/entities.ts` (`ProactiveTriggerType` union, line ~151), `src/config/index.ts`, `.env.example`, `src/proactive/prompt.ts`, `src/proactive/composers/template.ts`, `src/scheduler/cron.ts`
- Test: `tests/proactive/triggers/leak-alert.test.ts`, `tests/proactive/composers/leak-alert.test.ts`

**Interfaces:**
- Consumes: `leakCandidates` (Task 9), `monthBounds` (Task 1), `todayWIB`/`addDays`/`wibISOWeekLabel` from `domain/time.js`, `Detector`/`Composer` from `proactive/types.js`, `idr` from template.ts.
- Produces: triggerType `'leak_alert'`; `detectLeakAlert: Detector`; `createLeakAlertComposer(model): Composer`; payload `data: { week, spikes, recurring, recurringTotal, baselineTotal? }`; config `PROACTIVE_LEAK_CRON` (default `'5 9 * * 2'` — Tuesday 09:05 WIB, spec §4).

- [ ] **Step 1: Write the failing trigger test**

`tests/proactive/triggers/leak-alert.test.ts` (mirror `tests/proactive/triggers/anomaly.test.ts` mock style):
```ts
import { describe, it, expect, vi } from 'vitest';
import { detectLeakAlert } from '../../../src/proactive/triggers/leak-alert.js';
import type { Repos } from '../../../src/repositories/interfaces.js';
import type { Transaction } from '../../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}
function mockRepos(opts: { txns?: Transaction[] } = {}): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(async () => []), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(),
      findByDateRange: vi.fn(async (_u: string, from: string, to: string) =>
        (opts.txns ?? []).filter((t) => t.date >= from && t.date <= to)),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), findExpiredDeferrals: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(async () => []), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn(), rollRecurringIntoMonth: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(async () => []), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    cardStatements: {} as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

// 2026-08-18T02:00:00Z → WIB 2026-08-18 (a Tuesday).
const NOW = new Date('2026-08-18T02:00:00Z');

describe('detectLeakAlert', () => {
  it('returns [] when nothing leaks', async () => {
    const repos = mockRepos({ txns: [mkTxn({ date: '2026-08-05', description: ' stabil ', amount: 100_000 })] });
    expect(await detectLeakAlert({ userId: 'u', repos, now: NOW })).toEqual([]);
  });

  it('fires with dedupKey leak-alert:<ISO week> when a spike clears the gates', async () => {
    const repos = mockRepos({
      txns: [
        // current month (2026-08): 2x 'kopi kenangan' totalling 250k
        mkTxn({ date: '2026-08-05', description: 'kopi kenangan', amount: 150_000 }),
        mkTxn({ date: '2026-08-06', description: 'Kopi Kenangan', amount: 100_000 }),
        // previous month (2026-07): 2x totalling 100k → +150%
        mkTxn({ date: '2026-07-05', description: 'kopi kenangan', amount: 50_000 }),
        mkTxn({ date: '2026-07-06', description: 'kopi kenangan', amount: 50_000 }),
      ],
    });
    const out = await detectLeakAlert({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.triggerType).toBe('leak_alert');
    expect(out[0]!.channel).toBe('llm');
    expect(out[0]!.dedupKey).toBe(`leak-alert:${wibISOWeekLabel(NOW)}`); // self-verifying, no hardcoded week
    const data = out[0]!.data as { spikes: { label: string }[] };
    expect(data.spikes[0]!.label).toBe('kopi kenangan');
  });
});
```
(Add `wibISOWeekLabel` to the imports from `'../../../src/domain/time.js'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/proactive/triggers/leak-alert.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement the trigger**

`src/proactive/triggers/leak-alert.ts`:
```ts
import { addDays, todayWIB, wibISOWeekLabel } from '../../domain/time.js';
import { monthBounds } from '../../domain/analytics/period.js';
import { leakCandidates } from '../../domain/analytics/leaks.js';
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
  const from60 = addDays(today, -60);

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
```

`src/domain/entities.ts` — extend the union (~line 151):
```ts
export type ProactiveTriggerType =
  | 'scheduled_summary'
  | 'budget_threshold'
  | 'logging_gap'
  | 'anomaly'
  | 'morning_glance'
  | 'leak_alert'
  | 'health_digest';
```
(`health_digest` lands in Task 13; adding both now avoids touching the union twice. No DB change — `trigger_type` is a text column.)

- [ ] **Step 4: Run trigger test to verify it passes**

Run: `npx vitest run tests/proactive/triggers/leak-alert.test.ts` — Expected: PASS.

- [ ] **Step 5: Write the failing composer test**

`tests/proactive/composers/leak-alert.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { generateText } from 'ai';
import { createLeakAlertComposer } from '../../../src/proactive/composers/leak-alert.js';

vi.mock('ai', () => ({ generateText: vi.fn(async () => ({ text: 'prose line' })) }));
const model = {} as never;

const payload = {
  triggerType: 'leak_alert' as const,
  dedupKey: 'k',
  channel: 'llm' as const,
  data: {
    week: '2026-W34',
    spikes: [{ label: 'kopi kenangan', current: 250_000, previous: 100_000, deltaPct: 150, countCurrent: 2, countPrevious: 2 }],
    recurring: [{ name: 'spotify', amount: 54_000, kind: 'new' as const }, { name: 'netflix', amount: 100_000, kind: 'dormant' as const }],
    recurringTotal: 154_000,
  },
};

describe('createLeakAlertComposer', () => {
  it('renders deterministic blocks + one LLM prose line', async () => {
    const compose = createLeakAlertComposer(model);
    const out = await compose(payload, { now: new Date('2026-08-18T02:00:00Z') });
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('🔎 Kemungkinan bocoran');
    expect(text).toContain('kopi kenangan: 250.000 (+150% dari 100.000)');
    expect(text).toContain('🆕 Langganan baru: spotify (54.000)');
    expect(text).toContain('💤 Sepertinya nggak kepake: netflix (100.000)');
    expect(text).toContain('prose line');
  });

  it('LLM failure → deterministic blocks only (never throws)', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error('boom'));
    const compose = createLeakAlertComposer(model);
    const out = await compose(payload, { now: new Date('2026-08-18T02:00:00Z') });
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('kopi kenangan');
    expect(text).not.toContain('prose line');
  });
});
```

- [ ] **Step 6: Run composer test to verify it fails**

Run: `npx vitest run tests/proactive/composers/leak-alert.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 7: Implement composer + prompt + template fallback + config + cron**

`src/proactive/prompt.ts` — append:
```ts
/** System prompt for the leak alert's single prose line (advisory spec §4.1). */
export function buildLeakAlertSystemPrompt(todayLabel: string): string {
  return `Kamu menulis SATU baris prose untuk alert bocoran MoneyBot. Blok detail (angka) sudah dirender sistem — kamu HANYA menulis satu kalimat interpretasi dalam Bahasa Indonesia yang natural: apa yang paling perlu diperhatikan user dari data itu. Tanpa prefiks, tanpa menjelaskan bahwa kamu AI, tanpa mengulang angka.

Hari ini (WIB): ${todayLabel}

ATURAN:
1. SATU kalimat, maks ~20 kata.
2. Jangan mengarang angka — data angka sudah dirender sistem.
3. Jangan pakai tabel markdown.`;
}
```

`src/proactive/composers/template.ts` — add a template + dispatch case (after `anomalyTemplate`):
```ts
interface LeakAlertData {
  week: string
  spikes: { label: string; current: number; previous: number; deltaPct: number }[]
  recurring: { name: string; amount: number; kind: 'new' | 'dormant' }[]
  recurringTotal: number
  baselineTotal?: number
}

/** Deterministic block for the weekly leak alert (advisory spec §4.1). */
export function leakAlertBlock (payload: ProactivePayload): string {
  const d = payload.data as unknown as LeakAlertData
  const lines: string[] = ['🔎 Kemungkinan bocoran:']
  for (const s of d.spikes)
    lines.push(`• ${s.label}: ${idr(s.current)} (+${s.deltaPct}% dari ${idr(s.previous)})`)
  for (const r of d.recurring) {
    if (r.kind === 'new') lines.push(`🆕 Langganan baru: ${r.name} (${idr(r.amount)})`)
    else lines.push(`💤 Sepertinya nggak kepake: ${r.name} (${idr(r.amount)})`)
  }
  return lines.join('\n')
}

/** Fallback template: block only (no LLM prose). */
export function leakAlertTemplate (payload: ProactivePayload): string {
  return leakAlertBlock(payload)
}
```
and in `templateCompose`'s switch, before `default`:
```ts
    case 'leak_alert':
      return leakAlertTemplate(payload)
```
(Task 13 adds the `health_digest` case alongside it — do not add it here, the function does not exist yet.)

`src/proactive/composers/leak-alert.ts`:
```ts
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { buildLeakAlertSystemPrompt } from '../prompt.js';
import { todayWibDisplay } from '../../domain/time.js';
import { leakAlertBlock } from './template.js';
import { logEvent } from '../../utils/logger.js';
import type { Composer } from '../types.js';

/** Leak alert: deterministic blocks + one LLM prose line (advisory spec §4.1). */
export function createLeakAlertComposer(model: LanguageModel): Composer {
  return async (payload, ctx) => {
    const block = leakAlertBlock(payload);
    try {
      const { text } = await generateText({
        model,
        system: buildLeakAlertSystemPrompt(todayWibDisplay(ctx.now)),
        prompt: JSON.stringify(payload.data),
      });
      return [text.trim(), block].filter(Boolean).join('\n\n');
    } catch (err) {
      logEvent('warn', 'leak alert llm failed; block only', { error: (err as Error).message });
      return block;
    }
  };
}
```

`src/config/index.ts` — add to the schema (near `PROACTIVE_ANOMALY_CRON`):
```ts
  PROACTIVE_LEAK_CRON: z.string().default('5 9 * * 2'), // Tuesday 09:05 WIB (spec §4.1)
```
`.env.example` — add `PROACTIVE_LEAK_CRON=5 9 * * 2` beside the other proactive crons.

`src/scheduler/cron.ts` — after the anomaly block:
```ts
  // Proactive outreach — weekly leak alert, Tuesday 09:05 WIB (advisory spec §4.1;
  // deliberately not Monday: anomaly insight already lands Monday 09:00).
  cron.schedule(config.PROACTIVE_LEAK_CRON, () => {
    runProactivePass({
      detector: detectLeakAlert,
      composer: createLeakAlertComposer(model),
      repos, policy, now: new Date(), send,
    }).catch((err) => logEvent('error', 'proactive leak alert error', { error: (err as Error).message }));
  }, { timezone: 'Asia/Jakarta' });
```
plus imports `detectLeakAlert` / `createLeakAlertComposer` and adding `config.PROACTIVE_LEAK_CRON` to the `schedules` log array.

- [ ] **Step 8: Run tests + gates + commit**

```bash
npx vitest run tests/proactive/triggers/leak-alert.test.ts tests/proactive/composers/leak-alert.test.ts tests/proactive/composers/template.test.ts
npx tsc --noEmit && npm run lint
git add src/proactive/triggers/leak-alert.ts src/proactive/composers/leak-alert.ts src/domain/entities.ts src/config/index.ts src/proactive/prompt.ts src/proactive/composers/template.ts src/scheduler/cron.ts .env.example tests/proactive/triggers/leak-alert.test.ts tests/proactive/composers/leak-alert.test.ts
git commit -m "feat: weekly leak alert (Tuesday 09:05 WIB, deterministic blocks + one prose line)"
```

---

### Task 11: `health.ts` (components + weighted score)

**Files:**
- Create: `src/domain/analytics/health.ts`
- Test: `tests/domain/analytics-health.test.ts`

**Interfaces:**
- Consumes: `PacingResult` (Task 5), `ObligationsResult` (Task 6), `LeakCandidates` (Task 9), `CashflowSummary` (Task 2).
- Produces (tool + digest composer consume this):
```ts
export type HealthStatus = 'good' | 'warn' | 'bad' | 'insufficient_data' | 'not_applicable';
export interface HealthComponent {
  key: 'savings_rate' | 'budget_adherence' | 'bill_coverage' | 'runway' | 'leak_flags' | 'trend';
  label: string;
  value: number | null;
  display: string;       // human-readable, e.g. '24%' / '3.2 bulan' / '3/5 on track'
  status: HealthStatus;
  note?: string;
}
export interface HealthVerdict { month: string; asOf: string; score?: number; components: HealthComponent[] }
export function healthVerdict(input: HealthInput): HealthVerdict
export interface HealthInput {
  month: string;              // 'YYYY-MM' being judged
  asOf: string;               // 'YYYY-MM-DD' — today for the current month, month-end for past months
  trailingCashflow: CashflowSummary[]; // up to 3 FULL months BEFORE `month` (oldest→newest)
  pacing: PacingResult;       // for `month` (as-of `asOf`)
  obligations?: ObligationsResult;     // current month only; absent → not_applicable
  liquidBalance: number;
  currentExpense: number;     // `month`'s expense total (month-to-date when current)
  previousExpense: number;    // month-before-`month`'s expense total
  leakCount: number;          // spikes + recurring findings
}
```
Thresholds (spec §2.2, named constants): savings `≥20 good · ≥0 warn · <0 bad`; adherence `≥80% good · ≥50% warn · <50 bad`; coverage `covered/tight/short → good/warn/bad`; runway months `≥3 good · ≥1 warn · <1 bad`; leaks `0 good · 1 warn · ≥2 bad`; trend `≤0% good · ≤25% warn · >25 bad`. Weights `savings .25 · adherence .15 · coverage .25 · runway .20 · leaks .05 · trend .10`; points `good 100 · warn 50 · bad 0`; score = weighted mean over scorable components, `Math.round`. All-unscorable → no score.

- [ ] **Step 1: Write the failing test**

`tests/domain/analytics-health.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { healthVerdict, type HealthInput } from '../../src/domain/analytics/health.js';
import type { CashflowSummary } from '../../src/domain/analytics/cashflow.js';
import type { PacingResult } from '../../src/domain/analytics/pacing.js';
import type { ObligationsResult } from '../../src/domain/analytics/obligations.js';

function mkCashflow(i: number, e: number): CashflowSummary {
  return { income: i, expense: e, net: i - e, savingsRate: i > 0 ? Math.round(((i - e) / i) * 100) : undefined };
}
function mkPacing(onTrack: number, total: number): PacingResult {
  return {
    asOf: '2026-08-16', elapsedDays: 16, daysInMonth: 31,
    items: Array.from({ length: total }, (_, i) => ({
      budgetCodeId: `b${i}`, name: `b${i}`, spent: 0, alloc: 100_000, projected: 0,
      verdict: i < onTrack ? ('on_track' as const) : ('over_pace' as const),
      lowConfidence: false,
    })),
  };
}
const BASE: HealthInput = {
  month: '2026-08', asOf: '2026-08-16',
  trailingCashflow: [mkCashflow(5_000_000, 4_000_000), mkCashflow(5_000_000, 3_500_000), mkCashflow(5_000_000, 3_500_000)],
  pacing: mkPacing(4, 5),           // 80% on track → good
  obligations: {
    horizonEnd: '2026-09-15', items: [{ name: 'x', amount: 100_000, dueDate: '2026-08-20', kind: 'recurring' }],
    liquidBalance: 3_800_000, totalDue: 100_000, verdict: 'covered',
  },                                 // covered → good
  liquidBalance: 3_800_000,          // avg expense 3.666.667 → runway 1.04 → warn
  currentExpense: 3_000_000, previousExpense: 3_200_000, // trend -6% → good
  leakCount: 1,                      // warn
};

describe('healthVerdict', () => {
  it('builds all six components and the weighted score', () => {
    const v = healthVerdict(BASE);
    expect(v.month).toBe('2026-08');
    const byKey = Object.fromEntries(v.components.map((c) => [c.key, c]));
    expect(byKey.savings_rate!.status).toBe('good');   // avg (20+30+30)/3 ≈ 27%
    expect(byKey.budget_adherence!.status).toBe('good');
    expect(byKey.bill_coverage!.status).toBe('good');
    expect(byKey.runway!.status).toBe('warn');         // 3.8M / 3.67M ≈ 1.04 bulan
    expect(byKey.leak_flags!.status).toBe('warn');
    expect(byKey.trend!.status).toBe('good');
    // score = .25*100 + .15*100 + .25*100 + .20*50 + .05*50 + .10*100 = 87.5 → 88
    expect(v.score).toBe(88);
  });

  it('savings_rate insufficient when no trailing month has income', () => {
    const v = healthVerdict({ ...BASE, trailingCashflow: [mkCashflow(0, 1_000_000)] });
    const c = v.components.find((x) => x.key === 'savings_rate')!;
    expect(c.status).toBe('insufficient_data');
    expect(v.score).toBeLessThan(88); // weight redistributed
  });

  it('bill_coverage not_applicable when obligations absent (past month)', () => {
    const v = healthVerdict({ ...BASE, obligations: undefined });
    expect(v.components.find((x) => x.key === 'bill_coverage')!.status).toBe('not_applicable');
  });

  it('runway insufficient when no trailing month has expenses', () => {
    const v = healthVerdict({ ...BASE, trailingCashflow: [mkCashflow(5_000_000, 0)] });
    expect(v.components.find((x) => x.key === 'runway')!.status).toBe('insufficient_data');
  });

  it('trend insufficient when either month has zero expense', () => {
    const v = healthVerdict({ ...BASE, previousExpense: 0 });
    expect(v.components.find((x) => x.key === 'trend')!.status).toBe('insufficient_data');
  });

  it('budget_adherence insufficient when there are no budgets', () => {
    const v = healthVerdict({ ...BASE, pacing: mkPacing(0, 0) });
    expect(v.components.find((x) => x.key === 'budget_adherence')!.status).toBe('insufficient_data');
  });

  it('all unscorable → no score', () => {
    const v = healthVerdict({
      ...BASE, trailingCashflow: [], pacing: mkPacing(0, 0), obligations: undefined,
      liquidBalance: 0, previousExpense: 0,
    });
    expect(v.score).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/domain/analytics-health.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/domain/analytics/health.ts`:
```ts
import type { CashflowSummary } from './cashflow.js';
import type { PacingResult } from './pacing.js';
import type { ObligationsResult } from './obligations.js';

export type HealthStatus = 'good' | 'warn' | 'bad' | 'insufficient_data' | 'not_applicable';

export type HealthComponentKey =
  | 'savings_rate' | 'budget_adherence' | 'bill_coverage' | 'runway' | 'leak_flags' | 'trend';

export interface HealthComponent {
  key: HealthComponentKey;
  label: string;
  value: number | null;
  display: string;
  status: HealthStatus;
  note?: string;
}

export interface HealthVerdict {
  month: string;
  asOf: string;
  score?: number;
  components: HealthComponent[];
}

export interface HealthInput {
  month: string;
  asOf: string;
  trailingCashflow: CashflowSummary[];
  pacing: PacingResult;
  obligations?: ObligationsResult;
  liquidBalance: number;
  currentExpense: number;
  previousExpense: number;
  leakCount: number;
}

/** Component thresholds (spec §2.2). */
const SAVINGS_GOOD_PCT = 20;
const ADHERENCE_GOOD_PCT = 80;
const ADHERENCE_WARN_PCT = 50;
const RUNWAY_GOOD_MONTHS = 3;
const RUNWAY_WARN_MONTHS = 1;
const TREND_WARN_PCT = 25;

/** Weights sum to 1.0 (spec §2.2). */
const WEIGHTS: Record<HealthComponentKey, number> = {
  savings_rate: 0.25, budget_adherence: 0.15, bill_coverage: 0.25,
  runway: 0.2, leak_flags: 0.05, trend: 0.1,
};
const POINTS: Record<'good' | 'warn' | 'bad', number> = { good: 100, warn: 50, bad: 0 };

/** Holistic verdict (spec §2.2): components degrade individually, never globally. */
export function healthVerdict(input: HealthInput): HealthVerdict {
  const components: HealthComponent[] = [];

  // savings_rate — mean savingsRate over trailing months that have income.
  const savingsMonths = input.trailingCashflow.filter((c) => c.income > 0 && c.savingsRate != null);
  if (savingsMonths.length === 0) {
    components.push({ key: 'savings_rate', label: 'Rasio tabungan', value: null, display: '—', status: 'insufficient_data', note: 'Belum ada bulan dengan pemasukan tercatat' });
  } else {
    const avg = Math.round(savingsMonths.reduce((s, c) => s + (c.savingsRate ?? 0), 0) / savingsMonths.length);
    const status: HealthStatus = avg >= SAVINGS_GOOD_PCT ? 'good' : avg >= 0 ? 'warn' : 'bad';
    components.push({ key: 'savings_rate', label: 'Rasio tabungan', value: avg, display: `${avg}%`, status, note: `rata-rata ${savingsMonths.length} bulan` });
  }

  // budget_adherence — % of budgets on track this month.
  const total = input.pacing.items.length;
  if (total === 0) {
    components.push({ key: 'budget_adherence', label: 'Kedisiplinan budget', value: null, display: '—', status: 'insufficient_data', note: 'Belum ada budget bulan ini' });
  } else {
    const onTrack = input.pacing.items.filter((p) => p.verdict === 'on_track').length;
    const pct = Math.round((onTrack / total) * 100);
    const status: HealthStatus = pct >= ADHERENCE_GOOD_PCT ? 'good' : pct >= ADHERENCE_WARN_PCT ? 'warn' : 'bad';
    components.push({ key: 'budget_adherence', label: 'Kedisiplinan budget', value: pct, display: `${onTrack}/${total} on track`, status });
  }

  // bill_coverage — forward-looking; only meaningful for the current month (spec §3.2).
  if (!input.obligations) {
    components.push({ key: 'bill_coverage', label: 'Cakupan tagihan 30 hari', value: null, display: '—', status: 'not_applicable', note: 'Hanya untuk bulan berjalan' });
  } else {
    const map = { covered: 'good', tight: 'warn', short: 'bad' } as const;
    components.push({
      key: 'bill_coverage', label: 'Cakupan tagihan 30 hari',
      value: input.obligations.totalDue,
      display: `${input.obligations.verdict} (${input.obligations.totalDue} vs ${input.obligations.liquidBalance})`,
      status: map[input.obligations.verdict],
    });
  }

  // runway — liquid balance ÷ avg monthly expense over trailing months with expense.
  const expenseMonths = input.trailingCashflow.filter((c) => c.expense > 0);
  if (expenseMonths.length === 0) {
    components.push({ key: 'runway', label: 'Dana darurat', value: null, display: '—', status: 'insufficient_data', note: 'Belum ada bulan penuh dengan pengeluaran' });
  } else {
    const avgExpense = expenseMonths.reduce((s, c) => s + c.expense, 0) / expenseMonths.length;
    const months = input.liquidBalance / avgExpense;
    const status: HealthStatus = months >= RUNWAY_GOOD_MONTHS ? 'good' : months >= RUNWAY_WARN_MONTHS ? 'warn' : 'bad';
    components.push({ key: 'runway', label: 'Dana darurat', value: Math.round(months * 10) / 10, display: `${months.toFixed(1)} bulan`, status });
  }

  // leak_flags.
  const leakStatus: HealthStatus = input.leakCount >= 2 ? 'bad' : input.leakCount === 1 ? 'warn' : 'good';
  components.push({ key: 'leak_flags', label: 'Indikasi bocoran', value: input.leakCount, display: `${input.leakCount} temuan`, status: leakStatus });

  // trend — expense Δ% vs previous month.
  if (input.previousExpense <= 0 || input.currentExpense <= 0) {
    components.push({ key: 'trend', label: 'Tren pengeluaran', value: null, display: '—', status: 'insufficient_data', note: 'Butuh dua bulan dengan pengeluaran' });
  } else {
    const delta = Math.round(((input.currentExpense - input.previousExpense) / input.previousExpense) * 100);
    const status: HealthStatus = delta <= 0 ? 'good' : delta <= TREND_WARN_PCT ? 'warn' : 'bad';
    components.push({ key: 'trend', label: 'Tren pengeluaran', value: delta, display: `${delta >= 0 ? '+' : ''}${delta}% vs bulan lalu`, status });
  }

  // Weighted score over scorable components.
  let weightSum = 0;
  let pointSum = 0;
  for (const c of components) {
    if (c.status !== 'good' && c.status !== 'warn' && c.status !== 'bad') continue;
    weightSum += WEIGHTS[c.key];
    pointSum += WEIGHTS[c.key] * POINTS[c.status];
  }
  const verdict: HealthVerdict = { month: input.month, asOf: input.asOf, components };
  if (weightSum > 0) verdict.score = Math.round(pointSum / weightSum);
  return verdict;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/domain/analytics-health.test.ts` — Expected: PASS. (If the score assertion is off, recompute by hand from the constants before touching anything — the arithmetic above yields 87.5 → `Math.round` → 88.)

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/domain/analytics/health.ts tests/domain/analytics-health.test.ts
git commit -m "feat: analytics healthVerdict (6 components, weighted score)"
```

---

### Task 12: `get_financial_health` tool

**Files:**
- Modify: `src/agent/tools.ts` — insert after `tools.get_analytics`; extend the ANALISIS & SARAN prompt block from Task 4 with one line
- Test: `tests/agent/tools-analytics.test.ts` — extend

**Interfaces:**
- Consumes: `healthVerdict`/`HealthInput` (Task 11), `cashflowSummary` (Task 2), `pacing` (Task 5), `obligations` (Task 6), `leakCandidates` (Task 9), `monthBounds`/`resolveComparison` (Task 1), repos: `transactions.findByDateRange`, `budgets.findByUserAndMonth`, `accounts.findAllByUserId`, `recurrings.findAllByUserId`, `cardStatements.getWithFigures`.
- Produces: agent tool `get_financial_health({ month? })` → `{ month, asOf, score?, components: HealthComponent[] }`; un-gated read tool.

As-of semantics (spec §3.2): current month → `asOf = todayWIB()`, `obligations` computed; past month (`YYYY-MM` before current) → `asOf = month end`, `obligations` omitted (`not_applicable`). `trailingCashflow` = the 3 FULL months before the requested month. `pacing` runs with `asOf` inside the requested month (for past months the full elapsed month projects to itself — verdict ≈ spent vs alloc).

- [ ] **Step 1: Write the failing test (append to `tests/agent/tools-analytics.test.ts`)**

```ts
describe('buildTools — get_financial_health', () => {
  const budgetRows = [
    { budgetCodeId: 'b1', userId: 'u1', name: 'makan', monthlyBudget: 1_000_000, month: 8, year: 2026, spent: 400_000, isRecurring: false, createdAt: '', updatedAt: '' },
  ];

  function healthRepos(txns: Transaction[], opts: { accounts?: Account[]; recurrings?: RecurringPayment[] } = {}): Repos {
    const base = mockRepos({ txns });
    (base.accounts.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue(opts.accounts ?? []);
    (base.recurrings.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue(opts.recurrings ?? []);
    (base.budgets.findByUserAndMonth as ReturnType<typeof vi.fn>).mockResolvedValue(budgetRows);
    return base;
  }

  it('is a read tool (registered before onboarding)', () => {
    expect(buildTools({ userId: 'u1', repos: mockRepos(), hasAccount: false }).get_financial_health).toBeDefined();
  });

  it('returns score + components for a healthy current month', async () => {
    vi.setSystemTime(new Date('2026-08-16T03:00:00Z')); // WIB 2026-08-16
    try {
      const txns: Transaction[] = [
        // trailing months: 5.0M income, ~3.5M expense each
        ...([['2026-05', 3_500_000], ['2026-06', 3_500_000], ['2026-07', 3_600_000]] as const).flatMap(([mo, exp]) => [
          mkTxn({ date: `${mo}-10`, type: 'income', amount: 5_000_000 }),
          mkTxn({ date: `${mo}-15`, amount: exp }),
        ]),
        // current month
        mkTxn({ date: '2026-08-05', type: 'income', amount: 5_000_000 }),
        mkTxn({ date: '2026-08-10', amount: 1_000_000, budgetCodeId: 'b1' }),
      ];
      const accounts: Account[] = [{ accountId: 'a1', userId: 'u1', name: 'bca', type: 'bank', balance: 15_000_000, isActive: true, createdAt: '', updatedAt: '' }];
      const { get_financial_health } = buildTools({ userId: 'u1', repos: healthRepos(txns, { accounts }), hasAccount: true });
      const out = await get_financial_health.execute!(
        {},
        { toolCallId: 'c', messages: [] as never },
      ) as Record<string, never>;
      expect(out.month).toBe('2026-08');
      expect(out.score).toEqual(expect.any(Number));
      const keys = (out.components as { key: string; status: string }[]).map((c) => c.key);
      expect(keys).toEqual(['savings_rate', 'budget_adherence', 'bill_coverage', 'runway', 'leak_flags', 'trend']);
      const runway = (out.components as { key: string; status: string; display: string }[]).find((c) => c.key === 'runway')!;
      expect(runway.status).toBe('good'); // 15M / ~3.53M ≈ 4.2 bulan
    } finally {
      vi.useRealTimers();
    }
  });

  it('past month: bill_coverage not_applicable, no obligations fetch needed', async () => {
    const txns: Transaction[] = [mkTxn({ date: '2026-07-10', type: 'income', amount: 5_000_000 }), mkTxn({ date: '2026-07-15', amount: 3_000_000 })];
    const accounts: Account[] = [{ accountId: 'a1', userId: 'u1', name: 'bca', type: 'bank', balance: 10_000_000, isActive: true, createdAt: '', updatedAt: '' }];
    const { get_financial_health } = buildTools({ userId: 'u1', repos: healthRepos(txns, { accounts }), hasAccount: true });
    const out = await get_financial_health.execute!(
      { month: '2026-07' },
      { toolCallId: 'c', messages: [] as never },
    ) as Record<string, never>;
    expect(out.asOf).toBe('2026-07-31');
    const coverage = (out.components as { key: string; status: string }[]).find((c) => c.key === 'bill_coverage')!;
    expect(coverage.status).toBe('not_applicable');
  });

  it('thin history: components degrade, tool never errors', async () => {
    vi.setSystemTime(new Date('2026-08-16T03:00:00Z'));
    try {
      const { get_financial_health } = buildTools({ userId: 'u1', repos: healthRepos([]), hasAccount: true });
      const out = await get_financial_health.execute!(
        {},
        { toolCallId: 'c', messages: [] as never },
      ) as Record<string, never>;
      const statuses = (out.components as { status: string }[]).map((c) => c.status);
      expect(statuses).toContain('insufficient_data');
      expect(out.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
```
Add `Account`/`RecurringPayment` to the type import from `'../../src/domain/entities.js'` at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tools-analytics.test.ts` — Expected: new cases FAIL (tool undefined).

- [ ] **Step 3: Implement — insert after `tools.get_analytics` in `src/agent/tools.ts`**

New imports (top of file, beside the other analytics imports):
```ts
import { healthVerdict } from '../domain/analytics/health.js';
import { obligations } from '../domain/analytics/obligations.js';
import { leakCandidates } from '../domain/analytics/leaks.js';
import { monthBounds } from '../domain/analytics/period.js';
```
Tool body:
```ts
  tools.get_financial_health = tool({
    description:
      'Skor kesehatan keuangan bulanan (0-100) + 6 komponen: rasio tabungan, kedisiplinan budget, cakupan tagihan 30 hari, ' +
      'dana darurat (bulan), indikasi bocoran, tren pengeluaran. Untuk "sehat nggak keuangan aku?". Default: bulan berjalan.',
    parameters: z.object({
      month: z.string().optional().describe('YYYY-MM. Default: bulan berjalan (WIB). Bulan lampau juga bisa.'),
    }),
    execute: async ({ month }) => {
      try {
        const today = todayWIB();
        const currentMonth = today.slice(0, 7);
        const target = month ?? currentMonth;
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(target) || target > currentMonth) {
          return { status: 'missing_fields', missing: ['month'], message: 'Format YYYY-MM, tidak boleh di masa depan.' };
        }
        const isCurrent = target === currentMonth;
        const asOf = isCurrent ? today : monthBounds(Number(target.slice(0, 4)), Number(target.slice(5, 7))).to;

        const y = Number(target.slice(0, 4));
        const m = Number(target.slice(5, 7));

        // Calendar helper: offset 0 = judged month, -1..-3 = trailing months.
        const monthOf = (offset: number): { from: string; to: string } => {
          let mm = m + offset, yy = y;
          while (mm < 1) { mm += 12; yy -= 1; }
          return monthBounds(yy, mm);
        };

        // One fetch spanning the 3 trailing months + the judged month.
        const allTx = await repos.transactions.findByDateRange(userId, monthOf(-3).from, asOf);

        const inMonth = (from: string, to: string) => allTx.filter((t) => t.date >= from && t.date <= to);

        const trailingCashflow = [-3, -2, -1].map((o) => {
          const b = monthOf(o);
          return cashflowSummary(inMonth(b.from, b.to));
        });
        const judged = monthOf(0);
        const prev = monthOf(-1);
        const currentExpense = inMonth(judged.from, judged.to).filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
        const previousExpense = inMonth(prev.from, prev.to).filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

        const budgets = await repos.budgets.findByUserAndMonth(userId, y, m);
        const pacingResult = pacing(inMonth(judged.from, judged.to), budgets, asOf);

        const accounts = await repos.accounts.findAllByUserId(userId);
        const liquidBalance = accounts
          .filter((a) => a.isActive && (a.type === 'cash' || a.type === 'bank'))
          .reduce((s, a) => s + a.balance, 0);

        let obligationsResult;
        if (isCurrent) {
          const cardDues: { name: string; amount: number; dueDate: string }[] = [];
          for (const a of accounts.filter((x) => x.type === 'card' && x.billingDay != null && x.isActive)) {
            const stmts = await repos.cardStatements.getWithFigures(userId, a.accountId, new Date());
            for (const s of stmts) {
              if (s.remainingDue > 0) cardDues.push({ name: a.name, amount: s.remainingDue, dueDate: s.dueDate });
            }
          }
          const recurrings = await repos.recurrings.findAllByUserId(userId);
          obligationsResult = obligations({ recurrings, accounts, cardDues, today });
        }

        const prevTx = inMonth(prev.from, prev.to);
        const leaks = leakCandidates({
          currentTx: inMonth(judged.from, judged.to),
          previousTx: prevTx,
          tx60d: allTx.filter((t) => t.date >= judged.from), // dormancy window ≥ judged month (60d when history allows)
          recurrings: await repos.recurrings.findAllByUserId(userId),
          today: asOf,
        });
        const leakCount = leaks.spikes.length + leaks.recurring.length;

        const verdict = healthVerdict({
          month: target, asOf,
          trailingCashflow, pacing: pacingResult,
          obligations: obligationsResult,
          liquidBalance, currentExpense, previousExpense, leakCount,
        });
        return verdict;
      } catch (e) {
        logEvent('error', 'get_financial_health failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal menghitung skor kesehatan. Coba lagi.' };
      }
    },
  });
```
And in `src/agent/system-prompt.ts`, extend the ANALISIS & SARAN block (Task 4) with:
```
- "Sehat nggak keuangan aku?" → get_financial_health (bulan berjalan atau bulan lampau via month).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/tools-analytics.test.ts` — Expected: PASS (all describes).
Watch-outs if red: (1) `monthOf(-3)` arithmetic — trailing months must be the 3 FULL months BEFORE the judged month; (2) the mocked `findByDateRange` in this test file filters by date — `allTx` slicing depends on it, keep `mkTxn` dates inside the fetched window; (3) `getWithFigures` mock: `cardStatements: {} as never` — thin-history/healthy cases have no card accounts so it is never called; if a case adds cards, mock it as `vi.fn(async () => [])`.

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/agent/tools.ts src/agent/system-prompt.ts tests/agent/tools-analytics.test.ts
git commit -m "feat: get_financial_health verdict tool (6 components, past-month support)"
```

---

### Task 13: Monthly health digest (trigger + composer + config + cron)

**Files:**
- Create: `src/proactive/triggers/health-digest.ts`, `src/proactive/composers/health-digest.ts`
- Modify: `src/config/index.ts`, `.env.example`, `src/proactive/prompt.ts`, `src/proactive/composers/template.ts` (dispatch case), `src/scheduler/cron.ts`
- Test: `tests/proactive/triggers/health-digest.test.ts`, `tests/proactive/composers/health-digest.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 11–12's data pipeline (healthVerdict etc.), `wibISOWeekLabel` not needed here; dedupKey = `health digest:<YYYY-MM>`.
- Produces: triggerType `'health_digest'`; `detectHealthDigest: Detector`; `createHealthDigestComposer(model): Composer`; payload `data: { month, score?, components, prevScore?, prevStatuses?: Record<string, string> }`; config `PROACTIVE_HEALTH_DIGEST_CRON` default `'35 8 1 * *'` (1st of month 08:35 WIB, spec §4.2).

The digest judges the month that just ENDED (on Aug 1, judge July) — a monthly retrospective — while also reporting the running month's score when data allows. Simplest faithful shape: judge the previous month (full data, no partials), and include the previous-previous statuses for delta prose. So: `month = previous month`, `prevStatuses` = components of the month before that (both computed via `healthVerdict`).

- [ ] **Step 1: Write the failing trigger test**

`tests/proactive/triggers/health-digest.test.ts` (mock style as Task 10's):
```ts
import { describe, it, expect, vi } from 'vitest';
import { detectHealthDigest } from '../../../src/proactive/triggers/health-digest.js';
import type { Repos } from '../../../src/repositories/interfaces.js';
import type { Transaction } from '../../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-07-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}
function mockRepos(opts: { txns?: Transaction[] } = {}): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(async () => [{ accountId: 'a', userId: 'u', name: 'bca', type: 'bank', balance: 10_000_000, isActive: true, createdAt: '', updatedAt: '' }]), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(),
      findByDateRange: vi.fn(async (_u: string, from: string, to: string) =>
        (opts.txns ?? []).filter((t) => t.date >= from && t.date <= to)),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), findExpiredDeferrals: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(async () => []), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn(), rollRecurringIntoMonth: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(async () => []), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    cardStatements: {} as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

// 2026-08-01T01:30:00Z → WIB 2026-08-01; judged month = 2026-07.
const NOW = new Date('2026-08-01T01:30:00Z');

describe('detectHealthDigest', () => {
  it('judges the month that just ended; dedupKey carries that month', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ date: '2026-07-05', type: 'income', amount: 5_000_000 }),
        mkTxn({ date: '2026-07-15', amount: 3_000_000 }),
      ],
    });
    const out = await detectHealthDigest({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.triggerType).toBe('health_digest');
    expect(out[0]!.dedupKey).toBe('health-digest:2026-07');
    const data = out[0]!.data as { month: string; components: unknown[] };
    expect(data.month).toBe('2026-07');
    expect(data.components.length).toBe(6);
  });

  it('returns [] when the user has no active accounts', async () => {
    const repos = mockRepos();
    (repos.accounts.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    expect(await detectHealthDigest({ userId: 'u', repos, now: NOW })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/proactive/triggers/health-digest.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement the trigger**

`src/proactive/triggers/health-digest.ts` — reuse Task 12's pipeline, factored: extract the per-month computation from the `get_financial_health` execute body into a shared helper `computeHealthVerdict(userId, repos, target, today): Promise<HealthVerdict>` exported from `src/domain/analytics/compute.ts`… **Do NOT do that refactor** — instead, implement the trigger's own fetch (it is ~30 lines and trigger/tools tolerate mild duplication per YAGNI; a shared seam can be extracted later if a third consumer appears):
```ts
import { todayWIB } from '../../domain/time.js';
import { monthBounds } from '../../domain/analytics/period.js';
import { cashflowSummary } from '../../domain/analytics/cashflow.js';
import { pacing } from '../../domain/analytics/pacing.js';
import { leakCandidates } from '../../domain/analytics/leaks.js';
import { healthVerdict } from '../../domain/analytics/health.js';
import type { Detector, ProactivePayload } from '../types.js';

async function verdictFor(userId: string, deps: Parameters<Detector>[0]['repos'], target: string, today: string) {
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
    tx60d: allTx.filter((t) => t.date >= judged.from), recurrings, today: asOf,
  });

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
```

- [ ] **Step 4: Run trigger test to verify it passes**

Run: `npx vitest run tests/proactive/triggers/health-digest.test.ts` — Expected: PASS.

- [ ] **Step 5: Write the failing composer test**

`tests/proactive/composers/health-digest.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { generateText } from 'ai';
import { createHealthDigestComposer } from '../../../src/proactive/composers/health-digest.js';

vi.mock('ai', () => ({ generateText: vi.fn(async () => ({ text: 'prose paragraph' })) }));
const model = {} as never;

const payload = {
  triggerType: 'health_digest' as const,
  dedupKey: 'k',
  channel: 'llm' as const,
  data: {
    month: '2026-07',
    score: 78,
    components: [
      { key: 'savings_rate', label: 'Rasio tabungan', value: 24, display: '24%', status: 'good', note: 'rata-rata 3 bulan' },
      { key: 'runway', label: 'Dana darurat', value: 1.2, display: '1.2 bulan', status: 'warn' },
    ],
    prevScore: 71,
    prevStatuses: { savings_rate: 'warn', runway: 'warn' },
  },
};

describe('createHealthDigestComposer', () => {
  it('renders score line + per-component status blocks + LLM prose', async () => {
    const compose = createHealthDigestComposer(model);
    const out = await compose(payload, { now: new Date('2026-08-01T01:30:00Z') });
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('🩺 Skor keuangan Juli 2026: 78/100');
    expect(text).toContain('✅ Rasio tabungan: 24%');
    expect(text).toContain('⚠️ Dana darurat: 1.2 bulan');
    expect(text).toContain('prose paragraph');
  });

  it('LLM failure → blocks only', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error('boom'));
    const compose = createHealthDigestComposer(model);
    const out = await compose(payload, { now: new Date('2026-08-01T01:30:00Z') });
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('78/100');
    expect(text).not.toContain('prose paragraph');
  });
});
```

- [ ] **Step 6: Run composer test to verify it fails**

Run: `npx vitest run tests/proactive/composers/health-digest.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 7: Implement composer + prompt + template + config + cron**

`src/proactive/prompt.ts` — append:
```ts
/** System prompt for the monthly health digest prose (advisory spec §4.2). */
export function buildHealthDigestSystemPrompt(todayLabel: string): string {
  return `Kamu menulis satu paragraf pendek (2-3 kalimat) untuk laporan bulanan kesehatan keuangan MoneyBot. Blok skor + komponen sudah dirender sistem — kamu HANYA menulis interpretasi: apa yang membaik/memburuk dibanding bulan sebelumnya (bandingkan status komponen dengan prevStatuses), dan satu saran konkret yang paling berdampak. Bahasa Indonesia yang natural dan hangat.

Hari ini (WIB): ${todayLabel}

ATURAN:
1. 2-3 kalimat, tanpa prefiks, tanpa menjelaskan bahwa kamu AI.
2. Format nominal locale IDR tanpa "Rp"/"IDR".
3. Jangan mengarang angka — angka sudah dirender sistem.
4. Jangan pakai tabel markdown.`;
}
```

`src/proactive/composers/template.ts` — add (after `leakAlertTemplate`):
```ts
interface HealthDigestData {
  month: string // 'YYYY-MM'
  score?: number
  components: { key: string; label: string; display: string; status: string }[]
  prevScore?: number
}

const MONTH_NAMES_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember']

function monthLabelId (month: string): string {
  const m = Number(month.slice(5, 7))
  return `${MONTH_NAMES_ID[m - 1] ?? month} ${month.slice(0, 4)}`
}

const HEALTH_STATUS_ICON: Record<string, string> = { good: '✅', warn: '⚠️', bad: '🚨', insufficient_data: '❔', not_applicable: '➖' }

/** Deterministic block for the monthly health digest (advisory spec §4.2). */
export function healthDigestBlock (payload: ProactivePayload): string {
  const d = payload.data as unknown as HealthDigestData
  const lines: string[] = []
  lines.push(d.score != null
    ? `🩺 Skor keuangan ${monthLabelId(d.month)}: ${d.score}/100`
    : `🩺 Skor keuangan ${monthLabelId(d.month)}: belum bisa dinilai (data kurang)`)
  for (const c of d.components)
    lines.push(`${HEALTH_STATUS_ICON[c.status] ?? '❔'} ${c.label}: ${c.display}`)
  return lines.join('\n')
}

export function healthDigestTemplate (payload: ProactivePayload): string {
  return healthDigestBlock(payload)
}
```
(prevScore/prevStatuses are intentionally NOT in the block — the composer's LLM prose owns the month-over-month comparison.) In `templateCompose`'s switch add:
```ts
    case 'health_digest':
      return healthDigestTemplate(payload)
```

`src/proactive/composers/health-digest.ts`:
```ts
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { buildHealthDigestSystemPrompt } from '../prompt.js';
import { todayWibDisplay } from '../../domain/time.js';
import { healthDigestBlock } from './template.js';
import { logEvent } from '../../utils/logger.js';
import type { Composer } from '../types.js';

/** Monthly health digest: deterministic blocks + LLM delta prose (advisory spec §4.2). */
export function createHealthDigestComposer(model: LanguageModel): Composer {
  return async (payload, ctx) => {
    const block = healthDigestBlock(payload);
    try {
      const { text } = await generateText({
        model,
        system: buildHealthDigestSystemPrompt(todayWibDisplay(ctx.now)),
        prompt: JSON.stringify(payload.data),
      });
      return [text.trim(), block].filter(Boolean).join('\n\n');
    } catch (err) {
      logEvent('warn', 'health digest llm failed; block only', { error: (err as Error).message });
      return block;
    }
  };
}
```

`src/config/index.ts`: `PROACTIVE_HEALTH_DIGEST_CRON: z.string().default('35 8 1 * *'),` · `.env.example`: `PROACTIVE_HEALTH_DIGEST_CRON=35 8 1 * *`.

`src/scheduler/cron.ts` — after the leak-alert block:
```ts
  // Proactive outreach — monthly health digest, 1st of month 08:35 WIB (advisory
  // spec §4.2): judges the month that just ended.
  cron.schedule(config.PROACTIVE_HEALTH_DIGEST_CRON, () => {
    runProactivePass({
      detector: detectHealthDigest,
      composer: createHealthDigestComposer(model),
      repos, policy, now: new Date(), send,
    }).catch((err) => logEvent('error', 'proactive health digest error', { error: (err as Error).message }));
  }, { timezone: 'Asia/Jakarta' });
```
plus imports and adding both new crons to the `schedules` log array.

- [ ] **Step 8: Run tests + gates + commit**

```bash
npx vitest run tests/proactive/triggers/health-digest.test.ts tests/proactive/composers/health-digest.test.ts tests/proactive/composers/template.test.ts
npx tsc --noEmit && npm run lint
git add src/proactive/triggers/health-digest.ts src/proactive/composers/health-digest.ts src/config/index.ts src/proactive/prompt.ts src/proactive/composers/template.ts src/scheduler/cron.ts .env.example tests/proactive/triggers/health-digest.test.ts tests/proactive/composers/health-digest.test.ts
git commit -m "feat: monthly health digest (1st 08:35 WIB, verdict blocks + delta prose)"
```

---

## Final verification (whole plan)

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npm test` — full suite green, EXCEPT the pre-existing `tests/agent/system-prompt.test.ts` drift (identical before/after) and environmental reconcile timeouts (DB not reachable — rerun with the dev Neon URL in `.env`; see memory note). No NEW failures.
- [ ] Update `CLAUDE.md`'s stale "Active work in progress" block: remove the `feat/slice-0-1` pointer (work long merged) and replace with a one-line pointer to this plan while it executes.
- [ ] Final commit: `docs: refresh active-work pointer for advisory layer`

## Spec-coverage map

| Spec section | Tasks |
|---|---|
| §2.1 periodCompare / cashflowSummary | 2, 3 |
| §2.1 pacing | 5, 7, 8 |
| §2.1 obligations | 6, 12 |
| §2.1 leakCandidates | 9, 10 |
| §2.2 healthVerdict + components/score | 11, 12 |
| §2.3 normalization | 1 |
| §3.1 get_analytics | 3, 7 |
| §3.2 get_financial_health (as-of semantics) | 12 |
| §3.3 advice rules | 4, 12 |
| §4.1 weekly leak alert (Tue) | 10 |
| §4.2 monthly health digest | 13 |
| §5 edge cases (zero-division, thin history, first month, partial-month, backdated) | embedded in Tasks 2, 5, 6, 9, 11, 12 tests |
| §7 testing | every task's TDD cycle |

