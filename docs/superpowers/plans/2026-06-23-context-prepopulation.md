# Context Prepopulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepopulate each user's stable account and budget reference data into the system prompt per turn, eliminating the `get_accounts` round-trip on the write hot path while keeping balances/spent tool-only.

**Architecture:** Add a pure `enrichSystemPrompt(base, data)` helper in `src/agent/system-prompt.ts` that appends PREFERENSI / AKUN USER / BUDGET CODE blocks (stable data only — never balance or spent). Wire it into `src/agent/orchestrator.ts` by hoisting the existing accounts fetch and adding a current-month budgets fetch, both feeding the helper inside one graceful try/catch. Rewrite system-prompt rule #1 so the model uses the injected account list directly for writes but still calls `get_account_balance` for live balances.

**Tech Stack:** TypeScript (strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`), Vitest, `pg`/Neon, Vercel AI SDK.

**Spec:** `docs/superpowers/specs/2026-06-23-context-prepopulation-design.md`

---

## File Structure

- **Create** `src/utils/format.ts` — `formatIDR` helper, moved out of the telegram transport layer so the agent layer can use it without an `agent → telegram` dependency. (`src/utils/` already exists for cross-cutting helpers like `logger.ts`.)
- **Modify** `src/telegram/formatter.ts` — import `formatIDR` from `utils/format.ts` and re-export it, preserving this module's public API so `formatter.test.ts` and any callers keep working.
- **Modify** `src/agent/system-prompt.ts` — add `enrichSystemPrompt` + `EnrichmentData`; rewrite rule #1 and rule #11.
- **Modify** `src/agent/orchestrator.ts` — hoist accounts fetch, add budgets fetch, call `enrichSystemPrompt`, single graceful try/catch, reuse fetched accounts for the `hasAccount` gate.
- **Modify** `tests/agent/system-prompt.test.ts` — unit tests for `enrichSystemPrompt` (injection, omit-when-empty, staleness invariant).
- **Modify** `tests/agent/orchestrator.test.ts` — assert enriched `system` reaches `run`; graceful fallback on fetch failure; broaden the existing "unchanged prompt" test.

---

### Task 1: Move `formatIDR` to `src/utils/format.ts`

The agent layer (`system-prompt.ts`) needs IDR formatting for budget limits, but `formatIDR` currently lives in the telegram transport layer (`src/telegram/formatter.ts`). Importing transport → agent would invert the intended dependency direction (`telegram → agent`). Move it to a shared util and re-export from formatter to preserve its public API.

**Files:**
- Create: `src/utils/format.ts`
- Modify: `src/telegram/formatter.ts` (top imports + remove local definition)
- Test: `tests/telegram/formatter.test.ts` (unchanged — still imports from `formatter.ts` via the re-export)

- [ ] **Step 1: Create `src/utils/format.ts`**

```ts
/** Format a number as IDR locale: dot as thousands separator, no currency symbol.
 *  Shared across layers (telegram formatter + agent prompt) so the agent layer
 *  does not import from the transport layer. */
export function formatIDR(n: number): string {
  return n.toLocaleString('id-ID');
}
```

- [ ] **Step 2: Update `src/telegram/formatter.ts`**

Replace the header block (lines 1–7):

```ts
import type { RecurringPayment } from '../domain/entities.js';
import type { InlineKeyboardMarkup } from '@grammyjs/types';

/** Format a number as IDR locale: dot as thousands separator, no currency symbol. */
export function formatIDR(n: number): string {
  return n.toLocaleString('id-ID');
}
```

with:

```ts
import type { RecurringPayment } from '../domain/entities.js';
import type { InlineKeyboardMarkup } from '@grammyjs/types';
import { formatIDR } from '../utils/format.js';

// Re-exported to preserve this module's public API after formatIDR moved to
// src/utils/format.ts (so the agent layer can use it without a transport import).
export { formatIDR };
```

- [ ] **Step 3: Run formatter test to verify the re-export keeps the public API intact**

Run: `npx vitest run tests/telegram/formatter.test.ts`
Expected: PASS (the test imports `formatIDR` from `../../src/telegram/formatter.js`, now satisfied via re-export; `recurringPrompt` still works via the import).

- [ ] **Step 4: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/utils/format.ts src/telegram/formatter.ts
git commit -m "refactor(format): move formatIDR to src/utils for cross-layer reuse"
```

---

### Task 2: Add `enrichSystemPrompt` helper (TDD)

A pure function that appends the user's stable reference data to the base prompt. Tested in isolation (no fake runner needed). Volatile values (balance, spent) are deliberately never rendered.

**Files:**
- Modify: `src/agent/system-prompt.ts` (add imports, `ACCOUNT_TYPE_ICON`, `EnrichmentData`, `enrichSystemPrompt`)
- Test: `tests/agent/system-prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/agent/system-prompt.test.ts`, add imports at the top (after the existing `buildSystemPrompt` import) and a new `describe` block at the end of the file:

```ts
import { enrichSystemPrompt } from '../../src/agent/system-prompt.js';
import type { Account, BudgetCode, UserPreference } from '../../src/domain/entities.js';

describe('enrichSystemPrompt', () => {
  const base = 'BASE';

  const pref: UserPreference = { userId: 'u1', key: 'default_account', value: 'BCA', updatedAt: '' };
  const account: Account = {
    accountId: 'acct-1', userId: 'u1', name: 'BCA', type: 'bank',
    balance: 1234567, isActive: true, createdAt: '', updatedAt: '',
  };
  const budget: BudgetCode = {
    budgetCodeId: 'bc-1', userId: 'u1', name: 'Raissa', monthlyBudget: 800000,
    month: 6, year: 2026, spent: 999999, createdAt: '', updatedAt: '',
  };

  it('appends a PREFERENSI block when preferences are present', () => {
    const out = enrichSystemPrompt(base, { preferences: [pref] });
    expect(out.startsWith('BASE')).toBe(true);
    expect(out).toContain('PREFERENSI USER');
    expect(out).toContain('- default_account: BCA');
  });

  it('appends an AKUN block with id, name, and type icon — but NEVER the balance', () => {
    const out = enrichSystemPrompt(base, { accounts: [account] });
    expect(out).toContain('AKUN USER');
    expect(out).toContain('acct-1');
    expect(out).toContain('BCA');
    expect(out).toContain('🏦');
    // Staleness invariant: balance must NOT be rendered.
    expect(out).not.toContain('1234567');
  });

  it('appends a BUDGET block with id, name, and limit — but NEVER spent', () => {
    const out = enrichSystemPrompt(base, { budgets: [budget] });
    expect(out).toContain('BUDGET CODE BULAN INI');
    expect(out).toContain('bc-1');
    expect(out).toContain('Raissa');
    expect(out).toContain('batas 800.000');
    // Staleness invariant: spent must NOT be rendered.
    expect(out).not.toContain('999999');
  });

  it('returns the base unchanged when all arrays are empty or undefined', () => {
    expect(enrichSystemPrompt(base, { preferences: [], accounts: [], budgets: [] })).toBe(base);
    expect(enrichSystemPrompt(base, {})).toBe(base);
  });

  it('appends all present sections, separated by blank lines', () => {
    const out = enrichSystemPrompt(base, { preferences: [pref], accounts: [account], budgets: [budget] });
    expect(out).toContain('PREFERENSI USER');
    expect(out).toContain('AKUN USER');
    expect(out).toContain('BUDGET CODE BULAN INI');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/system-prompt.test.ts`
Expected: FAIL — `enrichSystemPrompt` is not exported from `system-prompt.ts`.

- [ ] **Step 3: Implement `enrichSystemPrompt`**

In `src/agent/system-prompt.ts`, update the imports at the top of the file. The file currently starts with:

```ts
import { CATEGORIES } from '../domain/categories.js';
```

Replace that single import line with:

```ts
import { CATEGORIES } from '../domain/categories.js';
import { formatIDR } from '../utils/format.js';
import type { Account, AccountType, BudgetCode, UserPreference } from '../domain/entities.js';
```

Then, immediately above the `/** Static fallback … BASE_PROMPT … */` comment near the end of the file (after the `buildSystemPrompt` function's closing brace `}`), add:

```ts
const ACCOUNT_TYPE_ICON: Record<AccountType, string> = {
  cash: '💵',
  bank: '🏦',
  card: '💳',
};

export interface EnrichmentData {
  preferences?: UserPreference[];
  accounts?: Account[];
  budgets?: BudgetCode[];
}

/**
 * Append the user's stable reference data to the base system prompt:
 * preferences, account list (id/name/type — NOT balance), and current-month
 * budget codes (id/name/limit — NOT spent). Volatile values are deliberately
 * omitted so the model reads live balances/spent via tools (staleness guard).
 * Each section is omitted when its array is empty/undefined.
 */
export function enrichSystemPrompt(base: string, data: EnrichmentData): string {
  const sections: string[] = [base];

  if (data.preferences?.length) {
    sections.push(
      'PREFERENSI USER (sudah diketahui — jangan tanya ulang):\n' +
        data.preferences.map((p) => `- ${p.key}: ${p.value}`).join('\n'),
    );
  }

  if (data.accounts?.length) {
    sections.push(
      'AKUN USER (pakai langsung untuk tool tulis; pilih accountId dari sini. JANGAN baca saldo dari sini — selalu panggil get_account_balance untuk saldo):\n' +
        data.accounts.map((a) => `- ${a.accountId} ${a.name} ${ACCOUNT_TYPE_ICON[a.type]}`).join('\n'),
    );
  }

  if (data.budgets?.length) {
    sections.push(
      'BUDGET CODE BULAN INI (id, nama, batas — untuk resolve nama→id; spent TIDAK ada di sini, pakai get_budget_codes untuk spent):\n' +
        data.budgets.map((b) => `- ${b.budgetCodeId} ${b.name} — batas ${formatIDR(b.monthlyBudget)}`).join('\n'),
    );
  }

  return sections.join('\n\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/system-prompt.test.ts`
Expected: PASS — all `enrichSystemPrompt` tests green; the existing `buildSystemPrompt` tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/agent/system-prompt.ts tests/agent/system-prompt.test.ts
git commit -m "feat(agent): enrichSystemPrompt helper for account/budget injection"
```

---

### Task 3: Rewrite system-prompt rule #1 and rule #11

LLM-instruction change (per design §8, behavior itself isn't asserted in CI), but we add lightweight presence assertions for the load-bearing phrases so a future edit can't silently drop them.

**Files:**
- Modify: `src/agent/system-prompt.ts` (rules 1 and 11 inside `buildSystemPrompt`)
- Test: `tests/agent/system-prompt.test.ts`

- [ ] **Step 1: Rewrite rule #1**

In `src/agent/system-prompt.ts`, inside `buildSystemPrompt`, replace this line (rule 1):

```
1. Jangan pernah mengasumsikan akun ada. Selalu panggil get_accounts dulu sebelum merujuk nama atau saldo akun.
```

with:

```
1. Daftar akun user ada di blok AKUN USER (di akhir prompt). Pakai langsung untuk memilih accountId di tool tulis — tidak perlu panggil get_accounts. TAPI untuk MENAMPILKAN saldo, SELALU panggil get_account_balance — jangan pernah membaca saldo dari blok AKUN USER (saldo di sana bisa kedaluwarsa). get_accounts tetap tersedia kalau daftar akun mungkin berubah (mis. baru saja membuat akun).
```

- [ ] **Step 2: Rewrite rule #11**

In the same function, replace rule 11:

```
11. Saat pertama kali ngobrol dengan user baru (get_accounts mengembalikan [] — user belum punya akun), sapa dan tanyakan namanya. Simpan dengan update_profile. Kalau user belum mau kasih nama, panggil mereka 'Teman' sementara. Setelah nama tersimpan, tanyakan nama dan tipe akun pertama, lalu panggil create_account.
```

with:

```
11. Saat pertama kali ngobrol dengan user baru (blok AKUN USER tidak ada / kosong — user belum punya akun), sapa dan tanyakan namanya. Simpan dengan update_profile. Kalau user belum mau kasih nama, panggil mereka 'Teman' sementara. Setelah nama tersimpan, tanyakan nama dan tipe akun pertama, lalu panggil create_account.
```

- [ ] **Step 3: Add presence-guard tests**

In `tests/agent/system-prompt.test.ts`, add a new `describe` block (the `prompt` const already exists at the top of the existing `buildSystemPrompt` describe):

```ts
describe('buildSystemPrompt — account-block rules', () => {
  const prompt = buildSystemPrompt('2026-06-22');

  it('rule 1 points the model at the AKUN USER block and mandates get_account_balance for balances', () => {
    expect(prompt).toContain('AKUN USER');
    expect(prompt).toContain('get_account_balance');
  });

  it('rule 11 onboards when the AKUN USER block is absent or empty', () => {
    expect(prompt).toMatch(/blok AKUN USER (tidak ada|kosong)/);
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/system-prompt.test.ts`
Expected: PASS — both new presence tests green; all prior tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/agent/system-prompt.ts tests/agent/system-prompt.test.ts
git commit -m "feat(agent): rewrite rules 1/11 for prepopulated account block"
```

---

### Task 4: Wire enrichment into the orchestrator (TDD)

Hoist the accounts fetch above enrichment, add a current-month budgets fetch, replace the inline preferences block with a call to `enrichSystemPrompt`, and reuse the fetched accounts for the `hasAccount` gate — collapsing the double-fetch. All three reads share one graceful try/catch.

**Files:**
- Modify: `src/agent/orchestrator.ts` (imports; enrichment block lines 46–64; tool-build block lines 75–77)
- Test: `tests/agent/orchestrator.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/agent/orchestrator.test.ts`, add these three tests inside the existing `describe('handleMessage', …)` block:

```ts
  it('injects AKUN USER + BUDGET CODE blocks into the system prompt when the user has accounts/budgets', async () => {
    const repos = mockRepos();
    (repos.users.findByTelegramChatId as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', telegramChatId: '1', name: 'Devin', language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
    });
    (repos.accounts.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue([
      { accountId: 'acct-1', userId: 'u1', name: 'BCA', type: 'bank', balance: 5550000, isActive: true, createdAt: '', updatedAt: '' },
    ]);
    (repos.budgets.findByUserAndMonth as ReturnType<typeof vi.fn>).mockResolvedValue([
      { budgetCodeId: 'bc-1', userId: 'u1', name: 'Raissa', monthlyBudget: 800000, month: 6, year: 2026, spent: 777000, createdAt: '', updatedAt: '' },
    ]);
    const run = vi.fn(async () => ({
      text: 'ok', responseMessages: [{ role: 'assistant' as const, content: 'ok' }], toolResults: [],
    }));
    await handleMessage({ text: 'halo', chatId: '1', repos, run, system: 'BASE', contextWindowTurns: 20, sessionIdleTimeoutMinutes: 30 });
    const call = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: string };
    expect(call.system).toContain('AKUN USER');
    expect(call.system).toContain('acct-1');
    expect(call.system).toContain('BUDGET CODE BULAN INI');
    expect(call.system).toContain('batas 800.000');
    // Staleness invariant: balance and spent must NOT leak into the prompt.
    expect(call.system).not.toContain('5550000');
    expect(call.system).not.toContain('777000');
  });

  it('leaves the system prompt unchanged when the user has no preferences, accounts, or budgets', async () => {
    const repos = mockRepos();
    (repos.users.findByTelegramChatId as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', telegramChatId: '1', name: 'Devin', language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
    });
    // mockRepos defaults: preferences [], accounts [], budgets []
    const run = vi.fn(async () => ({
      text: 'ok', responseMessages: [{ role: 'assistant' as const, content: 'ok' }], toolResults: [],
    }));
    await handleMessage({ text: 'halo', chatId: '1', repos, run, system: 'BASE', contextWindowTurns: 20, sessionIdleTimeoutMinutes: 30 });
    const call = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: string };
    expect(call.system).toBe('BASE');
    expect(call.system).not.toContain('AKUN USER');
  });

  it('falls back to the base prompt when the accounts read throws', async () => {
    const repos = mockRepos();
    (repos.users.findByTelegramChatId as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', telegramChatId: '1', name: 'Devin', language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
    });
    (repos.accounts.findAllByUserId as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    const run = vi.fn(async () => ({
      text: 'ok', responseMessages: [{ role: 'assistant' as const, content: 'ok' }], toolResults: [],
    }));
    await handleMessage({ text: 'halo', chatId: '1', repos, run, system: 'BASE', contextWindowTurns: 20, sessionIdleTimeoutMinutes: 30 });
    const call = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: string };
    expect(call.system).toBe('BASE');
    expect(logEvent).toHaveBeenCalledWith('error', 'prompt enrichment failed', expect.objectContaining({ userId: 'u1' }));
  });
```

Then **delete** the now-redundant older test `'leaves the system prompt unchanged when the user has no preferences'` (its `mockRepos` defaults already return `[]` for all three sources, so the new broader test above supersedes it). Keep the existing `'injects the PREFERENSI USER block …'` test unchanged — it still passes (prefs present, accounts/budgets default `[]`).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/agent/orchestrator.test.ts`
Expected: FAIL — `call.system` is still just `'BASE'` + (maybe) the inline PREFERENSI block; `'AKUN USER'` and `'BUDGET CODE BULAN INI'` are absent; the accounts-throws case fails because the current code fetches accounts outside any try/catch.

- [ ] **Step 3: Update imports**

In `src/agent/orchestrator.ts`, the current imports are:

```ts
import type { CoreMessage } from 'ai';
import type { Repos } from '../repositories/interfaces.js';
import type { AgentRunner } from './run-agent.js';
import { buildTools } from './tools.js';
import { isExpired, freshSession, trimTurns, extractLastTransactionId } from './orchestrator-helpers.js';
import { nowWIB } from '../domain/time.js';
import { logEvent } from '../utils/logger.js';
```

Replace with:

```ts
import type { CoreMessage } from 'ai';
import type { Repos } from '../repositories/interfaces.js';
import type { AgentRunner } from './run-agent.js';
import type { Account } from '../domain/entities.js';
import { buildTools } from './tools.js';
import { enrichSystemPrompt } from './system-prompt.js';
import { isExpired, freshSession, trimTurns, extractLastTransactionId } from './orchestrator-helpers.js';
import { nowWIB, wibYear, wibMonth } from '../domain/time.js';
import { logEvent } from '../utils/logger.js';
```

- [ ] **Step 4: Replace the enrichment block**

In `src/agent/orchestrator.ts`, replace the existing preferences-enrichment block (the comment + `let system = args.system;` + the `try { … } catch { … }` that reads `repos.preferences.findAllByUserId`):

```ts
	// Enrich the system prompt with the user's saved preferences (inject every
	// turn). Preferences are optional enrichment — degrade gracefully if the
	// read fails: log and proceed with the base prompt.
	let system = args.system;
	try {
		const prefs = await args.repos.preferences.findAllByUserId(user.userId);
		if (prefs.length) {
			system =
				args.system +
				'\n\nPREFERENSI USER (sudah diketahui — jangan tanya ulang):\n' +
				prefs.map((p) => `- ${p.key}: ${p.value}`).join('\n');
		}
	} catch (e) {
		logEvent('error', 'preferences load failed', {
			userId: user.userId,
			chatId: args.chatId,
			error: (e as Error).message,
		});
	}
```

with:

```ts
	// Enrich the system prompt with the user's stable reference data (inject
	// every turn): preferences, account list (id/name/type), and current-month
	// budget codes (id/name/limit). Volatile values (balance, spent) are
	// deliberately NOT injected — the model reads them via tools. The accounts
	// list is fetched once here and reused for the onboarding gate below.
	//
	// All three reads share one try/catch: on any failure we fall back to the
	// base prompt and an empty account list (hasAccount=false → onboarding-only
	// tools this turn), so a transient read error never crashes the request and
	// never lets a write tool fire against an unknown account set.
	let system = args.system;
	let accounts: Account[] = [];
	try {
		const [fetchedAccounts, prefs, budgets] = await Promise.all([
			args.repos.accounts.findAllByUserId(user.userId),
			args.repos.preferences.findAllByUserId(user.userId),
			args.repos.budgets.findByUserAndMonth(user.userId, wibYear(), wibMonth()),
		]);
		accounts = fetchedAccounts;
		system = enrichSystemPrompt(args.system, { preferences: prefs, accounts, budgets });
	} catch (e) {
		logEvent('error', 'prompt enrichment failed', {
			userId: user.userId,
			chatId: args.chatId,
			error: (e as Error).message,
		});
	}
```

- [ ] **Step 5: Reuse the fetched accounts for the gate**

In `src/agent/orchestrator.ts`, replace the tool-build block:

```ts
	// 4. Build tools (gated by onboarding state)
	const accounts = await args.repos.accounts.findAllByUserId(user.userId);
	const hasAccount = accounts.length > 0;
	const tools = buildTools({
		userId: user.userId,
		repos: args.repos,
		hasAccount,
		lastTransactionId: session.lastTransactionId,
	});
```

with:

```ts
	// 4. Build tools (gated by onboarding state). `accounts` was fetched during
	//    enrichment above and reused here (single fetch, no double-read).
	const hasAccount = accounts.length > 0;
	const tools = buildTools({
		userId: user.userId,
		repos: args.repos,
		hasAccount,
		lastTransactionId: session.lastTransactionId,
	});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/agent/orchestrator.test.ts`
Expected: PASS — all three new tests green; the existing onboarding / session-persist / fresh-session / PREFERENSI-injection tests still green (the session-persist test now incidentally also exercises the AKUN injection path, which is fine).

- [ ] **Step 7: Commit**

```bash
git add src/agent/orchestrator.ts tests/agent/orchestrator.test.ts
git commit -m "feat(agent): prepopulate account/budget reference data into system prompt"
```

---

### Task 5: Full verification gate

Confirm the whole change set passes type-check, lint, and the full suite. Then note the manual smoke test for the regression-to-watch.

**Files:** none (verification only)

- [ ] **Step 1: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors (the NFR-02 `no-restricted-imports` rule is unaffected — `pg` is not touched).

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: all green. (Per project memory, the 4 reconcile-test timeouts are pre-existing Neon latency — pass at 30s; not a regression. If they time out, retry rather than treat as a failure of this change.)

- [ ] **Step 4: Manual smoke (regression-to-watch — not automated)**

With a live `.env`, run `npm run dev` and verify against a real account:
1. Log an expense ("bakso 20000 bca") and confirm the agent writes it **without** a separate `get_accounts` step in the trace (it resolves `bca` from the injected AKUN block).
2. Ask "berapa saldo BCA?" and confirm the agent **still calls `get_account_balance`** to report the balance — it must not read a balance from the prompt (there is none) or hallucinate one.

Record the outcome in the PR/commit notes; this guards the rule #1 relaxation.

---

## Self-Review

**Spec coverage:**
- *Inject stable reference data (account id/name/type, budget id/name/limit)* → Task 2 (`enrichSystemPrompt`).
- *No balances / no spent (staleness invariant)* → Task 2 tests (`not.toContain` balance/spent) + Task 4 test (same invariant at the orchestrator boundary).
- *Hoist accounts fetch; single fetch feeding prompt + gate* → Task 4 Steps 4–5.
- *Budgets current-month fetch* → Task 4 Step 4 (`findByUserAndMonth(userId, wibYear(), wibMonth())`).
- *Rule #1 rewrite + onboarding rule #11 update* → Task 3.
- *Graceful fallback on fetch failure* → Task 4 Step 4 try/catch + Task 4 "falls back" test.
- *formatIDR importable from agent layer without transport dependency* → Task 1.
- *Update the "unchanged prompt" test premise* → Task 4 Step 1 (broadened + superseded test deleted).

**Placeholder scan:** none — every code step shows complete code and exact run/expected strings.

**Type consistency:** `EnrichmentData { preferences?: UserPreference[]; accounts?: Account[]; budgets?: BudgetCode[] }` (Task 2) matches the call site `enrichSystemPrompt(args.system, { preferences: prefs, accounts, budgets })` (Task 4) and the entity types in `src/domain/entities.ts` (`Account.accountId/name/type`, `BudgetCode.budgetCodeId/name/monthlyBudget`, `UserPreference.key/value`). `ACCOUNT_TYPE_ICON` is keyed by `AccountType` ('cash'|'bank'|'card'), matching `Account.type`. `wibYear()`/`wibMonth()` are no-arg per `src/domain/time.ts`.
