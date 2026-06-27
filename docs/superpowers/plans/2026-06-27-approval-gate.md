# Approval Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict MoneyBot to approved users — unapproved users get a deterministic reply and never consume an LLM call; first-touch users are persisted as `pending` and each configured admin is notified with a copy-paste approval command.

**Architecture:** Add a `status` column to `users` (`pending`/`approved`/`rejected`). A new `routeMessage` gate in `src/telegram/access.ts` replaces the bare `handleMessage` call wired in `src/index.ts`: approved → moneybot (unchanged); pending/rejected/first-touch → canned reply (no LLM); first-touch also persists + notifies `ADMIN_CHAT_IDS`. The proactive dispatcher filters to approved users so unapproved users are never proactively messaged. Approval itself is done by the operator via raw SQL — no admin bot.

**Tech Stack:** TypeScript (strict), grammY, Vercel AI SDK, `pg` on Neon Postgres, vitest, zod.

**Spec:** `docs/superpowers/specs/2026-06-27-approval-gate-design.md`

**Branch:** `feat/approval-gate` (already created and checked out)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `migrations/004_user_status.sql` | Add `status` column + backfill existing rows to `approved` | create |
| `src/domain/entities.ts` | `UserStatus` type + `User.status` | modify |
| `src/adapters/neon/mappers.ts` | Map `status` in `mapUser` | modify |
| `src/config/index.ts` | `ADMIN_CHAT_IDS` env → `string[]` | modify |
| `.env.example` | Document `ADMIN_CHAT_IDS` | modify |
| `src/telegram/access.ts` | `routeMessage` gate, `BETA_PENDING_MESSAGE`, `formatApprovalRequest`, `notifyAdmins` | create |
| `src/index.ts` | Wire `routeMessage` into `registerMessageHandler`; startup admin-count log | modify |
| `src/proactive/dispatcher.ts` | Filter `findAll()` to `approved` | modify |
| `tests/adapters/user.repository.test.ts` | `create` defaults `pending` | modify |
| `tests/telegram/access.test.ts` | Gate decision table | create |
| `tests/proactive/dispatcher.test.ts` | Mock users get `status`; new filter test | modify |

No changes to `src/telegram/bot.ts`, `src/agent/*`, `src/repositories/interfaces.ts`, or the neon user repository — `status` rides on the existing `SELECT *` in `findByTelegramChatId`/`findAll`.

---

## Task 1: Data model — `UserStatus`, `User.status`, migration, mapper

**Files:**
- Create: `migrations/004_user_status.sql`
- Modify: `src/domain/entities.ts`
- Modify: `src/adapters/neon/mappers.ts`
- Test: `tests/adapters/user.repository.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/adapters/user.repository.test.ts` (inside the top `describe('NeonUserRepository', ...)` block, after the existing `finds by id and updates name` test):

```ts
  it('creates a user with default pending status and maps it back', async () => {
    const repo = new NeonUserRepository();
    const chatId = uniqueChatId();
    const created = await repo.create({ telegramChatId: chatId, name: 'Devin' });
    expect(created.status).toBe('pending');
    const found = await repo.findByTelegramChatId(chatId);
    expect(found?.status).toBe('pending');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/user.repository.test.ts`
Expected: FAIL — `created.status` is `undefined` (column/mapper/type not present yet).

- [ ] **Step 3: Add the `UserStatus` type and `User.status`**

In `src/domain/entities.ts`, add the type above the `User` interface and the field inside it. The `User` interface becomes:

```ts
export type UserStatus = 'pending' | 'approved' | 'rejected';

export interface User {
  userId: string;
  telegramChatId: string;
  name: string;
  language: 'id' | 'en';
  timezone: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 4: Create the migration**

Create `migrations/004_user_status.sql`:

```sql
-- Approval gate: per-user access status. Default 'pending' for new signups.
ALTER TABLE users
  ADD COLUMN status VARCHAR NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected'));

-- Backfill: users already present are trusted and keep working.
UPDATE users SET status = 'approved';
```

- [ ] **Step 5: Map `status` in `mapUser`**

In `src/adapters/neon/mappers.ts`:

1. Add `UserStatus` to the type import from entities (line 1–9). The import block becomes:

```ts
import type {
  User,
  UserStatus,
  Account,
  Transaction,
  BudgetCode,
  RecurringPayment,
  SessionContext,
  UserPreference,
} from '../../domain/entities.js';
```

2. Add the `status` line to `mapUser`, after the `timezone` line:

```ts
export function mapUser(r: Row): User {
  return {
    userId: str(r, 'user_id'),
    telegramChatId: str(r, 'telegram_chat_id'),
    name: str(r, 'name'),
    language: str(r, 'language') === 'en' ? 'en' : 'id',
    timezone: str(r, 'timezone'),
    status: str(r, 'status') as UserStatus,
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

The migration is applied automatically: `npm test` / `npx vitest run` invokes `tests/global-setup.ts` which calls `migrate()`, and `migrate()` reads `migrations/*.sql` at runtime and applies `004_user_status.sql` (tracked in `_migrations`, so exactly once).

Run: `npx vitest run tests/adapters/user.repository.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add migrations/004_user_status.sql src/domain/entities.ts src/adapters/neon/mappers.ts tests/adapters/user.repository.test.ts
git commit -m "feat: add user approval status column and User.status"
```

---

## Task 2: Config — `ADMIN_CHAT_IDS`

**Files:**
- Modify: `src/config/index.ts`
- Modify: `.env.example`

> No isolated unit test: `ADMIN_CHAT_IDS` mirrors the existing (untested) `PROACTIVE_BUDGET_THRESHOLDS` transform exactly. Correctness is covered by `tsc` (the field exists and is typed `string[]`) and by the `routeMessage` tests in Task 3, which consume the value end-to-end via the `adminChatIds` dep.

- [ ] **Step 1: Add the field to the zod schema**

In `src/config/index.ts`, add `ADMIN_CHAT_IDS` to the `schema` object (e.g. after the `OPENROUTER_MODEL` line):

```ts
  OPENROUTER_MODEL: z.string().default('anthropic/claude-3-haiku'),
  // "123,456" -> ["123","456"] (strings; chat ids exceed Number.MAX_SAFE_INTEGER and may be negative).
  ADMIN_CHAT_IDS: z.string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
```

- [ ] **Step 2: Document it in `.env.example`**

Add at the end of `.env.example`:

```
# Approval-gate admins — Telegram chat IDs notified when a new user requests access.
# Comma-separated, e.g. ADMIN_CHAT_IDS=123456789,987654321
ADMIN_CHAT_IDS=
```

- [ ] **Step 3: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config/index.ts .env.example
git commit -m "feat: add ADMIN_CHAT_IDS config"
```

---

## Task 3: The gate — `src/telegram/access.ts`

**Files:**
- Create: `src/telegram/access.ts`
- Test: `tests/telegram/access.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/telegram/access.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));
vi.mock('../../src/agent/orchestrator.js', () => ({
  handleMessage: vi.fn(async () => ({ reply: 'MONEYBOT_REPLY' })),
}));

import { routeMessage, BETA_PENDING_MESSAGE, formatApprovalRequest } from '../../src/telegram/access.js';
import { handleMessage } from '../../src/agent/orchestrator.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { User } from '../../src/domain/entities.js';

function user(chatId: string, status: User['status']): User {
  return {
    userId: 'u-' + chatId,
    telegramChatId: chatId,
    name: 'A',
    language: 'id',
    timezone: 'Asia/Jakarta',
    status,
    createdAt: '',
    updatedAt: '',
  };
}

function mockRepos(opts: { found?: User | null } = {}): Repos {
  return {
    users: {
      findByTelegramChatId: vi.fn(async () => opts.found ?? null),
      findById: vi.fn(),
      findAll: vi.fn(),
      create: vi.fn(async (i: { telegramChatId: string }) => user(i.telegramChatId, 'pending')),
      update: vi.fn(),
    } as never,
    accounts: { findAllByUserId: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: { create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn() } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  } as never;
}

function makeRoute(repos: Repos, adminChatIds: readonly string[] = ['admin-1']) {
  const notify = vi.fn(async () => undefined);
  const route = routeMessage({
    repos,
    run: vi.fn() as never,
    buildSystem: () => 'SYS',
    contextWindowTurns: 20,
    sessionIdleTimeoutMinutes: 30,
    adminChatIds,
    notify,
  });
  return { route, notify };
}

describe('routeMessage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to the moneybot agent for an approved user', async () => {
    const repos = mockRepos({ found: user('c1', 'approved') });
    const { route, notify } = makeRoute(repos);
    const reply = await route('halo', 'c1');
    expect(reply).toBe('MONEYBOT_REPLY');
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('replies canned and skips the agent for a pending user', async () => {
    const repos = mockRepos({ found: user('c1', 'pending') });
    const { route, notify } = makeRoute(repos);
    const reply = await route('halo', 'c1');
    expect(reply).toBe(BETA_PENDING_MESSAGE);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('replies canned and skips the agent for a rejected user', async () => {
    const repos = mockRepos({ found: user('c1', 'rejected') });
    const { route } = makeRoute(repos);
    const reply = await route('halo', 'c1');
    expect(reply).toBe(BETA_PENDING_MESSAGE);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('on first touch creates a pending user, notifies admins, replies canned, skips the agent', async () => {
    const repos = mockRepos({ found: null });
    const { route, notify } = makeRoute(repos, ['a1', 'a2']);
    const reply = await route('halo', 'c1');
    expect(reply).toBe(BETA_PENDING_MESSAGE);
    expect(repos.users.create).toHaveBeenCalledWith({ telegramChatId: 'c1', name: '' });
    expect(handleMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith('a1', expect.any(String));
    expect(notify).toHaveBeenCalledWith('a2', expect.any(String));
  });

  it('does not re-notify on subsequent pending messages', async () => {
    const repos = mockRepos({ found: user('c1', 'pending') });
    const { route, notify } = makeRoute(repos, ['a1']);
    await route('halo', 'c1');
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies no one when adminChatIds is empty (user still persisted)', async () => {
    const repos = mockRepos({ found: null });
    const { route, notify } = makeRoute(repos, []);
    const reply = await route('halo', 'c1');
    expect(reply).toBe(BETA_PENDING_MESSAGE);
    expect(repos.users.create).toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('one admin notify failure does not abort the others', async () => {
    const repos = mockRepos({ found: null });
    const notify = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('blocked');
    });
    const route = routeMessage({
      repos,
      run: vi.fn() as never,
      buildSystem: () => 'SYS',
      contextWindowTurns: 20,
      sessionIdleTimeoutMinutes: 30,
      adminChatIds: ['bad', 'good'],
      notify,
    });
    const reply = await route('halo', 'c1');
    expect(reply).toBe(BETA_PENDING_MESSAGE);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe('formatApprovalRequest', () => {
  it('includes the chat id and a copy-paste approve UPDATE', () => {
    const msg = formatApprovalRequest(user('12345', 'pending'), 'hai');
    expect(msg).toContain('12345');
    expect(msg).toContain("UPDATE users SET status='approved' WHERE telegram_chat_id='12345';");
    expect(msg).toContain('hai');
  });

  it('truncates the first message preview to 100 chars', () => {
    const long = 'x'.repeat(500);
    const msg = formatApprovalRequest(user('9', 'pending'), long);
    expect(msg).toContain('x'.repeat(100));
    expect(msg).not.toContain('x'.repeat(101));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/telegram/access.test.ts`
Expected: FAIL — module `../../src/telegram/access.js` does not exist yet.

- [ ] **Step 3: Implement `src/telegram/access.ts`**

Create `src/telegram/access.ts`:

```ts
import type { Repos } from '../repositories/interfaces.js';
import type { AgentRunner } from '../agent/run-agent.js';
import type { User } from '../domain/entities.js';
import { handleMessage } from '../agent/orchestrator.js';
import { logEvent } from '../utils/logger.js';

/** Deterministic reply to any unapproved user (no user content; HTML-safe). */
export const BETA_PENDING_MESSAGE =
  '🚧 MoneyBot masih beta tertutup dan baru bisa dipakai pengguna yang sudah disetujui. ' +
  'Permintaan akses kamu sudah tercatat — mohon tunggu persetujuan ya. Terima kasih! 🙏';

/** First-message preview length sent to admins. */
const ADMIN_PREVIEW_LEN = 100;

/**
 * Plain-text notification sent to each admin when a user first requests access.
 * Plain text (no parse_mode) so a user-typed `<`/`&` cannot break rendering. The
 * embedded UPDATE is the entire approval UX — the operator runs it by hand.
 */
export function formatApprovalRequest(user: User, firstMessage: string): string {
  const preview = firstMessage.slice(0, ADMIN_PREVIEW_LEN);
  return (
    '🆕 Permintaan akses MoneyBot baru\n' +
    `🆔 Chat ID: ${user.telegramChatId}\n` +
    `💬 Pesan: "${preview}"\n\n` +
    'Untuk menyetujui, jalankan di DB:\n' +
    `UPDATE users SET status='approved' WHERE telegram_chat_id='${user.telegramChatId}';`
  );
}

export interface RouteMessageDeps {
  repos: Repos;
  run: AgentRunner;
  buildSystem: () => string;
  contextWindowTurns: number;
  sessionIdleTimeoutMinutes: number;
  adminChatIds: readonly string[];
  /** Wraps bot.api.sendMessage; injected so the gate is unit-testable without grammy. */
  notify: (adminChatId: string, text: string) => Promise<void>;
}

/** Best-effort: notify every admin. One bad admin chat id must not abort the rest. */
async function notifyAdmins(
  adminChatIds: readonly string[],
  user: User,
  firstMessage: string,
  notify: RouteMessageDeps['notify'],
): Promise<void> {
  const text = formatApprovalRequest(user, firstMessage);
  for (const adminChatId of adminChatIds) {
    try {
      await notify(adminChatId, text);
    } catch (err) {
      logEvent('error', 'admin notify failed', { adminChatId, error: (err as Error).message });
    }
  }
}

/**
 * Approval gate. Returns the reply text for a message. Unapproved users (no row,
 * pending, or rejected) get a deterministic canned reply and never reach the LLM.
 * First-touch users are persisted as `pending` and each admin is notified.
 * Approved users are delegated to the moneybot agent unchanged.
 */
export function routeMessage(
  deps: RouteMessageDeps,
): (text: string, chatId: string) => Promise<string> {
  return async (text, chatId) => {
    const user = await deps.repos.users.findByTelegramChatId(chatId);

    if (!user) {
      const created = await deps.repos.users.create({ telegramChatId: chatId, name: '' });
      await notifyAdmins(deps.adminChatIds, created, text, deps.notify);
      logEvent('info', 'access request', { chatId, userId: created.userId });
      return BETA_PENDING_MESSAGE;
    }

    if (user.status === 'approved') {
      const { reply } = await handleMessage({
        text,
        chatId,
        repos: deps.repos,
        run: deps.run,
        system: deps.buildSystem(),
        contextWindowTurns: deps.contextWindowTurns,
        sessionIdleTimeoutMinutes: deps.sessionIdleTimeoutMinutes,
      });
      return reply;
    }

    logEvent('info', 'access denied', { chatId, userId: user.userId, status: user.status });
    return BETA_PENDING_MESSAGE;
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/telegram/access.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/access.ts tests/telegram/access.test.ts
git commit -m "feat: add approval gate (routeMessage) with admin notifications"
```

---

## Task 4: Wire the gate into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

> No new test: this is composition. The gate logic is covered by Task 3; the wiring is verified by `tsc` + `lint`.

- [ ] **Step 1: Replace the import and the handler closure**

In `src/index.ts`:

1. Replace the `handleMessage` import (line 12) with the `routeMessage` import:

```ts
import { routeMessage } from './telegram/access.js';
```

2. Replace the `registerMessageHandler(...)` block (lines 34–45) with:

```ts
  const route = routeMessage({
    repos,
    run,
    buildSystem: () => buildSystemPrompt(todayWIB()),
    contextWindowTurns: config.CONTEXT_WINDOW_TURNS,
    sessionIdleTimeoutMinutes: config.SESSION_IDLE_TIMEOUT_MINUTES,
    adminChatIds: config.ADMIN_CHAT_IDS,
    notify: (id, msg) => bot.api.sendMessage(id, msg),
  });
  registerMessageHandler(async (text, chatId) => route(text, chatId));
```

`buildSystemPrompt` (line 13) and `todayWIB` (line 14) stay imported and are now used inside the `buildSystem` closure. `bot` is already imported on line 15 (`import { bot, registerMessageHandler } from './telegram/bot.js';`).

- [ ] **Step 2: Add the startup admin-count log**

In `src/index.ts` `main()`, immediately after `await seed();` (line 23), add:

```ts
  logEvent(
    config.ADMIN_CHAT_IDS.length ? 'info' : 'warn',
    'approval gate',
    { adminCount: config.ADMIN_CHAT_IDS.length },
  );
```

- [ ] **Step 3: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. (`handleMessage` import is gone and no longer referenced; `buildSystemPrompt`/`todayWIB` are still used.)

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire approval gate into the message handler"
```

---

## Task 5: Seal the proactive channel — approved-only filter

**Files:**
- Modify: `src/proactive/dispatcher.ts`
- Test: `tests/proactive/dispatcher.test.ts`

> This task's first step fixes the existing dispatcher tests: their mock users have no `status`, so once the filter lands they would all be filtered out and fail. Adding `status: 'approved'` to the mock first keeps them green, then the new test drives the filter.

- [ ] **Step 1: Give the dispatcher test's mock users a `status`**

In `tests/proactive/dispatcher.test.ts`:

1. Change the `mockRepos` `users` override type and default (lines 16–23) to include `status`:

```ts
function mockRepos(overrides: {
  users?: { userId: string; telegramChatId: string; status?: 'pending' | 'approved' | 'rejected' }[];
  muted?: boolean;
  existsKey?: boolean;
  countSince?: number;
  existingSession?: { chatId: string; userId: string; turns: unknown[]; lastActivityAt: string } | null;
} = {}): Repos {
  const users = overrides.users ?? [{ userId: 'u1', telegramChatId: 'c1', status: 'approved' }];
```

2. In the `catches a detector error, logs it, and continues to the next user` test, add `status: 'approved'` to both users:

```ts
    const repos = mockRepos({ users: [
      { userId: 'u1', telegramChatId: 'c1', status: 'approved' },
      { userId: 'u2', telegramChatId: 'c2', status: 'approved' },
    ] });
```

- [ ] **Step 2: Run existing dispatcher tests to confirm they still pass (filter not added yet)**

Run: `npx vitest run tests/proactive/dispatcher.test.ts`
Expected: PASS (all existing tests; no filter yet, so `status` is simply ignored).

- [ ] **Step 3: Add the failing filter test**

In `tests/proactive/dispatcher.test.ts`, add inside `describe('runProactivePass', ...)` (e.g. after the `kill-switch off` test):

```ts
  it('skips non-approved users (only approved users are sent to)', async () => {
    const repos = mockRepos({ users: [
      { userId: 'u1', telegramChatId: 'c1', status: 'pending' },
      { userId: 'u2', telegramChatId: 'c2', status: 'approved' },
    ] });
    const send = vi.fn(async () => undefined);
    const detector = vi.fn(async () => [summaryPayload]);
    const composer = vi.fn(async () => 'OK');
    await runProactivePass({ detector, composer, repos, policy: POLICY, now: NOW, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('c2', 'OK', undefined);
  });
```

- [ ] **Step 4: Run the new test to verify it fails**

Run: `npx vitest run tests/proactive/dispatcher.test.ts`
Expected: FAIL — `send` called twice (both users, no filter).

- [ ] **Step 5: Add the approved-only filter**

In `src/proactive/dispatcher.ts`, change line 43 from:

```ts
  const users = await o.repos.users.findAll();
```

to:

```ts
  // Approval gate: never proactively message (or spend LLM on) unapproved users.
  const users = (await o.repos.users.findAll()).filter((u) => u.status === 'approved');
```

- [ ] **Step 6: Run the dispatcher tests to verify they pass**

Run: `npx vitest run tests/proactive/dispatcher.test.ts`
Expected: PASS (all tests, including the new filter test).

- [ ] **Step 7: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/proactive/dispatcher.ts tests/proactive/dispatcher.test.ts
git commit -m "feat: restrict proactive outreach to approved users"
```

---

## Task 6: Final verification

- [ ] **Step 1: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Lint the whole project**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Run the test files touched by this plan**

Run: `npx vitest run tests/adapters/user.repository.test.ts tests/telegram/access.test.ts tests/proactive/dispatcher.test.ts`
Expected: all PASS.

- [ ] **Step 4: Full suite (informational)**

Run: `npx vitest run`

> Note: `tests/scripts/reconcile.test.ts` has 4 pre-existing failures caused by Neon latency at the default vitest timeout — they pass at 30s and are **not** a regression from this work. If those 4 are the only failures, the change is green. Confirm no *new* failures in `user.repository`, `access`, `dispatcher`, `orchestrator`, or the proactive trigger tests.

Expected: PASS except possibly the 4 known reconcile timeouts.

- [ ] **Step 5: Manual smoke check (optional, requires real `.env`)**

With `ADMIN_CHAT_IDS` set to your own chat id in `.env`:
1. Message the bot from an unapproved account → expect the canned beta reply; your admin account receives the approval notification with the `UPDATE` SQL.
2. Run the `UPDATE users SET status='approved' WHERE telegram_chat_id='<that chat id>';` against the dev DB.
3. Message again from that account → expect the normal moneybot agent reply.

---

## Self-Review (completed)

- **Spec coverage:** §4 data model → Task 1. §5 gate → Task 3 + Task 4. §5.4 messages → Task 3 (`BETA_PENDING_MESSAGE`, `formatApprovalRequest`). §6 proactive fix → Task 5. §7 config → Task 2 (+ startup log in Task 4). §9 testing → covered by Tasks 1, 3, 5. §8 orchestrator left untouched → confirmed (Task 4 only changes the call site in `index.ts`). §10 file map matches. ✓
- **Placeholder scan:** none — every code step contains complete code. ✓
- **Type consistency:** `UserStatus` defined (Task 1) and used in `mapUser` (Task 1) and as `User['status']` in tests (Tasks 3, 5). `routeMessage` / `RouteMessageDeps` / `formatApprovalRequest` / `BETA_PENDING_MESSAGE` names match between implementation (Task 3) and wiring (Task 4) and tests (Task 3). The dispatcher filter reads `u.status === 'approved'`, matching the `User.status` field type. ✓
