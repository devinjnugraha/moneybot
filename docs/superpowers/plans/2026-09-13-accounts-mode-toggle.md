# Accounts-Mode Toggle (Simple Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users opt out of per-account tracking (FR-11). In simple mode, transactions are recorded without any account mention and land in a single per-user "Dompet" container; balance queries return one aggregate number. Switchable both ways at any time; existing users are untouched (default `accounts_enabled = true`).

**Core design decision (user-approved 2026-09-13):** *virtual consolidation* — toggling off moves no money and writes no transfers. Legacy accounts are frozen in place; the "one balance" is a read-time aggregate. Toggling back on requires emptying only what accrued in Dompet during simple mode (hard gate in the tool). This keeps the switch reversible, side-effect-free, and bug-surface minimal. New users are asked which mode they want at onboarding (not defaulted).

**Architecture:** Migration adds `users.accounts_enabled` + `accounts.is_default` (partial unique). `IAccountRepository.ensureDefaultAccount`/`findDefault` (get-or-create / gate-read) and `IUserRepository.setAccountsEnabled` are the only new seams. Write tools make `accountId` *optional* and route at execute time: explicit name/id → resolve as today; omitted + simple mode → Dompet; omitted + accounts mode → `missing_fields`. A new `set_accounts_mode` tool owns the toggle + gate and is registered *before* the `hasAccount` gate (onboarding needs it). `get_account_balance` aggregates in simple mode. The system prompt gains a MODE SEDERHANA block (enrichment, appended last so it overrides the account rules) + onboarding mode choice + a MODE AKUN toggle rule. Morning-glance aggregates balances for simple users.

**Tech Stack:** TypeScript (strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`), `pg` on Neon Postgres, Vercel AI SDK `tool()`, zod, Vitest (real-Postgres repo tests, mocked `Repos` elsewhere).

---

## Global Constraints

- **NFR-02:** `pg`/db drivers importable ONLY inside `src/adapters/neon/` (ESLint `no-restricted-imports`). Tools import only from `src/repositories/interfaces.ts`.
- **Write tools never throw** — return the discriminated `WriteResult` (`ok | missing_fields | ambiguous | error`).
- **Every task passes:** `npx tsc --noEmit` AND `npm run lint` AND its `npx vitest run <files>`.
- **`verbatimModuleSyntax`:** type-only imports use `import type`; relative imports carry the `.js` suffix.
- **Bahasa Indonesia** for all user-facing copy and tool descriptions; IDR via `formatIDR` (no "Rp").
- Repo tests run against real Neon, isolate via unique users — never truncate.
- **No money movement on toggle** — the toggle writes only the flag + Dompet row (reactivation allowed). Never a transfer.

## File Structure

**Create:**
- `migrations/008_accounts_mode.sql` — users + accounts columns, partial unique index.
- This plan.

**Modify:**
- `src/domain/entities.ts` — `User.accountsEnabled`, `Account.isDefault`.
- `src/adapters/neon/mappers.ts` — map both.
- `src/repositories/interfaces.ts` — `setAccountsEnabled`, `ensureDefaultAccount`, `findDefault`.
- `src/adapters/neon/user.repository.ts`, `account.repository.ts` — implement.
- `src/agent/tools.ts` — optional `accountId` routing helper; `set_accounts_mode`; aggregate `get_account_balance`; simple-mode-aware insight `balanceAfter`.
- `src/agent/system-prompt.ts` — base: write-gate note, USER BARU mode choice, MODE AKUN section; enrichment: `accountsEnabled` + MODE SEDERHANA block.
- `src/agent/orchestrator.ts` — pass `user.accountsEnabled` into enrichment.
- `src/proactive/triggers/morning-glance.ts` — aggregate balances when simple mode.
- `tests/adapters/user.repository.test.ts`, `tests/adapters/account.repository.test.ts`, `tests/agent/tools.test.ts`, `tests/agent/system-prompt.test.ts`, `tests/proactive/triggers/morning-glance.test.ts`.
- `docs/SRS.md` — FR-11 (done alongside this plan), §6, §7, §8.2/8.3, FR-01, FR-03b.
- `CLAUDE.md` — active-work pointer at ship time.

---

## Task 1: Migration 008

- [ ] `migrations/008_accounts_mode.sql`:

```sql
ALTER TABLE users  ADD COLUMN accounts_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE accounts ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX idx_accounts_default ON accounts(user_id) WHERE is_default;
```

`NOT NULL DEFAULT` backfills every existing row to accounts mode (the "old users unaffected" requirement). Idempotent file applied by `npm run migrate`.

## Task 2: Domain + repositories

- [ ] `entities.ts`: `User.accountsEnabled: boolean`; `Account.isDefault: boolean`.
- [ ] `mappers.ts`: `accountsEnabled: bool(r, 'accounts_enabled')`, `isDefault: bool(r, 'is_default')`.
- [ ] `interfaces.ts` + adapters:

```ts
// IUserRepository
setAccountsEnabled(userId: string, enabled: boolean): Promise<void>;

// IAccountRepository
ensureDefaultAccount(userId: string): Promise<Account>;   // INSERT … ON CONFLICT (user_id) WHERE is_default DO UPDATE SET is_active = true RETURNING *
findDefault(userId: string): Promise<Account | null>;     // WHERE is_default (ignores is_active — gate reads a deactivated Dompet)
```

- [ ] Adapter tests (real Neon, unique users): ensure is idempotent (same accountId twice), reactivates an inactive default, findDefault null → after ensure → row, per-user uniqueness (two users, two Dompets).

## Task 3: Tools layer

- [ ] Shared `resolveAccountParam(userId, repos, accountId?)`: explicit → `findById`→`findByName`→`ambiguous` (unchanged); omitted → read flag fresh (`users.findById`) → simple: `findDefault ?? ensureDefaultAccount`; accounts: `missing_fields ['accountId']`. Fresh read keeps a mid-turn toggle correct.
- [ ] `create_expense`, `create_income`, `create_recurring_payment`: `accountId` optional with updated `.describe()`; resolve via helper.
- [ ] `set_accounts_mode(useAccounts)` — registered BEFORE the `hasAccount` gate (onboarding path). Off: `ensureDefaultAccount` + flag. On: gate `|Dompet.balance| ≥ 0.005` → `error` with transfer-out guidance; else flag + deactivate Dompet via `accounts.update(isActive: false)`. Never throws.
- [ ] `get_account_balance`: no `accountId` + simple mode → `{ saldo: Σ non-card, utangKartu?: Σ negative cards }`; else unchanged (explicit accountId still returns that account).
- [ ] `computeInsightContext`: simple mode → `balanceAfter` = aggregate liquid sum (a lone Dompet balance would cry "saldo menipis" for a legacy switcher with frozen millions).

## Task 4: System prompt + orchestrator

- [ ] Base prompt: write-gate line notes accountId auto-Dompet in simple mode; USER BARU asks the mode choice (never guesses); new MODE AKUN section (confirm-before-toggle, both directions' effects).
- [ ] `EnrichmentData.accountsEnabled?: boolean`; when `false`, append MODE SEDERHANA block LAST (overrides the AKUN USER block above it): never ask/mention accounts when logging; omit account line in confirmations; aggregated saldo; honor explicit account names; re-enable prep flow (transfer out of Dompet, then toggle).
- [ ] `orchestrator.ts`: `enrichSystemPrompt(args.system, { …, accountsEnabled: user.accountsEnabled })`.

## Task 5: Proactive layer

- [ ] `morning-glance.ts`: when `user.accountsEnabled === false`, `balances = [{ name: 'Dompet', type: 'cash', balance: Σ non-card }]` instead of per-account lines. Everything else (budgets, bills, cards) unchanged — card dues still show for legacy switchers.

## Task 6: Tests + verification

- [ ] Tool tests: routing matrix (omitted/simple→Dompet, omitted/accounts→missing_fields, explicit still resolves/ambiguous), set_accounts_mode both directions + gate + onboarding availability (hasAccount=false), aggregate balance, insight aggregate.
- [ ] Prompt tests: MODE SEDERHANA present iff `accountsEnabled === false`; base prompt mentions set_accounts_mode + onboarding choice.
- [ ] Morning-glance test: simple-mode aggregate.
- [ ] Gates: `npx tsc --noEmit`, `npm run lint`, targeted vitest, then full `npm test` (DB up; reconcile timeouts are environmental per memory).
- [ ] Optional E2E via verify skill: onboard → simple mode → log without account → saldo aggregate → attempt re-enable (gate) → transfer out → re-enable OK.

## Spec-coverage map

- FR-11/11a/11b/11c → Tasks 1–5; SP-11 → Task 4; §6/§7 → Tasks 1–2; §8.3 T19 + optional-accountId note → Task 3; FR-01 step 4 → Task 4; FR-03b simple branch → Task 3.

## Risks / resolved design points

- **Mid-turn staleness:** flag is re-read inside `resolveAccountParam`/`get_account_balance` at execute time, so toggle-then-log in one ReAct run routes correctly.
- **"Dompet" name collision** (user already has a non-default account literally named Dompet): the default row is distinct (`is_default`); name lookups may match either — harmless (both are the user's accounts), agent never surfaces accounts unprompted in simple mode. Documented, not engineered around.
- **Negative Dompet balance:** gate uses `Math.abs(balance) ≥ 0.005` — owing money also blocks re-enable.
- **update_account can rename/deactivate Dompet:** `findDefault` ignores `is_active`; `ensureDefaultAccount` reactivates on next toggle-off. Renaming is the user's choice.
- **mockRepos churn:** repo mocks are `as never`-cast; new interface methods break nothing at compile time.
- **orchestrator enrichment failure:** flag rides the existing try/catch — worst case the MODE block is missing for a turn, tools still route correctly (execute-time flag read).
