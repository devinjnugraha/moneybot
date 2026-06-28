# Proactive agent: today's-date context

**Date:** 2026-06-28
**Status:** Approved (decision: today's date + weekday in Bahasa Indonesia)

## Problem

The reactive agent already knows today's date — `buildSystemPrompt(todayWib)` in
`src/agent/system-prompt.ts` embeds `Hari ini (WIB): <YYYY-MM-DD>`. The proactive
side does **not**. Both proactive LLM entry points use static prompt constants
with zero date awareness:

- `src/proactive/composers/llm.ts` → `PROACTIVE_SYSTEM_PROMPT` (static); only
  `payload.data` is serialized into the user turn.
- `src/proactive/composers/morning-glance.ts` → `MORNING_GLANCE_SYSTEM_PROMPT`
  (static).

So when the proactive agent writes "ringkasan **hari ini**", "aktivitas
**kemarin**", or "tagihan **minggu ini**", it has no anchor. The date is already
available — composers are typed `(payload, ctx: ComposerCtx)` with `ctx.now`
injected by the dispatcher (`dispatcher.ts:58`) — it is simply not used.

## Goal

Give the proactive LLM composers today's-date context so their relative-time
prose is grounded.

## Decision

Inject a single human-readable line into each proactive system prompt:

```
Hari ini (WIB): Minggu, 28 Jun 2026
```

That is **today's date + weekday in Bahasa Indonesia**, formatted
`<Weekday-ID>, DD Mon YYYY`. Weekday is Indonesian (`id-ID` long); the
`DD Mon YYYY` date uses the same English month abbreviation the reactive prompt
already uses for display ("07 Jun 2026"). This is slightly richer than the
reactive agent's bare ISO date (chosen deliberately — the proactive prompts
reason about weekdays/weeks in prose), but intentionally does **not** include
yesterday's date or an ISO form, because the detectors already pass the concrete
data ranges and the proactive composer has no tool access (no date query params
to produce).

## Changes

1. **`src/domain/time.ts`** — add `todayWibDisplay(now = new Date()): string`,
   returning `<Weekday-ID>, DD Mon YYYY` via `Intl.DateTimeFormat` (two locale
   calls: `id-ID` weekday + `en-GB` date, both `timeZone: 'Asia/Jakarta'`).
   Matches the existing `todayWIB` Intl style. Pure / injectable.

2. **`src/proactive/prompt.ts`** — convert the two static consts into builder
   functions mirroring `buildSystemPrompt`:
   - `buildProactiveSystemPrompt(todayLabel: string): string`
   - `buildMorningGlanceSystemPrompt(todayLabel: string): string`
   Each inserts `Hari ini (WIB): ${todayLabel}` right after the opening
   sentence, before `ATURAN:`. The `todayLabel` param is the formatted display
   string (not ISO) — named distinctly from the reactive side's ISO `todayWib`.
   The old const exports are removed (only the two composers imported them).

3. **`src/proactive/composers/llm.ts`** — `llmCompose(payload, model,
   now = new Date())` builds the system prompt via
   `buildProactiveSystemPrompt(todayWibDisplay(now))`. `now` defaults to
   `new Date()` so the existing 2-arg call sites/tests still work; the live
   path supplies the injected time.

4. **`src/proactive/composers/resolve.ts`** — `createComposer`'s inner arrow
   becomes `(payload, ctx)` and forwards `ctx.now` to `llmCompose` (currently it
   drops `ctx`).

5. **`src/proactive/composers/morning-glance.ts`** — inner arrow becomes
   `(payload, ctx)` and builds the prompt via
   `buildMorningGlanceSystemPrompt(todayWibDisplay(ctx.now))`.

## Tests

- `tests/domain/time.test.ts` — `todayWibDisplay` for a known `now` (e.g.
  `2026-06-28T03:00:00Z` → WIB same calendar day → `"Minggu, 28 Jun 2026"`),
  plus a weekday-rollover case.
- `tests/proactive/composers/llm.test.ts` — assert `generateText` receives a
  `system` containing `Hari ini (WIB)` and the derived weekday+date when `now`
  is passed.
- `tests/proactive/composers/morning-glance.test.ts` — assert the morning-glance
  `system` prompt contains the injected date line.

## Verification

`npx tsc --noEmit` + `npm run lint` + `npx vitest run` (affected suites and full
suite).
