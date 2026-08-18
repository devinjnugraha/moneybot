# Budget Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user delete a budget code ("hapus budget terea") with **stop-going-forward** semantics: the resolved month's row is hard-deleted AND `is_recurring` is cleared on all same-name rows so the daily `sweepBudgetRollover` can never resurrect it. Prior-month history rows survive (past analytics / financial-health keep their data). Tagged transactions are never touched.

**Architecture:** One new repository method `IBudgetCodeRepository.delete(userId, budgetCodeId, name)` → `NeonBudgetCodeRepository` runs a single transaction (`createTransfer` precedent): FIRST a case-insensitive `UPDATE … SET is_recurring = false` on all same-name rows (kills the roll-over chain; `rowCount > 0` → `stoppedRecurring`), THEN the row `DELETE`. A new `delete_budget_code` write tool resolves name-or-UUID exactly like `update_budget_code` and never throws. The system prompt gains a confirm-before-delete rule (FR-09d pattern). No migration — schema unchanged. Closes the "stop this recurring chain" non-goal reserved in `2026-07-01-budget-auto-rolling-design.md` §8.

**Tech Stack:** TypeScript (strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`), `pg` on Neon Postgres, Vercel AI SDK `tool()`, zod, Vitest (real-Postgres repo tests, mocked `Repos` elsewhere).

---

## Global Constraints

- **NFR-02:** `pg`/db drivers importable ONLY inside `src/adapters/neon/` (ESLint `no-restricted-imports`). Tools import only from `src/repositories/interfaces.ts`.
- **Write tools never throw** — return the discriminated `WriteResult` (`ok | missing_fields | ambiguous | error`, `src/domain/entities.ts`).
- **Every task passes:** `npx tsc --noEmit` AND `npm run lint` AND its `npx vitest run <files>`. Vitest strips types and can pass while tsc fails — always run tsc too. `tsconfig.json` includes `tests/**/*.ts`, so tests are type-checked.
- **`verbatimModuleSyntax`:** type-only imports use `import type`; relative imports carry the `.js` suffix.
- **WIB dates** via `wibMonth()`/`wibYear()`; default month/year = current WIB month.
- **Bahasa Indonesia** for all user-facing copy and tool descriptions; IDR without "Rp" (`300.000`).
- Repo tests run against real Neon, isolate via unique users (`seedUser()`/`uniqueChatId()`) — never truncate.

## File Structure

**Modify:**
- `src/repositories/interfaces.ts` — `IBudgetCodeRepository` gains `delete`.
- `src/adapters/neon/budget-code.repository.ts` — implement `delete` (tx: flip → delete).
- `src/agent/tools.ts` — new `delete_budget_code` after `update_budget_code`.
- `src/agent/system-prompt.ts` — two BUDGET bullets (confirm-before-delete; transactions survive).
- `tests/adapters/budget-code.repository.test.ts` — 5 `delete` cases.
- `tests/agent/tools.test.ts` — default mock gains `delete: vi.fn()`; new describe.
- `tests/agent/system-prompt.test.ts` — new describe.
- `docs/SRS.md` — FR-06d; tool-table rows T17 (back-fill `update_budget_code`) + T18; repo-contract refresh (also back-fills `rollRecurringIntoMonth`).

**Create:**
- `docs/superpowers/plans/2026-08-18-budget-removal.md` — this plan.

No changes to: `migrations/` (no schema change), `src/domain/entities.ts`, `repos.ts`, `mappers.ts`, scheduler, orchestrator (enrichment re-renders from `findByUserAndMonth` every turn, so a deleted budget vanishes automatically).

---

## Task 1: `IBudgetCodeRepository.delete` + Neon adapter (flip-then-delete, one transaction)

**Files:**
- Modify: `src/repositories/interfaces.ts` (after `update`)
- Modify: `src/adapters/neon/budget-code.repository.ts` (after `update`, before `rollRecurringIntoMonth`)
- Test: `tests/adapters/budget-code.repository.test.ts`

**Interface produced (Task 2 consumes):**

```ts
delete(userId: string, budgetCodeId: string, name: string): Promise<{ stoppedRecurring: boolean }>;
```

- [ ] **Step 1: Write the failing tests** — 5 cases appended to the repo suite: (1) deletes current row + flips prior same-name recurring row + `rollRecurringIntoMonth` returns 0; (2) guard: current row one-time, prior recurring → still flips, sweep returns 0; (3) pure one-time → `stoppedRecurring: false`, row gone; (4) other names / other users untouched; (5) case-insensitive chain: prior `terea` + current `Terea` → flip catches the lowercase twin, sweep returns 0.
- [ ] **Step 2: Run to see it fail** — `npx vitest run tests/adapters/budget-code.repository.test.ts` → FAIL (`budgets.delete is not a function`).
- [ ] **Step 3: Add the interface method** with doc comment (semantics above).
- [ ] **Step 4: Implement** — single transaction (`pool.connect()` + BEGIN/COMMIT/ROLLBACK + `release()`, `createTransfer` precedent):

```sql
-- flip FIRST (case-insensitive superset of the sweep's exact-name match)
UPDATE budget_codes SET is_recurring = false, updated_at = NOW()
 WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND is_recurring = true;
-- then delete the resolved row
DELETE FROM budget_codes WHERE user_id = $1 AND budget_code_id = $2;
```

Return `{ stoppedRecurring: (flip.rowCount ?? 0) > 0 }`. Defensive: `del.rowCount === 0` → throw (rolls back the flip — correct for not-found). Design notes: flip-first ordering is failure-safe (flip commits + delete fails → no resurrection ever, retry finishes it); the flip matches the current row too, so `stoppedRecurring` is true whenever the current row itself was bulanan; `LOWER()` is a deliberate superset because `UNIQUE (user_id, name, year, month)` is case-sensitive and the sweep matches names exactly.
- [ ] **Step 5: Gates** — tsc + lint + vitest run → PASS.
- [ ] **Step 6: Commit** — `feat: stop-and-delete budget code repository method`.

## Task 2: `delete_budget_code` tool

**Files:**
- Modify: `src/agent/tools.ts` (after `update_budget_code` — inside the `hasAccount` gate)
- Test: `tests/agent/tools.test.ts`

- [ ] **Step 1: Write the failing tests** — add `delete: vi.fn()` to default `mockRepos`; new describe: name resolve (case-insensitive) forwards `(userId, budgetCodeId, name)` and returns `{ name, stoppedRecurring }`; UUID resolve; unknown → `missing_fields` + `options.budgets` + delete NOT called; repo throw → exact `{ status: 'error', message: 'Gagal menghapus budget code. Coba lagi.' }`; `hasAccount=false` → tool withheld.
- [ ] **Step 2: Run to see it fail.**
- [ ] **Step 3: Implement** — resolution copied from `update_budget_code`: optional `month`/`year` (default WIB), `findByUserAndMonth`, UUID regex vs case-insensitive name, miss → `missing_fields` with `options: { budgets: [...] }`. Success → `{ status: 'ok', data: { ...target, stoppedRecurring } }` (full entity, consistent with create/update; repo-computed `stoppedRecurring` so the model phrases "tidak akan dibuat ulang bulan depan" correctly even in the one-time-current/recurring-chain edge case). Catch → `logEvent('error', ...)` + Bahasa error copy. Description notes: name-or-UUID, confirm first, monthly stops re-creating, transactions survive.
- [ ] **Step 4: Gates** — tsc + lint + full `tests/agent/tools.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat: delete_budget_code tool`.

## Task 3: System-prompt confirmation rule

**Files:**
- Modify: `src/agent/system-prompt.ts` (BUDGET section, after the preferences bullet)
- Test: `tests/agent/system-prompt.test.ts`

- [ ] **Step 1: Write the failing tests** — prompt contains `delete_budget_code`, matches `Ya/Tidak`, mentions transactions surviving (`TIDAK menghapus transaksi`).
- [ ] **Step 2: Run to see it fail.**
- [ ] **Step 3: Add two bullets** (FR-09d confirm-then-act pattern): confirm with `"Mau hapus budget 'Terea' — batas 300.000 (bulanan)? (Ya/Tidak)"` before calling `delete_budget_code`; deleting a budget does NOT delete its transactions.
- [ ] **Step 4: Gates + commit** — `feat: prompt confirmation rule for budget deletion`.

## Task 4: SRS updates

**Files:** `docs/SRS.md` only.

- [ ] **Step 1: Tool table (§8.3)** — append `T17 update_budget_code` (back-fill; `""` clears rules) and `T18 delete_budget_code` (stops the recurring roll-over chain, keeps transactions).
- [ ] **Step 2: Repo contract (§7)** — refresh `IBudgetCodeRepository`: add `delete` (+ doc comment) and back-fill `rollRecurringIntoMonth`.
- [ ] **Step 3: FR-06d · Remove Budget Code** (after FR-06c) — When/Then with the confirm step and `✅ Budget 'Terea' dihapus.` + `stoppedRecurring` line; documents the stop-going-forward semantics (hard-delete resolved row; case-insensitive flip of all same-name prior rows incl. the one-time-current edge; history survives with `is_recurring = false`; tagged transactions untouched, render as "Tanpa Budget").
- [ ] **Step 4: Gates + commit** — `docs: SRS FR-06d remove budget code, tool-table + repo-contract back-fill`.

## Task 5: Commit the plan doc

- [ ] **Step 1:** Create this file.
- [ ] **Step 2:** Commit — `docs: budget removal implementation plan`.

---

## Final verification (whole plan)

- [ ] `npx tsc --noEmit` → no errors.
- [ ] `npm run lint` → no errors.
- [ ] `npm test` → full suite PASS.
- [ ] Optional E2E via `.claude/skills/verify/SKILL.md` recipe (real model + dev Neon, unique `chatId`, throwaway `.verify-delete-budget.mts`): onboard → seed prior-month recurring row → "Buat budget terea 300000 bulanan" → "Hapus budget terea" (assert reply is a confirmation question AND the row still exists via `repos.budgets.findByUserAndMonth`) → "Ya" (assert "dihapus"; current-month empty AND prior row exists with `isRecurring === false`). Delete the script after.

## Spec-coverage map

- Repo method + flip-before-delete SQL + transaction → Task 1.
- `delete_budget_code` tool (name/UUID resolve, missing_fields+options, error copy, onboarding gate, success payload) → Task 2.
- Prompt confirm rule + transactions-survive caveat → Task 3.
- SRS FR-06d / T17-T18 / repo contract → Task 4.
- Plan doc → Task 5.
- tsc/lint/vitest + e2e → Final verification.

## Risks / resolved design points

- **Concurrent sweep race:** none — while the target row exists the sweep's `NOT EXISTS` guard skips the name; after commit no `is_recurring=true` prior row remains; mid-tx sweeps see the pre-commit snapshot.
- **Dangling refs are safe:** no FK from `transactions`/`recurring_payments` to `budget_codes`; `get_report` groups unknown ids under `__none__` ("Tanpa Budget"); `incrementSpent` on a deleted id is a 0-row no-op; `old_budget_id` is `ON DELETE SET NULL`.
- **mockRepos churn:** budget mocks are `as never`-cast, so the new interface method breaks nothing at compile time; only new tests provide the `delete` fn.
- **SRS staleness beyond scope:** the §8.3 tool table also lacks other tools (`get_analytics`, `get_financial_health`, …); only `update_budget_code` is back-filled here.
