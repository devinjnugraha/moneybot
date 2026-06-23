# MoneyBot — Context prepopulation design (accounts & budget reference data)

- **Date:** 2026-06-23
- **Source:** discussion on whether to prepopulate accounts/budgets/preferences into the system prompt
- **Status:** Design — ready for implementation planning

## Purpose

Today the agent resolves account names → `accountId` and budget names → `budgetCodeId` via tool round-trips (`get_accounts`, `get_budget_codes`), mandated by system-prompt rule #1. This eliminates that round-trip on the write hot path by injecting each user's **stable reference data** into the system prompt per turn — the same enrichment seam preferences already use.

## Problem

`orchestrator.ts` already fetches the full account list every request for the onboarding gate (`hasAccount`), uses only `.length`, and discards the rest:

```ts
const accounts = await args.repos.accounts.findAllByUserId(user.userId); // full list
const hasAccount = accounts.length > 0;                                   // .length only
```

Then the model re-fetches the same list through a `get_accounts` tool call — rule #1 (`system-prompt.ts:17`) makes it mandatory before any write. The result, on the hottest path in the bot (logging a transaction — NFR-01 latency-sensitive):

1. **Double-fetch** — the account list is queried once by the orchestrator and again by the tool.
2. **Wasted ReAct round-trip** — one extra LLM step (1–3s on OpenRouter) per write, spent fetching data already held in memory.

Preferences are *already* prepopulated per turn (`orchestrator.ts:49-64`). Accounts and budgets are not.

## Design

### What gets injected (stable reference data only)

Each turn, the orchestrator appends to the system prompt:

```
AKUN USER (pakai langsung untuk tool tulis; pilih accountId dari sini):
- <full accountId> BCA 🏦
- <full accountId> Cash 💵

BUDGET CODE BULAN INI (id, nama, batas — untuk resolve nama→id; spent TIDAK ada di sini):
- <full budgetCodeId> Raissa — batas 800.000
```

- **Full UUIDs** — the model passes them verbatim to write tools (`create_expense`, `create_budget_code`, etc.), which do `findById`.
- **No balances, no spent.** This is the core staleness invariant (see below).
- Budget codes scoped to the current WIB month (`findByUserAndMonth(userId, wibYear(), wibMonth())`) — the same call `get_budget_codes` already makes.

### The staleness invariant (hard rule)

This is a money system; reporting a stale number is the failure mode that matters. Balances mutate on every transaction; budget `spent` mutates on every budgeted expense. **Volatile numbers are never injected** — the model reads them only through tools:

| Data | Injected? | Source of truth at runtime |
|---|---|---|
| account `accountId` / `name` / `type` | ✅ stable | prompt block |
| budget `budgetCodeId` / `name` / `monthlyBudget` (limit) | ✅ stable | prompt block |
| account `balance` | ❌ volatile | `get_account_balance` tool |
| budget `spent` | ❌ volatile | `get_budget_codes` tool |

A useful side effect: because the injected block is stable across turns within a session (balances/spent excluded), it keeps the system prompt a cacheable provider-prefix — injecting balances would thrash prompt caching every turn.

### Seam: where the enrichment lives

In `src/agent/orchestrator.ts`, extend the existing preferences-enrichment block. Hoist the accounts fetch above it so the **same query** feeds both the prompt and the `hasAccount` gate — collapsing the double-fetch to a single fetch:

```
resolve user
fetch accounts = repos.accounts.findAllByUserId(userId)   ← hoisted from step 4
fetch budgets  = repos.budgets.findByUserAndMonth(...)     ← new (current month)
build system = base + PREFERENSI block + AKUN block + BUDGET block
... later: hasAccount = accounts.length > 0; buildTools(...)
```

The injected blocks are appended by the orchestrator (like preferences today), **not** by `buildSystemPrompt` — keeping `buildSystemPrompt(todayWib)` static and unit-testable.

### Rule #1 rewrite (`src/agent/system-prompt.ts:17`)

From:

> Jangan pernah mengasumsikan akun ada. Selalu panggil get_accounts dulu sebelum merujuk nama atau saldo akun.

To (paraphrased — exact wording finalized in implementation):

> The user's accounts are listed in the AKUN USER block. Use them directly to pick `accountId` for write tools — you do not need to call `get_accounts`. BUT to **report a balance**, ALWAYS call `get_account_balance` — never read a balance from the block (balances there may be stale). `get_accounts` remains available if the list may have changed (e.g. you just created an account).

Rule #11 (onboarding) is updated to fire off the absence of the AKUN block / an empty account list rather than "`get_accounts` returns `[]`".

**Regression to watch:** relaxing rule #1 must not cause the model to stop grounding balances via the tool. Mitigations: (a) no balance is present in the block to misread; (b) the rule loudly mandates `get_account_balance` for any balance reporting. This is an LLM-behavior change — validated by manual smoke testing, not CI (per design doc §8).

## Out of scope

- Injecting balances or spent (explicitly excluded — staleness).
- Caching/persisting the snapshot across turns (it is recomputed per turn; correctness over cost).
- Changes to the proactive/scheduler paths (they do not go through the ReAct write loop).

## Testing

Framework: Vitest. The orchestrator is already unit-tested with an injectable fake runner (`tests/agent/orchestrator.test.ts`) that captures the `system` string passed to `run`. Extend that pattern:

- Assert the enriched `system` contains the AKUN USER block with account **names + full ids**.
- Assert it contains the BUDGET CODE block with budget **names + limits** (no spent).
- Assert **no balance and no spent** appear anywhere in the enriched `system` (the invariant, enforced as a negative assertion).
- Assert the AKUN block is omitted when `accounts = []` (onboarding path).
- Assert graceful fallback: when `accounts.findAllByUserId` or `budgets.findByUserAndMonth` throws, the orchestrator logs and proceeds with the base prompt (model falls back to `get_accounts`) — mirroring the existing preferences try/catch.
- Update the existing test *"leaves the system prompt unchanged when the user has no preferences"* (`orchestrator.test.ts:176`): its premise now requires **no preferences AND no accounts AND no budgets** to yield an unchanged prompt; otherwise accounts/budgets are appended. Its current mocks already return `[]` for all three, so the assertion `system === 'BASE'` still holds — update the test name/intent to reflect the broader condition.
- `system-prompt.test.ts` asserts only on rule 12 / icon mappings / taxonomy — rule #1 wording changes do not break it (and per §8, LLM instructions are not asserted in CI).

Repository and tool layers are unchanged; their existing tests are unaffected.
