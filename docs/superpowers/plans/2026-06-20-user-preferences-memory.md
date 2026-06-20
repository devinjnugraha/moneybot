# User Preferences Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent durable, per-user key/value preference memory that it writes via tools and that is injected into the system prompt on every turn.

**Architecture:** One new `user_preferences` table (composite PK `(user_id, key)` → upserts replace), a new `IUserPreferenceRepository` wired into `Repos`, two always-registered write tools (`remember_preference`, `forget_preference`) that never throw, and orchestrator-side enrichment of the system prompt with a `PREFERENSI USER` block (graceful degradation if the read fails). Follows existing layering `agent → tools → repositories → adapters/neon → Postgres`.

**Tech Stack:** TypeScript 5, `pg` (Neon), Vitest, ESLint, `tsx`, zod, Vercel AI SDK `tool()`.

**Reference:** Design spec at `docs/superpowers/specs/2026-06-20-user-preferences-memory-design.md`. SRS at `docs/SRS.md`.

---

## File Structure (this plan's deliverables)

```
Create:
  migrations/002_user_preferences.sql
  src/adapters/neon/user-preference.repository.ts
  tests/adapters/user-preference.repository.test.ts
Modify:
  src/domain/entities.ts                         ← add UserPreference
  src/repositories/interfaces.ts                 ← IUserPreferenceRepository + add to Repos
  src/adapters/neon/mappers.ts                   ← mapUserPreference
  src/adapters/neon/repos.ts                     ← assemble preferences repo
  src/agent/tools.ts                             ← remember_preference, forget_preference
  src/agent/orchestrator.ts                      ← inject PREFERENSI USER block
  src/agent/system-prompt.ts                     ← preference instructions
  tests/agent/tools.test.ts                      ← tool tests + preferences mock
  tests/agent/orchestrator.test.ts               ← injection test + preferences mock
  tests/telegram/callback-query.test.ts          ← preferences mock
  tests/scheduler/recurring-fire.test.ts         ← preferences mock
  tests/scheduler/defer-sweep.test.ts            ← preferences mock
```

**Verification after every task** (per `CLAUDE.md`): `npx tsc --noEmit` AND `npm run lint` AND the task's `npx vitest run <path>`. Vitest strips types — always run tsc too.

---

## Task 1: Migration + entity type

**Files:**
- Create: `migrations/002_user_preferences.sql`
- Modify: `src/domain/entities.ts`

- [ ] **Step 1: Create the migration `migrations/002_user_preferences.sql`**

```sql
-- User Preferences Memory (per-user key/value, injected into system prompt)
CREATE TABLE user_preferences (
  user_id    UUID        NOT NULL REFERENCES users(user_id),
  key        VARCHAR(96) NOT NULL,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);
```

- [ ] **Step 2: Add the `UserPreference` entity to `src/domain/entities.ts`**

Insert immediately after the `RecurringPayment` interface (before `SessionContext`):

```ts
export interface UserPreference {
  userId: string;
  key: string;
  value: string;
  updatedAt: string;
}
```

- [ ] **Step 3: Apply the migration to the dev DB**

Run: `npm run migrate`
Expected: a log line `{"timestamp":...,"level":"info","message":"migration applied","file":"002_user_preferences.sql"}`. (The idempotent runner skips `001_init.sql` as already applied.)

- [ ] **Step 4: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean. (Nothing references `UserPreference` yet — an unused exported interface is fine.)

- [ ] **Step 5: Commit**

```bash
git add migrations/002_user_preferences.sql src/domain/entities.ts
git commit -m "feat(db): user_preferences table + UserPreference entity"
```

---

## Task 2: Repository interface, mapper, and Neon implementation (TDD)

**Files:**
- Modify: `src/repositories/interfaces.ts` (add `IUserPreferenceRepository`; do NOT add to `Repos` yet — that is Task 3)
- Modify: `src/adapters/neon/mappers.ts` (add `mapUserPreference`)
- Create: `src/adapters/neon/user-preference.repository.ts`
- Create: `tests/adapters/user-preference.repository.test.ts`

- [ ] **Step 1: Write the failing test `tests/adapters/user-preference.repository.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonUserPreferenceRepository } from '../../src/adapters/neon/user-preference.repository.js';
import { uniqueChatId } from '../helpers/db.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
}

describe('NeonUserPreferenceRepository', () => {
  it('findAllByUserId returns [] when none saved', async () => {
    const user = await seedUser();
    const prefs = new NeonUserPreferenceRepository();
    expect(await prefs.findAllByUserId(user.userId)).toEqual([]);
  });

  it('upsert inserts a new preference', async () => {
    const user = await seedUser();
    const prefs = new NeonUserPreferenceRepository();
    const saved = await prefs.upsert(user.userId, 'default_account', 'BCA');
    expect(saved.key).toBe('default_account');
    expect(saved.value).toBe('BCA');
    expect(saved.userId).toBe(user.userId);
    const all = await prefs.findAllByUserId(user.userId);
    expect(all).toHaveLength(1);
    expect(all[0]!.value).toBe('BCA');
  });

  it('upsert updates the value when the key already exists (no duplicate row)', async () => {
    const user = await seedUser();
    const prefs = new NeonUserPreferenceRepository();
    await prefs.upsert(user.userId, 'default_account', 'BCA');
    await prefs.upsert(user.userId, 'default_account', 'GoPay');
    const all = await prefs.findAllByUserId(user.userId);
    expect(all).toHaveLength(1);
    expect(all[0]!.value).toBe('GoPay');
  });

  it('delete removes a preference', async () => {
    const user = await seedUser();
    const prefs = new NeonUserPreferenceRepository();
    await prefs.upsert(user.userId, 'salary_day', '25');
    await prefs.delete(user.userId, 'salary_day');
    expect(await prefs.findAllByUserId(user.userId)).toEqual([]);
  });

  it('delete is idempotent for a missing key (no error)', async () => {
    const user = await seedUser();
    const prefs = new NeonUserPreferenceRepository();
    await expect(prefs.delete(user.userId, 'never_set')).resolves.toBeUndefined();
  });

  it('isolates preferences per user', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    const prefs = new NeonUserPreferenceRepository();
    await prefs.upsert(u1.userId, 'x', 'one');
    expect(await prefs.findAllByUserId(u2.userId)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/user-preference.repository.test.ts`
Expected: FAIL — `Failed to load url .../user-preference.repository.js ... Does the file exist?`

- [ ] **Step 3: Add the interface to `src/repositories/interfaces.ts`**

Add the import of `UserPreference` to the existing entity import block at the top of the file:

```ts
import type {
  User,
  Account,
  Transaction,
  BudgetCode,
  RecurringPayment,
  SessionContext,
  UserPreference,
  AccountType,
  TransactionType,
} from '../domain/entities.js';
```

Add the interface after `ISessionRepository` (and before `Slice1Repos`):

```ts
export interface IUserPreferenceRepository {
  findAllByUserId(userId: string): Promise<UserPreference[]>;
  upsert(userId: string, key: string, value: string): Promise<UserPreference>;
  /** Idempotent: deleting a missing key is a no-op. */
  delete(userId: string, key: string): Promise<void>;
}
```

Do **not** add `preferences` to the `Repos` interface yet — that is Task 3 (it would break every mock-repo factory and belongs in its own task).

- [ ] **Step 4: Add `mapUserPreference` to `src/adapters/neon/mappers.ts`**

Add `UserPreference` to the entity import at the top:

```ts
import type {
  User,
  Account,
  Transaction,
  BudgetCode,
  RecurringPayment,
  SessionContext,
  UserPreference,
} from '../../domain/entities.js';
```

Add the mapper after `mapSession` at the end of the file:

```ts
export function mapUserPreference(r: Row): UserPreference {
  return {
    userId: str(r, 'user_id'),
    key: str(r, 'key'),
    value: str(r, 'value'),
    updatedAt: str(r, 'updated_at'),
  };
}
```

- [ ] **Step 5: Write `src/adapters/neon/user-preference.repository.ts`**

```ts
import { pool } from './pool.js';
import { mapUserPreference } from './mappers.js';
import type { IUserPreferenceRepository } from '../../repositories/interfaces.js';
import type { UserPreference } from '../../domain/entities.js';

export class NeonUserPreferenceRepository implements IUserPreferenceRepository {
  async findAllByUserId(userId: string): Promise<UserPreference[]> {
    const { rows } = await pool.query(
      'SELECT * FROM user_preferences WHERE user_id = $1 ORDER BY key',
      [userId],
    );
    return rows.map((r) => mapUserPreference(r as Record<string, unknown>));
  }

  async upsert(userId: string, key: string, value: string): Promise<UserPreference> {
    const { rows } = await pool.query(
      `INSERT INTO user_preferences (user_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       RETURNING *`,
      [userId, key, value],
    );
    return mapUserPreference(rows[0] as Record<string, unknown>);
  }

  async delete(userId: string, key: string): Promise<void> {
    await pool.query(
      'DELETE FROM user_preferences WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/user-preference.repository.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean. (The new interface/impl are exported but unused so far — that's fine; `Repos` is unchanged so all existing mocks still compile.)

- [ ] **Step 8: Commit**

```bash
git add src/repositories/interfaces.ts src/adapters/neon/mappers.ts src/adapters/neon/user-preference.repository.ts tests/adapters/user-preference.repository.test.ts
git commit -m "feat(repos): user-preference repository (findAll, upsert, idempotent delete)"
```

---

## Task 3: Wire the preferences repo into `Repos` and update all mock factories

**Files:**
- Modify: `src/repositories/interfaces.ts` (add `preferences` to `Repos`)
- Modify: `src/adapters/neon/repos.ts`
- Modify: `tests/agent/tools.test.ts`
- Modify: `tests/agent/orchestrator.test.ts`
- Modify: `tests/telegram/callback-query.test.ts`
- Modify: `tests/scheduler/recurring-fire.test.ts`
- Modify: `tests/scheduler/defer-sweep.test.ts`

Adding `preferences` to `Repos` makes every `Repos` mock in the test suite incomplete under `tsc`. This task adds the field, assembles it in `createRepos`, and adds a mock `preferences` object to each of the five mock factories so `tsc` stays green.

- [ ] **Step 1: Add `preferences` to the `Repos` interface in `src/repositories/interfaces.ts`**

```ts
export interface Repos {
  users: IUserRepository;
  accounts: IAccountRepository;
  transactions: ITransactionRepository;
  sessions: ISessionRepository;
  budgets: IBudgetCodeRepository;
  recurrings: IRecurringPaymentRepository;
  preferences: IUserPreferenceRepository;
}
```

- [ ] **Step 2: Assemble it in `src/adapters/neon/repos.ts`**

```ts
import { NeonUserRepository } from './user.repository.js';
import { NeonAccountRepository } from './account.repository.js';
import { NeonTransactionRepository } from './transaction.repository.js';
import { NeonSessionRepository } from './session.repository.js';
import { NeonBudgetCodeRepository } from './budget-code.repository.js';
import { NeonRecurringPaymentRepository } from './recurring-payment.repository.js';
import { NeonUserPreferenceRepository } from './user-preference.repository.js';
import type { Repos } from '../../repositories/interfaces.js';

export function createRepos(): Repos {
  return {
    users: new NeonUserRepository(),
    accounts: new NeonAccountRepository(),
    transactions: new NeonTransactionRepository(),
    sessions: new NeonSessionRepository(),
    budgets: new NeonBudgetCodeRepository(),
    recurrings: new NeonRecurringPaymentRepository(),
    preferences: new NeonUserPreferenceRepository(),
  };
}
```

- [ ] **Step 3: Add a mock `preferences` field to each of the five test mock factories**

In each file below, add this object inside the returned mock `Repos` (alongside the other repo mocks), adjusting nothing else:

```ts
    preferences: {
      findAllByUserId: vi.fn(async () => []),
      upsert: vi.fn(),
      delete: vi.fn(),
    } as never,
```

Files (insert it right after the `recurrings: { ... } as never,` block in each factory):
- `tests/agent/tools.test.ts` — inside `mockRepos()`
- `tests/agent/orchestrator.test.ts` — inside `mockRepos()`
- `tests/telegram/callback-query.test.ts` — inside `mockRepos()`
- `tests/scheduler/recurring-fire.test.ts` — inside `mockRepos()`
- `tests/scheduler/defer-sweep.test.ts` — inside `mockRepos()`

- [ ] **Step 4: Type-check + lint + full test suite**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: tsc clean, lint clean, all tests pass (the new repo test + all existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/repositories/interfaces.ts src/adapters/neon/repos.ts tests/agent/tools.test.ts tests/agent/orchestrator.test.ts tests/telegram/callback-query.test.ts tests/scheduler/recurring-fire.test.ts tests/scheduler/defer-sweep.test.ts
git commit -m "feat(repos): wire preferences repo into Repos + mock factories"
```

---

## Task 4: `remember_preference` and `forget_preference` tools (TDD)

**Files:**
- Modify: `src/agent/tools.ts`
- Modify: `tests/agent/tools.test.ts`

The tools are registered **always** (before the `if (!hasAccount) return tools;` gate), like the read tools, because preferences are not financial writes.

- [ ] **Step 1: Write the failing tests**

Append a new describe block at the end of `tests/agent/tools.test.ts`:

```ts
describe('buildTools — remember_preference / forget_preference', () => {
  it('remember_preference upserts and returns ok', async () => {
    const repos = mockRepos();
    (repos.preferences.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', key: 'default_account', value: 'BCA', updatedAt: '2026-06-20T00:00:00Z',
    });
    const { remember_preference } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(remember_preference, { key: 'default_account', value: 'BCA' });
    expect(res.status).toBe('ok');
    expect(res.data).toEqual({ key: 'default_account', value: 'BCA', updatedAt: '2026-06-20T00:00:00Z' });
    expect(repos.preferences.upsert).toHaveBeenCalledWith('u1', 'default_account', 'BCA');
  });

  it('remember_preference returns missing_fields for an empty key', async () => {
    const repos = mockRepos();
    const { remember_preference } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(remember_preference, { key: '   ', value: 'x' });
    expect(res.status).toBe('missing_fields');
    expect(res.missing).toContain('key');
    expect(repos.preferences.upsert).not.toHaveBeenCalled();
  });

  it('remember_preference returns Bahasa error when the repo throws (NFR-09)', async () => {
    const repos = mockRepos();
    (repos.preferences.upsert as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SQL CONNECTION LOST'));
    const { remember_preference } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(remember_preference, { key: 'k', value: 'v' });
    expect(res).toEqual({ status: 'error', message: 'Gagal menyimpan preferensi. Coba lagi.' });
    expect(logEvent).toHaveBeenCalledWith('error', expect.any(String), expect.objectContaining({ userId: 'u1' }));
  });

  it('forget_preference deletes and returns ok (idempotent semantics)', async () => {
    const repos = mockRepos();
    const { forget_preference } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(forget_preference, { key: 'default_account' });
    expect(res.status).toBe('ok');
    expect(res.data).toEqual({ key: 'default_account' });
    expect(repos.preferences.delete).toHaveBeenCalledWith('u1', 'default_account');
  });

  it('forget_preference returns Bahasa error when the repo throws (NFR-09)', async () => {
    const repos = mockRepos();
    (repos.preferences.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('BOOM'));
    const { forget_preference } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(forget_preference, { key: 'k' });
    expect(res).toEqual({ status: 'error', message: 'Gagal menghapus preferensi. Coba lagi.' });
  });
});
```

> Note: `logEvent` is already mocked at the top of `tests/agent/tools.test.ts` from Slice 5 (`vi.mock('../../src/utils/logger.js', ...)`). `callExec` and the `ToolCallResult` type (which has `status`, `message`, `missing`, `data`) already exist in that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent/tools.test.ts -t "remember_preference"`
Expected: FAIL — `Cannot read properties of undefined (reading 'execute')` or similar (tools not registered yet).

- [ ] **Step 3: Add the tools to `src/agent/tools.ts`**

Insert these two tool definitions immediately **after** the `get_account_balance` tool block and **before** the `get_report` tool block (i.e. among the always-registered tools, before the `if (!hasAccount) return tools;` gate):

```ts
  tools.remember_preference = tool({
    description:
      'Simpan preferensi user (akun favorit, tanggal gajian, kebiasaan kategorisasi, dll.). ' +
      'Upsert by key — kalau key sudah ada, nilainya diganti. Pakai key singkat yang deskriptif, ' +
      'simpan nilai singkat saja.',
    parameters: z.object({
      key: z.string().describe('Label singkat, mis. "default_account", "salary_day"'),
      value: z.string().describe('Nilai preferensi bebas'),
    }),
    execute: async ({ key, value }) => {
      const trimmedKey = key.trim();
      if (!trimmedKey) {
        return { status: 'missing_fields', missing: ['key'] };
      }
      try {
        const pref = await repos.preferences.upsert(userId, trimmedKey, value);
        return { status: 'ok', data: { key: pref.key, value: pref.value, updatedAt: pref.updatedAt } };
      } catch (e) {
        logEvent('error', 'remember_preference failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal menyimpan preferensi. Coba lagi.' };
      }
    },
  });

  tools.forget_preference = tool({
    description: 'Hapus preferensi user by key. Idempoten — aman dipanggil walau key tidak ada.',
    parameters: z.object({
      key: z.string(),
    }),
    execute: async ({ key }) => {
      const trimmedKey = key.trim();
      if (!trimmedKey) {
        return { status: 'missing_fields', missing: ['key'] };
      }
      try {
        await repos.preferences.delete(userId, trimmedKey);
        return { status: 'ok', data: { key: trimmedKey } };
      } catch (e) {
        logEvent('error', 'forget_preference failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal menghapus preferensi. Coba lagi.' };
      }
    },
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: PASS (all existing tools tests + the 5 new preference tests).

- [ ] **Step 5: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "feat(tools): remember_preference + forget_preference (user preference memory)"
```

---

## Task 5: Inject preferences into the system prompt (TDD)

**Files:**
- Modify: `src/agent/orchestrator.ts`
- Modify: `tests/agent/orchestrator.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the existing `describe('handleMessage', ...)` block in `tests/agent/orchestrator.test.ts`:

```ts
  it('injects the PREFERENSI USER block into the system prompt when prefs exist', async () => {
    const repos = mockRepos();
    (repos.users.findByTelegramChatId as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', telegramChatId: '1', name: 'Devin', language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
    });
    (repos.preferences.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue([
      { userId: 'u1', key: 'default_account', value: 'BCA', updatedAt: '' },
    ]);
    const run = vi.fn(async () => ({
      text: 'ok', responseMessages: [{ role: 'assistant' as const, content: 'ok' }], toolResults: [],
    }));
    await handleMessage({
      text: 'halo', chatId: '1', repos, run, system: 'BASE',
      contextWindowTurns: 20, sessionIdleTimeoutMinutes: 30,
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringContaining('PREFERENSI USER'),
    }));
    const call = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: string };
    expect(call.system).toContain('BASE');
    expect(call.system).toContain('- default_account: BCA');
  });

  it('leaves the system prompt unchanged when the user has no preferences', async () => {
    const repos = mockRepos();
    (repos.users.findByTelegramChatId as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', telegramChatId: '1', name: 'Devin', language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
    });
    (repos.preferences.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const run = vi.fn(async () => ({
      text: 'ok', responseMessages: [{ role: 'assistant' as const, content: 'ok' }], toolResults: [],
    }));
    await handleMessage({
      text: 'halo', chatId: '1', repos, run, system: 'BASE',
      contextWindowTurns: 20, sessionIdleTimeoutMinutes: 30,
    });
    const call = (run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: string };
    expect(call.system).toBe('BASE');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent/orchestrator.test.ts -t "PREFERENSI USER"`
Expected: FAIL — the runner is called with `system: 'BASE'` (no injection yet); the first test fails because `'BASE'` does not contain `'PREFERENSI USER'`.

- [ ] **Step 3: Implement the injection in `src/agent/orchestrator.ts`**

First, change the `const messages` declaration site is untouched. Insert the preferences enrichment **immediately after** the `logEvent('info', 'message received', ...)` call (the NFR-07 block) and **before** the `// 2. Load or reset session` comment:

```ts
  // Enrich the system prompt with the user's saved preferences (inject every
  // turn). Preferences are optional enrichment — degrade gracefully if the
  // read fails: log and proceed with the base prompt.
  let system = args.system;
  try {
    const prefs = await args.repos.preferences.findAllByUserId(user.userId);
    if (prefs.length) {
      system = args.system +
        '\n\nPREFERENSI USER (sudah diketahui — jangan tanya ulang):\n' +
        prefs.map((p) => `- ${p.key}: ${p.value}`).join('\n');
    }
  } catch (e) {
    logEvent('error', 'preferences load failed', { userId: user.userId, chatId: args.chatId, error: (e as Error).message });
  }

  // 2. Load or reset session
```

Then change the agent run call to use the enriched `system`. Replace `system: args.system,` inside the `args.run({ ... })` call with `system,`:

```ts
    result = await args.run({
      system,
      messages,
      tools,
      maxSteps: 10,
    });
```

- [ ] **Step 4: Run the orchestrator tests to verify they pass**

Run: `npx vitest run tests/agent/orchestrator.test.ts`
Expected: PASS (all existing + the 2 new injection tests).

- [ ] **Step 5: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/agent/orchestrator.ts tests/agent/orchestrator.test.ts
git commit -m "feat(agent): inject PREFERENSI USER block into system prompt (graceful degradation)"
```

---

## Task 6: System-prompt instructions for preference capture

**Files:**
- Modify: `src/agent/system-prompt.ts`

- [ ] **Step 1: Add the instruction paragraph to the system prompt**

In `src/agent/system-prompt.ts`, inside the template literal returned by `buildSystemPrompt`, add this paragraph immediately **before** the line `Pembayaran rutin bulanan:` (i.e. among the existing guidance paragraphs, after the `LAPORAN (get_report):` block):

```
PREFERENSI USER: Kalau user menyatakan preferensi (akun favorit, tanggal gajian, kebiasaan kategorisasi, hal yang ingin selalu diingat), simpan dengan remember_preference(key, value) supaya tidak ditanyakan ulang. Jangan tanya ulang hal yang sudah ada di blok PREFERENSI USER. Kalau user bilang "lupain" / "ga perlu lagi" / "hapus preferensi X", panggil forget_preference(key). Pakai key singkat yang deskriptif dan nilai singkat.
```

Keep it as part of the existing template literal (no new variable). The surrounding lines remain unchanged.

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/agent/system-prompt.ts
git commit -m "feat(agent): system-prompt guidance for remember/forget preferences"
```

---

## Task 7: Full suite verification

**Files:** None new.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (existing + 6 repo tests + 5 tool tests + 2 orchestrator tests).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors (NFR-02: no `pg` import outside `src/adapters/neon/`).

- [ ] **Step 4: Confirm the migration is applied**

Run: `npm run migrate`
Expected: `002_user_preferences.sql` is skipped as already applied (applied by the test global-setup); no error.

- [ ] **Step 5: If any fixups were needed, commit them**

```bash
git add -u && git commit -m "chore: preferences-memory final verification"
```
Otherwise no commit.

---

## Definition of Done

- [ ] `user_preferences` table created and migrated; `UserPreference` entity exists.
- [ ] `NeonUserPreferenceRepository` implements `findAllByUserId` / `upsert` / idempotent `delete` (6 integration tests).
- [ ] `preferences` wired into `Repos` + `createRepos`; all 5 mock factories updated.
- [ ] `remember_preference` + `forget_preference` tools registered always, never throw, Bahasa on error (5 unit tests).
- [ ] Orchestrator injects `PREFERENSI USER` block when prefs exist, leaves prompt unchanged when empty, degrades gracefully on read failure (2 tests).
- [ ] System prompt instructs the model to capture/forget preferences.
- [ ] `npx tsc --noEmit` clean, `npm run lint` clean, `npm test` green.
- [ ] No `pg` import outside `src/adapters/neon/` (NFR-02).

## Manual smoke (after implementation, requires real env)

With `npm run dev` and a real `TELEGRAM_BOT_TOKEN` + `OPENROUTER_API_KEY`:
1. Tell the bot a preference in one turn (e.g. "buat sementara aku selalu pakai BCA").
2. Confirm it acknowledges saving it (calls `remember_preference`).
3. In a later turn, send something where the preference applies and confirm it is honored without re-asking.
4. Say "lupain preference default_account" and confirm removal (calls `forget_preference`).
