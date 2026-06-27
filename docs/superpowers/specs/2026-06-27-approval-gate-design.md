# Approval Gate — Design Spec

- **Date:** 2026-06-27
- **Status:** Approved (awaiting implementation plan)
- **Branch:** `feat/approval-gate`

## 1. Problem

MoneyBot is in closed beta. Today anyone who knows the bot username can message it, get auto-onboarded into the `users` table, and consume LLM tokens via the ReAct loop and the proactive schedulers. We need to restrict use to approved users while keeping the surface for unapproved users cheap and deterministic.

## 2. Goals

- Unapproved users get a single deterministic reply and **never** trigger an LLM call (reactive or proactive).
- A brand-new user is persisted to `users` as `pending`, and each configured admin is notified with a copy-paste-ready approval command.
- Approval is performed by an operator **directly in the database** — no admin bot, no admin agent, no in-Telegram management UI.

## 3. Non-goals (explicitly out of scope)

- No admin agent, admin system prompt, or admin tools.
- No inline Approve/Reject buttons, no `/admin` mode switch.
- No new admin repository methods (`setStatus`, `findAllByStatus`). The application never writes `status`; only the migration backfill and the operator do.
- No dynamic/env config updates from the bot. (Possible future work; the shape of this change does not preclude it.)

## 4. Data model

### 4.1 Migration — `migrations/004_user_status.sql`

```sql
ALTER TABLE users
  ADD COLUMN status VARCHAR NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected'));

-- Backfill: users already present are trusted and keep working.
UPDATE users SET status = 'approved';
```

The migration runner (`src/adapters/neon/migrate.ts`) tracks applied files in `_migrations`, so this is applied once, in a transaction, in filename sort order (after `003_*`). New rows inserted by `NeonUserRepository.create` omit `status`, so they take the column default `'pending'`.

### 4.2 Entity — `src/domain/entities.ts`

```ts
export type UserStatus = 'pending' | 'approved' | 'rejected';
```

Add `status: UserStatus;` to the `User` interface.

### 4.3 Mapper — `src/adapters/neon/mappers.ts`

`mapUser` gains `status: str(r, 'status') as UserStatus`.

### 4.4 Repository

**No interface or adapter change.** `findByTelegramChatId` already does `SELECT *`, so `status` is returned and mapped with no new method. The application reads `status`; it never writes it.

## 5. Reactive gate — `src/telegram/access.ts` (new)

A `routeMessage(deps)` function replaces the bare `handleMessage` call currently wired in `src/index.ts`. `src/telegram/bot.ts`'s `registerMessageHandler` is unchanged (it still takes a `(text, chatId) => Promise<string>` and replies with its return value); `index.ts` simply passes the gated handler.

### 5.1 Decision table (per incoming `message:text`)

| Sender state | Action | LLM? |
|---|---|---|
| no `users` row (first touch) | `create` as `pending` → notify every `ADMIN_CHAT_IDS` → reply canned | no |
| `pending` or `rejected` | reply canned (no re-notify) | no |
| `approved` | delegate to moneybot `handleMessage` (unchanged) | yes |

Notify fires **only on first touch** (the transition from "no row" to "pending"), so a user messaging repeatedly does not spam admins.

### 5.2 Shape

```ts
export const BETA_PENDING_MESSAGE = '...';            // canned reply to unapproved users

export function formatApprovalRequest(user: User, firstMessage: string): string { /* ... */ }

export interface RouteMessageDeps {
  repos: Repos;
  run: AgentRunner;
  buildSystem: () => string;                           // fresh system prompt per call (date may change)
  contextWindowTurns: number;
  sessionIdleTimeoutMinutes: number;
  adminChatIds: readonly string[];
  notify: (adminChatId: string, text: string) => Promise<void>;  // injected; wraps bot.api.sendMessage
}

export function routeMessage(deps: RouteMessageDeps): (text: string, chatId: string) => Promise<string>;
```

Pseudocode of the returned closure:

```
user = deps.repos.users.findByTelegramChatId(chatId)
if (!user):
    created = deps.repos.users.create({ telegramChatId: chatId, name: '' })   // status defaults to 'pending'
    await notifyAdmins(deps.adminChatIds, created, text, deps.notify)          // best-effort, per-admin try/catch
    logEvent('info', 'access request', { chatId, userId: created.userId })
    return BETA_PENDING_MESSAGE
if (user.status === 'approved'):
    { reply } = await handleMessage({ text, chatId, repos, run, system: buildSystem(), contextWindowTurns, sessionIdleTimeoutMinutes })
    return reply
logEvent('info', 'access denied', { chatId, userId: user.userId, status: user.status })
return BETA_PENDING_MESSAGE
```

`notifyAdmins` iterates `adminChatIds` and calls `notify(id, formatApprovalRequest(user, firstMessage))` inside a per-admin `try/catch` (one bad admin chat ID must not abort the others). It logs each failure.

### 5.3 Wiring — `src/index.ts`

```ts
const route = routeMessage({
  repos, run,
  buildSystem: () => buildSystemPrompt(todayWIB()),
  contextWindowTurns: config.CONTEXT_WINDOW_TURNS,
  sessionIdleTimeoutMinutes: config.SESSION_IDLE_TIMEOUT_MINUTES,
  adminChatIds: config.ADMIN_CHAT_IDS,
  notify: (id, msg) => bot.api.sendMessage(id, msg),   // plain text, no parse_mode
});
registerMessageHandler(async (text, chatId) => route(text, chatId));
```

`notify` injects `bot.api.sendMessage` so `routeMessage` is unit-testable with a fake (mirrors the `bot` injection pattern in `tests/scheduler/defer-sweep.test.ts`).

### 5.4 Messages

**Canned reply to the unapproved user** (`BETA_PENDING_MESSAGE`):

> 🚧 MoneyBot masih beta tertutup dan baru bisa dipakai pengguna yang sudah disetujui. Permintaan akses kamu sudah tercatat — mohon tunggu persetujuan ya. Terima kasih! 🙏

This string is static (no user content), so passing it through `registerMessageHandler`'s existing `markdownToTelegramHTML` + `parse_mode: 'HTML'` path is safe.

**Admin notification** (`formatApprovalRequest`), sent to each `ADMIN_CHAT_IDS` as **plain text** (no `parse_mode`) so a user-typed `<` or `&` cannot break rendering:

```
🆕 Permintaan akses MoneyBot baru
🆔 Chat ID: <chatId>
💬 Pesan: "<first 100 chars of firstMessage>"

Untuk menyetujui, jalankan di DB:
UPDATE users SET status='approved' WHERE telegram_chat_id='<chatId>';
```

The first message is truncated to 100 characters. Embedding the exact `UPDATE` is the entire approval UX: the operator copy-pastes it into their SQL client.

## 6. Proactive leak fix — `src/proactive/dispatcher.ts`

`runProactivePass` iterates `await o.repos.users.findAll()` (line 43) and runs every detector per user. Without a filter, an unapproved user would be eligible for LLM-composed proactive messages. Add an approved-only filter at the source:

```ts
const users = (await o.repos.users.findAll()).filter((u) => u.status === 'approved');
```

This single change seals the proactive channel. It also means pending users never receive the inline `rec:` recurring-bill buttons (those only ship inside proactive messages), so `src/telegram/callback-query.ts` needs no gating.

## 7. Config — `src/config/index.ts` + `.env.example`

Add to the zod schema, mirroring `PROACTIVE_BUDGET_THRESHOLDS` but parsed as strings (Telegram chat IDs exceed `Number.MAX_SAFE_INTEGER` and group IDs are negative):

```ts
ADMIN_CHAT_IDS: z.string()
  .default('')
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
```

`.env.example`:

```
# Approval-gate admins — Telegram chat IDs notified when a new user requests access.
ADMIN_CHAT_IDS=123456789,987654321
```

Startup behavior: log `info` with the admin count; log `warn` if the list is empty ("no admins configured; approval requests will not be notified"). An empty list makes `notifyAdmins` a no-op (the gate still works — first-touch users are still persisted and get the canned reply).

## 8. Existing orchestrator

`src/agent/orchestrator.ts` retains its internal find-or-create (`handleMessage` lines 33–39). Under the gate it is only ever reached for `approved` users that already exist, so that create path is inert. It is left untouched as a defensive no-op to keep this change small and avoid rippling into the orchestrator's existing tests.

## 9. Testing (TDD)

- **Entity/mapper/repo:** `mapUser` returns `status`; `NeonUserRepository.create` defaults to `pending` (create a user, read it back, assert `status === 'pending'`). The backfill of existing rows to `approved` is covered by the migration SQL itself (verified by inspection / a one-time manual check against the dev DB), not by an automated test — `npm test` applies migrations once globally before the suite, so the backfill cannot be re-exercised in isolation.
- **`routeMessage` decision table** (fake runner that records whether it was called):
  - approved user → runner called once, its reply returned.
  - pending user → runner **not** called, returns `BETA_PENDING_MESSAGE`.
  - rejected user → runner **not** called, returns `BETA_PENDING_MESSAGE`.
  - first touch (no row) → user created with `pending`, `notify` called once per admin chat ID, runner **not** called, returns `BETA_PENDING_MESSAGE`.
  - subsequent pending message → `notify` **not** called again.
  - one admin `notify` throwing does not abort the others.
- **`formatApprovalRequest`:** contains the chat ID and the literal `UPDATE users SET status='approved' WHERE telegram_chat_id='<chatId>';`.
- **Dispatcher filter:** with one `pending` and one `approved` user (fake repo + fake detector + fake `send`), only the approved user is sent to.

## 10. File map

| File | Change |
|---|---|
| `migrations/004_user_status.sql` | new — add `status` column + backfill |
| `src/domain/entities.ts` | add `UserStatus`, `User.status` |
| `src/adapters/neon/mappers.ts` | map `status` in `mapUser` |
| `src/config/index.ts` | add `ADMIN_CHAT_IDS` |
| `.env.example` | document `ADMIN_CHAT_IDS` |
| `src/telegram/access.ts` | new — `routeMessage`, `BETA_PENDING_MESSAGE`, `formatApprovalRequest`, `notifyAdmins` |
| `src/index.ts` | wire `routeMessage` into `registerMessageHandler`; startup admin-count log |
| `src/proactive/dispatcher.ts` | filter `findAll()` to `approved` |
| tests under `tests/` | new tests per §9 |

No changes to `src/telegram/bot.ts`, `src/agent/*`, `src/repositories/interfaces.ts`, or the neon user repository.
