# Morning Glance v2 — Budget Bars & Enforced Layout

**Date:** 2026-06-30
**Status:** Design (pending implementation plan)
**Scope:** The proactive morning-glance message only. No other triggers, no dispatch/dedup/keyboard changes.

## Goal

Upgrade the morning glance (daily ~08:00 WIB proactive message) so it:

1. **Enforces a bullet list** for the account (saldo) list — guaranteed, not prompt-nudged.
2. **Adds budget spent vs remaining** for the current month, per budget code.
3. Renders each budget as a **percentage + a code-drawn range bar** `|————•——————|`.
4. Stays **short and stable** for Telegram mobile reading.

The report's structured visuals (account bullets, budget bars, bill lists) become **deterministic** — rendered in code. The LLM keeps only the warm prose (greeting + a one-line read on yesterday). This is the user's explicit choice: deterministic visuals, LLM-owned prose.

## Context & assessment (why the seams stay as they are)

The proactive layer already separates three concerns:

- **Detector** (`triggers/morning-glance.ts`) — gathers facts, pure given `repos` + `now`.
- **Composer** (`composers/morning-glance.ts`) — calls the model, attaches the due-bills keyboard, falls back to a template.
- **Prompt** (`prompt.ts`, `buildMorningGlanceSystemPrompt`) — the prose instructions sent to the model.

This separation is an asset for this change, not overhead: the report's *shape* is governed by the prompt + the detector data, while the composer remains thin plumbing. Critically, it gives deterministic formatting (code) a clean home distinct from prose (prompt) — which is exactly what a reliable progress bar needs, since LLMs drift on glyph-counting and `•` placement. **We keep all three seams; we do not merge them.**

The morning glance keeps its own dedicated composer (vs the generic `llmCompose`) because it must return `{ text, replyMarkup }` to attach the inline keyboard and uses a distinct forward-looking prompt. Unchanged.

## Design decisions (chosen)

| Decision | Choice | Rationale |
|---|---|---|
| Who renders structured visuals | **Code** (deterministic) | Bars/bullets must be stable & enforceable; LLM drifts on glyph layout. |
| Budget granularity | **Per-category** (one bar per budget code) | User wants per-code visibility. |
| Fusion of prose + structured block | **Composer appends** the deterministic block to LLM prose | Bulletproof — the LLM never touches the bar. |
| Budget figure format | **Full IDR** (locale convention: `450.000`) | Consistent with the rest of the bot. Revisit if length is a problem. |

## Data model — detector change

`triggers/morning-glance.ts` already computes `year`, `month`, `monthTag`. Add a budgets fetch (the same call `budget-threshold.ts` makes):

```ts
const codes = await repos.budgets.findByUserAndMonth(userId, year, month);
const budgets = codes
  .filter((c) => c.monthlyBudget > 0)
  .map((c) => {
    const alloc = c.monthlyBudget;
    const spent = c.spent;
    return {
      name: c.name,
      spent,
      alloc,
      remaining: alloc - spent,
      pct: alloc > 0 ? spent / alloc : 0, // fraction 0..N (may exceed 1)
    };
  })
  .sort((a, b) => b.pct - a.pct);
```

Add to `payload.data`:

```ts
data: { balances, upcoming, yesterday, todayDueBills, budgets }
```

`BudgetCode` (entity) carries `name`, `spent`, `monthlyBudget` only — **no icon, no category link.** Budget lines therefore render without a per-line emoji. (Adding an icon via a category mapping is explicitly out of scope.)

## Deterministic renderers — `composers/template.ts`

Add pure, tested functions (one source of truth, reused by the LLM path **and** the template fallback). All amounts via the existing `idr()` helper already in this file.

### `renderBudgetBar(pct: number, width = 10): string`

- Inner width `width` cells between the pipes.
- `left = clamp(round(pct * width), 0, width)` dashes before the `•`.
- `right = width - left` dashes after.
- Returns `` `|<— ×left>•<— ×right>|` `` wrapped in backticks so Telegram renders it monospace (`markdownToTelegramHTML` → `<code>…</code>`), guaranteeing bar alignment.

```
pct 0.00 → |•——————————|
pct 0.75 → |————————•——|
pct 1.00 → |——————————•|
pct 1.20 → |——————————•|   (clamped; the line's pct text shows 120%)
```

### `renderAccountList(balances: { name; balance }[]): string`

One bullet line per active account (the enforced bullet list):

```
🏦 Saldo
• BCA 12.500.000
• GoPay 450.000
```

Returns `''` when `balances` is empty (section is omitted).

### `renderBudgetBlock(budgets, monthLabel: string): string`

- Cap at **3** codes (already sorted by pct desc in the detector). If more, append a final `+N lainnya` line.
- Per-code line: `<name> <spent>/<alloc> · sisa <remaining> · <pct>% <bar>` — full IDR via `idr()`, `pct` rounded, bar via `renderBudgetBar`.
- Over-budget (`pct > 1.0`): prefix the line with 🚨 and show the real (e.g. `120%`) pct; the bar stays clamped full.

```
📊 Budget Juni
Makan 450.000/600.000 · sisa 150.000 · 75% |————————•——|
Transport 120.000/400.000 · sisa 280.000 · 30% |———•——————|
+1 lainnya
```

Returns `''` when `budgets` is empty.

### `renderUpcoming(upcoming): string`

Unchanged format from today's `morningGlanceTemplate` (already bulleted), capped at **3** with `+N lainnya` beyond. Returns `''` when empty.

### `renderTodayDue(todayDueBills): string`

Bulleted "Jatuh tempo hari ini" section, one `• <name> — <amount> via <account>` per bill. This is required because `dueBillsKeyboard` only labels buttons with the bill name when there is **more than one** due bill — so for a single due bill the text is the only place the bill is named. Returns `''` when empty (the CTA also gates on this).

### `renderMorningGlanceBlock(payload): string`

Assembles the non-empty sections (saldo → budget → upcoming → todayDue) joined by blank lines. Returns `''` if all empty.

### `morningGlanceTemplate` refactor

Rewrite to reuse the renderers: deterministic greeting + `renderMorningGlanceBlock` + deterministic CTA. The fallback thus renders **identically** to the LLM path's structured block.

## Composer change — `composers/morning-glance.ts`

The composer assembles the final text in a fixed order:

1. **LLM prose** — one `generateText` call returning a 1-line greeting + a 1-line yesterday commentary (system prompt below). The user prompt sent to the model contains **only `{ yesterday }`** (serialized) — NOT the full `payload.data`. Balances/budgets/upcoming/due are rendered deterministically and must not leak into the prose, so the model is given no access to them. On throw → fall back to `morningGlanceTemplate` (which now produces the full deterministic message) and return.
2. **Deterministic block** — `renderMorningGlanceBlock(payload)` (saldo → budget → upcoming → todayDue).
3. **CTA** — if `todayDueBills` is non-empty, append the fixed line `Tagihan hari ini tinggal dipancet di bawah ya 👇`.
4. **Keyboard** — unchanged `dueBillsKeyboard(todayDueBills)`.

Assembly (pseudo):

```ts
const prose = /* generateText({ system, prompt: JSON.stringify({ yesterday }) }) or template fallback */;
const block = renderMorningGlanceBlock(payload);
const parts = [prose, block].filter(Boolean);
if (bills.length > 0) parts.push('Tagihan hari ini tinggal dipancet di bawah ya 👇');
const text = parts.join('\n\n');
```

The keyboard wiring is unchanged. `markdownToTelegramHTML` runs at the send boundary as today, so backticked bars become `<code>` and `**bold**` in prose still works.

> Open (deferred): LLM budget commentary (e.g. "Makan udah 75%, hati-hati"). Not in v1 — the pct + bar is self-explanatory and adding it would re-introduce the placement/fusion fiddliness we just removed.

## Prompt change — `prompt.ts`

`buildMorningGlanceSystemPrompt` shrinks to own **only** the prose it still writes:

- Output: a 1-line morning greeting + a 1-line read on yesterday's spending (count + total), or — if `yesterday` is null — a single light nudge ("Kemarin belum ada catatan — ada yang mau diinput?").
- Keep: Bahasa Indonesia, natural/warm, IDR-locale formatting (dot thousands, no `Rp`/`IDR`), no markdown tables, optional `**bold**` on one number.
- Drop: the saldo/tagihan/CTA/budget rules (all deterministic now). Drop the old "maks 5 baris" line-limit rule (no longer meaningful — the composer controls length).

`buildProactiveSystemPrompt` (the other triggers) is **untouched**.

## Length discipline (mobile)

- Skip any section whose data is empty.
- Budgets capped at 3 (+ `+N lainnya`); upcoming capped at 3 (+ `+N lainnya`).
- Only active accounts (detector already filters `isActive`).
- Realistic total ≈ 10–13 mobile lines with a typical 2–3 accounts, 2–3 budgets, 1–2 upcoming bills.

If this still reads long in practice, the cheapest lever is the budget figure format (full IDR → compact `rb` shorthand) — a one-line renderer change, held back for now to keep locale consistency.

## Edge cases

- **No budgets / no balances / no upcoming:** the corresponding section is omitted; the message degrades gracefully to greeting + whatever exists + CTA.
- **`pct` exactly 0:** bar shows `•` at the far left; line still renders (the code has a budget set, just nothing spent).
- **Over-budget (`pct > 1.0`):** 🚨 prefix, real pct shown, bar clamped full.
- **LLM failure:** template fallback produces the full deterministic message (greeting + block + CTA) — no regression.
- **Rounding at boundaries:** `round(pct × width)` with `clamp(0, width)`; cross-multiply is unnecessary at display width 10 (the threshold detector already handles the exact-boundary case elsewhere).

## Testing

New unit tests (pure renderers, no DB):

- `renderBudgetBar`: pct 0 / 0.5 / 0.75 / 1.0 / 1.2 (over), and that output is wrapped in backticks with exactly `width` inner cells.
- `renderAccountList`: bullets enforced; empty → `''`.
- `renderBudgetBlock`: cap at 3 + `+N lainnya`; over-budget 🚨 + clamped bar; empty → `''`.
- `renderUpcoming`: cap at 3 + `+N lainnya`; empty → `''`.
- `renderTodayDue`: bullets each due bill (name + amount + account); empty → `''`.
- `renderMorningGlanceBlock`: empty sections omitted; ordering saldo → budget → upcoming → todayDue.

Updated existing tests:

- `triggers/morning-glance.test.ts`: detector now emits `budgets` (sorted by pct desc, capped, `monthlyBudget > 0` filter, `remaining`/`pct` fields).
- `composers/morning-glance.test.ts`: with `generateText` mocked to return prose, assert final text = `prose + block + CTA` and the keyboard is still built from `todayDueBills`; no-due-bills case omits the CTA; throw → template fallback text contains the block.
- `composers/template.test.ts`: `morningGlanceTemplate` now bullet-accounts and renders budget bars.
- `prompt.ts` test (if present): updated to the new shorter instruction set.

Verification gate (per CLAUDE.md): `npx tsc --noEmit` **and** `npm run lint` **and** the relevant `npx vitest run`.

## Out of scope

- Per-budget emoji icons (schema has no category link).
- LLM budget commentary / insight prose.
- Aggregated (single) budget bar — per-category chosen.
- Any change to the other 4 triggers, dispatch, dedup, quiet hours, or the due-bills keyboard/callback handling.
- Merging the composer/prompt separation (kept by design).
