# MoneyBot — Advisory Layer (Analytics + Financial Health) Design

- **Date:** 2026-08-16
- **Source:** user feature request (richer insight & queries; detailed financial advice)
- **Status:** Design — ready for implementation planning
- **Builds on:** `docs/superpowers/specs/2026-06-14-moneybot-impl-design.md` (architecture, tool layer),
  `2026-06-22-proactive-outreach-design.md` + `2026-06-24-moneybot-proactive-triggers-design.md` (engine, guard),
  `2026-07-01-budget-auto-rolling-design.md` (budget semantics),
  `2026-07-25-card-billing-design.md` (statements, derived figures)

## Purpose

Turn MoneyBot from a data-entry + glance bot into an advisor the user can interrogate:
trend analysis ("bulan ini boros apa?"), forward-looking affordability ("sisa bulan ini
aman?"), leak detection ("duit bocor di mana?"), and a holistic financial-health verdict
("sehat nggak keuangan aku?") — on demand in chat **and** via proactive pushes. The data
layer (transactions, budgets, card statements, recurring payments) is already rich enough
to reason over; what is missing is a derived-metrics layer between raw rows and the LLM.

---

## 1. Settled decisions

1. **Architecture — hybrid over a shared metrics module (option C).** One pure analytics
   module computes every derived metric. Chat gets a compositional `get_analytics` tool
   plus one deterministic `get_financial_health` verdict tool. Proactive composers call
   the module directly. The LLM never does arithmetic it can avoid: it selects tools and
   writes prose; code computes numbers.
2. **Deterministic formatting rule (existing preference, extended).** Bars, tables,
   guaranteed bullets, scores, and statuses are rendered in code. The LLM owns prose
   interpretation only — one or two sentences of "what this means", grounded in returned
   metrics.
3. **No new deps, no schema changes.** Everything is computed from existing tables at
   read time (same philosophy as card statements: derive, don't freeze). One exception is
   allowed if slicing proves it necessary — but the design assumes none.
4. **`today` is always a parameter.** No `Date.now()` inside analytics functions — callers
   (tools, triggers, tests) pass the current WIB date. Functions are pure and
   table-testable.
5. **Degrade per-component, not all-or-nothing.** Thin history yields
   `insufficient_data` components; the rest of the answer still renders.

## 2. The analytics module — `src/domain/analytics/`

Pure functions, zero I/O, no `pg` import (NFR-02 safe by construction — the module sits
in `domain/`, below the repository seam). Callers fetch domain objects via repos and pass
them in.

```
src/domain/analytics/
  period.ts     // WIB period math: month bounds, prev-period resolution, elapsed days
  compare.ts    // periodCompare
  cashflow.ts   // cashflowSummary
  pacing.ts     // pacing
  obligations.ts// obligations
  leaks.ts      // leakCandidates
  health.ts     // healthVerdict (consumes the others)
  normalize.ts  // description normalization for grouping
```

### 2.1 Functions

| Function | Inputs | Computes |
|---|---|---|
| `periodCompare(txA, txB, opts)` | transactions of two periods, `breakdown: 'category' \| 'budget' \| 'description'` | per-period totals, Δ% overall and per group; groups sorted by \|Δ\| desc |
| `cashflowSummary(tx, {from,to})` | transactions of a range | income, expense, net, savings rate = (income−expense)/income; `undefined` when income = 0 |
| `pacing(tx, budgets, {today})` | current-month transactions + budget rows | per budget: spent, run-rate = spent/elapsedDays, projected month-end = run-rate×daysInMonth, Δ vs monthlyBudget, verdict `on_track \| tight \| over_pace`, projected-overrun date when `over_pace` |
| `obligations(recurrings, statements, accounts, {today})` | active recurring payments, open card statements, accounts | next-30-day bills (recurring fires + card dues by derived due date) vs liquid balance = Σ balances of `cash`+`bank` accounts; coverage verdict `covered \| tight \| short` + shortfall amount |
| `leakCandidates(tx, recurrings, {today})` | ≥ 2 months of expense transactions + recurring rows | (a) description-group spikes: normalized groups whose total grew > 50% MoM with ≥ 2 occurrences each side; (b) recurring creep: active recurring total this month vs 3-mo-ago baseline, new subscriptions added; (c) dormant subscriptions: active recurring with no matching transaction occurrence in 60 days |
| `healthVerdict(inputs, {today})` | outputs of the above + budgets + accounts | 0–100 score + components (§2.2), each `{key, label, value, display, status: 'good'\|'warn'\|'bad'\|'insufficient_data'\|'not_applicable', note}` |

Thresholds (50% spike, 30-day horizon, etc.) live as named constants in the module with
doc comments — tuning points, not magic numbers.

### 2.2 Health components

| Key | Metric | good / warn / bad |
|---|---|---|
| `savings_rate` | 3-month trailing avg savings rate | ≥ 20% / 0–20% / < 0 |
| `budget_adherence` | % of budgets `on_track` this month | ≥ 80% / 50–80% / < 50% |
| `bill_coverage` | `obligations` verdict | covered / tight / short |
| `runway` | liquid balance ÷ avg monthly expense (trailing 3 full months), in months | ≥ 3 / 1–3 / < 1 |
| `leak_flags` | count of `leakCandidates` | 0 / 1 / ≥ 2 |
| `trend` | expense Δ% current vs previous month | ≤ 0% / 0–25% / > 25% |

Score = weighted mean of scorable components (those not `insufficient_data` /
`not_applicable`) mapped to 100/50/0 (weights: savings_rate .25, budget_adherence .15,
bill_coverage .25, runway .20, leak_flags .05, trend .10). If every component is
unscorable, the tool returns that verdict instead of a score.

### 2.3 Description normalization (`normalize.ts`)

`trim → lowercase → strip digits & qty markers (x2, 2x, 2pcs) → collapse whitespace →
truncate at punctuation`. Groups with fewer than 2 occurrences in a period or below a
min-total floor are excluded from spike detection, so one-off notes never surface as
"leaks".

## 3. Agent tools (read layer additions)

### 3.1 `get_analytics`

```
{ from, to,                       // YYYY-MM-DD WIB
  compareWith?: 'previous_period' | 'previous_month' | 'previous_year',
  breakdown?: 'category' | 'budget' | 'description',   // default category
  budgetCodeId?, categoryId?,     // drill-down filters
  topN? }                         // cap groups, default 10
```

Returns: `{ current: {total, count}, previous?, deltaPct?, groups: [{label, icon?, current,
previous?, deltaPct, pctOfTotal}], cashflow?, savingsRate?, pacing? }` — cashflow/savings-rate
included when the range spans ≥ 1 month; `pacing` (slice 2) included when the range
covers the current in-progress month. `compareWith` resolves via `period.ts`
(`previous_period` = the same-length window immediately preceding `from`) and is returned
so the LLM can cite the comparison window. Transfers excluded (FR-10e), matching
`get_report`.

### 3.2 `get_financial_health`

```
{ month? }   // 'YYYY-MM', defaults to current WIB month; past months allowed
```

Returns: `{ score?, components: HealthComponent[], generatedAt }` per §2.2. As-of
semantics: all components are evaluated as of the last day of the requested month
(trailing windows end there; `trend` compares the requested month vs the one before it).
The single exception is `bill_coverage`, which is forward-looking by nature: meaningful
only for the current month — for a past month it returns status `not_applicable`.
`not_applicable` components are excluded from scoring, like `insufficient_data`.

### 3.3 System-prompt advice rules

New short section: when the user asks an advice/analysis question, call the analytics
tools first; ground every number in a returned metric — never compute or invent figures;
acknowledge `insufficient_data` components plainly; keep prose to interpretation
(what/why/so-what), not restating tables.

## 4. Proactive additions (existing engine, guard, `/nudges` mute)

1. **Weekly leak alert** — Tuesdays ~09:05 WIB (deliberately not Monday: the weekly
   anomaly insight already lands Monday 09:00; spreading avoids stacked pushes).
   Detector runs `leakCandidates`; fires only when a candidate clears the spike floor or
   a new/dormant subscription is found. Composer: deterministic blocks per candidate +
   one LLM prose line.
2. **Monthly health digest** — 1st of month ~08:35 WIB. Renders `healthVerdict`
   components as deterministic blocks (status icons per component), score line, + LLM
   prose comparing to the previous month's components.

Both register in `src/scheduler/cron.ts` beside existing jobs; both pass through the
existing guard (quiet hours, max/day) and mute.

## 5. Edge cases

- **Thin history (< ~45 days):** trend/runway/savings components report
  `insufficient_data`; scoring skips them (§2.2).
- **Zero income:** savings rate `undefined` — never a fake −∞.
- **First month / no prior period:** `get_analytics` returns current-only (no `previous`,
  no deltas).
- **Partial month pacing:** run-rate uses elapsed days ≥ 1; day 1–2 of a month projects
  from a tiny sample — `pacing` marks projections `low_confidence` before day 5.
- **Backdated/late-logged transactions:** metrics are computed at read time, so they
  self-correct (consistent with card-statement philosophy).

## 6. Slice plan

| Slice | Ships | Surfaces |
|---|---|---|
| 1. Trends foundation | `period/compare/cashflow/normalize` + `get_analytics` + prompt rules | on-demand chat |
| 2. Forward-looking | `pacing` + `obligations` in module; exposed via `get_analytics` response extension + morning-glance pacing line | chat + morning glance |
| 3. Leak detection | `leaks` + weekly leak-alert trigger/composer | chat (via analytics) + push |
| 4. Financial health | `health` + `get_financial_health` + monthly digest | chat + push |

Each slice is independently shippable and ends at the standard gates
(`tsc --noEmit`, `lint`, vitest).

## 7. Testing

- **Unit (pure functions):** table-driven — zero-division, thin history, first-month
  no-delta, normalization noise cases, FIFO-free but spike-floor cases, partial-month
  low-confidence.
- **Tools:** existing vitest harness against dev Neon (global migrate+seed, per-test
  truncate), following `get_report` test patterns.
- **Triggers/composers:** existing proactive patterns with injected `today`.
- **No snapshot tests for LLM prose** — deterministic blocks get snapshot-style
  assertions; prose is stubbed.

## 8. Out of scope

Multi-currency, export/CSV, web dashboard, ML anomaly detection, per-trigger toggles,
what-if simulation ("kalau aku nabung 500rb/bulan?"), and per-user advisor
personalization beyond existing preferences. What-if is the most likely future follow-up
— the module's pure-function shape is designed to admit it without rework.
