# MoneyBot — Proactive Outreach Engine · Design

- **Date:** 2026-06-22
- **Source spec:** `docs/SRS.md` (MoneyBot v1.0) + `docs/superpowers/specs/2026-06-14-moneybot-impl-design.md`
- **Status:** Design — ready for implementation planning

## Purpose

MoneyBot is almost entirely **reactive** today: the user messages, the ReAct loop runs, the bot replies. The only proactive behavior is the recurring-payment scheduler (`src/scheduler/`), which sends **static, templated** prompts via `bot.api.sendMessage` — no LLM in the proactive path.

This design adds a **proactive outreach engine**: the bot reaches out on its own — scheduled spending summaries, budget/threshold nudges, logging-gap check-ins, and anomaly insights — with the LLM composing the richer messages and templates handling the simple ones. The engine reuses the existing in-process `node-cron`, the repository layer, and the proven `bot.api.sendMessage` outbound path. **No new infrastructure** is introduced (no separate worker, no queue, no external scheduler) — consistent with the project's minimal-infra preference and the always-on single-process runtime.

The key property that makes unsupervised outreach acceptable is a DB-enforced **dedup** invariant plus rate-limit, quiet-hours, and per-user mute. The recurring-payment reminders become the first instance of this engine's general model; this design generalizes that pattern.

Where this doc and the SRS differ, this doc is authoritative for the proactive feature. The SRS remains source of truth for everything else (entities, FR-01…FR-10, NFRs, taxonomy).

---

## 1. Goals & success criteria

| # | Goal | Criterion |
|---|------|-----------|
| P1 | Bot initiates conversation | Without any user message, the bot sends at least one correct, on-topic proactive message per cadence window |
| P2 | Summaries are LLM-composed | Daily summary is natural Bahasa Indonesia, references the user's actual transactions/budgets, not a fixed template |
| P3 | Never spammy | No user receives more than `PROACTIVE_MAX_PER_DAY` messages/day; the same nudge never repeats; quiet hours respected |
| P4 | Two-way | A reply to a proactive message can be answered conversationally via the existing reactive agent (drill-down works) |
| P5 | Controllable | User can mute/pause from chat (`/nudges`); a global kill switch exists via env |
| P6 | Never crashes the bot | Any failure in detection/composition/send is caught and logged; the polling bot and cron keep running |

---

## 2. Scope & sequencing

All four trigger types are in scope; the **engine is built once** and triggers are added as small additive slices. Each trigger is a *detector* (pure function: "is there something worth saying?") + a *composer* (LLM or template).

- **Slice 1 — engine core + `scheduled_summary`.** Dispatcher, interfaces, `outreach_log` + `proactive_settings` tables/repos, the guard, two-way reply seeding, `/nudges` command, and one LLM-composed daily summary trigger. Delivers P1/P2 and proves the architecture.
- **Slice 2 — `budget_threshold`.** First event-driven trigger (sweep cron); proves per-code dedup. Template composer.
- **Slice 3 — `logging_gap`.** Gap detection; one-per-day dedup. Template composer.
- **Slice 4 — `anomaly`.** Weekly baseline-vs-current; LLM-composed insight.

Later slices do not modify the engine — they add one file under `src/proactive/triggers/` and register a cron line.

### Assumptions & constraints

- `userId`-scoped throughout (NFR-03). Dispatcher loops all users; works for one today, multi-user-ready.
- Proactive is **on by default** per user; cadence/thresholds/quiet-hours are **env-configured** (NFR-08); the only per-user state is mute/pause.
- All scheduling and date arithmetic is WIB (NFR-10), consistent with the existing cron jobs.
- No new infrastructure — in-process `node-cron` in the same process as the polling bot.
- All user-facing proactive messages in Bahasa Indonesia (SP-01), IDR locale formatting (SP-10), no `Rp`/`IDR`.

---

## 3. Architecture & layering

```
node-cron (existing src/scheduler/cron.ts)
   │  fires on schedule (timezone Asia/Jakarta)
   ▼
runProactivePass() ── src/proactive/dispatcher.ts
   │  users = repos.users.findAll()
   │  for each user (kill-switch / mute check first):
   │    1. detector(repos, now)            → ProactivePayload[]
   │    2. guard.canSend(...)              → dedup + rate-limit + quiet-hours
   │    3. composer(payload)               → Bahasa Indonesia text  (LLM or template)
   │    4. bot.api.sendMessage(chatId, text)
   │    5. outreachLog.record(...)         (INSERT … ON CONFLICT DO NOTHING)
   │    6. seed assistant turn in session_contexts   (enables two-way reply)
   │  per-user try/catch → never throws to cron
   ▼
repositories/interfaces.ts ──► adapters/neon ──► Postgres     (NFR-02 intact)
```

Layering rules (hard):

- Detectors, dispatcher, composer, and guard import **only** from `src/repositories/interfaces.ts` — never from an adapter (NFR-02).
- The LLM composer receives the model via dependency injection (the `model` from `createOpenAI(...)`); it does not import a driver.
- The send step uses the grammY `bot.api.sendMessage` — the same outbound path `recurring-fire.ts` already uses.

---

## 4. Core interfaces (`src/proactive/types.ts`)

```ts
export type ProactiveTriggerType =
  | 'scheduled_summary'
  | 'budget_threshold'
  | 'logging_gap'
  | 'anomaly';

export type ComposerChannel = 'llm' | 'template';

export interface ProactivePayload {
  triggerType: ProactiveTriggerType;
  dedupKey: string;                 // DB-uniqueness key (see §6)
  channel: ComposerChannel;         // selects the composer
  data: Record<string, unknown>;    // trigger-specific facts for the composer
}

// A detector is PURE given repos + an injected `now`. Returns 0..N payloads.
// Returning [] means "nothing worth saying". Multiple payloads (e.g. several
// budgets crossed in one sweep) each flow through guard → composer → send.
export type Detector = (ctx: {
  userId: string;
  repos: Repos;
  now: Date;                        // injected WIB "now" — never real time
}) => Promise<ProactivePayload[]>;

// Composers turn one payload into the user-facing message.
export type Composer = (payload: ProactivePayload, ctx: {
  repos: Repos;
  model: LanguageModel;             // for the LLM composer; ignored by template
  now: Date;
}) => Promise<string>;
```

---

## 5. Files

```
src/proactive/
  types.ts                 // §4
  dispatcher.ts            // runProactivePass — per-user loop
  guard.ts                 // canSend(): dedup + rate-limit + quiet-hours + mute (pure)
  prompt.ts                // PROACTIVE_PROMPT (distinct from the reactive system prompt)
  settings.ts              // ProactiveSettings type + defaults resolver
  composers/
    llm.ts                 // generateText(model, PROACTIVE_PROMPT, payload) → text
    template.ts            // per-trigger deterministic formatters
  triggers/
    scheduled-summary.ts   // slice 1
    budget-threshold.ts    // slice 2
    logging-gap.ts         // slice 3
    anomaly.ts             // slice 4
src/adapters/neon/
  outreach-log.repository.ts
  proactive-settings.repository.ts
src/scheduler/cron.ts      // gains proactive cron.schedule(...) calls
src/telegram/
  nudges-command.ts        // /nudges command handler
migrations/
  002_proactive.sql
```

`src/index.ts` wires the new repos into `createRepos()` and registers the `/nudges` command handler.

---

## 6. Data model (`migrations/002_proactive.sql`)

```sql
-- Proactive outreach log (dedup + rate-limit source of truth)
CREATE TABLE outreach_log (
  outreach_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(user_id),
  trigger_type VARCHAR     NOT NULL CHECK (trigger_type IN
                ('scheduled_summary','budget_threshold','logging_gap','anomaly')),
  dedup_key    VARCHAR     NOT NULL,
  payload      JSONB       NOT NULL DEFAULT '{}',
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The dedup invariant, DB-enforced: a (user, dedup_key) pair can exist only once.
CREATE UNIQUE INDEX idx_outreach_dedup   ON outreach_log(user_id, dedup_key);
CREATE INDEX        idx_outreach_user_sent ON outreach_log(user_id, sent_at);

-- Per-user proactive control. No row == defaults (not muted).
CREATE TABLE proactive_settings (
  user_id    UUID        PRIMARY KEY REFERENCES users(user_id),
  muted      BOOLEAN     NOT NULL DEFAULT false,
  resume_at  TIMESTAMPTZ,                  -- mute auto-expires at this instant
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Entities (`src/domain/entities.ts`)

```ts
export interface OutreachLogEntry {
  outreachId: string;
  userId: string;
  triggerType: ProactiveTriggerType;
  dedupKey: string;
  payload: unknown;
  sentAt: string;        // ISO 8601
}

export interface ProactiveSettings {
  userId: string;
  muted: boolean;
  resumeAt?: string;     // ISO 8601
}
```

### Dedup keys (per trigger)

| Trigger | `dedup_key` | Meaning |
|---|---|---|
| `scheduled_summary` | `summary:<YYYY-MM-DD>` | one daily summary |
| `budget_threshold` | `budget:<codeId>:<YYYY-MM>:pct<level>` | one nudge per code × month × threshold level (80/100) |
| `logging_gap` | `gap:<YYYY-MM-DD>` | one gap nudge per day |
| `anomaly` | `anomaly:<YYYY-Www>` (ISO week) | one anomaly insight per week |

---

## 7. Repository interfaces (additions to `src/repositories/interfaces.ts`)

```ts
interface IOutreachLogRepository {
  record(i: {
    userId: string;
    triggerType: ProactiveTriggerType;
    dedupKey: string;
    payload: unknown;
    sentAt: Date;
  }): Promise<{ inserted: boolean }>;     // false ⇒ dedup key already existed
  existsKey(userId: string, dedupKey: string): Promise<boolean>;   // guard pre-check
  countSince(userId: string, since: Date): Promise<number>;        // rate-limit
}

interface IProactiveSettingsRepository {
  get(userId: string): Promise<ProactiveSettings>;                 // defaults if no row
  setMuted(userId: string, muted: boolean, resumeAt?: Date): Promise<void>;
}

interface IUserRepository {
  // existing methods unchanged, plus:
  findAll(): Promise<User[]>;             // dispatcher loop
}
```

Neon implementations live under `src/adapters/neon/` and are wired into `createRepos()` (so `Repos` gains `outreach` and `proactiveSettings`).

`record()` implementation uses `INSERT … ON CONFLICT (user_id, dedup_key) DO NOTHING` and returns `inserted: false` when the conflict fired — this is the atomic dedup backstop that survives double-fire and overlapping sweeps.

---

## 8. Dispatcher control flow (`src/proactive/dispatcher.ts`)

```ts
async function runProactivePass(opts: {
  detector: Detector;
  composer: Composer;            // LLM or template, selected per payload.channel
  repos: Repos;
  model: LanguageModel;
  now: Date;                     // injected
  send: (chatId: string, text: string) => Promise<void>;
}): Promise<void> {
  if (!config.PROACTIVE_ENABLED) return;                 // kill switch
  const users = await opts.repos.users.findAll();
  for (const user of users) {
    try {
      const settings = await opts.repos.proactiveSettings.get(user.userId);
      if (isMuted(settings, opts.now)) continue;         // mute + resumeAt
      if (inQuietHours(opts.now)) continue;              // quiet hours

      const payloads = await opts.detector({ userId: user.userId, repos: opts.repos, now: opts.now });
      for (const payload of payloads) {
        // cheap guards before any LLM call
        if (await opts.repos.outreach.existsKey(user.userId, payload.dedupKey)) continue;
        const sentToday = await opts.repos.outreach.countSince(user.userId, startOfTodayWIB(opts.now));
        if (sentToday >= config.PROACTIVE_MAX_PER_DAY) continue;

        const text = await opts.composer(payload, { repos: opts.repos, model: opts.model, now: opts.now });
        await opts.send(user.telegramChatId, text);

        // atomic dedup backstop (race between existsKey and record is safe here)
        await opts.repos.outreach.record({
          userId: user.userId, triggerType: payload.triggerType,
          dedupKey: payload.dedupKey, payload: payload.data, sentAt: opts.now,
        });
        await seedAssistantTurn(opts.repos.sessions, user, text, opts.now);  // two-way reply
      }
    } catch (err) {
      logEvent('error', 'proactive trigger failed',
        { userId: user.userId, error: (err as Error).message });
    }
  }
}
```

`seedAssistantTurn` loads the user's `session_contexts` row (or creates a fresh one), appends `{ role:'assistant', content:text, timestamp:now }` to `turns` (respecting `CONTEXT_WINDOW_TURNS`), and updates `lastActivityAt`. When the user later replies, the existing reactive `handleMessage` ReAct loop runs with that turn present and read tools available — drill-down ("ciutkan ke makanan") works with **no new reactive code**. If the reply arrives after the session idle timeout, a fresh session starts and the agent still answers data questions via tools.

### Two-way reply note

Proactive LLM composition uses a **single `generateText` call** with the proactive prompt + payload — not the full ReAct loop — because the detector has already gathered all data. Conversational drill-down on the *reply* uses the existing reactive agent. This keeps proactive cost to one LLM call per sent message.

---

## 9. Triggers

### 9.1 `scheduled_summary` (slice 1 — LLM)

- **Cadence:** `PROACTIVE_SUMMARY_CRON` (default `0 21 * * *`, daily 21:00 WIB).
- **Detector:** gather today's (WIB date) non-deleted, non-transfer transactions; compute total spend, top categories, and current-month budget status per code. **Zero transactions today → return `[]`** (no empty-summary nag).
- **Payload:** `{ triggerType:'scheduled_summary', dedupKey:'summary:'+todayWIB, channel:'llm', data:{ date, totalSpend, topCategories:[…], budgets:[{name,spent,alloc,pct}] } }`.
- **Composer (LLM):** `generateText({ model, system: PROACTIVE_PROMPT, prompt: serialize(payload) })` → a concise Indonesian digest. Falls back to the template composer on any LLM failure.

### 9.2 `budget_threshold` (slice 2 — template)

- **Cadence:** `PROACTIVE_SWEEP_CRON` (default `*/30 * * * *`).
- **Detector:** for each current-month budget code, compute `pct = spent / monthlyBudget`. For each level in `PROACTIVE_BUDGET_THRESHOLDS` (default `80,100`) that `pct` has reached, emit a payload. dedupKey `budget:<codeId>:<YYYY-MM>:pct<level>`.
- **Composer (template):** e.g. `⚠️ Budget 'food' udah 82% (1.640.000 / 2.000.000).`

### 9.3 `logging_gap` (slice 3 — template)

- **Cadence:** `PROACTIVE_SWEEP_CRON` (same sweep).
- **Detector:** `lastTxnDate = max(date)` for non-deleted transactions; `gapDays = todayWIB − lastTxnDate`. If `gapDays ≥ PROACTIVE_GAP_DAYS` (default 2), emit payload. dedupKey `gap:<todayWIB>` (one per day).
- **Composer (template):** e.g. `Halo, 2 hari ga ada catatan pengeluaran. Mau aku bantu catat sesuatu?`

### 9.4 `anomaly` (slice 4 — LLM)

- **Cadence:** `PROACTIVE_ANOMALY_CRON` (default `0 9 * * 1`, Monday 09:00 WIB).
- **Detector:** per category, this week's spend vs rolling 4-week average; flag categories where `thisWeek > PROACTIVE_ANOMALY_MULTIPLIER × avg` (default 3) and `avg > floor`. dedupKey `anomaly:<YYYY-Www>`.
- **Composer (LLM):** an insight referencing the flagged categories.

---

## 10. Safety invariants (`src/proactive/guard.ts` — pure)

`canSend`-style checks, evaluated cheapest-first so an LLM call is never made for a blocked send:

1. **Kill switch** — `config.PROACTIVE_ENABLED === false` → dispatcher returns immediately.
2. **Mute** — `settings.muted && now < settings.resumeAt` → skip. (`resumeAt` lets `/nudges off 8h` self-expire; `resumeAt` undefined ⇒ mute until explicitly turned back on.)
3. **Quiet hours** — `now` (WIB) within `PROACTIVE_QUIET_HOURS` window (default `22:00-07:00`) → skip.
4. **Dedup pre-check** — `existsKey(dedupKey)` → skip composing (saves the LLM call). Checked before rate-limit because it is the more selective common case (most sweeps, the key already exists), avoiding the `countSince` query. The `(user_id, dedup_key)` unique index is the atomic backstop for any race between `existsKey` and `record`.
5. **Rate limit** — `countSince(startOfTodayWIB(now)) ≥ PROACTIVE_MAX_PER_DAY` (default 5) → skip. Caps **all triggers combined** per user per day.

`inQuietHours`, `isMuted`, and `startOfTodayWIB` are pure functions of an injected `Date`.

---

## 11. Error handling

- **Per-user `try/catch`** in the dispatcher → `logEvent('error', ...)`, continue. One user's failure never stops others and never throws to cron.
- **LLM composer failure** → fall back to the template composer for that trigger (summaries still send, degraded). The template composer is a pure string and cannot fail.
- **Telegram send failure** → log and **do not** `record` the outreach row, so an event-driven nudge (threshold/gap) retries on the next sweep. For `scheduled_summary`, the day's dedup key is not recorded, so a same-day retry may send later that day — acceptable and documented.
- **DB failure** → log, skip the user.
- **Cron-level `.catch(log)`** on each `cron.schedule(...)` (matches the existing `recurring-fire` wiring) so a thrown error never kills the process.
- **Idempotency** — the `(user_id, dedup_key)` unique index makes a double-send impossible even under double-fire or overlapping sweeps: the second `INSERT … ON CONFLICT DO NOTHING` is a no-op.

---

## 12. Config (env — NFR-08)

All added to `src/config/index.ts` (zod-validated), with defaults:

| Var | Default | Purpose |
|---|---|---|
| `PROACTIVE_ENABLED` | `true` | global kill switch |
| `PROACTIVE_SUMMARY_CRON` | `0 21 * * *` | daily summary schedule |
| `PROACTIVE_SWEEP_CRON` | `*/30 * * * *` | event-driven trigger sweep |
| `PROACTIVE_ANOMALY_CRON` | `0 9 * * 1` | weekly anomaly schedule |
| `PROACTIVE_MAX_PER_DAY` | `5` | rate limit, all triggers combined |
| `PROACTIVE_QUIET_HOURS` | `22:00-07:00` | WIB quiet window |
| `PROACTIVE_BUDGET_THRESHOLDS` | `80,100` | pct levels (slice 2) |
| `PROACTIVE_GAP_DAYS` | `2` | logging-gap threshold (slice 3) |
| `PROACTIVE_ANOMALY_MULTIPLIER` | `3` | anomaly factor (slice 4) |

---

## 13. In-chat control (`src/telegram/nudges-command.ts`)

A grammY command — deterministic and cheap (preferred over an LLM tool):

- `/nudges` / `/nudges status` → show current mute state + resume time.
- `/nudges off` → mute until further notice (`resumeAt = undefined`).
- `/nudges off 8h` → mute for 8 hours (`resumeAt = now + 8h`); accepts `Nh`/`Nd`.
- `/nudges on` → unmute.

Handler calls `repos.proactiveSettings.setMuted(...)`. This is the only place proactive behavior is controllable from chat; everything else is env-configured.

---

## 14. Cron registration (`src/scheduler/cron.ts`)

Adds three schedules (all `timezone: 'Asia/Jakarta'`, all `.catch(log)`):

```ts
cron.schedule(config.PROACTIVE_SUMMARY_CRON, () =>
  runProactivePass({ detector: detectScheduledSummary, composer: resolveComposer, ... }).catch(log));
cron.schedule(config.PROACTIVE_SWEEP_CRON, () =>
  Promise.all([
    runProactivePass({ detector: detectBudgetThreshold, ... }),
    runProactivePass({ detector: detectLoggingGap,    ... }),
  ]).catch(log));
cron.schedule(config.PROACTIVE_ANOMALY_CRON, () =>
  runProactivePass({ detector: detectAnomaly, ... }).catch(log));
```

`resolveComposer` conforms to the `Composer` signature and is the single composer passed into `runProactivePass`; it routes each payload to the LLM or template composer based on `payload.channel`. The existing recurring-payment cron jobs remain unchanged.

---

## 15. Testing

Clock is always injected (`now: Date`) — no real time in tests.

- **`guard.test.ts`** — pure: each invariant (kill switch, mute/resume, quiet hours, rate limit, dedup pre-check) with injected `now` and fake rows.
- **`triggers/*.test.ts`** — detector purity: fake repos + injected `now`; assert payload shape and `[]` on no-data (zero txns; no crossed budgets; recent txn).
- **`composers/template.test.ts`** — deterministic formatting.
- **`composers/llm.test.ts`** — inject a fake model (the codebase already fakes the model/runner for orchestrator tests); assert one `generateText` call with `PROACTIVE_PROMPT` + payload, and template fallback on model error.
- **`dispatcher.test.ts`** — fakes for repos / send / composer; assert: skip when muted, skip when guard blocks, skip on rate limit, send+record+seed when actionable, **no-crash when detector throws** (loop continues), dedup pre-check prevents an LLM call.
- **`outreach-log.repository.test.ts`** (Neon integration, like existing repo tests) — `record` inserts; a second `record` with the same key returns `inserted:false` and does not duplicate; `existsKey` and `countSince` correct.
- **`proactive-settings.repository.test.ts`** — `get` returns defaults when no row; `setMuted` upserts.
- **`nudges-command.test.ts`** — parses `off` / `off 8h` / `on` / `status`; calls `setMuted` with correct `resumeAt`.

Per CLAUDE.md, every slice verifies with `npx tsc --noEmit` AND `npm run lint` AND the relevant `npx vitest run` (vitest strips types, so tsc is mandatory).

---

## 16. Out of scope

- Rich notification settings UI beyond mute/pause (no per-trigger toggles in v1; thresholds are env-configured).
- Proactive actions that **write** (the bot never auto-logs a transaction from a proactive message; it only prompts). Replies that confirm a write still go through the normal write gate (SP-03).
- Push delivery outside Telegram.
- ML-based anomaly detection (the multiplier-vs-rolling-average heuristic is sufficient for v1).
- Per-user cadence customization (global env cadence only; per-user state is just mute).

---

## 17. Open questions

| # | Question | Default |
|---|----------|---------|
| OQ-P1 | Should a scheduled summary with zero transactions still send a "you logged nothing today" note? | No — return `[]`; the `logging_gap` trigger covers inactivity separately and with its own cadence. |
| OQ-P2 | Should `/nudges off` with no duration mute forever or default to a window? | Forever (`resumeAt = undefined`); explicit `/nudges on` re-enables. |
| OQ-P3 | Should the anomaly trigger consider month-to-date vs week, or both? | Week (ISO week) for slice 4; month-to-date is already covered by `scheduled_summary`'s budget status. |
| OQ-P4 | Store `proactive_settings` in its own table vs the existing `user_preferences` KV? | Dedicated table (clean separation from the LLM's preference memory; queryable). KV reuse is the lighter fallback if the extra table is unwanted. |

---

_End of design — Proactive Outreach Engine. Next: implementation plan._
