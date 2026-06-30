# Morning Glance v2 — Budget Bars & Enforced Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the proactive morning-glance message so account balances render as a guaranteed bullet list, current-month budgets render as per-code spent/remaining + percentage + a code-drawn `|————•——————|` range bar, and the LLM owns only the greeting + yesterday prose — all bounded for Telegram mobile.

**Architecture:** Deterministic rendering lives in `src/proactive/composers/template.ts` (pure functions, one source of truth shared by the LLM path and the template fallback). The detector gains a budgets fetch; the composer stitches `LLM-prose + deterministic-block + CTA` and sends the model only `{ yesterday }`; the morning-glance system prompt shrinks to greeting + yesterday. The detector/composer/prompt seams are unchanged — we only add data and renderers.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), vitest, grammY, Vercel AI SDK `generateText`. Verification gate per `CLAUDE.md`: `npx tsc --noEmit` **and** `npm run lint` **and** the relevant `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-06-30-morning-glance-budget-bars-design.md`

---

## File Structure

- **Modify** `src/proactive/composers/template.ts` — add pure renderers (`renderBudgetBar`, `renderAccountList`, `renderBudgetBlock`, `renderUpcoming`, `renderTodayDue`, `renderMorningGlanceBlock`) + a shared `MORNING_GLANCE_DUE_CTA` const; refactor `morningGlanceTemplate` to reuse them.
- **Modify** `src/proactive/triggers/morning-glance.ts` — fetch current-month budgets; emit `budgets` in `payload.data`.
- **Modify** `src/proactive/prompt.ts` — rewrite `buildMorningGlanceSystemPrompt` to greeting + yesterday only.
- **Modify** `src/proactive/composers/morning-glance.ts` — assemble `prose + block + CTA`; send the LLM only `{ yesterday }`.
- **Modify** `tests/proactive/composers/template.test.ts` — cover the new renderers + updated fallback.
- **Modify** `tests/proactive/triggers/morning-glance.test.ts` — cover the budgets fetch.
- **Modify** `tests/proactive/composers/morning-glance.test.ts` — cover the new assembly.

`template.ts` is the home for deterministic proactive formatting (the composer already imports `morningGlanceTemplate` from it); no new files.

---

## Task 1: `renderBudgetBar` — the deterministic range bar

**Files:**
- Modify: `src/proactive/composers/template.ts` (add exported function near the top, after the `idr` helper)
- Test: `tests/proactive/composers/template.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/proactive/composers/template.test.ts` (and add `renderBudgetBar` to the import on line 2):

```ts
// line 2 — add renderBudgetBar to the existing import:
import { scheduledSummaryTemplate, budgetThresholdTemplate, loggingGapTemplate, anomalyTemplate, morningGlanceTemplate, templateCompose, renderBudgetBar } from '../../../src/proactive/composers/template.js';
```

Append a new describe block at the end of the file:

```ts
describe('renderBudgetBar', () => {
  it('wraps the bar in backticks so Telegram renders it monospace', () => {
    expect(renderBudgetBar(0.75)).startsWith('`');
    expect(renderBudgetBar(0.75)).endsWith('`');
  });

  it('places the bullet proportionally and keeps a fixed inner width of 10', () => {
    // 0%   -> bullet at far left
    expect(renderBudgetBar(0)).toBe('`|•——————————|`');
    // 50%  -> 5 dashes, bullet, 5 dashes
    expect(renderBudgetBar(0.5)).toBe('`|—————•—————|`');
    // 100% -> bullet at far right
    expect(renderBudgetBar(1)).toBe('`|——————————•|`');
  });

  it('clamps the bullet at the right edge when over budget', () => {
    expect(renderBudgetBar(1.2)).toBe('`|——————————•|`');
  });

  it('always has exactly 10 inner cells (pipes excluded)', () => {
    for (const pct of [0, 0.12, 0.3, 0.5, 0.75, 0.99, 1, 1.5]) {
      const inner = renderBudgetBar(pct).slice(2, -2); // strip backtick + pipe on each side
      expect(inner).toHaveLength(11); // 10 cells + 1 bullet
      expect([...inner].filter((c) => c === '—').length + 1).toBe(11); // dashes + the bullet
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: FAIL — `renderBudgetBar is not a function` (not exported yet).

- [ ] **Step 3: Implement `renderBudgetBar`**

In `src/proactive/composers/template.ts`, add immediately after the `idr` function (after line 6):

```ts
/**
 * Render a deterministic range bar for a budget fraction. Glyphs (|, em-dash,
 * bullet) are wrapped in backticks so Telegram renders the span monospace and
 * bars align across lines. `pct` is a fraction (0..N; values >1 clamp the
 * bullet at the right edge). `width` is the inner cell count (default 10).
 */
export function renderBudgetBar(pct: number, width = 10): string {
  const left = Math.min(width, Math.max(0, Math.round(pct * width)));
  const right = width - left;
  return '`|' + '—'.repeat(left) + '•' + '—'.repeat(right) + '|`';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: PASS (all `renderBudgetBar` cases + existing template tests still green).

- [ ] **Step 5: Verify types & lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/composers/template.ts tests/proactive/composers/template.test.ts
git commit -m "feat: add renderBudgetBar for deterministic budget range bars"
```

---

## Task 2: `renderAccountList` — enforced account bullets

**Files:**
- Modify: `src/proactive/composers/template.ts`
- Test: `tests/proactive/composers/template.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `renderAccountList` to the import line, then append:

```ts
describe('renderAccountList', () => {
  it('renders one bullet per account under a Saldo header', () => {
    const out = renderAccountList([
      { name: 'BCA', balance: 5_200_000 },
      { name: 'GoPay', balance: 450_000 },
    ]);
    expect(out).toBe('🏦 Saldo\n• BCA 5.200.000\n• GoPay 450.000');
  });

  it('returns empty string when there are no accounts', () => {
    expect(renderAccountList([])).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: FAIL — `renderAccountList is not a function`.

- [ ] **Step 3: Implement `renderAccountList`**

Add to `src/proactive/composers/template.ts` (after `renderBudgetBar`):

```ts
interface MGAccount {
  name: string;
  balance: number;
}

/** Render active-account balances as a guaranteed bullet list. '' when empty. */
export function renderAccountList(balances: readonly MGAccount[]): string {
  if (balances.length === 0) return '';
  const lines = balances.map((b) => `• ${b.name} ${idr(b.balance)}`);
  return `🏦 Saldo\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify types & lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/composers/template.ts tests/proactive/composers/template.test.ts
git commit -m "feat: add renderAccountList for enforced balance bullets"
```

---

## Task 3: `renderBudgetBlock` — per-code budget lines with bar + caps

**Files:**
- Modify: `src/proactive/composers/template.ts`
- Test: `tests/proactive/composers/template.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `renderBudgetBlock` to the import line, then append:

```ts
describe('renderBudgetBlock', () => {
  it('renders each code as spent/alloc · remaining · pct + bar', () => {
    const out = renderBudgetBlock([
      { name: 'Makan', spent: 450_000, alloc: 600_000, remaining: 150_000, pct: 0.75 },
    ]);
    expect(out).toContain('📊 Budget');
    expect(out).toContain('Makan 450.000/600.000 · sisa 150.000 · 75%');
    expect(out).toContain('`|————————•——|`'); // 75% bar
  });

  it('flags over-budget codes with 🚨 and the real pct, clamping the bar', () => {
    const out = renderBudgetBlock([
      { name: 'Makan', spent: 720_000, alloc: 600_000, remaining: -120_000, pct: 1.2 },
    ]);
    expect(out).toContain('🚨 Makan');
    expect(out).toContain('120%');
    expect(out).toContain('`|——————————•|`'); // clamped full
  });

  it('caps at 3 codes (sorted by pct desc upstream) and notes the rest', () => {
    const codes = [
      { name: 'A', spent: 90, alloc: 100, remaining: 10, pct: 0.9 },
      { name: 'B', spent: 50, alloc: 100, remaining: 50, pct: 0.5 },
      { name: 'C', spent: 30, alloc: 100, remaining: 70, pct: 0.3 },
      { name: 'D', spent: 10, alloc: 100, remaining: 90, pct: 0.1 },
    ];
    const out = renderBudgetBlock(codes);
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toContain('C');
    expect(out).not.toContain('D 10'); // D omitted from lines
    expect(out).toContain('+1 lainnya');
  });

  it('returns empty string when there are no budgets', () => {
    expect(renderBudgetBlock([])).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: FAIL — `renderBudgetBlock is not a function`.

- [ ] **Step 3: Implement `renderBudgetBlock`**

Add to `src/proactive/composers/template.ts` (after `renderAccountList`):

```ts
interface MGBudget {
  name: string;
  spent: number;
  alloc: number;
  remaining: number;
  pct: number; // fraction 0..N (may exceed 1)
}
const BUDGET_CAP = 3;

/** Render per-code budget lines (spent/alloc · remaining · pct + bar), capped. */
export function renderBudgetBlock(budgets: readonly MGBudget[]): string {
  if (budgets.length === 0) return '';
  const shown = budgets.slice(0, BUDGET_CAP);
  const lines = shown.map((b) => {
    const pct = Math.round(b.pct * 100);
    const prefix = b.pct > 1 ? '🚨 ' : '';
    return `${prefix}${b.name} ${idr(b.spent)}/${idr(b.alloc)} · sisa ${idr(b.remaining)} · ${pct}% ${renderBudgetBar(b.pct)}`;
  });
  if (budgets.length > BUDGET_CAP) lines.push(`+${budgets.length - BUDGET_CAP} lainnya`);
  return `📊 Budget\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify types & lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/composers/template.ts tests/proactive/composers/template.test.ts
git commit -m "feat: add renderBudgetBlock for per-code budget bars with caps"
```

---

## Task 4: `renderUpcoming` + `renderTodayDue` + the shared CTA const

**Files:**
- Modify: `src/proactive/composers/template.ts`
- Test: `tests/proactive/composers/template.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `renderUpcoming`, `renderTodayDue`, `MORNING_GLANCE_DUE_CTA` to the import line, then append:

```ts
describe('renderUpcoming', () => {
  it('lists upcoming bills as bullets with amount, account, dueDate', () => {
    const out = renderUpcoming([
      { name: 'Spotify', amount: 59_900, account: 'BCA CC', dueDate: '2026-06-25' },
    ]);
    expect(out).toBe('📅 Tagihan minggu ini\n• Spotify — 59.900 via BCA CC (2026-06-25)');
  });

  it('caps at 3 and notes the rest', () => {
    const bills = [
      { name: 'A', amount: 1, account: 'x', dueDate: '2026-06-23' },
      { name: 'B', amount: 1, account: 'x', dueDate: '2026-06-24' },
      { name: 'C', amount: 1, account: 'x', dueDate: '2026-06-25' },
      { name: 'D', amount: 1, account: 'x', dueDate: '2026-06-26' },
    ];
    expect(renderUpcoming(bills)).toContain('+1 lainnya');
  });

  it('returns empty string when there are none', () => {
    expect(renderUpcoming([])).toBe('');
  });
});

describe('renderTodayDue', () => {
  it('lists today\'s due bills as bullets (name + amount + account)', () => {
    const out = renderTodayDue([
      { name: 'Netflix', amount: 75_000, account: 'BCA CC' },
    ]);
    expect(out).toBe('Jatuh tempo hari ini\n• Netflix — 75.000 via BCA CC');
  });

  it('returns empty string when there are none', () => {
    expect(renderTodayDue([])).toBe('');
  });
});

describe('MORNING_GLANCE_DUE_CTA', () => {
  it('is the fixed pointer line to the due-bill keyboard', () => {
    expect(MORNING_GLANCE_DUE_CTA).toBe('Tagihan hari ini tinggal dipencet di bawah ya 👇');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: FAIL — `renderUpcoming is not a function`.

- [ ] **Step 3: Implement the three pieces**

Add to `src/proactive/composers/template.ts` (after `renderBudgetBlock`):

```ts
interface MGUpcoming {
  name: string;
  amount: number;
  account: string;
  dueDate: string;
}
interface MGDue {
  name: string;
  amount: number;
  account: string;
}
const UPCOMING_CAP = 3;

/** Render this week's upcoming bills as bullets, capped. '' when empty. */
export function renderUpcoming(upcoming: readonly MGUpcoming[]): string {
  if (upcoming.length === 0) return '';
  const shown = upcoming.slice(0, UPCOMING_CAP);
  const lines = shown.map((u) => `• ${u.name} — ${idr(u.amount)} via ${u.account} (${u.dueDate})`);
  if (upcoming.length > UPCOMING_CAP) lines.push(`+${upcoming.length - UPCOMING_CAP} lainnya`);
  return `📅 Tagihan minggu ini\n${lines.join('\n')}`;
}

/** Render today's due bills as bullets (name + amount + account). '' when empty. */
export function renderTodayDue(todayDueBills: readonly MGDue[]): string {
  if (todayDueBills.length === 0) return '';
  const lines = todayDueBills.map((b) => `• ${b.name} — ${idr(b.amount)} via ${b.account}`);
  return `Jatuh tempo hari ini\n${lines.join('\n')}`;
}

/** Fixed pointer to the inline due-bill keyboard; shared by the LLM path and fallback. */
export const MORNING_GLANCE_DUE_CTA = 'Tagihan hari ini tinggal dipencet di bawah ya 👇';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify types & lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/composers/template.ts tests/proactive/composers/template.test.ts
git commit -m "feat: add renderUpcoming/renderTodayDue and shared due-bill CTA"
```

---

## Task 5: `renderMorningGlanceBlock` — assemble the deterministic block

**Files:**
- Modify: `src/proactive/composers/template.ts`
- Test: `tests/proactive/composers/template.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `renderMorningGlanceBlock` to the import line, then append:

```ts
describe('renderMorningGlanceBlock', () => {
  const morningPayload = (data: Record<string, unknown>): ProactivePayload => ({
    triggerType: 'morning_glance',
    dedupKey: 'morning-glance:2026-06-22',
    channel: 'llm',
    data,
  });

  it('assembles saldo → budget → upcoming → todayDue, sections joined by blank lines', () => {
    const out = renderMorningGlanceBlock(morningPayload({
      balances: [{ name: 'BCA', balance: 1_000_000 }],
      budgets: [{ name: 'Makan', spent: 50, alloc: 100, remaining: 50, pct: 0.5 }],
      upcoming: [{ name: 'Spotify', amount: 1, account: 'x', dueDate: '2026-06-25' }],
      todayDueBills: [{ name: 'Netflix', amount: 2, account: 'y' }],
    }));
    expect(out.indexOf('🏦 Saldo')).toBeLessThan(out.indexOf('📊 Budget'));
    expect(out.indexOf('📊 Budget')).toBeLessThan(out.indexOf('📅 Tagihan minggu ini'));
    expect(out.indexOf('📅 Tagihan minggu ini')).toBeLessThan(out.indexOf('Jatuh tempo hari ini'));
    expect(out).toContain('\n\n'); // blank-line separators
  });

  it('omits empty sections', () => {
    const out = renderMorningGlanceBlock(morningPayload({
      balances: [{ name: 'BCA', balance: 1_000_000 }],
      budgets: [],
      upcoming: [],
      todayDueBills: [],
    }));
    expect(out).toBe('🏦 Saldo\n• BCA 1.000.000');
  });

  it('returns empty string when every section is empty', () => {
    expect(renderMorningGlanceBlock(morningPayload({
      balances: [], budgets: [], upcoming: [], todayDueBills: [],
    }))).toBe('');
  });
});
```

Note: `ProactivePayload` is already imported at the top of the test file (line 3).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: FAIL — `renderMorningGlanceBlock is not a function`.

- [ ] **Step 3: Implement `renderMorningGlanceBlock`**

Add to `src/proactive/composers/template.ts` (after `renderTodayDue` / the CTA const):

```ts
/**
 * Assemble the deterministic morning-glance block from a payload's data:
 * saldo → budget → upcoming → todayDue, empty sections omitted, joined by blank
 * lines. Returns '' when all sections are empty. Used by both the LLM composer
 * path and the template fallback so the structured block is identical.
 */
export function renderMorningGlanceBlock(payload: ProactivePayload): string {
  const d = payload.data as {
    balances?: MGAccount[];
    budgets?: MGBudget[];
    upcoming?: MGUpcoming[];
    todayDueBills?: MGDue[];
  };
  return [
    renderAccountList(d.balances ?? []),
    renderBudgetBlock(d.budgets ?? []),
    renderUpcoming(d.upcoming ?? []),
    renderTodayDue(d.todayDueBills ?? []),
  ]
    .filter(Boolean)
    .join('\n\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: PASS (all renderer tests + existing template tests green).

- [ ] **Step 5: Verify types & lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/composers/template.ts tests/proactive/composers/template.test.ts
git commit -m "feat: add renderMorningGlanceBlock to assemble the structured block"
```

---

## Task 6: Refactor `morningGlanceTemplate` to reuse the renderers

The fallback must render the same structured block as the LLM path. It also renders a deterministic yesterday line (no LLM in fallback) and the CTA when there are due bills.

**Files:**
- Modify: `src/proactive/composers/template.ts` (the `morningGlanceTemplate` function, currently lines ~109–129)
- Test: `tests/proactive/composers/template.test.ts` (the existing `morningGlanceTemplate` describe block + new assertions)

- [ ] **Step 1: Add new assertions to the existing `morningGlanceTemplate` tests**

In `tests/proactive/composers/template.test.ts`, the existing two tests still pass (their substring assertions hold), but add a focused test for the new bulleted/budget behavior. Append inside the `morningGlanceTemplate` describe block:

```ts
  it('renders balances as bullets and a budget bar, with the CTA when bills are due', () => {
    const out = morningGlanceTemplate({
      triggerType: 'morning_glance',
      dedupKey: 'morning-glance:2026-06-22',
      channel: 'llm',
      data: {
        balances: [{ name: 'BCA', balance: 5_200_000 }],
        budgets: [{ name: 'Makan', spent: 450_000, alloc: 600_000, remaining: 150_000, pct: 0.75 }],
        upcoming: [],
        yesterday: { count: 2, totalSpend: 85_000 },
        todayDueBills: [{ recurringId: 'r1', name: 'Netflix', amount: 75_000, account: 'BCA CC' }],
      },
    });
    // balances are bulleted (no single-line " · "-join)
    expect(out).toContain('🏦 Saldo\n• BCA 5.200.000');
    expect(out).not.toContain('· BCA');
    // budget bar present and backtick-wrapped
    expect(out).toContain('`|————————•——|`');
    // yesterday line
    expect(out).toContain('2 catatan');
    // CTA last, pointing at the keyboard
    expect(out.endsWith('Tagihan hari ini tinggal dipencet di bawah ya 👇')).toBe(true);
  });

  it('omits the CTA when there are no due bills', () => {
    const out = morningGlanceTemplate({
      triggerType: 'morning_glance',
      dedupKey: 'morning-glance:2026-06-22',
      channel: 'llm',
      data: { balances: [], budgets: [], upcoming: [], yesterday: null, todayDueBills: [] },
    });
    expect(out).not.toContain('dipencet');
    expect(out).toContain('belum ada catatan');
  });
```

- [ ] **Step 2: Run the test to verify the new one fails**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: FAIL — balances still rendered single-line (`· BCA` present), no `🏦 Saldo\n•`.

- [ ] **Step 3: Rewrite `morningGlanceTemplate`**

In `src/proactive/composers/template.ts`, replace the existing `morningGlanceTemplate` function (the one currently starting `export function morningGlanceTemplate(payload: ProactivePayload): string`) with:

```ts
/**
 * Deterministic LLM-fallback for the morning glance. Renders the same structured
 * block the LLM path appends, plus a deterministic greeting, a yesterday line
 * (no LLM here), and the due-bill CTA when there are bills due today.
 */
export function morningGlanceTemplate(payload: ProactivePayload): string {
  const d = payload.data as {
    yesterday?: { count: number; totalSpend: number } | null;
    todayDueBills?: unknown[];
  };
  const parts: string[] = ['🌅 Pagi!'];
  parts.push(
    d.yesterday
      ? `Kemarin: ${d.yesterday.count} catatan, total ${idr(d.yesterday.totalSpend)}.`
      : 'Kemarin belum ada catatan — ada yang mau diinput?',
  );
  const block = renderMorningGlanceBlock(payload);
  if (block) parts.push(block);
  if ((d.todayDueBills ?? []).length > 0) parts.push(MORNING_GLANCE_DUE_CTA);
  return parts.join('\n\n');
}
```

The four interfaces above the old function (`MorningGlanceBalance`, `MorningGlanceUpcoming`, `MorningGlanceDue`, `MorningGlanceData` — currently lines ~98–106) are now dead code (the new renderers define their own `MG*` interfaces). Delete all four `interface MorningGlance*` declarations. The new renderers' interfaces (`MGAccount`, `MGBudget`, `MGUpcoming`, `MGDue`) remain.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: PASS (new + existing `morningGlanceTemplate` tests green).

- [ ] **Step 5: Verify types & lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors (the dead `MorningGlance*` interfaces were deleted in Step 3).

- [ ] **Step 6: Commit**

```bash
git add src/proactive/composers/template.ts tests/proactive/composers/template.test.ts
git commit -m "feat: render morning-glance fallback with bullets + budget bars"
```

---

## Task 7: Detector — add current-month budgets to `payload.data`

**Files:**
- Modify: `src/proactive/triggers/morning-glance.ts` (before the `payload` construction, ~line 56)
- Test: `tests/proactive/triggers/morning-glance.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/proactive/triggers/morning-glance.test.ts`:

1. Add `BudgetCode` to the type import on line 4:
```ts
import type { Account, BudgetCode, RecurringPayment, Transaction } from '../../../src/domain/entities.js';
```

2. Add a `mkBudget` helper next to the other `mk*` helpers (after `mkTxn`):
```ts
function mkBudget(over: Partial<BudgetCode>): BudgetCode {
  return { budgetCodeId: 'b', userId: 'u', name: '', monthlyBudget: 0, month: 6, year: 2026, spent: 0, createdAt: '', updatedAt: '', ...over };
}
```

3. Add a `budgets` option to `mockRepos` — change line 29 from:
```ts
    budgets: { findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
```
to:
```ts
    budgets: { findByUserAndMonth: vi.fn(async () => opts.budgets ?? []), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
```
and update the `mockRepos` signature (line 19) to accept budgets:
```ts
function mockRepos(opts: { accounts?: Account[]; recurrings?: RecurringPayment[]; yesterday?: Transaction[]; budgets?: BudgetCode[] } = {}): Repos {
```

4. Append a new test inside the `detectMorningGlance` describe block:
```ts
  it('adds month budgets sorted by pct desc with remaining, excluding zero-alloc codes', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca' })],
      budgets: [
        mkBudget({ budgetCodeId: 'b1', name: 'Makan', monthlyBudget: 600_000, spent: 450_000 }),
        mkBudget({ budgetCodeId: 'b2', name: 'Transport', monthlyBudget: 400_000, spent: 120_000 }),
        mkBudget({ budgetCodeId: 'b3', name: 'Hiburan', monthlyBudget: 0, spent: 0 }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { budgets: { name: string; pct: number; remaining: number; alloc: number; spent: number }[] };
    expect(data.budgets.map((b) => b.name)).toEqual(['Makan', 'Transport']); // 75% before 30%
    expect(data.budgets[0]).toMatchObject({ spent: 450_000, alloc: 600_000, remaining: 150_000, pct: 0.75 });
    expect(data.budgets.map((b) => b.name)).not.toContain('Hiburan'); // monthlyBudget 0 filtered
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/triggers/morning-glance.test.ts`
Expected: FAIL — `data.budgets` is `undefined` (detector doesn't emit budgets yet).

- [ ] **Step 3: Add the budgets fetch to the detector**

In `src/proactive/triggers/morning-glance.ts`, insert this block immediately before the `const payload: ProactivePayload = {` line (after the `yesterday` computation):

```ts
  // Current-month budgets: spent vs remaining + pct, sorted most-used first.
  // Zero-alloc codes carry no meaningful fraction, so they are filtered out.
  const budgets = (await repos.budgets.findByUserAndMonth(userId, year, month))
    .filter((c) => c.monthlyBudget > 0)
    .map((c) => {
      const alloc = c.monthlyBudget;
      const spent = c.spent;
      return {
        name: c.name,
        spent,
        alloc,
        remaining: alloc - spent,
        pct: alloc > 0 ? spent / alloc : 0,
      };
    })
    .sort((a, b) => b.pct - a.pct);
```

Then add `budgets` to the payload data. Change the `data:` line (currently `data: { balances, upcoming, yesterday, todayDueBills },`) to:

```ts
    data: { balances, upcoming, yesterday, todayDueBills, budgets },
```

`year` and `month` are already computed at the top of the detector (lines 18–19).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/triggers/morning-glance.test.ts`
Expected: PASS (new budgets test + all existing detector tests green).

- [ ] **Step 5: Verify types & lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/triggers/morning-glance.ts tests/proactive/triggers/morning-glance.test.ts
git commit -m "feat: include month budgets (spent/remaining/pct) in morning glance"
```

---

## Task 8: Shrink the morning-glance system prompt to greeting + yesterday

**Files:**
- Modify: `src/proactive/prompt.ts` (`buildMorningGlanceSystemPrompt`, currently lines 30–45)

The composer will soon send the model only `{ yesterday }`, so the prompt must ask for exactly the two prose lines it still owns and explicitly tell it not to mention saldo/budget/tagihan (those are rendered by the system).

- [ ] **Step 1: Write the failing test**

There is no dedicated proactive-prompt unit test, so add a focused one. Create no new file — add to `tests/proactive/composers/morning-glance.test.ts` is not ideal (it mocks `ai`); instead append to `tests/proactive/composers/template.test.ts` is also off-topic. Add a tiny standalone check by appending to `tests/proactive/composers/morning-glance.test.ts` is fine because the prompt builder is a pure string function independent of the `ai` mock. Append:

```ts
import { buildMorningGlanceSystemPrompt } from '../../../src/proactive/prompt.js';

describe('buildMorningGlanceSystemPrompt', () => {
  it('keeps the WIB date anchor and scopes the LLM to greeting + yesterday only', () => {
    const p = buildMorningGlanceSystemPrompt('Minggu, 28 Jun 2026');
    expect(p).toContain('Hari ini (WIB): Minggu, 28 Jun 2026');
    expect(p).toContain('sapaan pagi'); // greeting instruction
    expect(p).toContain('kemarin'); // yesterday instruction
    // must NOT instruct the LLM to render saldo/budget/tagihan (deterministic now)
    expect(p).not.toContain('sebutkan saldo');
    expect(p).not.toContain('Sebutkan tagihan');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/composers/morning-glance.test.ts`
Expected: FAIL — current prompt still contains saldo/tagihan instructions (`not.toContain('sebutkan saldo')` fails) and lacks the `sapaan pagi` / `kemarin` scope.

- [ ] **Step 3: Rewrite `buildMorningGlanceSystemPrompt`**

In `src/proactive/prompt.ts`, replace the existing `buildMorningGlanceSystemPrompt` function body (the `return \`...\``) with:

```ts
export function buildMorningGlanceSystemPrompt(todayLabel: string): string {
  return `Kamu menulis bagian prose untuk PESAN PAGI MoneyBot (morning glance). Bagian struktur (saldo, budget, tagihan) sudah dirender terpisah oleh sistem — kamu HANYA menulis dua baris: (1) sapaan pagi singkat, dan (2) satu kalimat komentar soal aktivitas pengeluaran kemarin. Tulis dalam Bahasa Indonesia yang natural dan hangat.

Hari ini (WIB): ${todayLabel}

ATURAN:
1. Tulis HANYA kedua baris itu, tanpa prefiks, tanpa menjelaskan bahwa kamu AI.
2. Format nominal pakai locale IDR: titik sebagai pemisah ribuan, tanpa simbol. JANGAN tulis "Rp" atau "IDR".
3. Baris 1: sapaan pagi singkat (boleh pakai satu emoji pagi).
4. Baris 2: kalau ada pengeluaran kemarin, sebut jumlah catatan dan totalnya secara singkat; kalau tidak ada catatan, beri satu ajakan ringan untuk mulai mencatat.
5. Jangan menyebut saldo, budget, atau tagihan — bagian itu sudah dirender sistem.
6. Jangan mengarang angka — pakai HANYA data kemarin yang diberikan.
7. Boleh pakai **tebal** untuk satu angka penting.`;
}
```

Keep the JSDoc comment above the function (the `/** System prompt for the morning glance … */` block) unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/composers/morning-glance.test.ts`
Expected: PASS — both the new prompt test and the existing composer test that asserts `system: expect.stringContaining('Hari ini (WIB): Minggu, 28 Jun 2026')` still pass.

- [ ] **Step 5: Verify types & lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/prompt.ts tests/proactive/composers/morning-glance.test.ts
git commit -m "feat: scope morning-glance prompt to greeting + yesterday prose"
```

---

## Task 9: Composer — stitch prose + deterministic block + CTA

**Files:**
- Modify: `src/proactive/composers/morning-glance.ts` (the whole `createMorningGlanceComposer` body)
- Test: `tests/proactive/composers/morning-glance.test.ts`

- [ ] **Step 1: Update the tests to the new assembly**

In `tests/proactive/composers/morning-glance.test.ts`, replace the existing `payload` helper and the four tests with the versions below. (The `generateText` mock and `vi.mock('ai', …)` at the top stay unchanged.)

Replace the `payload` helper (lines ~12–17) with:

```ts
const payload = (over: {
  balances?: object[];
  upcoming?: object[];
  yesterday?: { count: number; totalSpend: number } | null;
  todayDueBills?: object[];
  budgets?: object[];
} = {}): ProactivePayload => ({
  triggerType: 'morning_glance',
  dedupKey: 'morning-glance:2026-06-22',
  channel: 'llm',
  data: {
    balances: over.balances ?? [],
    upcoming: over.upcoming ?? [],
    yesterday: over.yesterday ?? null,
    todayDueBills: over.todayDueBills ?? [],
    budgets: over.budgets ?? [],
  },
});
```

Replace the four tests inside `describe('createMorningGlanceComposer', …)` with:

```ts
  it('appends the deterministic block + CTA to LLM prose and keeps the keyboard', async () => {
    generateText.mockResolvedValue({ text: '🌅 Pagi, Devin!' });
    const compose = createMorningGlanceComposer(model);
    const out = await compose(payload({
      balances: [{ name: 'BCA', balance: 5_200_000 }],
      yesterday: { count: 2, totalSpend: 85_000 },
      todayDueBills: [{ recurringId: 'r1', name: 'Spotify', amount: 59_900, account: 'BCA CC' }],
    }), { now: new Date('2026-06-22T14:00:00Z') });
    const o = out as { text: string; replyMarkup?: { inline_keyboard: unknown[][] } };
    // prose first
    expect(o.text.startsWith('🌅 Pagi, Devin!')).toBe(true);
    // deterministic block appended
    expect(o.text).toContain('🏦 Saldo\n• BCA 5.200.000');
    // CTA last
    expect(o.text.endsWith('Tagihan hari ini tinggal dipencet di bawah ya 👇')).toBe(true);
    // keyboard still built from todayDueBills
    expect(o.replyMarkup?.inline_keyboard).toHaveLength(1);
  });

  it('omits the CTA and keyboard when there are no due bills', async () => {
    generateText.mockResolvedValue({ text: '🌅 Pagi tenang!' });
    const compose = createMorningGlanceComposer(model);
    const out = await compose(payload({ todayDueBills: [] }), { now: new Date('2026-06-22T14:00:00Z') });
    const o = out as { text: string; replyMarkup?: unknown };
    expect(o.replyMarkup).toBeUndefined();
    expect(o.text).not.toContain('dipencet');
  });

  it('sends only { yesterday } to the model, not balances/budgets', async () => {
    generateText.mockResolvedValue({ text: '🌅 Pagi!' });
    const compose = createMorningGlanceComposer(model);
    await compose(payload({
      balances: [{ name: 'BCA', balance: 5_200_000 }],
      budgets: [{ name: 'Makan', spent: 1, alloc: 2, remaining: 1, pct: 0.5 }],
      yesterday: { count: 1, totalSpend: 10_000 },
      todayDueBills: [],
    }), { now: new Date('2026-06-22T14:00:00Z') });
    expect(generateText).toHaveBeenCalledTimes(1);
    const call = (generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain('Kemarin');
    expect(call.prompt).not.toContain('BCA');
    expect(call.prompt).not.toContain('Makan');
  });

  it('injects today\'s WIB date into the morning-glance system prompt', async () => {
    generateText.mockResolvedValue({ text: '🌅 Pagi!' });
    const compose = createMorningGlanceComposer(model);
    // 2026-06-28T03:00:00Z -> 10:00 WIB, Sunday 28 Jun 2026.
    await compose(payload([]), { now: new Date('2026-06-28T03:00:00Z') });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ system: expect.stringContaining('Hari ini (WIB): Minggu, 28 Jun 2026') }),
    );
  });

  it('falls back to the full template when generateText throws', async () => {
    generateText.mockRejectedValue(new Error('model down'));
    const compose = createMorningGlanceComposer(model);
    const out = await compose(payload({
      balances: [{ name: 'BCA', balance: 1_000_000 }],
      yesterday: null,
      todayDueBills: [],
    }), { now: new Date('2026-06-22T14:00:00Z') });
    const o = out as { text: string };
    expect(o.text).toContain('🌅 Pagi!');
    expect(o.text).toContain('🏦 Saldo'); // deterministic block rendered by fallback too
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/proactive/composers/morning-glance.test.ts`
Expected: FAIL — composer still returns raw LLM text without the appended block/CTA, and still sends the full `payload.data`.

- [ ] **Step 3: Rewrite the composer**

In `src/proactive/composers/morning-glance.ts`:

1. Update the `template.js` import (line 6) to also pull in the block renderer and the CTA:

```ts
import { morningGlanceTemplate, renderMorningGlanceBlock, MORNING_GLANCE_DUE_CTA } from './template.js';
```

2. Replace the entire body returned by `createMorningGlanceComposer` with:

```ts
  return async (payload, ctx) => {
    const data = payload.data as {
      yesterday?: { count: number; totalSpend: number } | null;
      todayDueBills?: { recurringId: string; name: string }[];
    };
    const dueBills = data.todayDueBills ?? [];
    const replyMarkup = dueBillsKeyboard(dueBills);

    let prose: string;
    try {
      const { text: out } = await generateText({
        model,
        system: buildMorningGlanceSystemPrompt(todayWibDisplay(ctx.now)),
        // Only yesterday is prose-owned; saldo/budget/tagihan are rendered by the system.
        prompt: `Kemarin (WIB):\n${JSON.stringify(data.yesterday ?? null)}`,
      });
      prose = out.trim();
    } catch (err) {
      logEvent('warn', 'morning glance llm failed; falling back to template', { error: (err as Error).message });
      const fallback: ComposerOutput = { text: morningGlanceTemplate(payload) };
      if (replyMarkup) fallback.replyMarkup = replyMarkup;
      return fallback;
    }

    const block = renderMorningGlanceBlock(payload);
    const parts = [prose, block].filter(Boolean);
    if (dueBills.length > 0) parts.push(MORNING_GLANCE_DUE_CTA);

    const result: ComposerOutput = { text: parts.join('\n\n') };
    if (replyMarkup) result.replyMarkup = replyMarkup;
    return result;
  };
```

The top-of-file imports (`generateText`, `LanguageModel`, `buildMorningGlanceSystemPrompt`, `todayWibDisplay`, `dueBillsKeyboard`, `logEvent`, `Composer`, `ComposerOutput`) are unchanged and already present.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/proactive/composers/morning-glance.test.ts`
Expected: PASS (all five updated tests green).

- [ ] **Step 5: Verify types & lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/composers/morning-glance.ts tests/proactive/composers/morning-glance.test.ts
git commit -m "feat: compose morning glance as prose + deterministic block + CTA"
```

---

## Task 10: Full verification & spec coverage check

**Files:** none (verification only)

- [ ] **Step 1: Run the complete proactive test suite**

Run: `npx vitest run tests/proactive`
Expected: all tests PASS (template renderers, detector budgets, prompt scope, composer assembly, dispatcher).

- [ ] **Step 2: Full type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 3: Run the entire suite once**

Run: `npm test`
Expected: all tests PASS (this truncates the dev DB per `CLAUDE.md`; the new tests are pure/unit and unaffected).

- [ ] **Step 4: Manual spec coverage check**

Confirm each spec requirement has a task behind it:
- Enforced account bullets → Task 2 + Task 6 (fallback) + Task 9 (composer).
- Budget spent vs remaining, per-category → Task 7 (data) + Task 3 (render).
- Percentage + `|————•——————|` bar, code-drawn → Task 1 + Task 3.
- Mobile length discipline (caps, skip-empty) → Task 3 + Task 4 + Task 5.
- LLM owns only greeting + yesterday → Task 8 + Task 9.
- Fallback renders identically → Task 6.
- Deterministic block shared by both paths → Task 5 (renderer) + Task 6 (fallback) + Task 9 (composer).

If any is missing, add a task before considering the work done.

- [ ] **Step 5: Final commit (if any cleanup) otherwise done**

If steps 1–3 required no fixes, there is nothing to commit and the feature is complete. If lint/tsc required fixes (e.g. removing unused `MorningGlance*` interfaces), commit them:

```bash
git add -A
git commit -m "chore: morning glance v2 verification cleanup"
```

---

## Notes for the implementer

- **Em-dash vs hyphen:** the bar uses the em-dash character `—` (U+2014), not the ASCII hyphen `-`. Copy glyphs verbatim from this plan. This matters for `renderBudgetBar` cell counts and for Telegram's markdown-table detector (em-dashes are *not* treated as table separators — verified).
- **Backtick wrapping is load-bearing:** `renderBudgetBar` wraps its output in backticks so `markdownToTelegramHTML` (at the send boundary in `cron.ts`) converts it to `<code>`, rendering the bar monospace and aligned. Do not remove the backticks.
- **Locale:** all amounts go through the existing `idr()` helper (dot thousands separator, no symbol) — do not introduce `Rp`/`IDR`.
- **No new files:** everything renders out of `template.ts`; the composer and detector are edits to existing files.
