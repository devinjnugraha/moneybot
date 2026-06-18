# MoneyBot — Slice 2 Design

- **Date:** 2026-06-18
- **Status:** Design — ready for implementation planning
- **Prior art:** SRS (`docs/SRS.md`), impl design (`docs/superpowers/specs/2026-06-14-moneybot-impl-design.md`), Slice 0+1 plan (`docs/superpowers/plans/2026-06-14-moneybot-slice-0-1.md`)

## Purpose

This document records the Slice 2 design decisions approved during brainstorming. It refines the implementation design's §9 (build sequence) into a concrete, actionable design for the next slice. Where this doc and the impl design differ, this doc is authoritative (it reflects the actual Slice 1 baseline).

**Slice 1 delivered (the departure point):** T01 `get_accounts`, T02 `create_account`, T06 `create_expense`; the full SP-01…SP-10 system prompt; grammY long-polling bot; user/account/transaction/session repos; session lifecycle; write gate.

---

## 1. Scope

### In scope (all from SRS §8.3 / impl design §9)

| Group | Tools | Repo work |
|---|---|---|
| Read CRUD | T03 `get_categories`, T04 `get_budget_codes`, T09 `get_transactions`, T13 `get_recurring_payments`, T16 `get_account_balance` | None new (use existing) |
| Write — transactions | T07 `create_income`, T08 `create_transfer` (atomic), T10 `update_transaction`, T11 `soft_delete_transaction` | New method on `ITransactionRepository`: `createTransfer` |
| Write — budgets | T05 `create_budget_code` | New `IBudgetCodeRepository` + neon impl |
| Write — recurring | T12 `create_recurring_payment`, T14 `deactivate_recurring_payment` | New `IRecurringPaymentRepository` + neon impl |
| Enhancement | FR-03d overspend warning in `create_expense` | Budget code auto-creation flow (FR-03c) |
| Wiring | FR-08 koreksi via `lastTransactionId` in T10/T11 | `buildTools` receives `lastTransactionId` |
| Repo assembly | Expand `Slice1Repos` → `Repos`, update `createRepos()` | Orchestrator accepts `Repos` |

### Out of scope (deferred to Slice 3+)

- T15 `get_report` (period/category/budget-code breakdowns) — Slice 3
- Scheduler (daily cron, 5-min defer sweep, inline-keyboard callbacks) — Slice 4
- Reconciling script (OQ-03) — Slice 5
- Observability / logging (NFR-07) — Slice 5
- NL date resolution helper — Slice 3

---

## 2. Architecture changes from Slice 1

### 2.1 Repos type expansion

`Slice1Repos` (4 repos) → `Repos` (6 repos):

```ts
export interface Repos {
  users: IUserRepository;
  accounts: IAccountRepository;
  transactions: ITransactionRepository;
  sessions: ISessionRepository;
  budgets: IBudgetCodeRepository;       // new
  recurrings: IRecurringPaymentRepository;  // new
}
```

`IBudgetCodeRepository` and `IRecurringPaymentRepository` are already fully defined in `src/repositories/interfaces.ts` — no interface changes needed.

### 2.2 New transaction repository method

Add to `ITransactionRepository`:

```ts
export interface CreateTransferInput {
  userId: string;
  amount: number;
  fromAccountId: string;
  toAccountId: string;
  description: string;
  date: string;          // 'YYYY-MM-DD' (WIB)
  notes?: string;
}

// Inside ITransactionRepository:
createTransfer(input: CreateTransferInput): Promise<Transaction>;
```

This is the **sole atomic method** — it internally manages `pool.connect()` → `BEGIN` → `INSERT` + `UPDATE`×2 → `COMMIT` (or `ROLLBACK` on any failure). The tool layer never touches `pool` directly; the ESLint NFR-02 rule remains satisfied.

### 2.3 `buildTools` signature

```ts
export interface BuildToolsArgs {
  userId: string;
  repos: Repos;
  hasAccount: boolean;
  lastTransactionId?: string;  // new — for FR-08 koreksi
}
```

`lastTransactionId` is extracted by the orchestrator from `result.toolResults` and persisted in the session (already done). It is now threaded into `buildTools` so T10/T11 can use it as the default correction target when the model omits `transactionId`.

### 2.4 Orchestrator

`handleMessage` accepts `Repos` instead of `Slice1Repos`. The `hasAccount` gate is unchanged: accounts > 0 → write tools available.

---

## 3. `create_transfer` — atomic contract (NFR-05)

The only NFR-bearing new feature in Slice 2.

**Repo method (`NeonTransactionRepository.createTransfer`):**

```
1. client = await pool.connect()
2. try {
3.   await client.query('BEGIN')
4.   const { rows } = await client.query(
5.     `INSERT INTO transactions (user_id, type, amount, description, account_id, to_account_id, date, notes)
6.      VALUES ($1, 'transfer', $2, $3, $4, $5, $6, $7) RETURNING *`,
7.     [userId, amount, description, fromAccountId, toAccountId, date, notes ?? null]
8.   )
9.   await client.query('UPDATE accounts SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2 AND account_id = $3',
10.    [amount, userId, fromAccountId])
11.  await client.query('UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2 AND account_id = $3',
12.    [amount, userId, toAccountId])
13.  await client.query('COMMIT')
14.  return mapTransaction(rows[0])
15. } catch (err) {
16.  await client.query('ROLLBACK')
17.  throw err
18. } finally {
19.  client.release()
20. }
```

Any failure (INSERT or either UPDATE) → ROLLBACK. No compensating writes needed. The tool layer catches the throw and returns `{ status: 'error', message }` — the write gate keeps the ReAct loop alive.

**Tool (`create_transfer`):**

1. Zod validates `{ fromAccountId, toAccountId, amount, description, date?, notes? }`.
2. `execute` resolves both account IDs (by name or UUID) via the existing resolution pattern (`findById` then `findByName`). If either is unresolved → `ambiguous`.
3. Validates `fromAccountId !== toAccountId`. If equal → `error`.
4. Calls `repos.transactions.createTransfer(input)`.
5. Returns `TransactionResult` on `ok`.

The tool is transfer-agnostic — no special CC payment logic. FR-07a ("Bayar CC BCA 500000 dari Mandiri") is purely the model's direction: `fromAccountId=mandiri`, `toAccountId=bca-cc`. SP-06 ("Transfer tidak pernah dikategorikan…") is already in the prompt; the tool omits `categoryId`.

---

## 4. Budget codes — auto-create + overspend (FR-03c, FR-03d)

### 4.1 FR-03c — unknown budget code on `create_expense`

When `create_expense` receives a non-UUID `budgetCodeId` (the model passed a name like "jajan"):

1. Try `repos.budgets.findByName(userId, budgetCodeId, year, month)` (WIB month/year).
2. If found → use its `budgetCodeId` for the expense.
3. If not found → return `{ status: 'missing_fields', missing: ['budgetCodeId'], options: { monthlyBudget: null } }`.

SP-03 prompts the model to ask for all missing fields: "Anggaran jajan belum ada. Mau kasih limit berapa per bulan?" The user feeds back a number. The model calls T05 `create_budget_code` then re-invokes `create_expense` — autonomously within one `generateText` call per SP-08.

Budget code names are scoped per `userId + year + month` in the DB (UNIQUE constraint). "jajan" in June ≠ "jajan" in July.

### 4.2 FR-03d — overspend check (post-recording)

After `create_expense` successfully records the transaction and decrements balance:

1. If `budgetCodeId` is set: call `repos.budgets.incrementSpent(userId, budgetCodeId, amount)`.
2. Fetch the updated budget row: `findByUserAndMonth(userId, year, month)` filtered to the specific code.
3. Return `{ status: 'ok', data: { transaction, budget: { spent, limit: monthlyBudget, exceeded: spent > monthlyBudget } } }`.

The `TransactionResult` type already has the optional `budget` field — no type changes needed. SP-04 (confirmation) and SP-05 (overspend warning) are already in the prompt; the model renders the warning from the structured result.

---

## 5. Tool catalog

### 5.1 Read tools (always available post-onboarding)

All five are thin: validate params → call repo → return data. No write gate. No `WriteResult` shape — read tools return plain data (or `[]` / `null` for empty).

| Tool | Parameters | Returns | Repo call |
|---|---|---|---|
| T03 `get_categories` | `{}` | `Category[]` from `CATEGORIES` constant | None (static) |
| T04 `get_budget_codes` | `{ month?: number, year?: number }` defaulting to current WIB month/year | `BudgetCode[]` | `budgets.findByUserAndMonth` |
| T09 `get_transactions` | `{ fromDate, toDate, accountId?, categoryId?, type?, limit? }` | `Transaction[]` | `findByDateRange` + in-memory filter for optional fields |
| T13 `get_recurring_payments` | `{}` | `RecurringPayment[]` | `recurrings.findAllByUserId` (active only) |
| T16 `get_account_balance` | `{ accountId? }` | `{ accountId, name, balance }[]` (all if omitted) | `accounts.findAllByUserId` (filter in-memory if `accountId`) |

### 5.2 Write tools (gated behind `hasAccount`)

All return `WriteResult` (discriminated union). All never throw. All follow the established `findById` → `findByName` → `ambiguous` account resolution pattern.

| Tool | Zod params | Returns | Key behavior |
|---|---|---|---|
| T07 `create_income` | `{ description, amount, accountId, categoryId, budgetCodeId?, date? }` | `TransactionResult` | `type: 'income'`, balance delta `+amount`. No budget overspend check. |
| T08 `create_transfer` | `{ fromAccountId, toAccountId, amount, description, date?, notes? }` | `TransactionResult` | Calls `repos.transactions.createTransfer()`. Validates `fromId !== toId`. No `categoryId`. |
| T10 `update_transaction` | `{ transactionId?, amount?, description?, categoryId?, accountId?, notes? }` | `TransactionResult` | Resolves `transactionId` via FR-08 flow (§6). Updates only supplied fields (COALESCE pattern). |
| T11 `soft_delete_transaction` | `{ transactionId? }` | `{ status, data?: { transactionId }, message? }` | Resolves via FR-08. Reverses account balance delta (expense→+amount, income→-amount). Checks `deletedAt` already set → error. |
| T05 `create_budget_code` | `{ name, monthlyBudget, month?, year? }` | `WriteResult<BudgetCode>` | `month`/`year` default to current WIB. |
| T12 `create_recurring_payment` | `{ name, amount, accountId, categoryId, dayOfMonth, budgetCodeId? }` | `WriteResult<RecurringPayment>` | Computes `nextFireAt`: next occurrence of `dayOfMonth` on or after today (WIB). Uses `lastDayOfMonth` helper for short-month overflow. |
| T14 `deactivate_recurring_payment` | `{ recurringId }` | `WriteResult<RecurringPayment>` | Sets `isActive = false` via `repos.recurrings.deactivate`. |

**T09 filtering note:** `ITransactionRepository` has `findByDateRange` and `findByAccountAndDateRange`. The tool picks the query with the most WHERE clauses that still uses indexed columns, then filters `categoryId` / `type` in-memory. No new repo query methods needed.

**T11 balance reversal:** Reads the deleted transaction's `type` + `amount`, then `updateBalance(userId, accountId, -delta)` where delta = `amount` for expense (inversion), `-amount` for income. Two independent DB calls — no atomic block needed. A stale delete-without-reversal is a rare edge that the Slice 5 reconcile script catches.

---

## 6. FR-08 — koreksi (cross-cutting for T10/T11)

`update_transaction` and `soft_delete_transaction` share a `transactionId` resolution step:

1. If the model provides `transactionId` → use it (user explicitly named it).
2. If omitted → use `lastTransactionId` (passed to `buildTools` by the orchestrator, sourced from the session row).
3. If neither resolves → return `{ status: 'missing_fields', missing: ['transactionId'] }`.

SP-07 is already in the prompt instructing the model to ask "Transaksi mana yang mau dikoreksi?" when no `lastTransactionId` is available. No new prompt work needed.

---

## 7. System prompt additions

SP-01…SP-10 are already present in `src/agent/system-prompt.ts`. Slice 2 adds minimal guidance:

1. **Transfer path:** After SP-06, add: "Transfer memindahkan saldo antar dua akun. Pastikan nama kedua akun sudah jelas. Kalau user bilang 'transfer X dari A ke B', fromAccountId = A, toAccountId = B."
2. **Recurring path:** Add: "Untuk pembayaran rutin bulanan, tawarkan untuk menyimpannya sebagai recurring supaya diingatkan tiap bulan. Gunakan create_recurring_payment setelah transaksi berhasil dicatat."
3. **Income path:** Add: "Pemasukan menambah saldo akun. Format sama seperti pengeluaran: deskripsi, jumlah, akun."

That's it — no structural prompt rewrite. The taxonomy is already generated from `CATEGORIES`.

---

## 8. Testing strategy

Same layers as Slice 1, expanded:

| Layer | Target | Approach |
|---|---|---|
| **BudgetCode repo** | `tests/adapters/budget-code.repository.test.ts` | Integration — real Neon DB. Assert `findByUserAndMonth`, `findByName` scoping, `create`, `incrementSpent`, UNIQUE constraint on `(user_id, name, year, month)`. ~5 tests. |
| **RecurringPayment repo** | `tests/adapters/recurring-payment.repository.test.ts` | Integration — real Neon DB. Assert `findAllByUserId`, `findByDayOfMonth`, `create` with `nextFireAt`, `deactivate`. ~5 tests. |
| **createTransfer method** | `tests/adapters/transaction.repository.test.ts` (existing, add tests) | Integration — real Neon DB. Assert atomicity: successful transfer creates transaction + moves balances. Assert ROLLBACK: if `fromAccountId` doesn't exist, both balances untouched. ~3 new tests. |
| **Tools** | `tests/agent/tools.test.ts` (existing, expand) | Unit — mocked repos. One describe block per new tool. Assert write gate: all write tools return `missing_fields` / `ambiguous` / `ok` or `error`; never throw. Assert T03 returns static categories. ~40 new tests across all 10 tools. |
| **Orchestrator** | `tests/agent/orchestrator.test.ts` (existing, expand) | Unit — fake runner. Assert `Repos` shape works. Assert `lastTransactionId` threads into `buildTools`. ~2 new tests. |
| **System prompt** | Manual smoke | Verify expanded prompt doesn't break existing behavior. |

---

## 9. Implementation sequence

Dependency ordering — tasks build on each other:

1. **BudgetCode repository** — new, no deps beyond pool + mappers
2. **RecurringPayment repository** — new, same
3. **`Repos` type + `createRepos()`** — add both repos
4. **`createTransfer` on transaction repository** — new method, atomic block
5. **Orchestrator + `buildTools` wiring** — switch `Slice1Repos` → `Repos`, add `lastTransactionId`
6. **Read tools** — T03 (static), T04, T09, T13, T16
7. **`create_expense` enhancement** — FR-03c budget name resolution + FR-03d overspend check
8. **Write tools** — T07 `create_income`, T08 `create_transfer`, T10 `update_transaction`, T11 `soft_delete_transaction`
9. **Budget + recurring write tools** — T05 `create_budget_code`, T12 `create_recurring_payment`, T14 `deactivate_recurring_payment`
10. **System prompt additions** — transfer + recurring + income guidance
11. **Full suite verification** — `npx tsc --noEmit`, `npm run lint`, `npm test`

Each task follows TDD: write failing test → confirm it fails for the right reason → implement → pass → tsc + lint → commit.

---

## 10. Spec self-review

- **Placeholders:** None. All tool parameters, return types, and repo methods are specified.
- **Internal consistency:** The `Repos` type unifies all six repos. The `createTransfer` method lives on the existing `ITransactionRepository` to keep the atomic block internal. Tools use the same resolution patterns as Slice 1 (`findById` then `findByName`).
- **Scope check:** Self-contained. Tools T01–T14 + T16 are all accounted for. T15 (`get_report`) is explicitly deferred. Scheduler (Slice 4) and hardening (Slice 5) are out. No scope creep.
- **Ambiguity:** The budget code name resolution (by name → auto-create prompt) is explicit about the per-month scoping. The transfer tool's CC-payment handling is explicit: no special logic — the model decides direction.
