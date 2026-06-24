# Proactive Triggers — "Watching Me" Layer (Slice 1)

## Document Control

| Field      | Value                                                                 |
| ---------- | --------------------------------------------------------------------- |
| Project    | MoneyBot                                                              |
| Topic      | Merged morning glance + reactive inline insight                       |
| Date       | 2026-06-24                                                            |
| Status     | Draft v2 — pending user review                                        |
| Depends on | `src/proactive/` engine, `src/scheduler/cron.ts`, `src/scheduler/recurring-fire.ts`, `src/telegram/formatter.ts`, `src/telegram/callback-query.ts`, `src/agent/system-prompt.ts`, write tools in `src/agent/tools.ts` |

> **v2 change:** per user direction, the morning glance is **merged with the recurring-bill flow** into one morning message, **budget pacing is deferred**, and the build order is **morning glance first, then inline**.

---

## 1. Problem

The bot has a mature proactive engine but only feels present when something is **wrong**. Every existing trigger is either *scheduled* (`0 21 * * *` summary) or *reactive to a bad state* (budget breach, anomaly, logging gap). On a normal day the bot is silent until 21:00 — which reads as a fire alarm, not a companion. The user's words: *"it doesn't feel like an assistant watching me and my finance."*

The reactive agent also under-uses its one inline-insight surface: system-prompt rule 4 surfaces **only** budget-overspend after a write. Every other write confirmation is a silent structured block — the exact moment the user is most present, and the bot says nothing observational.

A second irritation: the morning has **two** near-identical touches queued — the 08:00 recurring-bill prompt (`fireRecurringPayments`) and what would be a separate glance. The user wants them **merged into one** morning message.

## 2. Goal

Make the bot feel like an **observant companion that anticipates and remembers**, within the user's stated constraints:

- **Directions chosen:** event-driven reaction + anticipation + memory/rapport.
- **Explicitly out:** autonomy/initiative — the bot informs and proposes-lightly; the user acts. (The recurring-bill "Catat/Tunda/Lewati" inline buttons are the ceiling.)
- **Touchpoint budget:** 3–5 **unprompted** touches/day (separate from inline reactions, which are free).
- **Inline data strategy:** enrich write-tool results (Option A) — zero extra LLM round-trips, no tax on read-only turns.

## 3. Scope (Slice 1)

Two changes:

| # | Change | Direction | Cadence | Surface |
| --- | --- | --- | --- | --- |
| S1-1 | **Merged morning glance** (glance + today's due-bill confirm buttons in one message; retires the standalone recurring cron) | anticipation + rapport | new cron `0 8 * * *` WIB | proactive push (LLM text + inline keyboard) |
| S1-2 | **Inline post-write insight** | event-driven | every write | reactive agent (rule-4 generalization + enriched write-tool result) |

### Non-goals (deferred to later slices)

- **Budget pacing prediction** (deferred from v1 per user direction).
- Bill **due-soon** pre-warning (the merged morning glance lists the *week's* upcoming bills as text; "due today" gets buttons).
- **Habit-profile** references (needs a stats precompute — heavier).
- **Month-end rollover** prompt (resolves SRS OQ-01).
- Warmer **weekly reflection** tone on the anomaly trigger.
- Any autonomous write / auto-confirm.

## 4. Architecture

### 4.1 Merged morning glance flows through the proactive engine

The engine gains **optional inline-keyboard support** so the morning message can carry due-bill buttons while keeping all guardrails (mute / quiet hours / per-day cap / dedup) and seeding a conversational turn. This is the only engine change and is backward-compatible.

```
cron (node-cron, Asia/Jakarta)  0 8 * * *
   └─ runProactivePass({ detector: morningGlance, composer, repos, policy, now, send })
        ├─ for each user (repos.users.findAll())
        │    ├─ detector → ProactivePayload[]  (glance data + todayDueBills)
        │    ├─ guard: isMuted / inQuietHours / per-day cap / dedup (outreach_log)
        │    ├─ composer(payload) → { text, replyMarkup? }   (LLM text + keyboard from todayDueBills)
        │    ├─ send(chatId, text, replyMarkup?)             ￩ NEW: optional reply_markup
        │    ├─ outreach_log.record(user, 'morning-glance:<date>', payload)
        │    └─ seed assistant turn in session_contexts (two-way reply enabled)
        └─ per-user try/catch
```

### 4.2 Engine change — optional `reply_markup`

- **Composer contract widens** from `(payload) => Promise<string>` to `(payload) => Promise<{ text: string; replyMarkup?: InlineKeyboardMarkup }>`. Existing composers return a bare `string`; a thin adapter wraps it as `{ text }` so they need no changes.
- **`send` widens** to `(chatId, text, replyMarkup?) => Promise<void>`; when `replyMarkup` is present it is passed as `reply_markup` to `bot.api.sendMessage` (alongside the existing `parse_mode: 'HTML'`). Implemented where `send` is defined in `src/scheduler/cron.ts`.
- **`runProactivePass`** threads `composed.replyMarkup` into `send`.
- **Morning-glance composer** is the first to populate `replyMarkup` (from `payload.todayDueBills`). Plain-text triggers leave it `undefined`.

### 4.3 New `ProactiveTriggerType`

Add `morning_glance` to the union in `src/domain/entities.ts` (`budget_pacing` is deferred).

---

## 5. S1-1 · Merged Morning Glance

**Why:** one forward-looking morning message per user — balances, the week's upcoming bills, yesterday's activity, **and** today's due bills as tappable confirms. Replaces the separate 08:00 recurring ping + the would-be glance. The day's "she's watching" anchor, bookended with the 21:00 recap (morning looks ahead, evening looks back).

### 5.1 Trigger

- **File:** `src/proactive/triggers/morning-glance.ts` (new; implements the existing `Detector` contract).
- **Cron:** `PROACTIVE_MORNING_GLANCE_CRON`, default `0 8 * * *`, registered in `src/scheduler/cron.ts`. **Replaces** the `config.CRON_SCHEDULE` recurring-fire cron.
- **dedup key:** `morning-glance:<YYYY-MM-DD>` (WIB) → exactly once per morning per user.

### 5.2 Detector payload

```typescript
interface MorningGlanceData {
  balances: { name: string; type: AccountType; balance: number }[];  // active accounts
  upcoming: { name: string; amount: number; account: string; dueDate: string }[]; // recurring due tomorrow..+7d (text only)
  yesterday: { count: number; totalSpend: number } | null;           // null = no expenses logged yesterday
  todayDueBills: { recurringId: string; name: string; amount: number; account: string }[]; // actionable today → get buttons
}
```

**Data sources (per user, all existing repos):**
- **Balances** → `IAccountRepository.findAllByUserId`.
- **Recurrings** → `IRecurringPaymentRepository.findAllByUserId(userId)` once, then partition by `nextFireAt` (WIB):
  - `todayDueBills` = active, `nextFireAt == today`, and `lastFiredAt` is null or in a different month than current (same "not already processed this month" guard as `findDueToday`, so a confirmed/skipped bill is not re-prompted). Resolve `account` name via `accounts.findById`.
  - `upcoming` = active, `nextFireAt` in `tomorrow .. +7 days`. **Excludes today** (today's bills are in `todayDueBills` with buttons, not duplicated as text).
- **Yesterday** → `ITransactionRepository.findByDateRange(userId, yesterday, yesterday)`, count + sum of `type = 'expense'` (transfers excluded per A6); `null` when none.

> If `todayDueBills` is empty, the message is a plain-text glance (no keyboard). The common case (0–1 due bills/day) stays compact; >1 bills produce one button-group per bill.

### 5.3 Composer

- **Text:** LLM channel (warm, ≤5 lines). Intent: greet, compact balances, name the week's upcoming bills (or "tagihan minggu ini aman"), note yesterday's activity (or its absence — light/informational), and if there are due bills, a one-line lead-in ("🔔 Tagihan jatuh tempo hari ini:"). Bahasa Indonesia, IDR format, no `Rp`/`IDR`.
- **Keyboard (`replyMarkup`):** built programmatically from `todayDueBills` — **not** by the LLM. One row per bill:
  - `[✅ Catat] [⏳ Tunda] [⏭️ Lewati]` with `callback_data` `rec:<recurringId>:confirm|defer|skip`.
  - When **more than one** bill is due, prefix each button's label with the bill name (e.g. `✅ Spotify`) to disambiguate which row acts on which bill.
  - Callback-data format **matches `recurringPrompt` exactly**, so `callback-query.ts` (`bot.callbackQuery(/^rec:.+/, …)`) handles taps **unchanged** — including its `lastFiredAt`-this-month idempotency guard and the defer → `pendingRecurringConfirmation` → `defer-sweep` re-prompt path.

### 5.4 What retires vs. stays

| Component | Disposition |
| --- | --- |
| `fireRecurringPayments` cron (`config.CRON_SCHEDULE`, 08:00) | **Retired** — due-today logic folds into the morning-glance detector (`findDueToday`/`findAllByUserId` partition). |
| `fireRecurringPayments` function | Remove (or leave dead) — no remaining caller. |
| `config.CRON_SCHEDULE` | Becomes unused; remove from `config/index.ts` + `.env.example`. |
| `recurringPrompt` (`formatter.ts`) | **Stays** — `defer-sweep` re-uses it for post-defer re-prompts. |
| `defer-sweep.ts` (*/5) | **Stays** — handles the 1-hour-later re-prompt after a user taps Tunda. Independent of the morning send. |
| `callback-query.ts` | **Stays unchanged.** |

### 5.5 Guardrail / behavior note

The merged message flows through the engine, so it is subject to `/nudges`, quiet hours, and the per-day cap. At `0 8 * * *` it is **outside** the default quiet window (`22:00–07:00`), so quiet hours won't suppress it. **Behavior change to flag:** a user who has muted nudges (`/nudges off`) will no longer receive the morning bill reminder via push (they can still ask "tagihan hari ini?" reactively). See OQ-P1.

---

## 6. S1-2 · Inline Post-Write Insight

**Why:** the cheapest, highest-frequency "watching me" channel — every write conversation gets an observational line for free.

### 6.1 Data strategy — Option A (enrich write-tool result)

Extend the result of `create_expense`, `create_income`, `create_transfer`, `update_transaction` with a small `insightContext` snapshot, computed in the same code path that already performs the write (cheap indexed reads on `idx_txn_user_date`):

```typescript
interface InsightContext {
  balanceAfter: number;            // balance of the affected account after the write
  todayCountInCategory: number;    // # of expenses in same categoryId today (streak: "kopi ke-3 hari ini")
  todaySpendInCategory: number;    // sum of same-category expenses today
  weekSpendInCategory: number;     // sum of same-category expenses, Mon..today
  budgetSpentPct?: number;         // for budget-tagged expenses (partly returned today)
  budgetRemaining?: number;
}
```

- For `transfer`/`income` where category is absent, the per-category fields are omitted; only `balanceAfter` applies.
- New repository method on `ITransactionRepository` (interface in `src/repositories/interfaces.ts`, impl in `src/adapters/neon/`):
  - `getCategoryContext(userId, categoryId, { weekStart, today }): { todayCount, todaySpend, weekSpend }`
- **Latency (NFR-01):** bounded, indexed reads appended to a turn that already hits the DB on a write. No extra LLM round-trip; read-only turns (e.g. "saldo saya") are unaffected.

### 6.2 System-prompt rule 4 generalization

Today rule 4 is budget-overspend only. Replace with a bounded insight palette (Bahasa Indonesia, mirroring existing rule style). Intent:

> **INSIGHT PASCA-TULIS (opsional, maks 1 baris):** Setelah `create_expense`/`create_income`/`create_transfer`/`update_transaction` berhasil, jika `insightContext` di hasil tool menunjukkan hal yang patut dicatat, tambahkan **SATU** kalimat singkat setelah blok konfirmasi (dan status budget). Pilih yang paling relevan:
> - nominal jauh di atas kebiasaan (bandingkan `todaySpendInCategory`/`weekSpendInCategory`),
> - streak/jumlah hari ini (`todayCountInCategory`),
> - saldo yang menipis / limit hampir penuh (`balanceAfter`),
> - reaksi pemasukan.
> **Kalau tidak ada yang menonjol, jangan tambahkan apa-apa.** Tetap ringkas — jangan bertele-tele.

- Bounded to one line, within the recently-raised confirmation line budget (commit 8646791: max lines 6→10).
- This is **reactive**, not a proactive trigger — it is **not** subject to `/nudges` or quiet hours. A global kill-switch (`PROACTIVE_INSIGHT_ENABLED`) is the safety valve (§7.3).

### 6.3 WriteResult invariant

`WriteResult` remains a discriminated union (`ok | missing_fields | ambiguous | error`). `insightContext` is added **only to the `ok` variant**. Write tools continue to **never throw** (CLAUDE.md hard rule).

---

## 7. Cross-cutting

### 7.1 Guardrail inheritance (S1-1)

`morning_glance` flows through `guard.ts`: mute, quiet hours, per-day cap (`PROACTIVE_MAX_PER_DAY`, default 5), dedup (`outreach_log` UNIQUE `(user_id, dedup_key)`). No new guard code.

### 7.2 Daily touchpoint accounting (3–5 target)

- **Guaranteed:** merged morning glance (1) — now also covers due-today bills, so no separate recurring ping.
- **Free:** inline insight (unlimited, doesn't count).
- Plus existing: 21:00 summary (1), logging-gap / anomaly (conditional).

On an **active** day: morning glance + an existing alert + unlimited inline ≈ 2–4 unprompted, well within 3–5. On a **calm** day: morning glance alone = quiet but present — the intended fix.

### 7.3 Config / env additions (`src/config/index.ts`)

- `PROACTIVE_MORNING_GLANCE_CRON` (default `0 8 * * *`).
- (Safety valve) `PROACTIVE_INSIGHT_ENABLED` (default `true`) — disables S1-2 without a deploy if inline feels noisy.
- **Remove** now-unused `CRON_SCHEDULE`.

### 7.4 Error handling & invariants

- Detectors stay **pure** (`() => ProactivePayload[]`, never throw — return `[]` on any internal issue). Per-user isolation inherited.
- Write tools **never throw**; `insightContext` only on `ok`.
- All amounts IDR-locale; all dates WIB; all user-facing text Bahasa Indonesia.
- `userId`-scoped everywhere (NFR-03) — new repo methods take `userId`.

---

## 8. Testing

| Change | Tests |
| --- | --- |
| S1-1 merged glance | (a) Detector unit: fixtures → assert payload shape; `todayDueBills` excludes already-processed-this-month; `upcoming` excludes today; `yesterday` null when no expenses. (b) Composer: LLM-mock returns `{ text, replyMarkup }`; `replyMarkup` has one row per due bill with correct `rec:<id>:<action>` data; >1 bills disambiguated by label; 0 bills → no `replyMarkup`. (c) Engine: `send` receives and forwards `replyMarkup`; plain-text triggers still send without it. (d) Integration: tapping a merged-message button routes through the **unchanged** `callback-query.ts` and confirms the bill (reuse existing callback tests). |
| S1-2 inline | (a) Repo `getCategoryContext` unit (sum/count over date range). (b) Write tools return `insightContext` on `ok`, omit on other variants, never throw. (c) `buildSystemPrompt` contains the generalized rule-4 text; honors `PROACTIVE_INSIGHT_ENABLED=false`. (d) Focused reactive test: a notable expense's tool result carries the snapshot (LLM line composition is model behavior — assert the data, not the prose). |
| Retirement | After removing `fireRecurringPayments` + `CRON_SCHEDULE`: assert no remaining references; existing recurring due-today coverage is preserved by the morning-glance detector. |

Vitest strips types — `npx tsc --noEmit` must also pass (per CLAUDE.md verification rules).

---

## 9. Open Questions / Risks

| # | Item | Slice-1 default |
| --- | --- | --- |
| OQ-P1 | Muted users lose the morning bill reminder (merged message is engine-gated). | Accept for Slice 1 (mute = mute; reactive "tagihan hari ini?" still works). Future: allow bill-carrying messages to bypass mute. |
| OQ-P2 | Morning glance vs 21:00 summary: replace or complement? | **Complement** — forward AM, backward PM. |
| OQ-P3 | Should inline insight be per-user suppressible (extend `/nudges`)? | No for Slice 1 (reactive). `PROACTIVE_INSIGHT_ENABLED` global valve first; per-user later if needed. |
| OQ-P4 | Morning-glance + logging-gap same-day double ping on a quiet day? | Acceptable within cap; tighten later if observed. |
| Risk | Merging retires a path users may implicitly rely on (separate 08:00 bill ping). | The merged message strictly **supersedes** it (same bills, same buttons, plus glance content). Net fewer pings. |
| Risk | Latency from `getCategoryContext` on write turns. | Bounded, indexed reads on a write turn already touching DB. Verify <5s via the run skill after implementation. |
| Risk | LLM composer omits/mangles the due-bill lead-in. | Buttons are programmatic (not LLM), so actionability never depends on prose. Lead-in is best-effort. |

---

## 10. Build order

Per user direction:

1. **S1-1 merged morning glance** first — the most visible "watching me" win. Includes the engine `reply_markup` generalization (§4.2) and the recurring-cron retirement (§5.4). Bigger piece, but unblocks the rest and immediately reduces morning noise (two pings → one).
2. **S1-2 inline insight** second — smallest blast radius after the engine change is in; improves every write conversation.

Each step is independently shippable and testable. **Budget pacing is deferred** to a later slice.
