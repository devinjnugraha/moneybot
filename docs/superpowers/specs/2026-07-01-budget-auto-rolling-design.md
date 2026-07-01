# MoneyBot — Budget Auto-Rolling (Recurring vs One-Time)

- **Date:** 2026-07-01
- **Source spec:** `docs/SRS.md` (resolves open question **OQ-01**: "Should budget codes auto-carry over to next month…?")
- **Status:** Design — ready for implementation planning

## Purpose

Today a `budget_code` exists only for the calendar month it was created in (`UNIQUE(user_id, name, year, month)`). When a new month begins, the user has no budgets and must set them up again. This feature makes budget creation a **recurring-vs-one-time decision resolved at creation time**: a monthly budget automatically rolls into each new month (same name + allocation, spent reset) so the model always operates against the current month's budget IDs; a one-time budget lives in its month and never propagates.

This design refines OQ-01's recommended "opt-in carryover" into an **at-creation intent flag** rather than a copy command.

---

## 1. Requirements

1. **At-creation decision.** When a budget code is created (`create_budget_code`, including the implicit-create path of FR-03c), the model **must ask** the user whether it is a monthly (recurring) budget or one-time. The intent is persisted on the row.
2. **Recurring rolls on the 1st.** A recurring budget is copied into each new month: same `name`, same `monthly_budget` (taken from the most recent prior instance), `spent` reset to 0, `is_recurring = true`. The copy links back to its predecessor.
3. **One-time is month-local.** A one-time budget never rolls; it is invisible outside its month because all reads are month-scoped.
4. **Enrichment stays current-month.** Prompt enrichment injects **only the current month's** budgets (with their fresh IDs), never past months, so the model writes expenses against correct budget IDs.
5. **Idempotent + self-healing.** Roll-over may run any number of times for a month and must not duplicate; it must catch up after multi-month downtime.
6. **Rules survive roll-over.** Because recurring budgets get a new id each month, budget references in stored preferences must use the user-defined budget **name** (stable, what the user sees), never the internal `budgetCodeId`. A system-prompt rule enforces this for all future preferences. (Existing stale-id preferences are re-stated by the user; no automated re-targeting.)

---

## 2. Resolved decisions

| Concern | Decision | Rationale |
|---|---|---|
| **Intent model** | A single `is_recurring` flag on each `budget_codes` row (no separate template table) | Matches the user's "monthly vs one-time at creation" framing; minimal schema. A dedicated recurring-budget entity (à la `recurring_payments`) is YAGNI until pause/stop/global-edit is needed. |
| **Lineage** | `old_budget_id` back-pointer to the **immediate predecessor** (May ← June ← July) | Traceability + a seam for future "stop this recurring chain". Self-FK `ON DELETE SET NULL` keeps integrity without breaking deletes. |
| **Roll-over trigger** | **Daily idempotent cron** at 00:05 WIB (`BUDGET_ROLLOVER_CRON`), plus a one-shot reconcile on boot | Chosen by the user. Daily + idempotent = naturally fires on the 1st and self-heals after downtime; boot reconcile closes the "restarted on the 1st after 00:05" gap (node-cron does not retro-fire missed runs). |
| **`isRecurring` param** | **Required** in `create_budget_code` | Guarantees the intent is always recorded (never silently defaulted to one-time). The system prompt drives the actual asking. |
| **Allocation source** | Most recent prior instance of the same name | Latest edit propagates forward; survives gaps (rolls from the newest available month). |
| **Enrichment scope** | Unchanged fetch (`findByUserAndMonth(current)`); add a `(bulanan)` marker | Requirement #4 is already met by the existing fetch; no roll-over call in the message path (cron owns it). |
| **Budget refs in preferences** | Prompt rule: persist the user-defined budget **name** only, never `budgetCodeId`. No re-targeting code. | Ids roll monthly; the name is the stable identity and what the user actually sees/defines. Existing stale-id preferences are re-stated by the user. |

---

## 3. Data model

New migration `migrations/005_budget_recurring.sql`:

```sql
ALTER TABLE budget_codes
  ADD COLUMN is_recurring  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN old_budget_id UUID REFERENCES budget_codes(budget_code_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_budget_recurring_prior
  ON budget_codes(user_id, name) WHERE is_recurring = true;
```

- Existing rows: `is_recurring = false` (one-time), `old_budget_id = NULL`. Safe default; no data backfill.
- The partial index speeds the roll-over "most recent prior recurring instance per name" lookup as history grows.
- `UNIQUE(user_id, name, year, month)` already present → roll-over idempotency is enforced at the DB.

**Entity/mapper changes:**
- `BudgetCode` gains `isRecurring: boolean` and `oldBudgetId?: string`.
- `mapBudgetCode` reads `is_recurring` and `old_budget_id`.
- `CreateBudgetCodeInput` gains `isRecurring?: boolean` and `oldBudgetId?: string` (only roll-over sets `oldBudgetId`; the tool never does).

---

## 4. Roll-over logic

### 4.1 Repository method

`IBudgetCodeRepository.rollRecurringIntoMonth(userId, year, month): Promise<number>` — returns the count of rows created.

Implemented as one statement (params bind in signature order: `$1 = userId`, `$2 = year`, `$3 = month`):

```sql
INSERT INTO budget_codes (user_id, name, monthly_budget, month, year, is_recurring, spent, old_budget_id)
SELECT user_id, name, monthly_budget, $3, $2, true, 0, budget_code_id
FROM (
  SELECT DISTINCT ON (name) name, monthly_budget, budget_code_id, user_id
  FROM budget_codes
  WHERE user_id = $1
    AND is_recurring = true
    AND (year, month) < ($2, $3)              -- strictly prior months
  ORDER BY name, year DESC, month DESC        -- most recent prior instance per name
) AS src
WHERE NOT EXISTS (
  SELECT 1 FROM budget_codes c
  WHERE c.user_id = $1 AND c.name = src.name AND c.year = $2 AND c.month = $3
);
```

Properties:
- **Idempotent:** the `NOT EXISTS` + `UNIQUE` constraint make a second run for the same month a no-op (0 rows).
- **Self-healing:** `(year, month) < target` + `ORDER BY … DESC` picks the newest available prior instance, so a multi-month gap rolls from the latest month present.
- **One-time ignored:** `is_recurring = true` filter.
- **Allocation:** copied from the most recent prior instance (edits propagate forward).
- **Lineage:** `old_budget_id` = the source row's `budget_code_id`.

### 4.2 Sweep

New `src/scheduler/budget-rollover.ts` (mirrors `src/scheduler/defer-sweep.ts`):

```ts
export async function sweepBudgetRollover(repos: Repos, now: Date = new Date()): Promise<void>
```

Iterates `repos.users.findAll()`; for each user calls `repos.budgets.rollRecurringIntoMonth(userId, wibYear(now), wibMonth(now))`; logs the per-user created count. Never throws the loop — per-user errors are logged and skipped.

---

## 5. Trigger — cron + boot reconcile

- **Config:** add `BUDGET_ROLLOVER_CRON: z.string().default('5 0 * * *')` to `src/config/index.ts` (00:05 WIB daily), consistent with the `PROACTIVE_*_CRON` vars.
- **Cron:** in `startCronJobs` (`src/scheduler/cron.ts`), register `cron.schedule(config.BUDGET_ROLLOVER_CRON, () => sweepBudgetRollover(repos).catch(...), { timezone: 'Asia/Jakarta' })`. Add the schedule string to the registered-schedules log line.
- **Boot reconcile:** in `src/index.ts`, after `migrate()` completes (and before/around `startCronJobs`), call `sweepBudgetRollover(repos).catch(...)` once so a restart on the 1st reconciles immediately rather than waiting for the next 00:05.

**Known limitation (documented, accepted):** between 00:00 and the first roll trigger (cron at 00:05, or boot) on the 1st, a user message could find no current-month recurring budget yet. Impact is minor and transient (the model would treat the name as unregistered and offer to create it); the next trigger reconciles. No roll-over call is added to the message path — cron/boot own it, per the chosen design.

---

## 6. Tool, system prompt, enrichment

### 6.1 `create_budget_code` tool (`src/agent/tools.ts`)

- Add a **required** parameter `isRecurring: z.boolean()`.
- Persist it via `repos.budgets.create({ …, isRecurring })` (the repo `create` writes `is_recurring`; `oldBudgetId` is left unset for manual creates).
- Description updated: note that `isRecurring=true` means the budget auto-rolls into each new month on the 1st.

### 6.2 System prompt (`src/agent/system-prompt.ts`)

Add a BUDGET rule (Bahasa Indonesia):

> Saat membuat budget code (`create_budget_code`), **WAJIB tanyakan dulu**: ini budget **bulanan** (recurring — dibuat ulang otomatis tiap tanggal 1 dengan alokasi yang sama, spent reset) atau **sekali untuk bulan ini**? Teruskan `isRecurring=true` untuk bulanan, `false` untuk sekali ini. Jangan menebak — tanya kalau user tidak menyebutkan. (Berlaku juga saat membuat budget baru karena nama belum terdaftar di pesan pengeluaran.)

Update the `DATA REFERENSI` bullet for budgets to note that recurring budgets are marked `(bulanan)` in the injected block.

Add a PREFERENCE rule (Bahasa Indonesia):

> Saat menyimpan preferensi yang menyebut budget (`remember_preference`), **SELALU** simpan **nama** budget — nama yang user definisikan dan lihat. **Jangan pernah** simpan `budgetCodeId`: id itu internal, jarang dilihat user, dan berganti tiap bulan untuk budget bulanan. Resolve nama→id pakai blok BUDGET CODE BULAN INI saat menulis transaksi.

### 6.3 Prompt enrichment (`enrichSystemPrompt`)

- The fetch in `orchestrator.ts` stays `findByUserAndMonth(wibYear(), wibMonth())` — already current-month-only (requirement #4).
- In the rendered `BUDGET CODE BULAN INI` block, append ` (bulanan)` to recurring budgets:
  `- <id> <name> — batas <IDR>` → `- <id> <name> — batas <IDR> (bulanan)` when `isRecurring`.

---

## 7. Test plan

- **Migration / mapper** (`tests/adapters/budget-code.repository.test.ts`): existing tests still pass; add: `is_recurring` defaults to `false`; `create` with `isRecurring: true` persists it; `oldBudgetId` is `undefined` for a fresh create.
- **`rollRecurringIntoMonth`** (same file):
  - creates a current-month copy from a prior-month recurring budget (name + allocation copied, `spent === 0`, `isRecurring === true`, `oldBudgetId ===` source id);
  - idempotent — second call returns 0 and creates nothing;
  - ignores one-time prior budgets;
  - copies the **latest** allocation when multiple prior months exist (edit propagates);
  - leaves an already-present current-month budget untouched;
  - resets `spent` to 0 even if the source had non-zero spent.
- **System prompt** (`tests/agent/system-prompt.test.ts`): assert the new BUDGET rule text is present; assert the PREFERENCE-by-name rule ("**nama** budget … **Jangan pernah** `budgetCodeId`") is present; assert `enrichSystemPrompt` marks recurring budgets with `(bulanan)` and omits the marker for one-time.
- **Tool** (`tests/agent/tools.test.ts`): update `create_budget_code` cases to pass `isRecurring`; add a case asserting `isRecurring` is persisted and that the schema requires it.
- **Sweep** (`tests/scheduler/budget-rollover.test.ts`, new): with a seeded prior-month recurring budget and a mock/real `Repos`, assert the current month gains one rolled copy with the correct `oldBudgetId`; second sweep is a no-op. (Thin function; primary correctness lives in the repo test.)

---

## 8. Non-goals (YAGNI)

- **Pausing/stopping a recurring budget.** Deleting a single month does not stop future roll-over (it re-copies from the next prior month). The `old_budget_id` chain is the seam a future "stop this recurring chain" feature would build on.
- **Global "edit once for all months".** Edits apply per-month; the roll-over copies the latest forward.
- **Pointing to the original/root budget.** `old_budget_id` links to the *immediate* predecessor (a linked list), not the root. A recursive CTE or a future `chain_id` can group a chain if needed.
- **Automated stale-id re-targeting / `IBudgetCodeRepository.findById`.** The agent is instructed to store budget names (§6.2); existing stale-id preferences are re-stated by the user. No write-path id re-targeting is added.

---

## 9. Verification

Every task must pass before claiming done: `npx tsc --noEmit` AND `npm run lint` AND `npx vitest run` for the relevant files. Apply the migration with `npm run migrate`. Vitest strips types, so a tsc failure can hide behind a green vitest — always run tsc too.
