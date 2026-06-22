# Proactive Outreach Engine — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a proactive outreach engine that lets MoneyBot send the user an LLM-composed daily spending summary on its own schedule, spam-safe via DB-enforced dedup + rate-limit + quiet-hours + per-user mute, with two-way replies enabled.

**Architecture:** A cron-driven dispatcher (`runProactivePass`) loops users, runs a pure **detector** (is there something worth saying?), checks the **guard** (mute/quiet/dedup/rate-limit), composes a message (LLM, template fallback), sends via the existing `bot.api.sendMessage`, records an atomic dedup row in `outreach_log`, and seeds the digest as an assistant turn so the user can reply and drill in. Two new tables, two new repos added to `Repos`; no new infrastructure — in-process `node-cron`, same process as the polling bot. Layering rule (NFR-02) intact: detectors/dispatcher/composer import only from `repositories/interfaces.ts`, never an adapter.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `node-cron`, Vercel AI SDK `generateText`, grammY, `pg`, Vitest (real-Neon repo tests + mocked repos for logic layers).

**Spec:** `docs/superpowers/specs/2026-06-22-proactive-outreach-design.md`

---

## Conventions (apply to every task)

- **Branch:** already on `feat/proactive-outreach`. Commit one task at a time.
- **Verification trio (a task is done only when ALL three are clean):**
  ```bash
  npx tsc --noEmit          # strict type-check (vitest strips types, so this is mandatory)
  npm run lint              # ESLint flat config; NFR-02 fails if a db driver leaks outside src/adapters/neon/
  npx vitest run <path>     # the task's test file (or `npm test` for the full suite)
  ```
- **TDD cycle:** write the failing test → run it (confirm it fails for the right reason) → implement → run (pass) → trio → commit.
- **Imports:** `.js` extensions on all relative imports (`verbatimModuleSyntax`). Entity types from `src/domain/entities.js`; repo interfaces from `src/repositories/interfaces.js`.
- **ESLint gotchas in this repo:** `no-explicit-any` (use `unknown` + casts), `no-duplicate-imports`, `no-restricted-imports` (no `pg`/db outside `src/adapters/neon/`).
- **Test isolation:** tests do NOT auto-truncate. Use `uniqueChatId()` from `tests/helpers/db.ts` so each test creates distinct users. For `findAll()`-style tests, assert membership (`some(...)`) not exact counts.
- **Commit messages:** conventional (`feat(...)`, `test:`, `chore:`). End every commit message body with:
  ```
  Co-Authored-By: Claude <noreply@anthropic.com>
  ```

**File map (what gets created/modified across the slice):**

```
migrations/002_proactive.sql                              [Task 1] new
src/domain/entities.ts                                    [Task 2] add ProactiveTriggerType, OutreachLogEntry, ProactiveSettings
src/proactive/types.ts                                    [Task 2] new — ProactivePayload, Detector, Composer, ProactivePolicy
src/config/index.ts                                       [Task 3] add proactive env vars
src/repositories/interfaces.ts                            [Task 4,5] findAll + IOutreachLogRepository + IProactiveSettingsRepository + Repos fields
src/adapters/neon/user.repository.ts                      [Task 4] findAll
src/adapters/neon/outreach-log.repository.ts              [Task 5] new
src/adapters/neon/proactive-settings.repository.ts        [Task 5] new
src/adapters/neon/repos.ts                                [Task 5] wire new repos
src/proactive/guard.ts                                    [Task 6] new — isMuted, inQuietHours, startOfTodayWIB
src/proactive/prompt.ts                                   [Task 7] new — PROACTIVE_SYSTEM_PROMPT
src/proactive/composers/template.ts                       [Task 8] new
src/proactive/composers/llm.ts                            [Task 9] new
src/proactive/composers/resolve.ts                        [Task 10] new — createComposer
src/proactive/triggers/scheduled-summary.ts               [Task 11] new — detectScheduledSummary
src/proactive/dispatcher.ts                               [Task 12] new — runProactivePass + seedAssistantTurn
src/telegram/nudges-command.ts                            [Task 13] new — /nudges
src/scheduler/cron.ts                                     [Task 14] register proactive cron + model param
src/index.ts                                              [Task 14] pass model to startCronJobs, register /nudges
existing mock-`Repos` factories (3 test files)            [Task 5] add outreach + proactiveSettings fields
```

---

## Task 1: Migration 002 — `outreach_log` + `proactive_settings`

**Files:**
- Create: `migrations/002_proactive.sql`

- [ ] **Step 1: Write the migration SQL**

Create `migrations/002_proactive.sql`:

```sql
-- Proactive outreach log: dedup + rate-limit source of truth (design §6).
-- The (user_id, dedup_key) UNIQUE index is the atomic dedup invariant.
CREATE TABLE outreach_log (
  outreach_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(user_id),
  trigger_type VARCHAR     NOT NULL CHECK (trigger_type IN
                ('scheduled_summary','budget_threshold','logging_gap','anomaly')),
  dedup_key    VARCHAR     NOT NULL,
  payload      JSONB       NOT NULL DEFAULT '{}',
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_outreach_dedup     ON outreach_log(user_id, dedup_key);
CREATE INDEX        idx_outreach_user_sent ON outreach_log(user_id, sent_at);

-- Per-user proactive control. No row == defaults (not muted).
CREATE TABLE proactive_settings (
  user_id    UUID        PRIMARY KEY REFERENCES users(user_id),
  muted      BOOLEAN     NOT NULL DEFAULT false,
  resume_at  TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2: Apply the migration to the dev DB**

Run: `npm run migrate`
Expected output: a line `[info] migration applied { file: '002_proactive.sql' }` (JSON log). If `002_proactive.sql` is absent from the log it was already applied in a prior run — that's fine.

- [ ] **Step 3: Verify the tables exist**

Run:
```bash
npx tsx -e "import('./src/adapters/neon/pool.js').then(async ({pool}) => { const r = await pool.query(\"SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('outreach_log','proactive_settings') ORDER BY tablename\"); console.log(r.rows.map(x=>x.tablename)); await pool.end(); })"
```
Expected: `[ 'outreach_log', 'proactive_settings' ]`

- [ ] **Step 4: Commit**

```bash
git add migrations/002_proactive.sql
git commit -m "feat(db): outreach_log + proactive_settings tables (proactive slice 1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Domain entities + proactive types

**Files:**
- Modify: `src/domain/entities.ts` (append new types)
- Create: `src/proactive/types.ts`

- [ ] **Step 1: Add proactive domain types to `entities.ts`**

Append to `src/domain/entities.ts` (after the `UserPreference` interface, before `SessionContext` — placement is not load-bearing):

```ts
// ---- Proactive outreach ----

export type ProactiveTriggerType =
  | 'scheduled_summary'
  | 'budget_threshold'
  | 'logging_gap'
  | 'anomaly';

export interface OutreachLogEntry {
  outreachId: string;
  userId: string;
  triggerType: ProactiveTriggerType;
  dedupKey: string;
  payload: unknown;
  sentAt: string; // ISO 8601
}

export interface ProactiveSettings {
  userId: string;
  muted: boolean;
  resumeAt?: string; // ISO 8601; undefined => mute until explicitly turned back on
}
```

- [ ] **Step 2: Create `src/proactive/types.ts`**

```ts
import type { LanguageModel } from 'ai';
import type { ProactiveTriggerType } from '../domain/entities.js';
import type { Repos } from '../repositories/interfaces.js';

export type ComposerChannel = 'llm' | 'template';

export interface ProactivePayload {
  triggerType: ProactiveTriggerType;
  dedupKey: string; // DB-uniqueness key (design §6)
  channel: ComposerChannel; // selects the composer
  data: Record<string, unknown>; // trigger-specific facts for the composer
}

/** Context passed to a composer. `now` is injected — never real time. */
export interface ComposerCtx {
  now: Date;
}

/** Turns one payload into the user-facing Bahasa Indonesia message. */
export type Composer = (payload: ProactivePayload, ctx: ComposerCtx) => Promise<string>;

/**
 * A detector is PURE given repos + an injected `now`. Returns 0..N payloads.
 * `[]` means "nothing worth saying". (Design §4.)
 */
export type Detector = (ctx: {
  userId: string;
  repos: Repos;
  now: Date;
}) => Promise<ProactivePayload[]>;

/** Tunable policy injected into the dispatcher (built from config in cron.ts). */
export interface ProactivePolicy {
  enabled: boolean;
  maxPerDay: number;
  quietHours: string; // "HH:MM-HH:MM" (WIB), may cross midnight
  contextWindowTurns: number;
}

// `LanguageModel` is re-exported so callers wiring the composer need only this module.
export type { LanguageModel };
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/domain/entities.ts src/proactive/types.ts
git commit -m "feat(proactive): domain entities + proactive types

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Config — proactive env vars

**Files:**
- Modify: `src/config/index.ts`

> **Why `z.string().transform()` for the boolean:** `z.coerce.boolean()` runs `Boolean(value)`; for the string `"false"` that yields `true` (non-empty string) — a footgun. The string-then-transform pattern reads the literal `'true'`/`'false'`.

- [ ] **Step 1: Add the proactive env vars to the zod schema**

In `src/config/index.ts`, add these keys inside the `z.object({ ... })` (after the existing `CRON_SCHEDULE` line):

```ts
  PROACTIVE_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  PROACTIVE_SUMMARY_CRON: z.string().default('0 21 * * *'),
  PROACTIVE_MAX_PER_DAY: z.coerce.number().int().positive().default(5),
  PROACTIVE_QUIET_HOURS: z.string().default('22:00-07:00'),
```

- [ ] **Step 2: Verify it compiles and the defaults parse**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

Run:
```bash
npx tsx -e "import('./src/config/index.js').then(({config}) => { console.log({on:config.PROACTIVE_ENABLED, cron:config.PROACTIVE_SUMMARY_CRON, max:config.PROACTIVE_MAX_PER_DAY, quiet:config.PROACTIVE_QUIET_HOURS}); })"
```
Expected: `{ on: true, cron: '0 21 * * *', max: 5, quiet: '22:00-07:00' }`

- [ ] **Step 3: Commit**

```bash
git add src/config/index.ts
git commit -m "feat(config): proactive outreach env vars

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: `users.findAll()`

The dispatcher needs to enumerate users. Add `findAll()` to the user repository (adding a *method* to `IUserRepository` does not break existing `as never` mocks; only adding *fields* to `Repos` does).

**Files:**
- Modify: `src/repositories/interfaces.ts` (the `IUserRepository` interface)
- Modify: `src/adapters/neon/user.repository.ts`
- Test: `tests/adapters/user.repository.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/adapters/user.repository.test.ts` (if the file does not yet import `NeonUserRepository` / `uniqueChatId`, mirror the top of `tests/adapters/user-preference.repository.test.ts`):

```ts
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { uniqueChatId } from '../helpers/db.js';
```

Then add this test block (inside the existing `describe` or as a new one):

```ts
describe('NeonUserRepository.findAll', () => {
  it('includes created users', async () => {
    const repo = new NeonUserRepository();
    const u1 = await repo.create({ telegramChatId: uniqueChatId(), name: 'A' });
    const u2 = await repo.create({ telegramChatId: uniqueChatId(), name: 'B' });
    const all = await repo.findAll();
    const ids = all.map((u) => u.userId);
    expect(ids).toContain(u1.userId);
    expect(ids).toContain(u2.userId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/user.repository.test.ts`
Expected: FAIL — `repo.findAll is not a function` (or a tsc error that `findAll` does not exist on `IUserRepository`).

- [ ] **Step 3: Add `findAll` to the interface and the implementation**

In `src/repositories/interfaces.ts`, add to `IUserRepository`:

```ts
export interface IUserRepository {
  findByTelegramChatId(chatId: string): Promise<User | null>;
  findById(userId: string): Promise<User | null>;
  findAll(): Promise<User[]>;
  create(input: CreateUserInput): Promise<User>;
  update(userId: string, patch: Partial<User>): Promise<User>;
}
```

In `src/adapters/neon/user.repository.ts`, add this method inside `class NeonUserRepository`:

```ts
  async findAll(): Promise<User[]> {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at');
    return rows.map((r) => mapUser(r as Record<string, unknown>));
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/user.repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the trio**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/repositories/interfaces.ts src/adapters/neon/user.repository.ts tests/adapters/user.repository.test.ts
git commit -m "feat(repos): users.findAll() for proactive dispatcher

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: `outreach_log` + `proactive_settings` repositories

> **Cascade warning:** adding `outreach` and `proactiveSettings` fields to `Repos` will break the three existing mock-`Repos` factories (they're returned as typed `Repos`, so missing keys fail tsc). This task updates all three.

**Files:**
- Modify: `src/repositories/interfaces.ts` (new interfaces + `Repos` fields)
- Create: `src/adapters/neon/outreach-log.repository.ts`
- Create: `src/adapters/neon/proactive-settings.repository.ts`
- Modify: `src/adapters/neon/repos.ts`
- Modify (mock factories): `tests/scheduler/recurring-fire.test.ts`, `tests/agent/orchestrator.test.ts`, `tests/telegram/callback-query.test.ts`
- Test: `tests/adapters/outreach-log.repository.test.ts`
- Test: `tests/adapters/proactive-settings.repository.test.ts`

- [ ] **Step 1: Add the repository interfaces + `Repos` fields**

In `src/repositories/interfaces.ts`:

Add the import of `ProactiveTriggerType` to the existing type import at the top:

```ts
import type {
  User,
  Account,
  Transaction,
  BudgetCode,
  RecurringPayment,
  SessionContext,
  UserPreference,
  ProactiveTriggerType,
  AccountType,
  TransactionType,
} from '../domain/entities.js';
```

Add the two interfaces (after `IUserPreferenceRepository`):

```ts
export interface IOutreachLogRepository {
  record(i: {
    userId: string;
    triggerType: ProactiveTriggerType;
    dedupKey: string;
    payload: unknown;
    sentAt: Date;
  }): Promise<{ inserted: boolean }>; // false => dedup key already existed
  existsKey(userId: string, dedupKey: string): Promise<boolean>;
  countSince(userId: string, since: Date): Promise<number>;
}

export interface IProactiveSettingsRepository {
  get(userId: string): Promise<ProactiveSettings>; // defaults if no row
  setMuted(userId: string, muted: boolean, resumeAt?: Date): Promise<void>;
}
```

Add the two fields to `Repos`:

```ts
export interface Repos {
  users: IUserRepository;
  accounts: IAccountRepository;
  transactions: ITransactionRepository;
  sessions: ISessionRepository;
  budgets: IBudgetCodeRepository;
  recurrings: IRecurringPaymentRepository;
  preferences: IUserPreferenceRepository;
  outreach: IOutreachLogRepository;
  proactiveSettings: IProactiveSettingsRepository;
}
```

You must also import `ProactiveSettings` into `interfaces.ts` for the `IProactiveSettingsRepository` return type. Add it to the same type-import block above (append `ProactiveSettings,` alongside `ProactiveTriggerType,`).

- [ ] **Step 2: Write the failing outreach-log repo test**

Create `tests/adapters/outreach-log.repository.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonOutreachLogRepository } from '../../src/adapters/neon/outreach-log.repository.js';
import { uniqueChatId } from '../helpers/db.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
}

describe('NeonOutreachLogRepository', () => {
  it('record inserts and reports inserted=true', async () => {
    const user = await seedUser();
    const repo = new NeonOutreachLogRepository();
    const res = await repo.record({
      userId: user.userId, triggerType: 'scheduled_summary',
      dedupKey: 'summary:2026-06-22', payload: { a: 1 }, sentAt: new Date('2026-06-22T14:00:00Z'),
    });
    expect(res.inserted).toBe(true);
  });

  it('record with an existing dedup key returns inserted=false (no duplicate row)', async () => {
    const user = await seedUser();
    const repo = new NeonOutreachLogRepository();
    const input = {
      userId: user.userId, triggerType: 'scheduled_summary' as const,
      dedupKey: 'summary:2026-06-22', payload: { a: 1 }, sentAt: new Date('2026-06-22T14:00:00Z'),
    };
    const first = await repo.record(input);
    const second = await repo.record(input);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
  });

  it('existsKey reflects recorded keys', async () => {
    const user = await seedUser();
    const repo = new NeonOutreachLogRepository();
    expect(await repo.existsKey(user.userId, 'summary:2026-06-22')).toBe(false);
    await repo.record({ userId: user.userId, triggerType: 'scheduled_summary', dedupKey: 'summary:2026-06-22', payload: {}, sentAt: new Date() });
    expect(await repo.existsKey(user.userId, 'summary:2026-06-22')).toBe(true);
  });

  it('countSince counts rows at or after the threshold', async () => {
    const user = await seedUser();
    const repo = new NeonOutreachLogRepository();
    await repo.record({ userId: user.userId, triggerType: 'scheduled_summary', dedupKey: 'k1', payload: {}, sentAt: new Date('2026-06-22T10:00:00Z') });
    await repo.record({ userId: user.userId, triggerType: 'logging_gap', dedupKey: 'k2', payload: {}, sentAt: new Date('2026-06-22T18:00:00Z') });
    expect(await repo.countSince(user.userId, new Date('2026-06-22T00:00:00Z'))).toBe(2);
    expect(await repo.countSince(user.userId, new Date('2026-06-22T12:00:00Z'))).toBe(1);
  });

  it('isolates dedup keys per user', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    const repo = new NeonOutreachLogRepository();
    await repo.record({ userId: u1.userId, triggerType: 'scheduled_summary', dedupKey: 'shared', payload: {}, sentAt: new Date() });
    expect(await repo.existsKey(u2.userId, 'shared')).toBe(false);
  });
});
```

- [ ] **Step 3: Write the failing proactive-settings repo test**

Create `tests/adapters/proactive-settings.repository.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonProactiveSettingsRepository } from '../../src/adapters/neon/proactive-settings.repository.js';
import { uniqueChatId } from '../helpers/db.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
}

describe('NeonProactiveSettingsRepository', () => {
  it('get returns not-muted defaults when no row exists', async () => {
    const user = await seedUser();
    const repo = new NeonProactiveSettingsRepository();
    const s = await repo.get(user.userId);
    expect(s).toEqual({ userId: user.userId, muted: false });
  });

  it('setMuted(true) persists and resumes undefined => mute forever', async () => {
    const user = await seedUser();
    const repo = new NeonProactiveSettingsRepository();
    await repo.setMuted(user.userId, true);
    const s = await repo.get(user.userId);
    expect(s.muted).toBe(true);
    expect(s.resumeAt).toBeUndefined();
  });

  it('setMuted(true, resumeAt) persists the resume instant', async () => {
    const user = await seedUser();
    const repo = new NeonProactiveSettingsRepository();
    const resumeAt = new Date('2026-06-22T20:00:00Z');
    await repo.setMuted(user.userId, true, resumeAt);
    const s = await repo.get(user.userId);
    expect(s.muted).toBe(true);
    expect(Date.parse(s.resumeAt ?? '')).toBe(resumeAt.getTime());
  });

  it('setMuted(false) unmutes an already-muted user', async () => {
    const user = await seedUser();
    const repo = new NeonProactiveSettingsRepository();
    await repo.setMuted(user.userId, true);
    await repo.setMuted(user.userId, false);
    expect((await repo.get(user.userId)).muted).toBe(false);
  });
});
```

- [ ] **Step 4: Run both new test files to verify they fail**

Run: `npx vitest run tests/adapters/outreach-log.repository.test.ts tests/adapters/proactive-settings.repository.test.ts`
Expected: FAIL — modules `NeonOutreachLogRepository` / `NeonProactiveSettingsRepository` not found.

- [ ] **Step 5: Implement `outreach-log.repository.ts`**

Create `src/adapters/neon/outreach-log.repository.ts`:

```ts
import { pool } from './pool.js';
import type { IOutreachLogRepository } from '../../repositories/interfaces.js';
import type { ProactiveTriggerType } from '../../domain/entities.js';

export class NeonOutreachLogRepository implements IOutreachLogRepository {
  async record(i: {
    userId: string;
    triggerType: ProactiveTriggerType;
    dedupKey: string;
    payload: unknown;
    sentAt: Date;
  }): Promise<{ inserted: boolean }> {
    const { rows } = await pool.query(
      `INSERT INTO outreach_log (user_id, trigger_type, dedup_key, payload, sent_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, dedup_key) DO NOTHING
       RETURNING outreach_id`,
      [i.userId, i.triggerType, i.dedupKey, JSON.stringify(i.payload ?? {}), i.sentAt],
    );
    return { inserted: rows.length > 0 };
  }

  async existsKey(userId: string, dedupKey: string): Promise<boolean> {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM outreach_log WHERE user_id = $1 AND dedup_key = $2',
      [userId, dedupKey],
    );
    return (rowCount ?? 0) > 0;
  }

  async countSince(userId: string, since: Date): Promise<number> {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM outreach_log WHERE user_id = $1 AND sent_at >= $2',
      [userId, since],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
```

- [ ] **Step 6: Implement `proactive-settings.repository.ts`**

Create `src/adapters/neon/proactive-settings.repository.ts`:

```ts
import { pool } from './pool.js';
import type { IProactiveSettingsRepository } from '../../repositories/interfaces.js';
import type { ProactiveSettings } from '../../domain/entities.js';

export class NeonProactiveSettingsRepository implements IProactiveSettingsRepository {
  async get(userId: string): Promise<ProactiveSettings> {
    const { rows } = await pool.query(
      'SELECT muted, resume_at FROM proactive_settings WHERE user_id = $1',
      [userId],
    );
    if (rows.length === 0) return { userId, muted: false };
    const row = rows[0] as { muted: boolean; resume_at: string | null };
    return {
      userId,
      muted: row.muted,
      resumeAt: row.resume_at ?? undefined,
    };
  }

  async setMuted(userId: string, muted: boolean, resumeAt?: Date): Promise<void> {
    await pool.query(
      `INSERT INTO proactive_settings (user_id, muted, resume_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         muted = EXCLUDED.muted,
         resume_at = EXCLUDED.resume_at,
         updated_at = NOW()`,
      [userId, muted, resumeAt ?? null],
    );
  }
}
```

- [ ] **Step 7: Wire both into `createRepos()`**

Replace the contents of `src/adapters/neon/repos.ts` with:

```ts
import { NeonUserRepository } from './user.repository.js';
import { NeonAccountRepository } from './account.repository.js';
import { NeonTransactionRepository } from './transaction.repository.js';
import { NeonSessionRepository } from './session.repository.js';
import { NeonBudgetCodeRepository } from './budget-code.repository.js';
import { NeonRecurringPaymentRepository } from './recurring-payment.repository.js';
import { NeonUserPreferenceRepository } from './user-preference.repository.js';
import { NeonOutreachLogRepository } from './outreach-log.repository.js';
import { NeonProactiveSettingsRepository } from './proactive-settings.repository.js';
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
    outreach: new NeonOutreachLogRepository(),
    proactiveSettings: new NeonProactiveSettingsRepository(),
  };
}
```

- [ ] **Step 8: Update the three existing mock-`Repos` factories**

Each of these files returns a `Repos` object literal and now needs the two new keys. Add this block inside each mock's returned object (next to `preferences:`):

- `tests/scheduler/recurring-fire.test.ts`
- `tests/agent/orchestrator.test.ts`
- `tests/telegram/callback-query.test.ts`

```ts
    outreach: {
      record: vi.fn(async () => ({ inserted: true })),
      existsKey: vi.fn(async () => false),
      countSince: vi.fn(async () => 0),
    } as never,
    proactiveSettings: {
      get: vi.fn(async () => ({ userId: 'u1', muted: false })),
      setMuted: vi.fn(async () => undefined),
    } as never,
```

- [ ] **Step 9: Run the new tests to verify they pass**

Run: `npx vitest run tests/adapters/outreach-log.repository.test.ts tests/adapters/proactive-settings.repository.test.ts`
Expected: both PASS.

- [ ] **Step 10: Verify the full trio (catches mock-factory cascade + NFR-02)**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: tsc clean, lint clean, all tests pass. If tsc reports `Property 'outreach' is missing` in a test file, you missed a mock factory — add the block from Step 8 there too.

- [ ] **Step 11: Commit**

```bash
git add src/repositories/interfaces.ts src/adapters/neon/outreach-log.repository.ts src/adapters/neon/proactive-settings.repository.ts src/adapters/neon/repos.ts tests/adapters/outreach-log.repository.test.ts tests/adapters/proactive-settings.repository.test.ts tests/scheduler/recurring-fire.test.ts tests/agent/orchestrator.test.ts tests/telegram/callback-query.test.ts
git commit -m "feat(repos): outreach_log + proactive_settings repositories

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: `guard.ts` — pure safety checks

**Files:**
- Create: `src/proactive/guard.ts`
- Test: `tests/proactive/guard.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/proactive/guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isMuted, inQuietHours, startOfTodayWIB } from '../../src/proactive/guard.js';
import type { ProactiveSettings } from '../../src/domain/entities.js';

// All `now` values are UTC instants whose WIB (UTC+7) time is known.
// 14:00Z = 21:00 WIB; 16:00Z = 23:00 WIB; 00:00Z = 07:00 WIB; 2026-06-21T23:59Z = 06:59 WIB.

describe('isMuted', () => {
  it('false when not muted', () => {
    const s: ProactiveSettings = { userId: 'u', muted: false };
    expect(isMuted(s, new Date('2026-06-22T14:00:00Z'))).toBe(false);
  });
  it('true when muted forever (no resumeAt)', () => {
    const s: ProactiveSettings = { userId: 'u', muted: true };
    expect(isMuted(s, new Date('2026-06-22T14:00:00Z'))).toBe(true);
  });
  it('true when muted and now is before resumeAt', () => {
    const s: ProactiveSettings = { userId: 'u', muted: true, resumeAt: '2026-06-22T16:00:00Z' };
    expect(isMuted(s, new Date('2026-06-22T14:00:00Z'))).toBe(true);
  });
  it('false when muted but resumeAt has passed (auto-expire)', () => {
    const s: ProactiveSettings = { userId: 'u', muted: true, resumeAt: '2026-06-22T14:00:00Z' };
    expect(isMuted(s, new Date('2026-06-22T16:00:00Z'))).toBe(false);
  });
});

describe('inQuietHours (window 22:00-07:00 WIB, overnight)', () => {
  const window = '22:00-07:00';
  it('not quiet at 21:00 WIB', () => {
    expect(inQuietHours(new Date('2026-06-22T14:00:00Z'), window)).toBe(false);
  });
  it('quiet at 23:00 WIB', () => {
    expect(inQuietHours(new Date('2026-06-22T16:00:00Z'), window)).toBe(true);
  });
  it('quiet at 06:59 WIB', () => {
    expect(inQuietHours(new Date('2026-06-21T23:59:00Z'), window)).toBe(true);
  });
  it('not quiet at exactly 07:00 WIB (end exclusive)', () => {
    expect(inQuietHours(new Date('2026-06-22T00:00:00Z'), window)).toBe(false);
  });
});

describe('inQuietHours (same-day window 09:00-17:00)', () => {
  const window = '09:00-17:00';
  it('quiet at 12:00 WIB', () => {
    expect(inQuietHours(new Date('2026-06-22T05:00:00Z'), window)).toBe(true); // 12:00 WIB
  });
  it('not quiet at 18:00 WIB', () => {
    expect(inQuietHours(new Date('2026-06-22T11:00:00Z'), window)).toBe(false); // 18:00 WIB
  });
});

describe('startOfTodayWIB', () => {
  it('returns the UTC instant of 00:00 WIB on the current WIB day', () => {
    // 2026-06-22 16:00 UTC == 2026-06-22 23:00 WIB => WIB day is 2026-06-22.
    // Midnight WIB that day == 2026-06-21 17:00 UTC.
    const start = startOfTodayWIB(new Date('2026-06-22T16:00:00Z'));
    expect(start.toISOString()).toBe('2026-06-21T17:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/guard.test.ts`
Expected: FAIL — `guard.js` not found.

- [ ] **Step 3: Implement `guard.ts`**

Create `src/proactive/guard.ts`:

```ts
import { todayWIB } from '../domain/time.js';
import type { ProactiveSettings } from '../domain/entities.js';

/** True if the user is muted AND the mute has not auto-expired. */
export function isMuted(settings: ProactiveSettings, now: Date): boolean {
  if (!settings.muted) return false;
  if (!settings.resumeAt) return true; // mute forever
  return Date.parse(settings.resumeAt) > now.getTime();
}

/** Midnight (00:00) of the current WIB day, as a UTC instant. */
export function startOfTodayWIB(now: Date): Date {
  return new Date(`${todayWIB(now)}T00:00:00+07:00`);
}

function wibMinutesOfDay(now: Date): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [hh, mm] = fmt.format(now).split(':').map(Number) as [number, number];
  return hh * 60 + mm;
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * True if `now` (interpreted in WIB) falls inside `quietHours` ("HH:MM-HH:MM").
 * A window whose start > end (e.g. 22:00-07:00) is treated as overnight.
 * Both bounds: start inclusive, end exclusive.
 */
export function inQuietHours(now: Date, quietHours: string): boolean {
  const parts = quietHours.split('-');
  if (parts.length !== 2) return false;
  const start = parseHHMM(parts[0]!);
  const end = parseHHMM(parts[1]!);
  if (start === end) return false; // empty window
  const m = wibMinutesOfDay(now);
  if (start < end) return m >= start && m < end;
  return m >= start || m < end; // overnight wrap
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the trio**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/guard.ts tests/proactive/guard.test.ts
git commit -m "feat(proactive): pure guard (mute, quiet-hours, start-of-day)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Proactive system prompt

**Files:**
- Create: `src/proactive/prompt.ts`

- [ ] **Step 1: Write the prompt module**

Create `src/proactive/prompt.ts`:

```ts
/**
 * System prompt for LLM-composed proactive messages (design §8). Distinct from
 * the reactive agent prompt: this runs as a SINGLE generateText call with the
 * detector's gathered data, no tool access. Output is plain Markdown (converted
 * to Telegram HTML at the send boundary).
 */
export const PROACTIVE_SYSTEM_PROMPT = `Kamu menulis pesan proaktif MoneyBot — ringkasan dan insight keuangan yang dikirim bot sendiri ke user tanpa diminta. Tulis selalu dalam Bahasa Indonesia yang natural, ramah, dan ringkas (maks 6 baris).

ATURAN:
1. Tulis HANYA pesan final, tanpa prefiks, tanpa menjelaskan bahwa kamu AI.
2. Format nominal pakai locale IDR: titik sebagai pemisah ribuan, tanpa simbol (contoh 20.000, 1.500.000). JANGAN tulis "Rp" atau "IDR".
3. MULAI pesan ringkasan harian dengan judul berbasis emoji (mis. "📊 Ringkasan hari ini"). Sebut total pengeluaran, lalu 2-3 kategori teratas dengan nominal.
4. Kalau ada budget yang terpakai ≥80%, sebut statusnya singkat di baris terakhir.
5. Jangan mengarang angka — pakai HANYA data yang diberikan. Kalau data kosong untuk sebuah bagian, lewati bagian itu.
6. Ditutup dengan satu ajakan singkat yang berguna (mis. "Balas pesan ini kalau mau lihat detail per kategori.").
7. Boleh pakai **tebal** untuk menonjolkan satu atau dua angka penting.`;
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/proactive/prompt.ts
git commit -m "feat(proactive): LLM composer system prompt

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Template composer (LLM fallback)

**Files:**
- Create: `src/proactive/composers/template.ts`
- Test: `tests/proactive/composers/template.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/proactive/composers/template.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scheduledSummaryTemplate, templateCompose } from '../../../src/proactive/composers/template.js';
import type { ProactivePayload } from '../../../src/proactive/types.js';

const summaryPayload = (data: Record<string, unknown>): ProactivePayload => ({
  triggerType: 'scheduled_summary',
  dedupKey: 'summary:2026-06-22',
  channel: 'template',
  data,
});

describe('scheduledSummaryTemplate', () => {
  it('formats total + top categories + budgets', () => {
    const out = scheduledSummaryTemplate(summaryPayload({
      date: '2026-06-22',
      totalSpend: 120000,
      topCategories: [
        { id: 'food.dining', name: 'Makan di Luar', icon: '🍜', amount: 80000 },
        { id: 'transport.ridehail', name: 'Ojek / Ride-hailing', icon: '🛵', amount: 40000 },
      ],
      budgets: [{ name: 'food', spent: 80000, alloc: 100000, pct: 0.8 }],
    }));
    expect(out).toContain('📊');
    expect(out).toContain('120.000');
    expect(out).toContain('Makan di Luar');
    expect(out).toContain('80.000');
    expect(out).toContain('food');
    // no currency symbol
    expect(out).not.toContain('Rp');
  });

  it('omits the budget block when there are no budgets', () => {
    const out = scheduledSummaryTemplate(summaryPayload({
      date: '2026-06-22', totalSpend: 50000,
      topCategories: [{ id: 'food.coffee', name: 'Kopi & Minuman', icon: '☕', amount: 50000 }],
      budgets: [],
    }));
    expect(out).toContain('50.000');
    expect(out).not.toContain('Budget');
  });
});

describe('templateCompose', () => {
  it('routes scheduled_summary to the summary template', () => {
    const out = templateCompose(summaryPayload({ date: '2026-06-22', totalSpend: 10000, topCategories: [], budgets: [] }));
    expect(out).toContain('10.000');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the template composer**

Create `src/proactive/composers/template.ts`:

```ts
import type { ProactivePayload } from '../types.js';

/** Format a number as IDR locale (dot thousands separator, no symbol). */
function idr(n: number): string {
  return n.toLocaleString('id-ID');
}

interface SummaryCategory {
  id: string;
  name: string;
  icon: string;
  amount: number;
}
interface SummaryBudget {
  name: string;
  spent: number;
  alloc: number;
  pct: number;
}
interface SummaryData {
  date: string;
  totalSpend: number;
  topCategories: SummaryCategory[];
  budgets: SummaryBudget[];
}

/** Deterministic LLM-fallback for the daily summary. */
export function scheduledSummaryTemplate(payload: ProactivePayload): string {
  const d = payload.data as SummaryData;
  const lines: string[] = [];
  lines.push(`📊 Ringkasan pengeluaran ${d.date}:`);
  lines.push(`Total: ${idr(d.totalSpend)}`);
  if (d.topCategories.length > 0) {
    lines.push('Top kategori:');
    for (const c of d.topCategories) lines.push(`${c.icon} ${c.name}: ${idr(c.amount)}`);
  }
  if (d.budgets.length > 0) {
    lines.push('Budget:');
    for (const b of d.budgets) {
      lines.push(`${b.name}: ${idr(b.spent)} / ${idr(b.alloc)} (${Math.round(b.pct * 100)}%)`);
    }
  }
  return lines.join('\n');
}

/** Dispatch a template-channel payload to its formatter. */
export function templateCompose(payload: ProactivePayload): string {
  switch (payload.triggerType) {
    case 'scheduled_summary':
      return scheduledSummaryTemplate(payload);
    default:
      return '(tidak ada pesan)';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the trio**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/composers/template.ts tests/proactive/composers/template.test.ts
git commit -m "feat(proactive): template composer (LLM fallback)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: LLM composer

**Files:**
- Create: `src/proactive/composers/llm.ts`
- Test: `tests/proactive/composers/llm.test.ts`

- [ ] **Step 1: Write the failing test (mocks `generateText` from `ai`)**

Create `tests/proactive/composers/llm.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK's generateText BEFORE importing the module under test.
vi.mock('ai', () => ({ generateText: vi.fn() }));

import { generateText } from 'ai';
import { llmCompose } from '../../../src/proactive/composers/llm.js';
import type { ProactivePayload } from '../../../src/proactive/types.js';
import type { LanguageModel } from 'ai';

const payload: ProactivePayload = {
  triggerType: 'scheduled_summary',
  dedupKey: 'summary:2026-06-22',
  channel: 'llm',
  data: { date: '2026-06-22', totalSpend: 120000, topCategories: [], budgets: [] },
};
const fakeModel = {} as LanguageModel;

describe('llmCompose', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls generateText with the proactive system prompt + serialized payload', async () => {
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'Halo, hari ini...' });
    const out = await llmCompose(payload, fakeModel);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
        system: expect.stringContaining('MoneyBot'),
        prompt: expect.stringContaining('120000'),
      }),
    );
    expect(out).toBe('Halo, hari ini...');
  });

  it('propagates errors (the resolver handles fallback)', async () => {
    (generateText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rate limited'));
    await expect(llmCompose(payload, fakeModel)).rejects.toThrow('rate limited');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/composers/llm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `llm.ts`**

Create `src/proactive/composers/llm.ts`:

```ts
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { PROACTIVE_SYSTEM_PROMPT } from '../prompt.js';
import type { ProactivePayload } from '../types.js';

/** Serialize the payload's data into a readable prompt for the model. */
function serialize(payload: ProactivePayload): string {
  return `Tulis pesan proaktif untuk data berikut (trigger: ${payload.triggerType}):\n\n${JSON.stringify(payload.data, null, 2)}`;
}

/**
 * Compose a message via a single generateText call (no tools — the detector
 * already gathered the data). Throws on failure; the resolver falls back to the
 * template composer.
 */
export async function llmCompose(payload: ProactivePayload, model: LanguageModel): Promise<string> {
  const { text } = await generateText({
    model,
    system: PROACTIVE_SYSTEM_PROMPT,
    prompt: serialize(payload),
  });
  return text;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/composers/llm.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the trio**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/composers/llm.ts tests/proactive/composers/llm.test.ts
git commit -m "feat(proactive): LLM composer (single generateText call)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Composer resolver (channel routing + LLM fallback)

**Files:**
- Create: `src/proactive/composers/resolve.ts`
- Test: `tests/proactive/composers/resolve.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/proactive/composers/resolve.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', () => ({ generateText: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));

import { generateText } from 'ai';
import { logEvent } from '../../../src/utils/logger.js';
import { createComposer } from '../../../src/proactive/composers/resolve.js';
import type { ProactivePayload } from '../../../src/proactive/types.js';
import type { LanguageModel } from 'ai';

const fakeModel = {} as LanguageModel;

describe('createComposer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the template composer for channel "template"', async () => {
    const composer = createComposer(fakeModel);
    const out = await composer(
      {
        triggerType: 'scheduled_summary', dedupKey: 'summary:2026-06-22', channel: 'template',
        data: { date: '2026-06-22', totalSpend: 9000, topCategories: [], budgets: [] },
      },
      { now: new Date('2026-06-22T14:00:00Z') },
    );
    expect(out).toContain('9.000');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('uses the LLM composer for channel "llm" when it succeeds', async () => {
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'LLM compose OK' });
    const composer = createComposer(fakeModel);
    const out = await composer(
      { triggerType: 'scheduled_summary', dedupKey: 'x', channel: 'llm', data: {} },
      { now: new Date('2026-06-22T14:00:00Z') },
    );
    expect(out).toBe('LLM compose OK');
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('falls back to the template composer when the LLM call throws', async () => {
    (generateText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const composer = createComposer(fakeModel);
    const out = await composer(
      {
        triggerType: 'scheduled_summary', dedupKey: 'x', channel: 'llm',
        data: { date: '2026-06-22', totalSpend: 7000, topCategories: [], budgets: [] },
      },
      { now: new Date('2026-06-22T14:00:00Z') },
    );
    expect(out).toContain('7.000'); // template fallback ran
    expect(logEvent).toHaveBeenCalledWith('warn', expect.any(String), expect.objectContaining({ error: 'boom' }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/composers/resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `resolve.ts`**

Create `src/proactive/composers/resolve.ts`:

```ts
import type { LanguageModel } from 'ai';
import type { Composer } from '../types.js';
import { llmCompose } from './llm.js';
import { templateCompose } from './template.js';
import { logEvent } from '../../utils/logger.js';

/**
 * Build a Composer that routes by payload.channel. LLM-channel payloads try the
 * LLM composer and fall back to the template composer on any error, so a model
 * failure never silently drops a proactive message (design §11).
 */
export function createComposer(model: LanguageModel): Composer {
  return async (payload) => {
    if (payload.channel === 'template') return templateCompose(payload);
    try {
      return await llmCompose(payload, model);
    } catch (err) {
      logEvent('warn', 'proactive llm compose failed; falling back to template', {
        triggerType: payload.triggerType,
        error: (err as Error).message,
      });
      return templateCompose(payload);
    }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/composers/resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the trio**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/composers/resolve.ts tests/proactive/composers/resolve.test.ts
git commit -m "feat(proactive): composer resolver (channel routing + LLM fallback)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: `scheduled_summary` detector

**Files:**
- Create: `src/proactive/triggers/scheduled-summary.ts`
- Test: `tests/proactive/triggers/scheduled-summary.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/proactive/triggers/scheduled-summary.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { detectScheduledSummary } from '../../../src/proactive/triggers/scheduled-summary.js';
import type { Repos } from '../../../src/repositories/interfaces.js';
import type { Transaction, BudgetCode } from '../../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-06-22', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

function mockRepos(opts: { txns?: Transaction[]; budgets?: BudgetCode[] } = {}): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(),
      findByDateRange: vi.fn(async () => opts.txns ?? []),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: {
      findByUserAndMonth: vi.fn(async () => opts.budgets ?? []),
      findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn(),
    } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

// 2026-06-22T14:00:00Z == 2026-06-22 21:00 WIB (deterministic WIB "today").
const NOW = new Date('2026-06-22T14:00:00Z');

describe('detectScheduledSummary', () => {
  it('returns [] when there are no transactions today (no empty nag)', async () => {
    const repos = mockRepos({ txns: [] });
    const out = await detectScheduledSummary({ userId: 'u', repos, now: NOW });
    expect(out).toEqual([]);
  });

  it('ignores transfer/income and sums only expenses', async () => {
    const repos = mockRepos({
      txns: [
        mkTxn({ type: 'expense', amount: 30000, categoryId: 'food.dining' }),
        mkTxn({ type: 'transfer', amount: 500000 }),
        mkTxn({ type: 'income', amount: 5_000_000 }),
        mkTxn({ type: 'expense', amount: 20000, categoryId: 'transport.ridehail' }),
      ],
    });
    const out = await detectScheduledSummary({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    const data = out[0]!.data as { totalSpend: number; topCategories: { id: string; amount: number }[] };
    expect(data.totalSpend).toBe(50000);
    expect(data.topCategories[0]).toMatchObject({ id: 'food.dining', amount: 30000 });
    expect(data.topCategories[1]).toMatchObject({ id: 'transport.ridehail', amount: 20000 });
  });

  it('builds the dedup key from the WIB date and selects the llm channel', async () => {
    const repos = mockRepos({ txns: [mkTxn({ type: 'expense', amount: 10000, categoryId: 'food.coffee' })] });
    const out = await detectScheduledSummary({ userId: 'u', repos, now: NOW });
    expect(out[0]!.dedupKey).toBe('summary:2026-06-22');
    expect(out[0]!.channel).toBe('llm');
    expect(out[0]!.triggerType).toBe('scheduled_summary');
  });

  it('resolves category names via the seeded taxonomy', async () => {
    const repos = mockRepos({ txns: [mkTxn({ type: 'expense', amount: 15000, categoryId: 'food.coffee' })] });
    const out = await detectScheduledSummary({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { topCategories: { name: string; icon: string }[] };
    expect(data.topCategories[0]!.name).toBe('Kopi & Minuman');
    expect(data.topCategories[0]!.icon).toBe('☕');
  });

  it('includes budget status for the current WIB month', async () => {
    const repos = mockRepos({
      txns: [mkTxn({ type: 'expense', amount: 10000, categoryId: 'food.dining' })],
      budgets: [{
        budgetCodeId: 'b1', userId: 'u', name: 'food', monthlyBudget: 100000, spent: 80000,
        month: 6, year: 2026, createdAt: '', updatedAt: '',
      }],
    });
    const out = await detectScheduledSummary({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { budgets: { name: string; pct: number }[] };
    expect(data.budgets[0]).toMatchObject({ name: 'food', pct: 0.8 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/triggers/scheduled-summary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the detector**

Create `src/proactive/triggers/scheduled-summary.ts`:

```ts
import { CATEGORIES } from '../../domain/categories.js';
import { todayWIB, wibYear, wibMonth } from '../../domain/time.js';
import type { Detector, ProactivePayload } from '../types.js';

// Static taxonomy lookup (categories are system-seeded, not user-editable).
const NAME_BY_ID = new Map(CATEGORIES.map((c) => [c.categoryId, c]));

interface SummaryCategory {
  id: string;
  name: string;
  icon: string;
  amount: number;
}
interface SummaryBudget {
  name: string;
  spent: number;
  alloc: number;
  pct: number;
}

/**
 * Daily spending summary detector (design §9.1). Returns `[]` when nothing was
 * spent today. Transfers and income are excluded; only expenses are totaled.
 */
export const detectScheduledSummary: Detector = async ({ userId, repos, now }) => {
  const date = todayWIB(now);
  const txns = await repos.transactions.findByDateRange(userId, date, date);
  const expenses = txns.filter((t) => t.type === 'expense');
  if (expenses.length === 0) return [];

  const totalSpend = expenses.reduce((sum, t) => sum + t.amount, 0);

  const byCategory = new Map<string, number>();
  for (const t of expenses) {
    const key = t.categoryId ?? 'other.misc';
    byCategory.set(key, (byCategory.get(key) ?? 0) + t.amount);
  }
  const topCategories: SummaryCategory[] = [...byCategory.entries()]
    .map(([id, amount]) => {
      const cat = NAME_BY_ID.get(id);
      return { id, name: cat?.name ?? id, icon: cat?.icon ?? '📌', amount };
    })
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);

  const codes = await repos.budgets.findByUserAndMonth(userId, wibYear(now), wibMonth(now));
  const budgets: SummaryBudget[] = codes.map((c) => ({
    name: c.name,
    spent: c.spent,
    alloc: c.monthlyBudget,
    pct: c.monthlyBudget > 0 ? c.spent / c.monthlyBudget : 0,
  }));

  const payload: ProactivePayload = {
    triggerType: 'scheduled_summary',
    dedupKey: `summary:${date}`,
    channel: 'llm',
    data: { date, totalSpend, topCategories, budgets },
  };
  return [payload];
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/triggers/scheduled-summary.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the trio**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/triggers/scheduled-summary.ts tests/proactive/triggers/scheduled-summary.test.ts
git commit -m "feat(proactive): scheduled_summary detector

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: Dispatcher

**Files:**
- Create: `src/proactive/dispatcher.ts`
- Test: `tests/proactive/dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/proactive/dispatcher.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));

import { runProactivePass } from '../../src/proactive/dispatcher.js';
import { logEvent } from '../../src/utils/logger.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { ProactivePayload, ProactivePolicy } from '../../src/proactive/types.js';

// 2026-06-22T14:00:00Z == 21:00 WIB (outside the 22:00-07:00 quiet window).
const NOW = new Date('2026-06-22T14:00:00Z');
const POLICY: ProactivePolicy = {
  enabled: true, maxPerDay: 5, quietHours: '22:00-07:00', contextWindowTurns: 20,
};

function mockRepos(overrides: {
  users?: { userId: string; telegramChatId: string }[];
  muted?: boolean;
  existsKey?: boolean;
  countSince?: number;
  existingSession?: { chatId: string; userId: string; turns: unknown[]; lastActivityAt: string } | null;
} = {}): Repos {
  const users = overrides.users ?? [{ userId: 'u1', telegramChatId: 'c1' }];
  return {
    users: {
      findByTelegramChatId: vi.fn(), findById: vi.fn(),
      findAll: vi.fn(async () => users),
      create: vi.fn(), update: vi.fn(),
    } as never,
    accounts: { findAllByUserId: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: { create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn() } as never,
    sessions: {
      get: vi.fn(async () => overrides.existingSession ?? null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(),
    } as never,
    budgets: { findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: {
      record: vi.fn(async () => ({ inserted: true })),
      existsKey: vi.fn(async () => overrides.existsKey ?? false),
      countSince: vi.fn(async () => overrides.countSince ?? 0),
    } as never,
    proactiveSettings: {
      get: vi.fn(async () => ({ userId: 'u1', muted: overrides.muted ?? false })),
      setMuted: vi.fn(async () => undefined),
    } as never,
  };
}

const summaryPayload: ProactivePayload = {
  triggerType: 'scheduled_summary', dedupKey: 'summary:2026-06-22', channel: 'llm', data: {},
};

describe('runProactivePass', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends, records, and seeds an assistant turn for an actionable user', async () => {
    const repos = mockRepos();
    const send = vi.fn(async () => undefined);
    const detector = vi.fn(async () => [summaryPayload]);
    const composer = vi.fn(async () => 'COMPOSED');

    await runProactivePass({ detector, composer, repos, policy: POLICY, now: NOW, send });

    expect(send).toHaveBeenCalledWith('c1', 'COMPOSED');
    expect(repos.outreach.record).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', dedupKey: 'summary:2026-06-22', sentAt: NOW }));
    expect(repos.sessions.set).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'c1', lastActivityAt: NOW.toISOString() }));
    const setArg = (repos.sessions.set as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { turns: { role: string; content: string }[] };
    expect(setArg.turns.at(-1)).toMatchObject({ role: 'assistant', content: 'COMPOSED' });
  });

  it('skips a muted user (no detector, no send)', async () => {
    const repos = mockRepos({ muted: true });
    const send = vi.fn();
    const detector = vi.fn(async () => [summaryPayload]);
    await runProactivePass({ detector, composer: vi.fn(), repos, policy: POLICY, now: NOW, send });
    expect(detector).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('skips when in quiet hours', async () => {
    const repos = mockRepos();
    const send = vi.fn();
    const detector = vi.fn(async () => [summaryPayload]);
    // 23:00 WIB == inside 22:00-07:00
    await runProactivePass({ detector, composer: vi.fn(), repos, policy: POLICY, now: new Date('2026-06-22T16:00:00Z'), send });
    expect(detector).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('skips composing when the dedup key already exists', async () => {
    const repos = mockRepos({ existsKey: true });
    const send = vi.fn();
    const composer = vi.fn(async () => 'SHOULD NOT RUN');
    const detector = vi.fn(async () => [summaryPayload]);
    await runProactivePass({ detector, composer, repos, policy: POLICY, now: NOW, send });
    expect(composer).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('skips when the daily rate limit is reached', async () => {
    const repos = mockRepos({ countSince: 5 });
    const send = vi.fn();
    const composer = vi.fn();
    const detector = vi.fn(async () => [summaryPayload]);
    await runProactivePass({ detector, composer, repos, policy: POLICY, now: NOW, send });
    expect(composer).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('kill-switch off: fetches no users, sends nothing', async () => {
    const repos = mockRepos();
    const send = vi.fn();
    const detector = vi.fn();
    await runProactivePass({ detector, composer: vi.fn(), repos, policy: { ...POLICY, enabled: false }, now: NOW, send });
    expect(repos.users.findAll).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('catches a detector error, logs it, and continues to the next user', async () => {
    const repos = mockRepos({ users: [
      { userId: 'u1', telegramChatId: 'c1' },
      { userId: 'u2', telegramChatId: 'c2' },
    ] });
    const send = vi.fn(async () => undefined);
    const detector = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([summaryPayload]);
    const composer = vi.fn(async () => 'OK');
    await runProactivePass({ detector, composer, repos, policy: POLICY, now: NOW, send });
    expect(logEvent).toHaveBeenCalledWith('error', expect.any(String), expect.objectContaining({ userId: 'u1', error: 'boom' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('c2', 'OK');
  });

  it('records [] payload (nothing to say) without sending', async () => {
    const repos = mockRepos();
    const send = vi.fn();
    const detector = vi.fn(async () => []);
    await runProactivePass({ detector, composer: vi.fn(), repos, policy: POLICY, now: NOW, send });
    expect(send).not.toHaveBeenCalled();
    expect(repos.outreach.record).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/dispatcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dispatcher.ts`**

Create `src/proactive/dispatcher.ts`:

```ts
import type { CoreMessage } from 'ai';
import type { Repos } from '../repositories/interfaces.js';
import type { Detector, Composer, ProactivePolicy } from './types.js';
import { freshSession, trimTurns } from '../agent/orchestrator-helpers.js';
import { isMuted, inQuietHours, startOfTodayWIB } from './guard.js';
import { logEvent } from '../utils/logger.js';

export interface RunProactivePassOptions {
  detector: Detector;
  composer: Composer;
  repos: Repos;
  policy: ProactivePolicy;
  now: Date;
  send: (chatId: string, text: string) => Promise<void>;
}

/** Append the composed message as an assistant turn so the user can reply & drill in. */
async function seedAssistantTurn(
  repos: Repos,
  chatId: string,
  userId: string,
  text: string,
  nowIso: string,
  maxTurns: number,
): Promise<void> {
  const existing = await repos.sessions.get(chatId);
  const ctx = existing ?? freshSession(chatId, userId, nowIso);
  const turns = trimTurns(
    [...ctx.turns, { role: 'assistant', content: text } as CoreMessage],
    maxTurns,
  );
  await repos.sessions.set({ ...ctx, turns, lastActivityAt: nowIso });
}

/**
 * Run one proactive trigger for all users. Per-user try/catch guarantees a
 * single user's failure never stops others or throws to cron (design §11).
 */
export async function runProactivePass(o: RunProactivePassOptions): Promise<void> {
  if (!o.policy.enabled) return;

  const users = await o.repos.users.findAll();
  for (const user of users) {
    try {
      const settings = await o.repos.proactiveSettings.get(user.userId);
      if (isMuted(settings, o.now)) continue;
      if (inQuietHours(o.now, o.policy.quietHours)) continue;

      const payloads = await o.detector({ userId: user.userId, repos: o.repos, now: o.now });
      for (const payload of payloads) {
        // Cheap guards before any LLM call (design §10).
        if (await o.repos.outreach.existsKey(user.userId, payload.dedupKey)) continue;
        const sentToday = await o.repos.outreach.countSince(user.userId, startOfTodayWIB(o.now));
        if (sentToday >= o.policy.maxPerDay) continue;

        const text = await o.composer(payload, { now: o.now });
        await o.send(user.telegramChatId, text);

        // Atomic dedup backstop for any race between existsKey and record.
        await o.repos.outreach.record({
          userId: user.userId,
          triggerType: payload.triggerType,
          dedupKey: payload.dedupKey,
          payload: payload.data,
          sentAt: o.now,
        });
        await seedAssistantTurn(o.repos, user.telegramChatId, user.userId, text, o.now.toISOString(), o.policy.contextWindowTurns);
      }
    } catch (err) {
      logEvent('error', 'proactive trigger failed', { userId: user.userId, error: (err as Error).message });
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proactive/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the trio**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/dispatcher.ts tests/proactive/dispatcher.test.ts
git commit -m "feat(proactive): dispatcher (runProactivePass + two-way seed)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: `/nudges` command

**Files:**
- Create: `src/telegram/nudges-command.ts`
- Test: `tests/telegram/nudges-command.test.ts`

> Mirror the `callback-query.ts` pattern: a pure `dispatchNudgesCommand(...)` (testable without grammY) plus a thin `registerNudgesCommand(repos)` wrapper.

- [ ] **Step 1: Write the failing test**

Create `tests/telegram/nudges-command.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { dispatchNudgesCommand, parseNudgesArgs } from '../../src/telegram/nudges-command.js';
import type { Repos } from '../../src/repositories/interfaces.js';

const NOW = new Date('2026-06-22T14:00:00Z');

function mockRepos(overrides: { user?: { userId: string; telegramChatId: string } | null; muted?: boolean; resumeAt?: string } = {}): Repos {
  const user = overrides.user === undefined ? { userId: 'u1', telegramChatId: 'c1' } : overrides.user;
  return {
    users: {
      findByTelegramChatId: vi.fn(async () => user),
      findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn(),
    } as never,
    accounts: { findAllByUserId: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: { create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn() } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: {
      get: vi.fn(async () => ({ userId: 'u1', muted: overrides.muted ?? false, resumeAt: overrides.resumeAt })),
      setMuted: vi.fn(async () => undefined),
    } as never,
  };
}

describe('parseNudgesArgs', () => {
  it('"status" / "" => status', () => {
    expect(parseNudgesArgs('', NOW)).toMatchObject({ action: 'status' });
    expect(parseNudgesArgs('status', NOW)).toMatchObject({ action: 'status' });
  });
  it('"on" => unmute', () => {
    expect(parseNudgesArgs('on', NOW)).toMatchObject({ action: 'unmute' });
  });
  it('"off" => mute forever (no resumeAt)', () => {
    expect(parseNudgesArgs('off', NOW)).toMatchObject({ action: 'mute' });
    expect((parseNudgesArgs('off', NOW) as { resumeAt?: unknown }).resumeAt).toBeUndefined();
  });
  it('"off 8h" => mute for 8 hours', () => {
    const r = parseNudgesArgs('off 8h', NOW);
    expect(r).toMatchObject({ action: 'mute' });
    expect((r as { resumeAt: Date }).resumeAt.getTime()).toBe(NOW.getTime() + 8 * 3600_000);
  });
  it('"off 2d" => mute for 2 days', () => {
    const r = parseNudgesArgs('off 2d', NOW) as { resumeAt: Date };
    expect(r.resumeAt.getTime()).toBe(NOW.getTime() + 48 * 3600_000);
  });
  it('garbage => unknown', () => {
    expect(parseNudgesArgs('banana', NOW)).toMatchObject({ action: 'unknown' });
  });
});

describe('dispatchNudgesCommand', () => {
  it('status replies with the current mute state (not muted)', async () => {
    const repos = mockRepos({ muted: false });
    const { reply } = await dispatchNudgesCommand('status', 'c1', repos, NOW);
    expect(reply).toContain('aktif');
    expect(repos.proactiveSettings.setMuted).not.toHaveBeenCalled();
  });

  it('off mutes forever and confirms', async () => {
    const repos = mockRepos();
    const { reply } = await dispatchNudgesCommand('off', 'c1', repos, NOW);
    expect(repos.proactiveSettings.setMuted).toHaveBeenCalledWith('u1', true, undefined);
    expect(reply).toContain('berhenti');
  });

  it('off 8h mutes with a resume instant and confirms', async () => {
    const repos = mockRepos();
    const { reply } = await dispatchNudgesCommand('off 8h', 'c1', repos, NOW);
    expect(repos.proactiveSettings.setMuted).toHaveBeenCalledWith('u1', true, new Date(NOW.getTime() + 8 * 3600_000));
    expect(reply).toContain('8 jam');
  });

  it('on unmutes and confirms', async () => {
    const repos = mockRepos({ muted: true });
    const { reply } = await dispatchNudgesCommand('on', 'c1', repos, NOW);
    expect(repos.proactiveSettings.setMuted).toHaveBeenCalledWith('u1', false);
    expect(reply).toContain('aktif');
  });

  it('replies help on unknown args', async () => {
    const repos = mockRepos();
    const { reply } = await dispatchNudgesCommand('banana', 'c1', repos, NOW);
    expect(reply).toContain('/nudges');
  });

  it('rejects unregistered users', async () => {
    const repos = mockRepos({ user: null });
    const { reply } = await dispatchNudgesCommand('off', 'ghost', repos, NOW);
    expect(reply).toContain('belum');
    expect(repos.proactiveSettings.setMuted).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/telegram/nudges-command.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `nudges-command.ts`**

Create `src/telegram/nudges-command.ts`:

```ts
import { bot } from './bot.js';
import { markdownToTelegramHTML } from './formatter.js';
import type { Repos } from '../repositories/interfaces.js';

export type NudgesIntent =
  | { action: 'status' }
  | { action: 'mute'; resumeAt?: Date } // resumeAt undefined => mute forever
  | { action: 'unmute' }
  | { action: 'unknown'; raw: string };

/** Pure parser for the `/nudges` argument string. */
export function parseNudgesArgs(args: string, now: Date): NudgesIntent {
  const a = args.trim().toLowerCase();
  if (a === '' || a === 'status') return { action: 'status' };
  if (a === 'on' || a === 'unmute') return { action: 'unmute' };
  if (a === 'off') return { action: 'mute' };
  const m = a.match(/^off\s+(\d+)\s*([hd])$/);
  if (m) {
    const n = Number(m[1]);
    const hours = m[2] === 'd' ? n * 24 : n;
    return { action: 'mute', resumeAt: new Date(now.getTime() + hours * 3600_000) };
  }
  return { action: 'unknown', raw: args };
}

function formatStatus(muted: boolean, resumeAt?: string): string {
  if (!muted) return '🔕 Nudge proaktif: aktif. Bot akan kirim ringkasan sesuai jadwal.';
  if (!resumeAt) return '🔕 Nudge proaktif: dimatikan sampai kamu nyalakan lagi dengan /nudges on.';
  return `🔕 Nudge proaktif: dimatikan sampai ${new Date(resumeAt).toLocaleString('id-ID')} (WIB lokal server).`;
}

export interface NudgesResult {
  reply: string;
}

/** Pure dispatch — testable without grammY wiring (mirrors callback-query.ts). */
export async function dispatchNudgesCommand(
  args: string,
  chatId: string,
  repos: Repos,
  now: Date,
): Promise<NudgesResult> {
  const user = await repos.users.findByTelegramChatId(chatId);
  if (!user) return { reply: 'Kamu belum terdaftar. Ketik sesuatu untuk mulai.' };

  const intent = parseNudgesArgs(args, now);
  switch (intent.action) {
    case 'status': {
      const s = await repos.proactiveSettings.get(user.userId);
      return { reply: formatStatus(s.muted, s.resumeAt) };
    }
    case 'mute': {
      await repos.proactiveSettings.setMuted(user.userId, true, intent.resumeAt);
      if (intent.resumeAt) {
        const hours = Math.round((intent.resumeAt.getTime() - now.getTime()) / 3600_000);
        return { reply: `🔕 Oke, nudge proaktif berhenti selama ${hours} jam. Balas /nudges on untuk menyalakan.` };
      }
      return { reply: '🔕 Oke, nudge proaktif berhenti sampai kamu nyalakan lagi dengan /nudges on.' };
    }
    case 'unmute': {
      await repos.proactiveSettings.setMuted(user.userId, false);
      return { reply: '🔔 Nudge proaktif dinyalakan lagi.' };
    }
    case 'unknown':
      return {
        reply:
          'Pakai: /nudges status | /nudges off | /nudges off 8h | /nudges off 2d | /nudges on',
      };
  }
}

/** grammY wiring. Register BEFORE the catch-all message handler so commands are intercepted. */
export function registerNudgesCommand(repos: Repos): void {
  bot.command('nudges', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const args = typeof ctx.match === 'string' ? ctx.match : '';
    const { reply } = await dispatchNudgesCommand(args, chatId, repos, new Date());
    await ctx.reply(markdownToTelegramHTML(reply), { parse_mode: 'HTML' });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/telegram/nudges-command.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the trio**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/nudges-command.ts tests/telegram/nudges-command.test.ts
git commit -m "feat(telegram): /nudges command (mute/pause proactive)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 14: Wire cron + entry point

**Files:**
- Modify: `src/scheduler/cron.ts`
- Modify: `src/index.ts`

> **Why convert Markdown → HTML at the send boundary:** the LLM composer returns Markdown (`**bold**`); Telegram `parse_mode: 'HTML'` needs tags. The dispatcher test injects a fake `send`, so the conversion (which lives in the cron `send` adapter) is outside the dispatcher's unit.

- [ ] **Step 1: Update `startCronJobs` to take the model and register the proactive summary cron**

Replace the contents of `src/scheduler/cron.ts` with:

```ts
import cron from 'node-cron';
import type { LanguageModel } from 'ai';
import { fireRecurringPayments } from './recurring-fire.js';
import { sweepDeferredPayments } from './defer-sweep.js';
import { runProactivePass } from '../proactive/dispatcher.js';
import { createComposer } from '../proactive/composers/resolve.js';
import { detectScheduledSummary } from '../proactive/triggers/scheduled-summary.js';
import { markdownToTelegramHTML } from '../telegram/formatter.js';
import { bot } from '../telegram/bot.js';
import { config } from '../config/index.js';
import type { Repos } from '../repositories/interfaces.js';
import { logEvent } from '../utils/logger.js';

/** Start all in-process cron jobs (timezone WIB per NFR-10). */
export function startCronJobs(repos: Repos, model: LanguageModel): void {
  // Daily 08:00 WIB — fire recurring payment prompts
  cron.schedule(config.CRON_SCHEDULE, () => {
    fireRecurringPayments(repos).catch((err) =>
      logEvent('error', 'recurring-fire error', { error: (err as Error).message }),
    );
  }, { timezone: 'Asia/Jakarta' });

  // Every 5 minutes — sweep deferred payments
  cron.schedule('*/5 * * * *', () => {
    sweepDeferredPayments(repos).catch((err) =>
      logEvent('error', 'defer-sweep error', { error: (err as Error).message }),
    );
  }, { timezone: 'Asia/Jakarta' });

  // Proactive outreach — daily spending summary (LLM-composed).
  const composer = createComposer(model);
  const policy = {
    enabled: config.PROACTIVE_ENABLED,
    maxPerDay: config.PROACTIVE_MAX_PER_DAY,
    quietHours: config.PROACTIVE_QUIET_HOURS,
    contextWindowTurns: config.CONTEXT_WINDOW_TURNS,
  };
  const send = async (chatId: string, text: string): Promise<void> => {
    await bot.api.sendMessage(chatId, markdownToTelegramHTML(text), { parse_mode: 'HTML' });
  };

  cron.schedule(config.PROACTIVE_SUMMARY_CRON, () => {
    runProactivePass({ detector: detectScheduledSummary, composer, repos, policy, now: new Date(), send })
      .catch((err) => logEvent('error', 'proactive summary error', { error: (err as Error).message }));
  }, { timezone: 'Asia/Jakarta' });

  logEvent('info', 'cron jobs registered', {
    schedules: [config.CRON_SCHEDULE, '*/5 * * * *', config.PROACTIVE_SUMMARY_CRON],
  });
}
```

- [ ] **Step 2: Pass the model to `startCronJobs` and register `/nudges` in `src/index.ts`**

In `src/index.ts`:

Add the import near the other telegram imports:

```ts
import { registerNudgesCommand } from './telegram/nudges-command.js';
```

Change the `startCronJobs(repos);` call to pass the model:

```ts
  startCronJobs(repos, model);
```

Register `/nudges` **before** `registerMessageHandler` so the command is intercepted instead of reaching the agent (commands are `message:text`):

```ts
  registerNudgesCommand(repos);
  registerMessageHandler(async (text, chatId) => {
    ...
  });

  startCronJobs(repos, model);
  registerCallbackHandler(repos);
```

- [ ] **Step 3: Verify the trio**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: tsc clean, lint clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/scheduler/cron.ts src/index.ts
git commit -m "feat(proactive): wire summary cron + /nudges into entry point

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 15: Final verification

- [ ] **Step 1: Full clean build**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: all green.

- [ ] **Step 2: Confirm NFR-02 holds (no driver leak outside the adapter)**

Run: `npm run lint`
Expected: clean. (The `no-restricted-imports` rule would flag any `pg` import outside `src/adapters/neon/`.)

- [ ] **Step 3: Smoke the dispatch path without a live Telegram call (optional sanity check)**

This is a read-only confidence check that the detector + dispatcher compose end-to-end against the real DB:

```bash
npx tsx -e "import('./src/adapters/neon/repos.js').then(async ({createRepos}) => { import('./src/proactive/triggers/scheduled-summary.js').then(async ({detectScheduledSummary}) => { const repos = createRepos(); const users = await repos.users.findAll(); console.log('users:', users.length); const payloads = users[0] ? await detectScheduledSummary({userId: users[0].userId, repos, now: new Date('2026-06-22T14:00:00Z')}) : []; console.log('payloads:', JSON.stringify(payloads)); (await import('./src/adapters/neon/pool.js')).pool.end(); }); });"
```
Expected: prints `users: N` and `payloads: []` (or a summary payload if the user spent today).

- [ ] **Step 4: Manual end-to-end (requires real `.env` + Telegram bot, user-run)**

> The user runs this. With a populated DB, temporarily set `PROACTIVE_SUMMARY_CRON` to a couple minutes ahead in `.env`, run `npm run dev`, and confirm the bot sends an Indonesian daily summary at the scheduled minute. Then test `/nudges off`, `/nudges status`, `/nudges on` from Telegram, and replying to a summary with a drill-down question (e.g. "ciutkan ke makanan").

This step needs real credentials and is not automatable in CI. Document the outcome in the commit/PR; do not mark it complete on the basis of the unit tests alone.

---

## Self-review (completed by plan author)

**Spec coverage (design §):**
- §3 layering + §8 dispatcher loop → Task 12. ✓
- §4 types → Task 2. ✓
- §5 files → all created (types, dispatcher, guard, prompt, composers×3, trigger, repos×2, nudges-command, migration). ✓
- §6 data model → Task 1. ✓
- §7 repository interfaces (`record`/`existsKey`/`countSince`, `get`/`setMuted`, `findAll`) → Tasks 4–5. ✓
- §8 two-way seed → Task 12 `seedAssistantTurn` (reuses `freshSession`/`trimTurns`). ✓
- §9.1 `scheduled_summary` → Task 11. ✓
- §10 guard (5 invariants, cheapest-first; dedup pre-check before rate-limit) → Task 6 + Task 12 dispatcher order. ✓
- §11 error handling (per-user try/catch, LLM→template fallback, send-failure skips record via not reaching it) → Task 12 + Task 10. ✓
- §12 config → Task 3. ✓
- §13 `/nudges` → Task 13. ✓
- §14 cron registration → Task 14. ✓
- §15 testing → every task is TDD. ✓

**Placeholder scan:** none — every code step contains complete code; every command has expected output.

**Type consistency:** `ProactiveTriggerType`/`ProactiveSettings` defined in `entities.ts` (Task 2) and imported by `interfaces.ts` (Task 5), `types.ts` (Task 2), guard (Task 6), detectors/dispatcher. `Repos` gains `outreach` + `proactiveSettings` once (Task 5) and all four mock factories in later tests include them. `createComposer(model)` (Task 10) is the single `Composer` passed to `runProactivePass`; `model` is captured in the composer closure, so the dispatcher options intentionally omit `model` (refinement of spec §8, noted in Task 12). `startCronJobs(repos, model)` signature updated once (Task 14) and called once in `index.ts`.

**One known simplification (called out, not a gap):** the dispatcher records the outreach row *after* a successful send. On a Telegram send failure the row is never written, so an event-driven trigger retries next sweep — for `scheduled_summary` that means a same-day retry may fire later. This matches design §11 exactly.
