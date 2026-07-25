# MoneyBot — Card Billing & Payment Design

- **Date:** 2026-07-25
- **Source:** user feature request (credit-card billing cycle + atomic payment)
- **Status:** Design — ready for implementation planning
- **Builds on:** `docs/superpowers/specs/2026-06-14-moneybot-impl-design.md` (architecture, write-gate §5, scheduler §6)

## Purpose

Add credit-card billing-cycle semantics to `card` accounts: a monthly billing date that
defines statement periods, a due date, proactive prompting of amounts due, and a single
atomic `pay_card_bill` action. A new `card_statements` table records billing metadata; all
financial figures are **derived live from the transaction ledger** so that late-logged or
backdated charges update past statements automatically.

---

## 1. Settled behavioral decisions

1. **Payment model — partial payments, carried balance.** Statements carry unpaid balances
   forward across cycles. The card's live `balance` (already maintained incrementally,
   negative = owed) is the single source of truth for "total currently owed".
2. **Statement generation — auto, via the existing daily WIB sweep.** Folded into the
   `00:05 WIB` cron (+ a boot reconcile), mirroring `sweepBudgetRollover`. Self-heals after
   downtime.
3. **Pay trigger — conversational only.** The agent resolves the funding source + amount,
   then calls `pay_card_bill` once. No inline button (the from-account varies per payment).
4. **Allocation rule — FIFO.** A payment pays the oldest unpaid statement first, splitting
   across the next statement if it overpays.
5. **Live-derived figures — nothing frozen.** A statement's charges/balance/paid-ness are
   computed on read from transactions. Late-logging a charge into a past cycle updates that
   statement (it can even un-pay a statement you'd settled).

---

## 2. Data model

### 2.1 Migration `006_card_billing.sql`

Card account gains a billing day + a grace period:

```sql
ALTER TABLE accounts
  ADD COLUMN billing_day SMALLINT,                         -- 1–31, statement cut day; NULL for non-cards / cards w/o billing
  ADD COLUMN due_in_days  SMALLINT NOT NULL DEFAULT 15,
  ADD CONSTRAINT accounts_billing_day_range
    CHECK (billing_day IS NULL OR billing_day BETWEEN 1 AND 31);
```

`billing_day` is nullable so existing cards keep working (the sweep skips them). For a new
card, `create_account` requires/prompt for `billing_day`; `due_in_days` defaults to 15.

New `card_statements` table — billing metadata only; **all financial figures and the due
date are derived**, never stored:

```sql
CREATE TABLE card_statements (
  statement_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(user_id),
  account_id    UUID        NOT NULL REFERENCES accounts(account_id),
  cycle_start   DATE        NOT NULL,   -- day after the previous billing date (exclusive lower bound)
  cycle_end     DATE        NOT NULL,   -- the billing date (cut)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, cycle_end)        -- one statement per card per billing date
);
CREATE INDEX idx_card_statements_user_account ON card_statements(user_id, account_id, cycle_end);
```

`due_date` is derived as `cycle_end + account.due_in_days` at read time (so changing
`due_in_days` never leaves stale due dates). **No `statement_id` is added to `transactions`**
— a card payment is an ordinary `transfer` row (source→card); per-statement attribution is
done by FIFO at read time, not by a stored FK.

### 2.2 Domain types (`src/domain/entities.ts`)

```ts
// Account gains:
billingDay?: number;     // 1–31, only meaningful for cards
dueInDays: number;       // grace; default 15

// New:
export type CardStatementStatus = 'open' | 'partially_paid' | 'paid';

export interface CardStatement {
  statementId: string;
  userId: string;
  accountId: string;
  cycleStart: string;    // 'YYYY-MM-DD'
  cycleEnd: string;      // the billing date
  createdAt: string;
  updatedAt: string;
}

// CardStatement + all figures derived on read (not stored).
export interface CardStatementWithFigures extends CardStatement {
  openingBalance: number;     // card signed balance carried in
  newCharges: number;         // Σ expenses in (cycleStart, cycleEnd]
  paymentsInCycle: number;    // Σ transfers-in (source→card) in (cycleStart, cycleEnd]
  closingBalance: number;     // opening − newCharges + paymentsInCycle (signed)
  statementBalance: number;   // max(0, −closingBalance) — what was due at the cut
  dueDate: string;            // cycleEnd + account.dueInDays
  amountPaid: number;         // post-cut payments FIFO-allocated to this statement
  remainingDue: number;       // statementBalance − amountPaid
  status: CardStatementStatus;
  paidAt?: string;            // derived: timestamp of the payment that satisfied it, else undefined
  overdue: boolean;           // dueDate < today (WIB) AND status !== 'paid'
}
```

`CreateAccountInput` gains `billingDay?: number` and `dueInDays?: number`.

---

## 3. Statement lifecycle (daily sweep)

New `src/scheduler/card-statements.ts` exports `sweepCardStatements(repos, now)`, called from
the existing daily `BUDGET_ROLLOVER_CRON` (`00:05 WIB`) in `src/scheduler/cron.ts` and once on
boot in `src/index.ts` — exactly the `sweepBudgetRollover` pattern. Per-user errors are logged
and skipped so one failure never blocks the rest.

**Per active card with `billing_day` set:**

1. `lastCut` = most recent billing date `≤ today` (day-31 → last-day-of-month rule, reusing
   `lastDayOfMonth`/`nextFireDate`).
2. Find the latest already-frozen `cycle_end` for this card. For every cut date from the next
   cycle after that **up through `lastCut`**, insert one statement row (handles multi-month
   downtime catch-up). Skip cycles whose `cycle_end` predates the card's `created_at` (no
   statement for cycles before the card existed).
3. Each insert: `prevCut` = the billing date before this one; `cycle_start = prevCut`,
   `cycle_end = this cut`. `UNIQUE(account_id, cycle_end)` makes it idempotent. **No figures
   are computed or stored** — only the window.

The sweep creates rows for ended cycles regardless of activity; zero-activity cycles derive to
`statementBalance = 0` and are filtered out at read time (`status !== 'paid' && remainingDue > 0`).

---

## 4. Derived figures & FIFO allocation

Computed in TS by `ICardStatementRepository.getWithFigures(userId, accountId)` from the card's
statements + its `expense` and `transfer`-in rows (all `deleted_at IS NULL`). Data volume per
card is small, so derivation in TS is clearer than windowed SQL.

For statements sorted by `cycle_end` ascending:

- `openingBalance[i]` = `closingBalance[i−1]`, or the card's signed balance at `cycle_start[0]`
  for the first (`Σ signed txn effect WHERE date ≤ cycle_start[0]`).
- `newCharges[i]` = `Σ expenses WHERE cycle_start < date ≤ cycle_end`.
- `paymentsInCycle[i]` = `Σ transfers-in (type='transfer', to_account=card) WHERE cycle_start < date ≤ cycle_end`.
- `closingBalance[i]` = `openingBalance[i] − newCharges[i] + paymentsInCycle[i]` (equals the
  card's live balance at the cut).
- `statementBalance[i]` = `max(0, −closingBalance[i])`.
- `dueDate[i]` = `cycle_end[i] + account.due_in_days`.

**Post-cut payments** = transfers-in with `date > cycle_end` of the most recent cut. Allocate
FIFO (payment date ascending) against `statementBalance` of each statement in `cycle_end` order:
fill the earliest statement with `remainingDue > 0` before moving to the next; a single payment
may split across two statements.

- `amountPaid[i]` = FIFO share allocated to statement `i`.
- `remainingDue[i]` = `statementBalance[i] − amountPaid[i]`.
- `status[i]` = `paid` if `remainingDue ≤ 0`; `partially_paid` if `amountPaid > 0`; else `open`.
- `paidAt[i]` = if `status === 'paid'`, the timestamp of the payment that brought `remainingDue ≤ 0`; else undefined.
- `overdue[i]` = `dueDate < todayWIB() AND status !== 'paid'`.

**Consistency invariant:** `Σ remainingDue` over ended statements plus current-cycle (post-last-cut)
net charges equals `−card.balance` (total owed). `get_accounts` reports owed/available directly
from `−balance` / `creditLimit + balance`; the per-statement breakdown is the explanation.

A backdated expense into a past cycle raises that statement's `newCharges` → `closingBalance` →
`statementBalance`, so `remainingDue`/`status`/`paidAt` recompute (possibly un-paying it). Soft-
deleted expenses/payments are excluded by the `deleted_at IS NULL` filter, so deleting a payment
un-pays the statement. Always correct, nothing stale.

---

## 5. `pay_card_bill` tool (atomic payment)

Conversational only. A purposeful specialization of a transfer: the `to` account must be a
billed card, the amount is guarded, and the reply carries derived billing context. Because
paid-ness is derived, **there is no "mark as paid" step** — the live model reflects the payment
by definition, which is exactly the "one atomic call, no transfer-then-mark" guarantee requested.

**Parameters (Zod):**
- `cardAccountId: string` — card name or id (resolved via `findById`/`findByName`).
- `fromAccountId: string` — funding source (cash/bank), name or id.
- `amount?: number` — omitted ⇒ pay the **full outstanding** (`max(0, −card.balance)`).
  Provided ⇒ that exact amount (partial payment).

**`execute` (returns `WriteResult`, never throws):**
1. Resolve `cardAccountId`; reject → `error` if it is not a `card` or has no `billing_day`
   ("kartu belum diset billing date").
2. Resolve `fromAccountId`; → `ambiguous` (with account list) if not found, → `error` if same
   as the card.
3. `totalOwed = max(0, −card.balance)`. If `0` → `error` "tidak ada tagihan tertunggak."
   If `amount > totalOwed` → `error` "tidak bisa bayar lebih dari tagihan Rp X — pakai
   `create_transfer` untuk memindahkan dana bebas." (No silent capping.)
4. **Atomic DB txn** (`pool.connect()` → `BEGIN`/`COMMIT`, rollback on error — the
   `createTransfer` pattern): insert the `transfer` row (from→card) → debit source → credit
   card. That is the entire write; it reuses `transactions.createTransfer`.
5. After commit, derive the post-payment state and return it for the agent's reply.

**Returns** `WriteResult<{ transaction; card: { name; paidAmount; remainingOwed; availableLimit };
settledStatements: { cycleEnd }[]; nextDue?: { cycleEnd; dueDate; amount } }>`. The agent renders
the SP-style confirmation from this.

A pure `payCardBillCore(params, repos)` helper (mirroring `createExpenseCore`) holds the logic so
the tool `execute` and any future caller share it.

---

## 6. Read tools & account tools

- **`get_accounts` enrichment (cheap, no derivation):** for cards, also return `billingDay`,
  `dueInDays`, `availableLimit` (`creditLimit + balance`), `owed` (`max(0, −balance)`). All from
  existing columns — no statement query.
- **`get_card_statements({ cardAccountId?, includePaid? })`** — new read tool returning
  `CardStatementWithFigures[]` for on-demand "berapa tagihan kartu X?" queries.
- **`update_account({ accountId, billingDay?, dueInDays?, name?, isActive? })`** — new tool
  (and `IAccountRepository.update` SQL extended to patch `billing_day`/`due_in_days`) so cards
  created before this feature can be onboarded and a wrong billing day fixed.
- **`create_account`** for a card requires `billingDay` (returns `missing_fields` if absent);
  `dueInDays` defaults to 15.

---

## 7. Proactive prompting

Folded into the **existing morning glance** (no new cron). The morning-glance detector already
gathers balances + recurring bills + budgets; add a `cardStatements` slice via
`ICardStatementRepository.getDueWithin(userId, 7, now)` — statements with `status !== 'paid'`
and (`dueDate ≤ today+7` or `overdue`), sorted by `dueDate`.

Rendered as a **deterministic code block** (per the project's formatting rule — bullets/bars in
code, LLM owns prose only), shown only when something is due/overdue:

```
💳 Tagihan kartu:
• BCA CC — Rp 3.500.000, jatuh tempo 20 Jul (terlambat 2 hari)
• Mandiri CC — Rp 1.200.000, jatuh tempo 25 Jul
```

Overdue is the derived flag, so a missed due date surfaces automatically the next morning — no
separate nag cron for v1.

---

## 8. System-prompt additions (`src/agent/system-prompt.ts`)

- To pay a card / "bayar tagihan kartu", call `pay_card_bill` — **not** `create_transfer`.
  Resolve the from-account; default amount to full outstanding if the user says
  "lunas"/"bayar semua".
- Cards have a billing cycle (`billingDay`) and a due date; statements are generated
  automatically — query them with `get_card_statements`.
- When creating a card account, ask for `billingDay` if not given (`dueInDays` defaults to 15).
- Brief framing of `availableLimit` vs `owed` so the agent can explain card state.

---

## 9. Edge cases & error handling

- **`billing_day = NULL`** → sweep skips the card; `pay_card_bill` rejects; `get_card_statements`
  returns empty.
- **Backdated expense into a paid cycle** → `statementBalance` rises, status flips paid→partial,
  `paidAt` clears. Automatic.
- **Soft-deleted expense/payment** → excluded from derived sums; deleting a payment un-pays.
- **Overpayment** → `pay_card_bill` rejects; use `create_transfer` for arbitrary moves.
- **Nothing owed / `amount` omitted with zero balance** → `error` "tidak ada tagihan tertunggak."
- **Day-31 billing in short months** → reuses the existing last-day rule.
- **Card with no activity** → rows still created; derive to 0; filtered out at read.
- **Concurrency** — simultaneous `pay_card_bill` calls are separate txns; `balance = balance + δ`
  row updates are atomic, so no double-spend at the money level.

All write paths return the discriminated `WriteResult` and never throw across the boundary
(design §5), so the ReAct loop always continues.

---

## 10. Testing strategy (matches the project's existing approach)

- **Neon adapter (integration, real Postgres):**
  - `ensureEndedCycles` — correct rows, idempotent, day-31 last-day, skips pre-creation cycles,
    self-heals multi-month gaps.
  - `getWithFigures` — `openingBalance`/`newCharges`/`statementBalance`; FIFO allocation across
    a single statement and across multiple (split payment); `status`/`paidAt`; backdated expense
    updates figures; soft-delete exclusion; `overdue` derivation.
- **Tools (unit, mocked repos):** `pay_card_bill` returns `missing_fields`/`ambiguous`/`error`
  and **never throws**; rejects non-card / no-`billing_day` / overpayment; defaults amount to
  full outstanding; returns derived state on success. Plus `get_card_statements`, `get_accounts`
  enrichment, `update_account`, and `create_account` billing-day requirement.
- **Scheduler:** `sweepCardStatements` per-user error isolation (mirrors the budget-rollover test).
- **Morning glance:** `cardStatements` slice surfaces overdue + due-within-7; deterministic block
  renders correctly; empty when nothing due.
- **System-prompt test** updated for the new rules + tool list.
- Every task passes `npx tsc --noEmit` + `npm run lint` (NFR-02) + the relevant `npx vitest run`.

---

## 11. Files

**New:**
- `migrations/006_card_billing.sql`
- `src/adapters/neon/card-statement.repository.ts`
- `src/scheduler/card-statements.ts`
- `tests/adapters/card-statement.repository.test.ts`
- `tests/scheduler/card-statements.test.ts`
- `tests/agent/tools-card.test.ts` (or folded into `tools.test.ts`)

**Changed:**
- `src/domain/entities.ts` — Account fields, `CardStatement`/`CardStatementWithFigures`, status type.
- `src/repositories/interfaces.ts` — `CreateAccountInput`, `ICardStatementRepository`, `Repos`.
- `src/adapters/neon/account.repository.ts` — `create`/`update` for `billing_day`/`due_in_days`.
- `src/adapters/neon/mappers.ts` — `mapAccount`, `mapCardStatement`.
- `src/adapters/neon/repos.ts` — instantiate `cardStatements`.
- `src/agent/tools.ts` — `pay_card_bill`, `get_card_statements`, `update_account`; `get_accounts`
  enrichment; `create_account` billing-day requirement.
- `src/agent/system-prompt.ts` — new rules + tool list.
- `src/scheduler/cron.ts` — register `sweepCardStatements` in the daily cron.
- `src/index.ts` — boot reconcile for card statements.
- `src/proactive/triggers/morning-glance.ts` — `cardStatements` slice.
- `src/proactive/composers/morning-glance.ts` + `template.ts` — deterministic card block.
- `tests/agent/system-prompt.test.ts`, `tests/proactive/triggers/morning-glance.test.ts`,
  composer/template tests — updated.

---

## 12. Out of scope (v1) / fast-follows

- Interest, late fees, minimum-payment computation (the partial/carry-balance model supports
  them later without schema change).
- A separate overdue-nag cron (morning-glance surfacing is enough for v1).
- Optional explicit per-payment statement attribution (`statement_id` on `transactions`) for
  non-FIFO intent — FIFO covers the default.
- Transfers-out from a card as "charges" in derivation (v1 treats expenses as charges).
