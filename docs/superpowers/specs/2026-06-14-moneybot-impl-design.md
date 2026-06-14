# MoneyBot — Implementation Design

- **Date:** 2026-06-14
- **Source spec:** `docs/SRS.md` (MoneyBot v1.0, Analysis Phase)
- **Status:** Design — ready for implementation planning

## Purpose

This document captures the implementation-level design for MoneyBot: the concrete runtime, framework, and structural decisions that refine the SRS's analysis-phase spec into something ready to scaffold. Where this doc and the SRS differ, **this doc is authoritative for implementation**; every delta is called out explicitly in §2.

The SRS remains the source of truth for: functional requirements (FR-01…FR-10), data model entities, the PostgreSQL schema, the repository interface contract (§7), the system-prompt rules (SP-01…SP-10), the tool registry (T01…T16), the category taxonomy (§10), and the non-functional requirements. This design does not restate those; it specifies *how* they are built.

---

## 1. Resolved architecture decisions

| Concern | Decision | Rationale |
|---|---|---|
| **Runtime** | Always-on Node.js server, single process | User choice; simplifies scheduler and DB-connection lifecycle |
| **Telegram transport** | **grammY + long-polling.** No HTTP server, no webhook endpoint | The SRS's webhook rationale (stateless / serverless) does not hold once always-on. Long-polling eliminates the public-HTTPS / TLS / `update_id`-dedup burden. grammY supports `bot.startWebhook()` as a one-line swap if push delivery is ever wanted. |
| **HTTP health route** | None by default. If the host (Render/Railway/fly.io) requires an HTTP health check, a ~10-line bare `http` server with a single `/health` route — still no Fastify, still no webhook | A single health route does not justify an HTTP framework |
| **Agent loop** | **Vercel AI SDK** — `generateText` with `maxSteps`. OpenRouter via the OpenAI-compatible provider (`createOpenAI({ baseURL: 'https://openrouter.ai/api/v1' })`), model from `OPENROUTER_MODEL` | The SDK runs the ReAct tool loop for us; Zod-typed tools; mature streaming support if needed later. |
| **DB driver** | **`pg` Pool** inside `/src/adapters/neon/` (replaces `@neondatabase/serverless`) | Always-on → real connection reuse and, critically, native transaction support so the atomic transfer (SRS §8.4 / NFR-05) maps to `pool.connect()` → `BEGIN` → sequential queries → `COMMIT`. The serverless HTTP driver's benefit is moot on one long-lived instance. |
| **Scheduler** | Two in-process `node-cron` jobs, both with `timezone: 'Asia/Jakarta'` (NFR-10) | Daily 08:00 WIB fires due recurring payments; a 5-minute sweep re-fires deferred prompts. |
| **Testing** | **Vitest.** Real-Postgres integration for repository/adapter; mocked `I*Repository` for tools; mock model provider for orchestrator | Money correctness requires real SQL; logic layers do not. |
| **Method** | TDD for the repository and tool layers; mock-model tests for the orchestrator | Crisp contracts, high correctness value. |

NFR-02 (no driver import outside `/src/adapters/neon/`) is enforced by an ESLint `no-restricted-imports` rule — itself a test.

---

## 2. Deltas from the SRS

These *refine* (do not contradict) the SRS, driven by the always-on runtime and the framework choice:

1. **DB driver — SRS §4.2 specified `@neondatabase/serverless`; changed to `pg`.**
   Lives entirely inside the adapter. Repository interfaces, tools, and agent are unaffected. A future return to serverless deployment is a swap of the adapter's internal driver only.

2. **Telegram transport — SRS §4.2 specified webhooks; changed to grammY long-polling.**
   See §1. This also removes the Fastify dependency.

3. **`processed_updates` table (NFR-04) — dropped.**
   Webhook-retry dedup is unnecessary under grammY long-polling: Telegram update offsets are acknowledged, so there is no retry storm. Residual risk — a process crash mid-handler reprocessing one update — is mitigated by handler-level idempotency and the deterministic behavior of the write tools. **The DDL for `processed_updates` is not created.**

4. **Session message shape — SRS §6.1 `ConversationTurn { role, content }` is too thin** to reconstruct a multi-step tool conversation across turns. `session_contexts.turns` instead stores the full Vercel AI SDK **`CoreMessage[]`** (user / assistant / tool-call / tool-result) as JSONB, so a follow-up message inherits the complete prior context (needed for FR-08 "koreksi tadi"). The TypeScript `SessionContext` type is updated accordingly; the `ConversationTurn` interface is removed.

5. **Telegram formatter scope — SRS §4.3 `/telegram/formatter.ts` ("All Telegram message formatting") shrinks** to the scheduler's fixed recurring-payment prompt template + inline keyboard, plus an optional `formatIDR` helper. The agent's conversational replies are LLM-generated (SP-01 / SP-10).

---

## 3. Component layout

Directory structure follows SRS §4.3 unchanged, with the deltas above reflected in contents:

```
/src
  /adapters
    /neon             ← pg Pool; the ONLY place `pg` is imported
      pool.ts         ← Pool singleton
      user.repository.ts
      account.repository.ts
      transaction.repository.ts
      budget-code.repository.ts
      recurring-payment.repository.ts
      session.repository.ts
      migrate.ts      ← applies migrations
      seed.ts         ← category seeding (SRS §10)
  /agent
    orchestrator.ts   ← per-request flow (§4)
    system-prompt.ts  ← SP-01…SP-10 + embedded category taxonomy
    tools.ts          ← buildTools({ userId, repos }) factory (§4)
    types.ts          ← WriteResult, CoreMessage session shape
  /repositories
    interfaces.ts     ← SRS §7, verbatim
  /scheduler
    cron.ts           ← registers the two node-cron jobs
    recurring-fire.ts ← daily 08:00 due-payment firing
    defer-sweep.ts    ← 5-min deferred-prompt re-fire
  /telegram
    bot.ts            ← grammY bot setup + long-polling start
    callback-query.ts ← inline-keyboard handlers (confirm/defer/skip)
    formatter.ts      ← recurring-prompt template + inline keyboard + formatIDR
  /domain
    entities.ts       ← SRS §6.1 entities (SessionContext updated per §2)
    categories.ts     ← SRS §10 taxonomy (data only)
  /config
    index.ts          ← all env vars centralized (NFR-08)
/scripts
  reconcile.ts        ← dev-only balance reconcile (OQ-03)
/migrations
  001_init.sql        ← SRS §6.2 DDL minus processed_updates
```

The hard rule from SRS §4.3 holds: the tool layer imports only from `/repositories/interfaces.ts`, never from an adapter.

---

## 4. Agent loop mechanics (SRS §8.1, concretely)

Per-request flow inside the grammY `on("message")` handler:

```
1. chatId → userRepo.findByTelegramChatId(chatId)
   - absent → onboarding (FR-01): create User, welcome, prompt first account.
     `buildTools` returns ONLY `create_account` until an active Account exists,
     so no other write tool is even available to the model during onboarding
2. session = sessionRepo.get(chatId)
   - if absent OR lastActivityAt + SESSION_IDLE_TIMEOUT_MINUTES < now → fresh session
3. messages = session.turns (CoreMessage[])
   messages.push({ role: 'user', content: text })
4. tools = buildTools({ userId: user.userId, repos })
5. result = await generateText({
     model: openrouter(OPENROUTER_MODEL),
     system: systemPrompt,            // SP-01…SP-10 + full category taxonomy
     messages,
     tools,
     maxSteps: 10,                    // safety cap only
   })
6. messages.push(...result.response.messages)   // assistant + tool-call + tool-result
7. trim to CONTEXT_WINDOW_TURNS — a *turn* is one user message plus every
   following message (assistant / tool-call / tool-result) up to the next user
   message; trim removes whole turns from the front, never splitting a tool-call
   from its tool-result
8. session.lastTransactionId = latest transactionId found in result.toolResults
   session.lastActivityAt = now
   sessionRepo.set(session)
9. ctx.reply(result.text)
```

`generateText` (not `streamText`): Telegram renders a single message at the end, so token-streaming buys nothing. A `sendChatAction('typing')` is sent before step 5 for perceived latency (NFR-01).

### Tools — thin wrappers over repositories

Each tool is `tool({ description, parameters: zodSchema, execute })`. `execute` closes over the resolved `userId` and the repository instances, so tools never receive or trust a userId from the model. Zod defines parameter *shape*; **field-presence and ambiguity checks live inside `execute`** and return structured signals (§5) — they do not throw.

Example — `create_expense`:
1. Zod validates `{ description, amount, accountId, categoryId, budgetCodeId?, date? }`.
2. `execute` resolves the account (calls `accountRepo.findById`); if absent/ambiguous → returns `{ status: 'ambiguous' | 'missing_fields' }`.
3. On `ok`: `txnRepo.create` + `accountRepo.updateBalance(-amount)` + (if budget) `budgetRepo.incrementSpent(+amount)`, all within the same DB transaction.
4. Returns `{ status: 'ok', data: { transaction, budget?: { spent, limit, exceeded } } }`. The model renders the SP-04 confirmation and, if `exceeded`, the SP-05 / FR-03d warning.

### Categorization (FR-05)

Pure model reasoning. The full category taxonomy (SRS §10) is embedded in the system prompt, so the model selects `categoryId` itself using both the Indonesian (`name`) and English (`nameEn`) labels. `get_categories` (T03) exists only if the model wants to re-list them; it is not required on the hot path.

### Session storage

`session_contexts.turns` stores the `CoreMessage[]` as JSONB (§2). Rolling window keeps the last `CONTEXT_WINDOW_TURNS` (default 20). `lastTransactionId` is extracted from `result.toolResults` after `generateText` and persisted (§4 step 8) — driving FR-08 and FR-09b.

### Atomic transfer (SRS §8.4 / NFR-05)

`create_transfer`'s repository method runs the three statements inside one `client = pool.connect(); BEGIN; …; COMMIT` block. Partial failure rolls back automatically; no compensating writes.

---

## 5. Write-gate contract (SP-03)

The write gate is enforced two ways and **never terminates the ReAct loop**:

**A. System prompt (SP-03)** instructs the model not to call write tools unless all required fields are known and unambiguous, and to ask for all missing fields in a single message.

**B. Tools never throw across the boundary.** Every write tool's `execute` returns a discriminated result:

```ts
type WriteResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'missing_fields'; missing: string[]; options?: Record<string, unknown> }
  | { status: 'ambiguous';   field: string; matches: { id: string; label: string }[] }
  | { status: 'error';       message: string };   // recoverable
```

Loop behavior per case — **the loop continues on every case**:

| Model action | Tool returns | Model's next step (same `generateText`) |
|---|---|---|
| Omits a required field | `missing_fields` | emits final text asking the user for all missing fields (FR-03b) |
| Supplies an ambiguous value (e.g. "bca" matches 2 accounts) | `ambiguous` | emits final text asking the user to disambiguate |
| Calls a read tool first to resolve (SP-02 / SP-09) | read result | proceeds to the write within the same turn |
| All fields resolved | `ok` | emits the SP-04 confirmation |
| Transient failure | `error` | recovers or, at `maxSteps`, emits a graceful fallback |

The **only** things that end a turn: the model emits final text (asking the user or confirming), or `maxSteps` is hit (safety cap → graceful "aku masih gagal, coba ulangi"). The write gate does not force-terminate; it gives the model in-loop feedback that the model acts on.

---

## 6. Scheduler & inline callbacks

Two in-process `node-cron` jobs, both `timezone: 'Asia/Jakarta'`:

1. **Daily 08:00 (`CRON_SCHEDULE`)** — fire initial prompts.
   - Selection: `recurring_payments` where `is_active = true` AND `last_fired_at` is not in the current month AND `day_of_month` matches today (with the overflow rule below).
   - For each: send the FR-09b prompt + inline keyboard via `bot.api.sendMessage(chatId, …)`. The scheduler resolves `userId → chatId` via the `users` table and uses the shared `bot` instance (injected).

2. **Every 5 minutes** — defer sweep.
   - Re-prompts any `session_contexts` row whose `pendingRecurringConfirmation.expiresAt` has passed, **then clears that `pendingRecurringConfirmation`**. Each defer therefore auto-re-prompts at most once; a second defer sets a fresh `expiresAt`. If the user ignores the re-prompt, no further auto-prompts that day (the daily cron already fired). This bounds the sweep and prevents indefinite re-firing.
   - This makes "Tunda 1 jam" **durable across restarts** — defer state lives in the DB, not in a `setTimeout`. For a bill-payment system, missing a reminder is the worst failure mode, so this is load-bearing.

**Day-of-month overflow (A10 / OQ-04):** on day `D` of a month with `M` days, fire payments where `day_of_month = D` **or** (`day_of_month > M` **and** `D = M`). A `day 31` subscription therefore fires on Feb 28. Encoded in the selection query.

**Inline callbacks (A11):** grammY `bot.callbackQuery(callbackData, handler)`. `callback_data` encodes action + id:

```
rec:<recurringId>:confirm
rec:<recurringId>:defer
rec:<recurringId>:skip
```

Handlers:
- **`confirm`** → `create_expense` (closes over `userId`), set `last_fired_at = today`, `answerCallbackQuery`, edit the prompt into a confirmation.
- **`defer`** → write `pendingRecurringConfirmation { recurringId, expiresAt: now + 1h }` to the session row (durable); the 5-min sweep re-prompts.
- **`skip`** → set `last_fired_at = today` (blocks re-fire this month), no transaction, reply "…dilewati."

---

## 7. Open-question resolutions

| OQ | Resolution |
|---|---|
| **OQ-01** budget carryover | **Deferred to post-v1.** v1 stays scoped-per-month (SRS A3). FR-03c already creates a budget on first reference each month, so logging still works without carryover. Carryover ("salin budget bulan lalu") is a convenience fast-follow. |
| **OQ-02** context collision during pending recurring | Pending confirmation is **not invalidated** by normal messages. The user may log an expense while a recurring prompt sits unanswered; the inline keyboard stays answerable until confirmed / skipped / expired. |
| **OQ-03** balance drift | Ship a **dev-only `/scripts/reconcile.ts`** (run via `tsx`) that recomputes `accounts.balance` from the transaction sum. Not an agent tool. Cheap insurance for a money system. |
| **OQ-04** day-31 in short months | Resolved in §6 (last-day logic). |
| **OQ-05** correct non-last transactions | Out of scope v1 (per SRS). Agent asks for date/description if `lastTransactionId` is absent. |

---

## 8. Testing strategy

| Layer | Approach | Why |
|---|---|---|
| **Repository / Neon adapter** | Integration tests vs a **real Postgres** (Neon dev branch, or Docker `pg` via testcontainers). **No DB mocks.** | SQL correctness and transaction atomicity (NFR-05) cannot be validated against a mock. Money bugs live here. |
| **Tools** | Unit tests with mocked `I*Repository`. Every write tool is asserted to return `missing_fields` / `ambiguous` / `error` **and never throw** (the §5 guarantee). | Crisp contracts; fast; the write-gate is the safety core. |
| **Orchestrator** | Mock model provider (deterministic, no real LLM). Validate session load/save, rolling-window trim, `lastTransactionId` extraction from `toolResults`, write-gate recovery within one `generateText`. | Loop mechanics are logic, not LLM behavior. |
| **Categorization (G2) / NL dates** | Manual smoke tests + a small fixture corpus. **Not in CI.** | Cannot meaningfully assert on LLM output in CI. |

Framework: **Vitest**. The ESLint `no-restricted-imports` rule (NFR-02) is itself a test that fails the build if a driver import leaks outside `/src/adapters/neon/`.

---

## 9. Build sequence

Vertical-slice-first — front-loads the risky seams, leaves a working bot ASAP.

- **Slice 0 — Skeleton.** `git init`; `package.json`, `tsconfig`, Vitest, ESLint (with the NFR-02 rule); `/config` env module; `pg` Pool in `adapters/neon/pool.ts`; migration runner + `001_init.sql` (SRS §6.2 DDL minus `processed_updates`); category seeding (`seed.ts`, SRS §10).
- **Slice 1 — Vertical slice.** Onboarding (FR-01) + `users` / `accounts` / `transactions` repositories + `get_accounts`, `create_account`, `create_expense` tools + minimal system prompt + grammY long-polling + session load/save. **End state: `bakso 20000 bca` → categorized expense → Indonesian reply.** Proves the grammY → agent → tools → repos → Neon seam.
- **Slice 2 — Remaining CRUD tools.** `create_income`; **atomic `create_transfer`**; `update_transaction`; `soft_delete_transaction`; `get_transactions`; `get_account_balance`; `get_categories`; budget codes (`create_budget_code`, `get_budget_codes`, `incrementSpent` + FR-03d overspend warning); recurring CRUD (`create` / `get` / `deactivate`); full system prompt (SP-01…SP-10); FR-08 koreksi via `lastTransactionId`.
- **Slice 3 — Reports.** `get_report` (period / category / budget-code breakdowns) + NL date resolution (model-driven, with a small WIB date-range helper).
- **Slice 4 — Scheduler.** Daily 08:00 cron; 5-minute defer sweep; inline-keyboard callbacks (confirm / defer / skip); `pendingRecurringConfirmation` persistence.
- **Slice 5 — Hardening.** Observability / logging (NFR-07); Bahasa error messages (NFR-09); soft-delete filtering everywhere (NFR-06); reconcile script (OQ-03).

---

## 10. Out of scope (v1)

Per SRS §12, plus: budget carryover (OQ-01), webhook transport, `processed_updates` idempotency table, `@neondatabase/serverless` driver, Fastify/HTTP framework.
