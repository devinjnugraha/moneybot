# Budget Auto-Rolling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make budget creation a recurring-vs-one-time decision resolved at creation; recurring budgets roll into each new month (same name + allocation, spent reset) via an idempotent daily cron + boot reconcile, with `old_budget_id` lineage and prompt enrichment staying current-month-only.

**Architecture:** Add `is_recurring` + `old_budget_id` columns to `budget_codes`. A new repo method `rollRecurringIntoMonth` does one idempotent `INSERT…SELECT` (most-recent prior instance per name → current month, spent reset, lineage set). A `sweepBudgetRollover` function iterates all users; a daily cron (`BUDGET_ROLLOVER_CRON`) + a boot-time call drive it. `create_budget_code` gets a required `isRecurring`; the system prompt asks "bulanan/sekali" and stores budget refs by name, never id. Enrichment renders a `(bulanan)` marker.

**Tech Stack:** TypeScript (strict), `pg` on Neon Postgres, grammY, Vercel AI SDK, `node-cron`, Vitest (real-Postgres for repos, mocked `Repos` for logic layers).

**Spec:** `docs/superpowers/specs/2026-07-01-budget-auto-rolling-design.md`

---

## File Structure

**Create:**
- `migrations/005_budget_recurring.sql` — adds `is_recurring` + `old_budget_id` (+ partial index).
- `src/scheduler/budget-rollover.ts` — `sweepBudgetRollover(repos, now)`.
- `tests/scheduler/budget-rollover.test.ts` — sweep unit test (mocked repos).

**Modify:**
- `src/domain/entities.ts` — `BudgetCode` gains `isRecurring: boolean` + `oldBudgetId?: string`.
- `src/adapters/neon/mappers.ts` — `mapBudgetCode` reads the two new columns.
- `src/repositories/interfaces.ts` — `CreateBudgetCodeInput` gains `isRecurring?`/`oldBudgetId?`; `IBudgetCodeRepository` gains `rollRecurringIntoMonth`.
- `src/adapters/neon/budget-code.repository.ts` — `create` writes the new columns; add `rollRecurringIntoMonth`.
- `src/config/index.ts` — add `BUDGET_ROLLOVER_CRON`.
- `src/scheduler/cron.ts` — register the cron.
- `src/index.ts` — boot-time `sweepBudgetRollover`.
- `src/agent/tools.ts` — `create_budget_code` required `isRecurring`.
- `src/agent/system-prompt.ts` — BUDGET + PREFERENCE rules; `(bulanan)` marker.

**Test modifications (typed `BudgetCode` literals must gain `isRecurring: false`):**
- `tests/proactive/triggers/budget-threshold.test.ts` — `mkBudget` base.
- `tests/proactive/triggers/morning-glance.test.ts` — `mkBudget` base.
- `tests/agent/system-prompt.test.ts` — `budget` const + new assertions.
- `tests/agent/tools.test.ts` — `create_budget_code` cases.
- `tests/adapters/budget-code.repository.test.ts` — new repo cases.

**Test harness facts (do not change):** `global-setup.ts` runs `migrate()`+`seed()` once (so migration 005 auto-applies for tests). Tests isolate via unique users (`uniqueChatId()`), **not** truncation. `npm test` runs vitest with a single fork. Repos are tested against real Postgres; scheduler/logic layers use mocked `Repos` (cast `as never`). Always run `npx tsc --noEmit` — vitest strips types and can pass while tsc fails.

---

## Task 1: Migration + entity + mapper (schema foundation)

**Files:**
- Create: `migrations/005_budget_recurring.sql`
- Modify: `src/domain/entities.ts:40-50` (the `BudgetCode` interface)
- Modify: `src/adapters/neon/mappers.ts:81-93` (`mapBudgetCode`)
- Test: `tests/adapters/budget-code.repository.test.ts`

- [ ] **Step 1: Add the failing assertion to the existing repo test**

In `tests/adapters/budget-code.repository.test.ts`, in the first test (`'creates a budget code and finds it by user + month + year'`), add assertions on the new fields. After the existing `expect(found[0]!.name).toBe('Jajan');` line add:

```ts
    expect(bc.isRecurring).toBe(false); // default for a manual create
    expect(bc.oldBudgetId).toBeUndefined();
    expect(found[0]!.isRecurring).toBe(false);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/budget-code.repository.test.ts`
Expected: FAIL (tsc/property error — `isRecurring` does not exist on `BudgetCode`).

- [ ] **Step 3: Create the migration**

Create `migrations/005_budget_recurring.sql`:

```sql
-- Recurring vs one-time budgets + lineage for auto roll-over (design §3).
ALTER TABLE budget_codes
  ADD COLUMN is_recurring  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN old_budget_id UUID REFERENCES budget_codes(budget_code_id) ON DELETE SET NULL;

-- Speeds "most recent prior recurring instance per (user, name)" in roll-over.
CREATE INDEX IF NOT EXISTS idx_budget_recurring_prior
  ON budget_codes(user_id, name) WHERE is_recurring = true;
```

- [ ] **Step 4: Apply the migration to the dev DB**

Run: `npm run migrate`
Expected: logs `migration applied` for `005_budget_recurring.sql` (idempotent — safe to re-run).

- [ ] **Step 5: Add the fields to the entity**

In `src/domain/entities.ts`, replace the `BudgetCode` interface:

```ts
export interface BudgetCode {
  budgetCodeId: string;
  userId: string;
  name: string;
  monthlyBudget: number;
  month: number; // 1–12
  year: number;
  spent: number;
  isRecurring: boolean; // true → rolls into each new month on the 1st
  oldBudgetId?: string; // immediate predecessor this was rolled over from
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 6: Update the mapper**

In `src/adapters/neon/mappers.ts`, replace the `mapBudgetCode` function:

```ts
export function mapBudgetCode(r: Row): BudgetCode {
  return {
    budgetCodeId: str(r, 'budget_code_id'),
    userId: str(r, 'user_id'),
    name: str(r, 'name'),
    monthlyBudget: num(r, 'monthly_budget'),
    month: num(r, 'month'),
    year: num(r, 'year'),
    spent: num(r, 'spent'),
    isRecurring: bool(r, 'is_recurring'),
    oldBudgetId: maybeStr(r, 'old_budget_id'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  };
}
```

- [ ] **Step 7: Fix the typed `BudgetCode` literals so tsc stays green**

Three test factories/constants must now include `isRecurring`:

- `tests/proactive/triggers/budget-threshold.test.ts` — in `mkBudget`, add `isRecurring: false,` to the returned base object.
- `tests/proactive/triggers/morning-glance.test.ts` — in `mkBudget`, add `isRecurring: false,` to the returned base object.
- `tests/agent/system-prompt.test.ts` — in the `budget` const (the `BudgetCode` literal), add `isRecurring: false,`.

(Other test files construct budget objects inside `as never` mocks, so they are not type-checked — leave them.)

- [ ] **Step 8: Run tsc + the repo test to verify they pass**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx vitest run tests/adapters/budget-code.repository.test.ts`
Expected: PASS (the new `isRecurring`/`oldBudgetId` assertions hold — default false / undefined).

- [ ] **Step 9: Commit**

```bash
git add migrations/005_budget_recurring.sql src/domain/entities.ts src/adapters/neon/mappers.ts tests/adapters/budget-code.repository.test.ts tests/proactive/triggers/budget-threshold.test.ts tests/proactive/triggers/morning-glance.test.ts tests/agent/system-prompt.test.ts
git commit -m "feat: add is_recurring + old_budget_id columns to budget_codes"
```

---

## Task 2: `CreateBudgetCodeInput` + repo `create` writes the new columns

**Files:**
- Modify: `src/repositories/interfaces.ts:47-53` (`CreateBudgetCodeInput`)
- Modify: `src/adapters/neon/budget-code.repository.ts:24-32` (`create`)
- Test: `tests/adapters/budget-code.repository.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/adapters/budget-code.repository.test.ts`, add a new test inside the `describe`:

```ts
  it('persists isRecurring on create (defaults false when omitted)', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const recurring = await budgets.create({
      userId: user.userId, name: 'Terea', monthlyBudget: 300_000, month: 6, year: 2026, isRecurring: true,
    });
    expect(recurring.isRecurring).toBe(true);

    const oneTime = await budgets.create({
      userId: user.userId, name: 'Trip', monthlyBudget: 1_000_000, month: 6, year: 2026,
    });
    expect(oneTime.isRecurring).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/budget-code.repository.test.ts`
Expected: FAIL (tsc error — `isRecurring` not in `CreateBudgetCodeInput`; create ignores it → persisted value still false for the recurring case).

- [ ] **Step 3: Extend the input type**

In `src/repositories/interfaces.ts`, replace the `CreateBudgetCodeInput` interface:

```ts
export interface CreateBudgetCodeInput {
  userId: string;
  name: string;
  monthlyBudget: number;
  month: number;
  year: number;
  isRecurring?: boolean; // default false; only roll-over sets oldBudgetId
  oldBudgetId?: string;
}
```

- [ ] **Step 4: Update the repo `create` to write the columns**

In `src/adapters/neon/budget-code.repository.ts`, replace the `create` method:

```ts
  async create(input: CreateBudgetCodeInput): Promise<BudgetCode> {
    const { rows } = await pool.query(
      `INSERT INTO budget_codes (user_id, name, monthly_budget, month, year, is_recurring, old_budget_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [input.userId, input.name, input.monthlyBudget, input.month, input.year,
       input.isRecurring ?? false, input.oldBudgetId ?? null],
    );
    return mapBudgetCode(rows[0] as Record<string, unknown>);
  }
```

- [ ] **Step 5: Run tsc + tests to verify they pass**

Run: `npx tsc --noEmit` → no errors.
Run: `npx vitest run tests/adapters/budget-code.repository.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/repositories/interfaces.ts src/adapters/neon/budget-code.repository.ts tests/adapters/budget-code.repository.test.ts
git commit -m "feat: persist is_recurring/old_budget_id on budget create"
```

---

## Task 3: `rollRecurringIntoMonth` (the core roll-over query)

**Files:**
- Modify: `src/repositories/interfaces.ts:111-117` (`IBudgetCodeRepository`)
- Modify: `src/adapters/neon/budget-code.repository.ts` (add method)
- Test: `tests/adapters/budget-code.repository.test.ts`

- [ ] **Step 1: Write the failing tests**

At the top of `tests/adapters/budget-code.repository.test.ts`, add imports and a prior-month helper (after the existing imports):

```ts
import { wibYear, wibMonth } from '../../src/domain/time.js';

function priorMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}
```

Add these tests inside the `describe`:

```ts
  it('rolls a prior-month recurring budget into the current month (spent reset, lineage set)', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const cur = { year: wibYear(), month: wibMonth() };
    const prev = priorMonth(cur.year, cur.month);
    const src = await budgets.create({
      userId: user.userId, name: 'Terea', monthlyBudget: 300_000, month: prev.month, year: prev.year, isRecurring: true,
    });
    await budgets.incrementSpent(user.userId, src.budgetCodeId, 120_000); // source has spent

    const created = await budgets.rollRecurringIntoMonth(user.userId, cur.year, cur.month);
    expect(created).toBe(1);

    const current = await budgets.findByUserAndMonth(user.userId, cur.year, cur.month);
    expect(current).toHaveLength(1);
    expect(current[0]!.name).toBe('Terea');
    expect(current[0]!.monthlyBudget).toBe(300_000);
    expect(current[0]!.spent).toBe(0); // reset
    expect(current[0]!.isRecurring).toBe(true);
    expect(current[0]!.oldBudgetId).toBe(src.budgetCodeId); // lineage
  });

  it('is idempotent (second call creates nothing)', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const cur = { year: wibYear(), month: wibMonth() };
    const prev = priorMonth(cur.year, cur.month);
    await budgets.create({
      userId: user.userId, name: 'Terea', monthlyBudget: 300_000, month: prev.month, year: prev.year, isRecurring: true,
    });
    await budgets.rollRecurringIntoMonth(user.userId, cur.year, cur.month);
    const second = await budgets.rollRecurringIntoMonth(user.userId, cur.year, cur.month);
    expect(second).toBe(0);
    const current = await budgets.findByUserAndMonth(user.userId, cur.year, cur.month);
    expect(current).toHaveLength(1);
  });

  it('ignores one-time prior budgets', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const cur = { year: wibYear(), month: wibMonth() };
    const prev = priorMonth(cur.year, cur.month);
    await budgets.create({
      userId: user.userId, name: 'Trip', monthlyBudget: 1_000_000, month: prev.month, year: prev.year, isRecurring: false,
    });
    const created = await budgets.rollRecurringIntoMonth(user.userId, cur.year, cur.month);
    expect(created).toBe(0);
    expect(await budgets.findByUserAndMonth(user.userId, cur.year, cur.month)).toHaveLength(0);
  });

  it('copies the most recent prior allocation when several months exist', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const cur = { year: wibYear(), month: wibMonth() };
    const prev1 = priorMonth(cur.year, cur.month);
    const prev2 = priorMonth(prev1.year, prev1.month);
    await budgets.create({ userId: user.userId, name: 'Food', monthlyBudget: 100_000, month: prev2.month, year: prev2.year, isRecurring: true });
    const newer = await budgets.create({ userId: user.userId, name: 'Food', monthlyBudget: 200_000, month: prev1.month, year: prev1.year, isRecurring: true });

    await budgets.rollRecurringIntoMonth(user.userId, cur.year, cur.month);
    const current = await budgets.findByUserAndMonth(user.userId, cur.year, cur.month);
    expect(current).toHaveLength(1);
    expect(current[0]!.monthlyBudget).toBe(200_000); // latest edit propagates
    expect(current[0]!.oldBudgetId).toBe(newer.budgetCodeId);
  });

  it('leaves an already-present current-month budget untouched', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const cur = { year: wibYear(), month: wibMonth() };
    const prev = priorMonth(cur.year, cur.month);
    await budgets.create({ userId: user.userId, name: 'Terea', monthlyBudget: 300_000, month: prev.month, year: prev.year, isRecurring: true });
    // current-month instance already exists with a different allocation + spent
    const existing = await budgets.create({ userId: user.userId, name: 'Terea', monthlyBudget: 999_000, month: cur.month, year: cur.year, isRecurring: true });
    await budgets.incrementSpent(user.userId, existing.budgetCodeId, 50_000);

    const created = await budgets.rollRecurringIntoMonth(user.userId, cur.year, cur.month);
    expect(created).toBe(0);
    const current = await budgets.findByUserAndMonth(user.userId, cur.year, cur.month);
    expect(current).toHaveLength(1);
    expect(current[0]!.monthlyBudget).toBe(999_000); // not overwritten
    expect(current[0]!.spent).toBe(50_000);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/adapters/budget-code.repository.test.ts`
Expected: FAIL (tsc error — `rollRecurringIntoMonth` not on `IBudgetCodeRepository`).

- [ ] **Step 3: Add the method to the interface**

In `src/repositories/interfaces.ts`, replace the `IBudgetCodeRepository` interface:

```ts
export interface IBudgetCodeRepository {
  findByUserAndMonth(userId: string, year: number, month: number): Promise<BudgetCode[]>;
  findByName(userId: string, name: string, year: number, month: number): Promise<BudgetCode | null>;
  create(input: CreateBudgetCodeInput): Promise<BudgetCode>;
  incrementSpent(userId: string, budgetCodeId: string, delta: number): Promise<void>;
  update(userId: string, budgetCodeId: string, patch: Partial<BudgetCode>): Promise<BudgetCode>;
  /**
   * Create current-month copies of the user's recurring budgets that don't yet
   * exist for (year, month). Copies name + the most-recent prior allocation,
   * resets spent to 0, sets is_recurring=true, and links old_budget_id to the
   * source row. Idempotent (no-op if the month already has the name). Returns
   * the number of rows created.
   */
  rollRecurringIntoMonth(userId: string, year: number, month: number): Promise<number>;
}
```

- [ ] **Step 4: Implement the method in the Neon repo**

In `src/adapters/neon/budget-code.repository.ts`, add this method to `NeonBudgetCodeRepository` (e.g. after `update`):

```ts
  async rollRecurringIntoMonth(userId: string, year: number, month: number): Promise<number> {
    const result = await pool.query(
      `INSERT INTO budget_codes (user_id, name, monthly_budget, month, year, is_recurring, spent, old_budget_id)
       SELECT user_id, name, monthly_budget, $3, $2, true, 0, budget_code_id
       FROM (
         SELECT DISTINCT ON (name) name, monthly_budget, budget_code_id, user_id
         FROM budget_codes
         WHERE user_id = $1
           AND is_recurring = true
           AND (year < $2 OR (year = $2 AND month < $3))
         ORDER BY name, year DESC, month DESC
       ) AS src
       WHERE NOT EXISTS (
         SELECT 1 FROM budget_codes c
         WHERE c.user_id = $1 AND c.name = src.name AND c.year = $2 AND c.month = $3
       )`,
      [userId, year, month],
    );
    return result.rowCount ?? 0;
  }
```

- [ ] **Step 5: Run tsc + tests to verify they pass**

Run: `npx tsc --noEmit` → no errors.
Run: `npx vitest run tests/adapters/budget-code.repository.test.ts` → PASS (all five roll-over cases).

- [ ] **Step 6: Commit**

```bash
git add src/repositories/interfaces.ts src/adapters/neon/budget-code.repository.ts tests/adapters/budget-code.repository.test.ts
git commit -m "feat: roll recurring budgets into a target month (idempotent)"
```

---

## Task 4: `sweepBudgetRollover` scheduler function

**Files:**
- Create: `src/scheduler/budget-rollover.ts`
- Create: `tests/scheduler/budget-rollover.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/scheduler/budget-rollover.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sweepBudgetRollover } from '../../src/scheduler/budget-rollover.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { User } from '../../src/domain/entities.js';

vi.mock('../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));

function mkUser(id: string): User {
  return {
    userId: id, telegramChatId: `c-${id}`, name: 'U', language: 'id', timezone: 'Asia/Jakarta',
    status: 'approved', createdAt: '', updatedAt: '',
  };
}

function mockRepos(users: User[], roll: ReturnType<typeof vi.fn>): Repos {
  return {
    users: { findAll: vi.fn(async () => users) } as never,
    budgets: { rollRecurringIntoMonth: roll } as never,
  } as never;
}

describe('sweepBudgetRollover', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rolls every user into the current WIB month', async () => {
    const roll = vi.fn(async () => 1);
    const repos = mockRepos([mkUser('u1'), mkUser('u2')], roll);
    await sweepBudgetRollover(repos, new Date('2026-07-01T00:05:00Z'));
    expect(repos.users.findAll).toHaveBeenCalled();
    expect(roll).toHaveBeenCalledTimes(2);
    // (year, month) derived from WIB for the given instant
    const [userId, year, month] = roll.mock.calls[0]!;
    expect(userId).toBe('u1');
    expect(year).toBe(2026);
    expect(month).toBe(7);
  });

  it('continues when one user throws', async () => {
    const roll = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(1);
    const repos = mockRepos([mkUser('u1'), mkUser('u2')], roll);
    await expect(sweepBudgetRollover(repos, new Date('2026-07-01T00:05:00Z'))).resolves.toBeUndefined();
    expect(roll).toHaveBeenCalledTimes(2); // second user still processed
  });

  it('is a no-op when there are no users', async () => {
    const roll = vi.fn(async () => 0);
    const repos = mockRepos([], roll);
    await sweepBudgetRollover(repos, new Date('2026-07-01T00:05:00Z'));
    expect(roll).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/scheduler/budget-rollover.test.ts`
Expected: FAIL (cannot resolve `../../src/scheduler/budget-rollover.js`).

- [ ] **Step 3: Implement the sweep function**

Create `src/scheduler/budget-rollover.ts`:

```ts
import type { Repos } from '../repositories/interfaces.js';
import { wibYear, wibMonth } from '../domain/time.js';
import { logEvent } from '../utils/logger.js';

/**
 * Roll every user's recurring budgets into the current WIB month. Per-user
 * errors are logged and skipped so one failure never blocks the rest. Driven by
 * the daily BUDGET_ROLLOVER_CRON and by a one-shot reconcile on boot.
 */
export async function sweepBudgetRollover(repos: Repos, now: Date = new Date()): Promise<void> {
  const year = wibYear(now);
  const month = wibMonth(now);
  const users = await repos.users.findAll();
  let totalCreated = 0;
  for (const user of users) {
    try {
      const created = await repos.budgets.rollRecurringIntoMonth(user.userId, year, month);
      if (created > 0) {
        logEvent('info', 'budget rollover created', { userId: user.userId, year, month, created });
      }
      totalCreated += created;
    } catch (err) {
      logEvent('error', 'budget rollover failed for user', {
        userId: user.userId, year, month, error: (err as Error).message,
      });
    }
  }
  if (totalCreated > 0) {
    logEvent('info', 'budget rollover sweep complete', { year, month, users: users.length, totalCreated });
  }
}
```

- [ ] **Step 4: Run tsc + tests to verify they pass**

Run: `npx tsc --noEmit` → no errors.
Run: `npx vitest run tests/scheduler/budget-rollover.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/budget-rollover.ts tests/scheduler/budget-rollover.test.ts
git commit -m "feat: sweep recurring budgets into the current month"
```

---

## Task 5: Config + cron registration + boot reconcile (wiring)

**Files:**
- Modify: `src/config/index.ts:15` (add config var near the other crons)
- Modify: `src/scheduler/cron.ts` (import + schedule + log)
- Modify: `src/index.ts:37` (boot reconcile after repos created)

This task is wiring; the logic it invokes is already covered by Tasks 3–4. Verify with `tsc` + `lint` (no new unit test — `node-cron` scheduling is a side effect).

- [ ] **Step 1: Add the config var**

In `src/config/index.ts`, add this line immediately after the `PROACTIVE_MORNING_GLANCE_CRON` line:

```ts
  BUDGET_ROLLOVER_CRON: z.string().default('5 0 * * *'),
```

- [ ] **Step 2: Register the cron job**

In `src/scheduler/cron.ts`:

1. Add to the imports (near the existing scheduler imports):

```ts
import { sweepBudgetRollover } from './budget-rollover.js';
```

2. Inside `startCronJobs`, after the morning-glance `cron.schedule(...)` block, add:

```ts
  // Daily 00:05 WIB — roll recurring budgets into the new month (idempotent;
  // also reconciled once on boot). Self-heals after downtime.
  cron.schedule(config.BUDGET_ROLLOVER_CRON, () => {
    sweepBudgetRollover(repos).catch((err) =>
      logEvent('error', 'budget rollover cron error', { error: (err as Error).message }),
    );
  }, { timezone: 'Asia/Jakarta' });
```

3. In the final `logEvent('info', 'cron jobs registered', { schedules: [...] })` call, add `config.BUDGET_ROLLOVER_CRON` to the `schedules` array.

- [ ] **Step 3: Add the boot-time reconcile**

In `src/index.ts`:

1. Add to the imports:

```ts
import { sweepBudgetRollover } from './scheduler/budget-rollover.js';
```

2. Immediately after the line `const repos = createRepos();`, add:

```ts
  // Reconcile recurring budgets once on boot so a restart on the 1st rolls the
  // new month immediately (node-cron does not retro-fire missed schedules).
  await sweepBudgetRollover(repos).catch((err) =>
    logEvent('error', 'boot budget rollover failed', { error: (err as Error).message }),
  );
```

- [ ] **Step 4: Verify tsc + lint**

Run: `npx tsc --noEmit` → no errors.
Run: `npm run lint` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/config/index.ts src/scheduler/cron.ts src/index.ts
git commit -m "feat: schedule daily budget roll-over + boot reconcile"
```

---

## Task 6: `create_budget_code` required `isRecurring`

**Files:**
- Modify: `src/agent/tools.ts:707-730` (`create_budget_code`)
- Test: `tests/agent/tools.test.ts:674-693`

- [ ] **Step 1: Update + extend the tool test**

In `tests/agent/tools.test.ts`, replace the body of the `'creates a budget code with defaults for month/year'` test and add a second test. The new block for that `describe`:

```ts
  it('creates a budget code with defaults for month/year and forwards isRecurring', async () => {
    const repos = mockRepos({
      budgets: {
        findByUserAndMonth: vi.fn(),
        findByName: vi.fn(),
        create: vi.fn(async (i: { name: string; monthlyBudget: number; isRecurring?: boolean }) => ({
          budgetCodeId: 'b-new', userId: 'u1', name: i.name, monthlyBudget: i.monthlyBudget,
          month: 6, year: 2026, spent: 0, isRecurring: i.isRecurring ?? false, createdAt: '', updatedAt: '',
        })),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_budget_code } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_budget_code, { name: 'Jajan', monthlyBudget: 500_000, isRecurring: true });
    expect(res.status).toBe('ok');
    expect(repos.budgets.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jajan', monthlyBudget: 500_000, isRecurring: true }));
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/agent/tools.test.ts -t "forwards isRecurring"`
Expected: FAIL — `repos.budgets.create` is called without `isRecurring` (tool doesn't forward it yet), so `objectContaining({ isRecurring: true })` fails.

- [ ] **Step 3: Add the required parameter + forward it**

In `src/agent/tools.ts`, replace the `tools.create_budget_code = tool({ ... })` block:

```ts
  tools.create_budget_code = tool({
    description:
      'Buat budget code baru dengan alokasi bulanan. Default month/year dari WIB. ' +
      'isRecurring=true → budget bulanan: dibuat ulang otomatis tiap tanggal 1 dengan alokasi sama (spent reset).',
    parameters: z.object({
      name: z.string(),
      monthlyBudget: z.number().positive(),
      isRecurring: z.boolean().describe('true = budget bulanan (recurring tiap tanggal 1); false = sekali untuk bulan ini.'),
      month: z.number().int().min(1).max(12).optional(),
      year: z.number().int().positive().optional(),
    }),
    execute: async ({ name, monthlyBudget, isRecurring, month, year }) => {
      try {
        const bc = await repos.budgets.create({
          userId,
          name,
          monthlyBudget,
          isRecurring,
          month: month ?? wibMonth(),
          year: year ?? wibYear(),
        });
        return { status: 'ok', data: bc };
      } catch (e) {
        logEvent('error', 'create_budget_code failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal membuat budget code. Coba lagi.' };
      }
    },
  });
```

- [ ] **Step 4: Update the NFR-09 error test for create_budget_code**

In `tests/agent/tools.test.ts`, the existing `'create_budget_code: returns ID message on error'` test (in the NFR-09 describe) calls `callExec(create_budget_code, { name: 'Jajan', monthlyBudget: 500_000 })`. Direct execute bypasses zod, so it still works, but update the call args for clarity to include `isRecurring: false`:

```ts
    const res = await callExec(create_budget_code, { name: 'Jajan', monthlyBudget: 500_000, isRecurring: false });
```

- [ ] **Step 5: Run tsc + tests to verify they pass**

Run: `npx tsc --noEmit` → no errors.
Run: `npx vitest run tests/agent/tools.test.ts` → PASS (create_budget_code cases, including NFR-09).

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "feat: require isRecurring on create_budget_code"
```

---

## Task 7: System-prompt rules + enrichment `(bulanan)` marker

**Files:**
- Modify: `src/agent/system-prompt.ts` (`buildSystemPrompt` rules + `enrichSystemPrompt` marker)
- Test: `tests/agent/system-prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/agent/system-prompt.test.ts`:

1. The `budget` const already has `isRecurring: false` (added in Task 1 Step 7) — no change needed there; it stays a one-time budget so the existing "never renders spent" test still asserts no `(bulanan)` marker leaks in.

2. Add a new `describe` block at the end of the file:

```ts
describe('buildSystemPrompt — budget auto-rolling rules', () => {
  const prompt = buildSystemPrompt('2026-07-01');

  it('tells the model to ask bulanan-vs-sekali at creation', () => {
    expect(prompt).toMatch(/bulanan/i);
    expect(prompt).toContain('isRecurring');
  });

  it('tells the model to store budget NAME (not budgetCodeId) in preferences', () => {
    expect(prompt).toContain('Jangan pernah');
    expect(prompt).toContain('budgetCodeId');
  });
});

describe('enrichSystemPrompt — recurring marker', () => {
  const base = 'BASE';
  const recurring: BudgetCode = {
    budgetCodeId: 'bc-r', userId: 'u1', name: 'Terea', monthlyBudget: 300_000,
    month: 7, year: 2026, spent: 0, isRecurring: true, createdAt: '', updatedAt: '',
  };
  const oneTime: BudgetCode = {
    budgetCodeId: 'bc-o', userId: 'u1', name: 'Trip', monthlyBudget: 1_000_000,
    month: 7, year: 2026, spent: 0, isRecurring: false, createdAt: '', updatedAt: '',
  };

  it('marks recurring budgets with (bulanan)', () => {
    const out = enrichSystemPrompt(base, { budgets: [recurring] });
    expect(out).toContain('(bulanan)');
  });

  it('does not mark one-time budgets', () => {
    const out = enrichSystemPrompt(base, { budgets: [oneTime] });
    expect(out).not.toContain('(bulanan)');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent/system-prompt.test.ts`
Expected: FAIL (the new rules/marker don't exist yet).

- [ ] **Step 3: Add the prompt rules**

In `src/agent/system-prompt.ts`, inside `buildSystemPrompt`, find the `PEMBAYARAN RUTIN:` section and add a new section immediately before it (before the line `PEMBAYARAN RUTIN:`):

```
BUDGET:
- Saat membuat budget code (`create_budget_code`), WAJIB tanyakan dulu: ini budget **bulanan** (recurring — dibuat ulang otomatis tiap tanggal 1 dengan alokasi yang sama, spent reset) atau **sekali untuk bulan ini**? Teruskan isRecurring=true untuk bulanan, false untuk sekali ini. Jangan menebak — tanya kalau user tidak menyebutkan. (Berlaku juga saat membuat budget baru karena nama belum terdaftar di pesan pengeluaran.)
- Saat menyimpan preferensi yang menyebut budget (`remember_preference`), SELALU simpan **nama** budget — nama yang user definisikan dan lihat. Jangan pernah simpan `budgetCodeId`: id itu internal, jarang dilihat user, dan berganti tiap bulan untuk budget bulanan. Resolve nama→id pakai blok BUDGET CODE BULAN INI saat menulis transaksi.

```

Also update the existing `DATA REFERENSI` bullet that mentions budgets. Replace:

```
- Gunakan blok BUDGET CODE BULAN INI untuk resolve nama budget ke budgetCodeId. Untuk spent/status terbaru, gunakan data dari tool.
```

with:

```
- Gunakan blok BUDGET CODE BULAN INI untuk resolve nama budget ke budgetCodeId (budget bulanan ditandai `(bulanan)`). Untuk spent/status terbaru, gunakan data dari tool.
```

- [ ] **Step 4: Add the `(bulanan)` marker in enrichment**

In `src/agent/system-prompt.ts`, in `enrichSystemPrompt`, replace the budgets block:

```ts
	if (data.budgets?.length) {
		sections.push(
			'BUDGET CODE BULAN INI (id, nama, batas — untuk resolve nama→id; spent TIDAK ada di sini, pakai get_budget_codes untuk spent):\n' +
				data.budgets
					.map((b) => {
						const marker = b.isRecurring ? ' (bulanan)' : '';
						return `- ${b.budgetCodeId} ${b.name} — batas ${formatIDR(b.monthlyBudget)}${marker}`;
					})
					.join('\n')
		);
	}
```

- [ ] **Step 5: Run tsc + tests to verify they pass**

Run: `npx tsc --noEmit` → no errors.
Run: `npx vitest run tests/agent/system-prompt.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/system-prompt.ts tests/agent/system-prompt.test.ts
git commit -m "feat: prompt budget bulanan/sekali rule + (bulanan) marker"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run the full type check + lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all tests PASS, including the new repo / sweep / tool / system-prompt cases. (Repo tests auto-apply migration 005 via the global setup.)

- [ ] **Step 3: Sanity-check the dev DB**

Run: `npm run migrate`
Expected: `005_budget_recurring.sql` reported already applied (idempotent), no errors.

```bash
git log --oneline -8
```

Expected: the seven feature commits from Tasks 1–7 on top of the branch base.

---

## Self-Review (run after writing the plan)

**Spec coverage:**
- §3 data model (is_recurring + old_budget_id + index) → Task 1. ✓
- §4.1 `rollRecurringIntoMonth` → Task 3. ✓
- §4.2 `sweepBudgetRollover` → Task 4. ✓
- §5 cron + boot reconcile + `BUDGET_ROLLOVER_CRON` → Task 5. ✓
- §6.1 `create_budget_code` required `isRecurring` → Task 6. ✓
- §6.2 BUDGET + PREFERENCE prompt rules → Task 7. ✓
- §6.3 enrichment `(bulanan)` marker (fetch unchanged) → Task 7. ✓
- §7 test plan — repo (Task 1/2/3), sweep (Task 4), system-prompt (Task 7), tool (Task 6). ✓
- §9 verification (tsc + lint + vitest + migrate) → Task 8. ✓

**Placeholder scan:** none — every code/SQL/test step is complete.

**Type consistency:** `rollRecurringIntoMonth(userId, year, month)` signature matches across interface (Task 3), Neon impl (Task 3), and sweep caller (Task 4). `CreateBudgetCodeInput.isRecurring?`/`oldBudgetId?` used in Task 2 repo and Task 6 tool. `BudgetCode.isRecurring`/`oldBudgetId` used in mapper (Task 1), roll-over lineage assertion (Task 3), enrichment marker (Task 7). Sweep param order `rollRecurringIntoMonth(userId, year, month)` matches the test's `[userId, year, month]` destructure. ✓
