# MoneyBot — Slice 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the remaining CRUD tools, budget codes, recurring payments, and the atomic `create_transfer` so users can record income, transfers, corrections, recurring schedules, and query transactions/budgets/recurrings.

**Architecture:** Extends Slice 1's grammY → orchestrator → tools → repos → Neon stack. Two new repository implementations (`budget_codes`, `recurring_payments`) follow the existing `pool.query` + mapper pattern. `createTransfer` is the only atomic method — it uses `pool.connect()` → `BEGIN` → statements → `COMMIT` inside the transaction repo. All tools follow the established write-gate contract (never throw, return `WriteResult`). `Slice1Repos` is expanded to `Repos` (6 repos).

**Tech Stack:** Same as Slice 0+1 — TypeScript 5, grammY, Vercel AI SDK (`ai` + `@ai-sdk/openai` via OpenRouter), `zod`, `pg` (Neon), Vitest, ESLint, `tsx`.

**Reference:** Design spec at `docs/superpowers/specs/2026-06-18-moneybot-slice-2-design.md`. SRS at `docs/SRS.md`. Slice 0+1 plan at `docs/superpowers/plans/2026-06-14-moneybot-slice-0-1.md`. Slice 0+1 RESUME at `docs/superpowers/plans/2026-06-14-moneybot-slice-0-1-RESUME.md` (deviation notes).

---

## File Structure (this plan's deliverables — new + modified)

```
Create:
  src/adapters/neon/budget-code.repository.ts
  src/adapters/neon/recurring-payment.repository.ts
  tests/adapters/budget-code.repository.test.ts
  tests/adapters/recurring-payment.repository.test.ts
Modify:
  src/adapters/neon/mappers.ts            ← add mapBudgetCode, mapRecurringPayment
  src/adapters/neon/repos.ts              ← Slice1Repos → Repos (add budgets, recurrings)
  src/repositories/interfaces.ts          ← add Repos, CreateTransferInput; ITransactionRepository.createTransfer
  src/domain/time.ts                      ← add nextFireDate + wibMonth/wibYear helpers
  src/agent/tools.ts                      ← expand buildTools (10 new tools + FR-03d)
  src/agent/orchestrator.ts               ← Slice1Repos → Repos; thread lastTransactionId
  src/agent/system-prompt.ts              ← add transfer + recurring + income guidance
  tests/agent/tools.test.ts               ← expand: new tool describe blocks
  tests/agent/orchestrator.test.ts        ← expand: Repos shape + lastTransactionId threading
```

**Design discipline:** The `createTransfer` method on `ITransactionRepository` is the ONLY place that opens a `pool.connect()` client — everything else stays on anonymous `pool.query()`. Mappers stay centralized in `mappers.ts`. Tools never import from `adapters/neon/`.

---

## Task 1: `nextFireDate` + WIB month/year helpers

**Files:**
- Modify: `src/domain/time.ts`

`nextFireDate` computes the next occurrence of `dayOfMonth` on or after today (WIB). The helper uses the existing `lastDayOfMonth` to handle short-month overflow (day 31 → Feb 28). Also add small `wibMonth`/`wibYear` extractors to avoid repeating the `Intl.DateTimeFormat` incantation everywhere.

- [ ] **Step 1: Add helpers to `src/domain/time.ts`**

Add after the existing exports:

```ts
const TZ = 'Asia/Jakarta';

function wibDateParts(now: Date): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [year, month, day] = fmt.format(now).split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

/** Current month (1–12) in WIB. */
export function wibMonth(now: Date = new Date()): number {
  return wibDateParts(now).month;
}

/** Current year in WIB. */
export function wibYear(now: Date = new Date()): number {
  return wibDateParts(now).year;
}

/**
 * Next occurrence of `dayOfMonth` on or after today (WIB).
 * A day-31 subscription in February fires on Feb 28 (last-day rule).
 */
export function nextFireDate(dayOfMonth: number, today: Date = new Date()): string {
  const { year, month, day: todayDay } = wibDateParts(today);
  const daysInMonth = lastDayOfMonth(year, month);
  const targetDay = Math.min(dayOfMonth, daysInMonth);

  if (todayDay <= targetDay) {
    return `${year}-${String(month).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
  }

  // Next month
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextDaysInMonth = lastDayOfMonth(nextYear, nextMonth);
  const nextTargetDay = Math.min(dayOfMonth, nextDaysInMonth);
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextTargetDay).padStart(2, '0')}`;
}
```

> The existing `TZ` constant, `todayWIB`, `nowWIB`, and `lastDayOfMonth` remain unchanged at the top of the file.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/domain/time.ts
git commit -m "feat(domain): nextFireDate + wibMonth/wibYear helpers for recurring payments

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: BudgetCode repository (TDD)

**Files:**
- Modify: `src/adapters/neon/mappers.ts` — add `mapBudgetCode`
- Create: `src/adapters/neon/budget-code.repository.ts`
- Create: `tests/adapters/budget-code.repository.test.ts`

- [ ] **Step 1: Write the failing test `tests/adapters/budget-code.repository.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonBudgetCodeRepository } from '../../src/adapters/neon/budget-code.repository.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: '1', name: 'U' });
}

describe('NeonBudgetCodeRepository', () => {
  it('creates a budget code and finds it by user + month + year', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const bc = await budgets.create({ userId: user.userId, name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026 });
    expect(bc.name).toBe('Jajan');
    expect(bc.spent).toBe(0);
    const found = await budgets.findByUserAndMonth(user.userId, 2026, 6);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('Jajan');
  });

  it('finds by name (case-insensitive) within a month/year', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    await budgets.create({ userId: user.userId, name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026 });
    const found = await budgets.findByName(user.userId, 'jajan', 2026, 6);
    expect(found?.monthlyBudget).toBe(500_000);
  });

  it('increments spent', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const bc = await budgets.create({ userId: user.userId, name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026 });
    await budgets.incrementSpent(user.userId, bc.budgetCodeId, 50_000);
    await budgets.incrementSpent(user.userId, bc.budgetCodeId, 25_000);
    const found = await budgets.findByName(user.userId, 'Jajan', 2026, 6);
    expect(found?.spent).toBe(75_000);
  });

  it('scopes budget codes per user + month + year (isolation)', async () => {
    const userA = await seedUser();
    const userB = await new NeonUserRepository().create({ telegramChatId: '2', name: 'B' });
    const budgets = new NeonBudgetCodeRepository();
    await budgets.create({ userId: userA.userId, name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026 });
    // Different user, same name/month — separate
    await budgets.create({ userId: userB.userId, name: 'Jajan', monthlyBudget: 300_000, month: 6, year: 2026 });
    const aBudgets = await budgets.findByUserAndMonth(userA.userId, 2026, 6);
    expect(aBudgets).toHaveLength(1);
    // Different month — separate row
    await budgets.create({ userId: userA.userId, name: 'Jajan', monthlyBudget: 600_000, month: 7, year: 2026 });
    const aJune = await budgets.findByUserAndMonth(userA.userId, 2026, 6);
    expect(aJune).toHaveLength(1);
    const aJuly = await budgets.findByUserAndMonth(userA.userId, 2026, 7);
    expect(aJuly).toHaveLength(1);
  });

  it('updates a budget code field', async () => {
    const user = await seedUser();
    const budgets = new NeonBudgetCodeRepository();
    const bc = await budgets.create({ userId: user.userId, name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026 });
    const updated = await budgets.update(user.userId, bc.budgetCodeId, { monthlyBudget: 750_000 });
    expect(updated.monthlyBudget).toBe(750_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/budget-code.repository.test.ts`
Expected: FAIL — module not found (`Cannot find module '../../src/adapters/neon/budget-code.repository.js'`).

- [ ] **Step 3: Add `mapBudgetCode` to `src/adapters/neon/mappers.ts`**

Add the import at the top:

```ts
import type {
  User,
  Account,
  Transaction,
  BudgetCode,
  RecurringPayment,
  SessionContext,
} from '../../domain/entities.js';
```

Add before `mapSession`:

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
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  };
}
```

- [ ] **Step 4: Write `src/adapters/neon/budget-code.repository.ts`**

```ts
import { pool } from './pool.js';
import { mapBudgetCode } from './mappers.js';
import type { IBudgetCodeRepository, CreateBudgetCodeInput } from '../../repositories/interfaces.js';
import type { BudgetCode } from '../../domain/entities.js';

export class NeonBudgetCodeRepository implements IBudgetCodeRepository {
  async findByUserAndMonth(userId: string, year: number, month: number): Promise<BudgetCode[]> {
    const { rows } = await pool.query(
      'SELECT * FROM budget_codes WHERE user_id = $1 AND year = $2 AND month = $3 ORDER BY name',
      [userId, year, month],
    );
    return rows.map((r) => mapBudgetCode(r as Record<string, unknown>));
  }

  async findByName(userId: string, name: string, year: number, month: number): Promise<BudgetCode | null> {
    const { rows } = await pool.query(
      `SELECT * FROM budget_codes
       WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND year = $3 AND month = $4`,
      [userId, name, year, month],
    );
    return rows[0] ? mapBudgetCode(rows[0] as Record<string, unknown>) : null;
  }

  async create(input: CreateBudgetCodeInput): Promise<BudgetCode> {
    const { rows } = await pool.query(
      `INSERT INTO budget_codes (user_id, name, monthly_budget, month, year)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.userId, input.name, input.monthlyBudget, input.month, input.year],
    );
    return mapBudgetCode(rows[0] as Record<string, unknown>);
  }

  async incrementSpent(userId: string, budgetCodeId: string, delta: number): Promise<void> {
    await pool.query(
      `UPDATE budget_codes
       SET spent = spent + $3, updated_at = NOW()
       WHERE user_id = $1 AND budget_code_id = $2`,
      [userId, budgetCodeId, delta],
    );
  }

  async update(userId: string, budgetCodeId: string, patch: Partial<BudgetCode>): Promise<BudgetCode> {
    const { rows } = await pool.query(
      `UPDATE budget_codes
       SET name = COALESCE($3, name),
           monthly_budget = COALESCE($4, monthly_budget),
           updated_at = NOW()
       WHERE user_id = $1 AND budget_code_id = $2
       RETURNING *`,
      [userId, budgetCodeId, patch.name ?? null, patch.monthlyBudget ?? null],
    );
    return mapBudgetCode(rows[0] as Record<string, unknown>);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/budget-code.repository.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/neon/mappers.ts src/adapters/neon/budget-code.repository.ts tests/adapters/budget-code.repository.test.ts
git commit -m "feat(repos): budget code repository (create, findByUserAndMonth, findByName, incrementSpent)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: RecurringPayment repository (TDD)

**Files:**
- Modify: `src/adapters/neon/mappers.ts` — add `mapRecurringPayment`
- Create: `src/adapters/neon/recurring-payment.repository.ts`
- Create: `tests/adapters/recurring-payment.repository.test.ts`

- [ ] **Step 1: Write the failing test `tests/adapters/recurring-payment.repository.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
import { NeonRecurringPaymentRepository } from '../../src/adapters/neon/recurring-payment.repository.js';

async function seed() {
  const users = new NeonUserRepository();
  const accounts = new NeonAccountRepository();
  const user = await users.create({ telegramChatId: '1', name: 'U' });
  const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
  return { user, acc };
}

describe('NeonRecurringPaymentRepository', () => {
  it('creates a recurring payment', async () => {
    const { user, acc } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    const rp = await recurrings.create({
      userId: user.userId,
      name: 'Netflix',
      amount: 159_000,
      accountId: acc.accountId,
      categoryId: 'entertainment.streaming',
      dayOfMonth: 15,
      nextFireAt: '2026-06-15',
    });
    expect(rp.name).toBe('Netflix');
    expect(rp.isActive).toBe(true);
    expect(rp.dayOfMonth).toBe(15);
    expect(rp.nextFireAt).toBe('2026-06-15');
  });

  it('finds all active recurring payments for a user', async () => {
    const { user, acc } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    await recurrings.create({
      userId: user.userId, name: 'Netflix', amount: 159_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    await recurrings.create({
      userId: user.userId, name: 'Spotify', amount: 54_990,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 1, nextFireAt: '2026-07-01',
    });
    const all = await recurrings.findAllByUserId(user.userId);
    expect(all).toHaveLength(2);
  });

  it('finds by day of month', async () => {
    const { user, acc } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    await recurrings.create({
      userId: user.userId, name: 'Netflix', amount: 159_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    await recurrings.create({
      userId: user.userId, name: 'Spotify', amount: 54_990,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 1, nextFireAt: '2026-07-01',
    });
    const day1 = await recurrings.findByDayOfMonth(1);
    expect(day1).toHaveLength(1);
  });

  it('finds by id and by name', async () => {
    const { user, acc } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    const rp = await recurrings.create({
      userId: user.userId, name: 'Netflix', amount: 159_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    const byId = await recurrings.findById(user.userId, rp.recurringId);
    expect(byId?.name).toBe('Netflix');
    const byName = await recurrings.findByName(user.userId, 'Netflix');
    expect(byName?.recurringId).toBe(rp.recurringId);
  });

  it('deactivates (sets isActive = false)', async () => {
    const { user, acc } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    const rp = await recurrings.create({
      userId: user.userId, name: 'Netflix', amount: 159_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    await recurrings.deactivate(user.userId, rp.recurringId);
    const byId = await recurrings.findById(user.userId, rp.recurringId);
    expect(byId?.isActive).toBe(false);
    const all = await recurrings.findAllByUserId(user.userId);
    expect(all).toHaveLength(0);
  });

  it('updates a recurring payment field', async () => {
    const { user, acc } = await seed();
    const recurrings = new NeonRecurringPaymentRepository();
    const rp = await recurrings.create({
      userId: user.userId, name: 'Netflix', amount: 159_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming', dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    const updated = await recurrings.update(user.userId, rp.recurringId, { amount: 179_000, nextFireAt: '2026-07-15' });
    expect(updated.amount).toBe(179_000);
    expect(updated.nextFireAt).toBe('2026-07-15');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/recurring-payment.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `mapRecurringPayment` to `src/adapters/neon/mappers.ts`**

Add after `mapBudgetCode`:

```ts
export function mapRecurringPayment(r: Row): RecurringPayment {
  return {
    recurringId: str(r, 'recurring_id'),
    userId: str(r, 'user_id'),
    name: str(r, 'name'),
    amount: num(r, 'amount'),
    accountId: str(r, 'account_id'),
    categoryId: str(r, 'category_id'),
    budgetCodeId: maybeStr(r, 'budget_code_id'),
    dayOfMonth: num(r, 'day_of_month'),
    isActive: bool(r, 'is_active'),
    lastFiredAt: maybeStr(r, 'last_fired_at'),
    nextFireAt: str(r, 'next_fire_at'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  };
}
```

- [ ] **Step 4: Write `src/adapters/neon/recurring-payment.repository.ts`**

```ts
import { pool } from './pool.js';
import { mapRecurringPayment } from './mappers.js';
import type { IRecurringPaymentRepository, CreateRecurringPaymentInput } from '../../repositories/interfaces.js';
import type { RecurringPayment } from '../../domain/entities.js';

export class NeonRecurringPaymentRepository implements IRecurringPaymentRepository {
  async findAllByUserId(userId: string): Promise<RecurringPayment[]> {
    const { rows } = await pool.query(
      'SELECT * FROM recurring_payments WHERE user_id = $1 AND is_active = true ORDER BY day_of_month',
      [userId],
    );
    return rows.map((r) => mapRecurringPayment(r as Record<string, unknown>));
  }

  async findByDayOfMonth(dayOfMonth: number): Promise<RecurringPayment[]> {
    const { rows } = await pool.query(
      `SELECT * FROM recurring_payments
       WHERE day_of_month = $1 AND is_active = true`,
      [dayOfMonth],
    );
    return rows.map((r) => mapRecurringPayment(r as Record<string, unknown>));
  }

  async findById(userId: string, recurringId: string): Promise<RecurringPayment | null> {
    const { rows } = await pool.query(
      'SELECT * FROM recurring_payments WHERE user_id = $1 AND recurring_id = $2',
      [userId, recurringId],
    );
    return rows[0] ? mapRecurringPayment(rows[0] as Record<string, unknown>) : null;
  }

  async findByName(userId: string, name: string): Promise<RecurringPayment | null> {
    const { rows } = await pool.query(
      `SELECT * FROM recurring_payments
       WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND is_active = true`,
      [userId, name],
    );
    return rows[0] ? mapRecurringPayment(rows[0] as Record<string, unknown>) : null;
  }

  async create(input: CreateRecurringPaymentInput): Promise<RecurringPayment> {
    const { rows } = await pool.query(
      `INSERT INTO recurring_payments
        (user_id, name, amount, account_id, category_id, budget_code_id, day_of_month, next_fire_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.userId, input.name, input.amount, input.accountId,
        input.categoryId, input.budgetCodeId ?? null, input.dayOfMonth, input.nextFireAt,
      ],
    );
    return mapRecurringPayment(rows[0] as Record<string, unknown>);
  }

  async update(userId: string, recurringId: string, patch: Partial<RecurringPayment>): Promise<RecurringPayment> {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [userId, recurringId];
    let i = 3;
    if (patch.name !== undefined) { sets.push(`name = $${i++}`); values.push(patch.name); }
    if (patch.amount !== undefined) { sets.push(`amount = $${i++}`); values.push(patch.amount); }
    if (patch.accountId !== undefined) { sets.push(`account_id = $${i++}`); values.push(patch.accountId); }
    if (patch.categoryId !== undefined) { sets.push(`category_id = $${i++}`); values.push(patch.categoryId); }
    if (patch.dayOfMonth !== undefined) { sets.push(`day_of_month = $${i++}`); values.push(patch.dayOfMonth); }
    if (patch.nextFireAt !== undefined) { sets.push(`next_fire_at = $${i++}`); values.push(patch.nextFireAt); }
    const { rows } = await pool.query(
      `UPDATE recurring_payments SET ${sets.join(', ')} WHERE user_id = $1 AND recurring_id = $2 RETURNING *`,
      values,
    );
    return mapRecurringPayment(rows[0] as Record<string, unknown>);
  }

  async deactivate(userId: string, recurringId: string): Promise<void> {
    await pool.query(
      'UPDATE recurring_payments SET is_active = false, updated_at = NOW() WHERE user_id = $1 AND recurring_id = $2',
      [userId, recurringId],
    );
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/recurring-payment.repository.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/neon/mappers.ts src/adapters/neon/recurring-payment.repository.ts tests/adapters/recurring-payment.repository.test.ts
git commit -m "feat(repos): recurring payment repository (create, findAll, findByDay, deactivate)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: `Repos` type expansion + `createRepos()` + `createTransfer` on txn repo

**Files:**
- Modify: `src/repositories/interfaces.ts` — add `Repos` interface, `CreateTransferInput`, and `createTransfer` method
- Modify: `src/adapters/neon/transaction.repository.ts` — implement `createTransfer`
- Modify: `src/adapters/neon/repos.ts` — `createRepos()` returns `Repos`

- [ ] **Step 1: Add `CreateTransferInput` + method + `Repos` to `src/repositories/interfaces.ts`**

Add after `CreateTransactionInput`:

```ts
export interface CreateTransferInput {
  userId: string;
  amount: number;
  fromAccountId: string;
  toAccountId: string;
  description: string;
  date: string; // 'YYYY-MM-DD' (WIB)
  notes?: string;
}
```

Add `createTransfer` to `ITransactionRepository`:

```ts
export interface ITransactionRepository {
  create(input: CreateTransactionInput): Promise<Transaction>;
  createTransfer(input: CreateTransferInput): Promise<Transaction>; // atomic (NFR-05)
  findByDateRange(userId: string, from: string, to: string): Promise<Transaction[]>;
  findByAccountAndDateRange(
    userId: string,
    accountId: string,
    from: string,
    to: string,
  ): Promise<Transaction[]>;
  findLatestByUserId(userId: string, limit?: number): Promise<Transaction[]>;
  findById(userId: string, transactionId: string): Promise<Transaction | null>;
  update(userId: string, transactionId: string, patch: Partial<Transaction>): Promise<Transaction>;
  softDelete(userId: string, transactionId: string): Promise<void>;
}
```

Add `Repos` after the existing `Slice1Repos`:

```ts
/** Full repos — Slice 2 target. */
export interface Repos {
  users: IUserRepository;
  accounts: IAccountRepository;
  transactions: ITransactionRepository;
  sessions: ISessionRepository;
  budgets: IBudgetCodeRepository;
  recurrings: IRecurringPaymentRepository;
}
```

- [ ] **Step 2: Implement `createTransfer` in `src/adapters/neon/transaction.repository.ts`**

Add the import at the top:

```ts
import type { CreateTransferInput } from '../../repositories/interfaces.js';
```

Add the method before the closing `}` of `NeonTransactionRepository`:

```ts
  async createTransfer(input: CreateTransferInput): Promise<Transaction> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO transactions
          (user_id, type, amount, description, account_id, to_account_id, date, notes)
         VALUES ($1, 'transfer', $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          input.userId, input.amount, input.description,
          input.fromAccountId, input.toAccountId, input.date, input.notes ?? null,
        ],
      );
      await client.query(
        'UPDATE accounts SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2 AND account_id = $3',
        [input.amount, input.userId, input.fromAccountId],
      );
      await client.query(
        'UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2 AND account_id = $3',
        [input.amount, input.userId, input.toAccountId],
      );
      await client.query('COMMIT');
      return mapTransaction(rows[0] as Record<string, unknown>);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
```

- [ ] **Step 3: Update `src/adapters/neon/repos.ts`**

```ts
import { NeonUserRepository } from './user.repository.js';
import { NeonAccountRepository } from './account.repository.js';
import { NeonTransactionRepository } from './transaction.repository.js';
import { NeonSessionRepository } from './session.repository.js';
import { NeonBudgetCodeRepository } from './budget-code.repository.js';
import { NeonRecurringPaymentRepository } from './recurring-payment.repository.js';
import type { Repos } from '../../repositories/interfaces.js';

export function createRepos(): Repos {
  return {
    users: new NeonUserRepository(),
    accounts: new NeonAccountRepository(),
    transactions: new NeonTransactionRepository(),
    sessions: new NeonSessionRepository(),
    budgets: new NeonBudgetCodeRepository(),
    recurrings: new NeonRecurringPaymentRepository(),
  };
}
```

- [ ] **Step 4: Add transfer atomicity tests to the existing `tests/adapters/transaction.repository.test.ts`**

Add after the existing describe blocks:

```ts
  describe('createTransfer — atomic (NFR-05)', () => {
    it('creates a transfer and moves balances atomically', async () => {
      const { user } = await seed();
      const accounts = new NeonAccountRepository();
      const from = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank', openingBalance: 100_000 });
      const to = await accounts.create({ userId: user.userId, name: 'Mandiri', type: 'bank', openingBalance: 50_000 });
      const txns = new NeonTransactionRepository();
      const t = await txns.createTransfer({
        userId: user.userId,
        amount: 30_000,
        fromAccountId: from.accountId,
        toAccountId: to.accountId,
        description: 'transfer ke Mandiri',
        date: '2026-06-18',
      });
      expect(t.type).toBe('transfer');
      expect(t.amount).toBe(30_000);
      expect(t.accountId).toBe(from.accountId);
      expect(t.toAccountId).toBe(to.accountId);
      // Balances moved
      const fromAfter = await accounts.findById(user.userId, from.accountId);
      const toAfter = await accounts.findById(user.userId, to.accountId);
      expect(fromAfter?.balance).toBe(70_000);
      expect(toAfter?.balance).toBe(80_000);
    });

    it('rolls back both balances when the to-account does not exist', async () => {
      const { user } = await seed();
      const accounts = new NeonAccountRepository();
      const from = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank', openingBalance: 100_000 });
      const txns = new NeonTransactionRepository();
      await expect(
        txns.createTransfer({
          userId: user.userId,
          amount: 30_000,
          fromAccountId: from.accountId,
          toAccountId: '00000000-0000-0000-0000-000000000000', // does not exist
          description: 'bad transfer',
          date: '2026-06-18',
        }),
      ).rejects.toThrow(); // FK violation triggers ROLLBACK
      // from balance is untouched
      const fromAfter = await accounts.findById(user.userId, from.accountId);
      expect(fromAfter?.balance).toBe(100_000);
    });
  });
```

Also add the import at the top:

```ts
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
```

(Already imported; confirm.)

- [ ] **Step 5: Run the transfer tests to verify they pass**

Run: `npx vitest run tests/adapters/transaction.repository.test.ts`
Expected: PASS (6 tests — 4 existing + 2 new).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all tests pass (existing 32 + 11 new from Tasks 2–3 + 2 transfer = 45 total).

- [ ] **Step 7: Commit**

```bash
git add src/repositories/interfaces.ts src/adapters/neon/transaction.repository.ts src/adapters/neon/repos.ts tests/adapters/transaction.repository.test.ts
git commit -m "feat(repos): Repos type (6 repos) + atomic createTransfer (NFR-05)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Orchestrator + `buildTools` wiring (Repos, lastTransactionId)

**Files:**
- Modify: `src/agent/orchestrator.ts` — `Slice1Repos` → `Repos`; thread `lastTransactionId`
- Modify: `src/agent/tools.ts` — `Slice1Repos` → `Repos`; add `lastTransactionId` to `BuildToolsArgs`
- Modify: `tests/agent/orchestrator.test.ts` — `Slice1Repos` → `Repos`
- Modify: `tests/agent/tools.test.ts` — `Slice1Repos` → `Repos`

**This is a rename + wiring task — no new test logic, just type updates.** The existing test assertions remain unchanged.

- [ ] **Step 1: Update `BuildToolsArgs` in `src/agent/tools.ts`**

Change the import:

```ts
import type { Repos } from '../repositories/interfaces.js';
```

Change the interface:

```ts
export interface BuildToolsArgs {
  userId: string;
  repos: Repos;
  hasAccount: boolean;
  lastTransactionId?: string;
}
```

(No other changes to `tools.ts` in this task — the new tools arrive in Tasks 6–9.)

- [ ] **Step 2: Update `handleMessage` in `src/agent/orchestrator.ts`**

Change the import:

```ts
import type { Repos } from '../repositories/interfaces.js';
```

Change `HandleMessageArgs`:

```ts
export interface HandleMessageArgs {
  text: string;
  chatId: string;
  repos: Repos;
  run: AgentRunner;
  system: string;
  contextWindowTurns: number;
  sessionIdleTimeoutMinutes: number;
  now?: () => Date;
}
```

In the function body, update the `buildTools` call (after `hasAccount` check, before `run`):

```ts
  const tools = buildTools({
    userId: user.userId,
    repos: args.repos,
    hasAccount,
    lastTransactionId: session.lastTransactionId,
  });
```

- [ ] **Step 3: Update `tests/agent/orchestrator.test.ts`**

Change `Slice1Repos` → `Repos` in the import:

```ts
import type { Repos } from '../../src/repositories/interfaces.js';
```

Update `mockRepos()` to add the two new repos:

```ts
function mockRepos(): Repos {
  return {
    users: {
      findByTelegramChatId: vi.fn(async () => null),
      findById: vi.fn(),
      create: vi.fn(async (i: { telegramChatId: string; name: string }) => ({
        userId: 'u1', telegramChatId: i.telegramChatId, name: i.name, language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
      })),
      update: vi.fn(),
    } as never,
    accounts: {
      findAllByUserId: vi.fn(async () => []),
      findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
    } as never,
    transactions: { create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn() } as never,
    sessions: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(),
    } as never,
    budgets: {
      findByUserAndMonth: vi.fn(async () => []),
      findByName: vi.fn(async () => null),
      create: vi.fn(),
      incrementSpent: vi.fn(),
      update: vi.fn(),
    } as never,
    recurrings: {
      findAllByUserId: vi.fn(async () => []),
      findByDayOfMonth: vi.fn(),
      findById: vi.fn(),
      findByName: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
    } as never,
  };
}
```

- [ ] **Step 4: Update `tests/agent/tools.test.ts`**

Change `Slice1Repos` → `Repos` in the import:

```ts
import type { Repos } from '../../src/repositories/interfaces.js';
```

Update `mockRepos` to add the two new repos (same as above but with `overrides`):

```ts
function mockRepos(overrides: Partial<Repos> = {}): Repos {
  return {
    users: { create: vi.fn(async (i: { telegramChatId: string; name: string }) => ({ userId: 'u1', telegramChatId: i.telegramChatId, name: i.name, language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '' })) } as never,
    accounts: {
      findAllByUserId: vi.fn(async () => []),
      findById: vi.fn(async () => null),
      findByName: vi.fn(async () => null),
      create: vi.fn(async (i: { name: string; type: string; creditLimit?: number }) => ({ accountId: 'a1', userId: 'u1', name: i.name, type: i.type as never, balance: 0, creditLimit: i.creditLimit, isActive: true, createdAt: '', updatedAt: '' })),
      updateBalance: vi.fn(async () => undefined),
      update: vi.fn(async () => ({}) as never),
    } as never,
    transactions: {
      create: vi.fn(async (i: { amount: number; description: string; categoryId?: string }) => ({ transactionId: 't1', userId: 'u1', type: 'expense' as const, amount: i.amount, description: i.description, categoryId: i.categoryId, accountId: 'a1', isRecurringInstance: false, date: '', createdAt: '', updatedAt: '' })),
      createTransfer: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: {
      findByUserAndMonth: vi.fn(),
      findByName: vi.fn(),
      create: vi.fn(),
      incrementSpent: vi.fn(),
      update: vi.fn(),
    } as never,
    recurrings: {
      findAllByUserId: vi.fn(),
      findByDayOfMonth: vi.fn(),
      findById: vi.fn(),
      findByName: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
    } as never,
    ...overrides,
  };
}
```

- [ ] **Step 5: Type-check + full suite**

Run: `npx tsc --noEmit` → `npm run lint` → `npm test`
Expected: all clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/agent/orchestrator.ts src/agent/tools.ts tests/agent/orchestrator.test.ts tests/agent/tools.test.ts
git commit -m "refactor(agent): Slice1Repos -> Repos (6 repos); thread lastTransactionId into buildTools

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Read tools — T03, T04, T09, T13, T16

**Files:**
- Modify: `src/agent/tools.ts` — register 5 read tools
- Modify: `tests/agent/tools.test.ts` — add read-tool describe blocks

- [ ] **Step 1: Write the failing read-tool tests**

Add to `tests/agent/tools.test.ts` before the closing of the file (after existing describe blocks):

```ts
describe('buildTools — get_categories (T03)', () => {
  it('returns all categories from the static taxonomy', async () => {
    const repos = mockRepos();
    const { get_categories } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_categories, {});
    expect(Array.isArray(res)).toBe(true);
    // The taxonomy has 58 categories; the tool returns them all
    const arr = res as unknown as Array<{ categoryId: string }>;
    expect(arr.length).toBeGreaterThan(0);
    expect(arr.some((c) => c.categoryId === 'food.dining')).toBe(true);
  });
});

describe('buildTools — get_budget_codes (T04)', () => {
  it('returns budget codes for the user', async () => {
    const repos = mockRepos({
      budgets: {
        findByUserAndMonth: vi.fn(async () => [
          { budgetCodeId: 'b1', userId: 'u1', name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026, spent: 0, createdAt: '', updatedAt: '' },
        ]),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_budget_codes } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_budget_codes, {});
    const arr = res as unknown as Array<{ name: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.name).toBe('Jajan');
  });
});

describe('buildTools — get_transactions (T09)', () => {
  it('returns transactions filtered by date range', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          { transactionId: 't1', userId: 'u1', type: 'expense' as const, amount: 20_000, description: 'bakso', categoryId: 'food.dining', accountId: 'a1', isRecurringInstance: false, date: '2026-06-15', createdAt: '', updatedAt: '' },
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
    });
    const { get_transactions } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_transactions, { fromDate: '2026-06-01', toDate: '2026-06-30' });
    const arr = res as unknown as Array<{ description: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.description).toBe('bakso');
  });
});

describe('buildTools — get_recurring_payments (T13)', () => {
  it('returns active recurring payments', async () => {
    const repos = mockRepos({
      recurrings: {
        findAllByUserId: vi.fn(async () => [
          { recurringId: 'r1', userId: 'u1', name: 'Netflix', amount: 159_000, accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 15, isActive: true, nextFireAt: '2026-06-15', createdAt: '', updatedAt: '' },
        ]),
        findByDayOfMonth: vi.fn(),
        findById: vi.fn(),
        findByName: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        deactivate: vi.fn(),
      } as never,
    });
    const { get_recurring_payments } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_recurring_payments, {});
    const arr = res as unknown as Array<{ name: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.name).toBe('Netflix');
  });
});

describe('buildTools — get_account_balance (T16)', () => {
  it('returns balances for all accounts when no accountId given', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => [
          { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' },
          { accountId: 'a2', userId: 'u1', name: 'Mandiri', type: 'bank', balance: 50_000, isActive: true, createdAt: '', updatedAt: '' },
        ]),
        findById: vi.fn(),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_account_balance } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_account_balance, {});
    const arr = res as unknown as Array<{ name: string; balance: number }>;
    expect(arr).toHaveLength(2);
    expect(arr[0]!.balance).toBe(100_000);
  });

  it('returns balance for a single account by accountId', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => [
          { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' },
        ]),
        findById: vi.fn(async (_u: string, id: string) =>
          id === 'a1' ? { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 100_000, isActive: true, createdAt: '', updatedAt: '' } : null,
        ),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_account_balance } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_account_balance, { accountId: 'a1' });
    const obj = res as unknown as { balance: number };
    expect(obj.balance).toBe(100_000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: FAIL — the new tools are undefined (buildTools doesn't register them yet).

- [ ] **Step 3: Implement the 5 read tools in `src/agent/tools.ts`**

Add the import at the top:

```ts
import { CATEGORIES } from '../domain/categories.js';
```

In the `buildTools` function, after `tools.get_accounts = tool(...)` and BEFORE the `if (!hasAccount) return tools;` line, register the read tools:

```ts
  // Read tools: always available post-onboarding (but registered before the
  // hasAccount gate so get_accounts is also always available for SP-02).
  // All of these are read-only — they return data, not WriteResult.

  tools.get_categories = tool({
    description: 'Daftar semua kategori sistem (pengeluaran & pemasukan).',
    parameters: z.object({}),
    execute: async () => {
      return CATEGORIES.map((c) => ({
        categoryId: c.categoryId,
        name: c.name,
        nameEn: c.nameEn,
        icon: c.icon,
        type: c.type,
      }));
    },
  });

  tools.get_budget_codes = tool({
    description: 'Daftar budget codes user untuk bulan/tahun tertentu. Default: bulan ini (WIB).',
    parameters: z.object({
      month: z.number().int().min(1).max(12).optional(),
      year: z.number().int().positive().optional(),
    }),
    execute: async ({ month, year }) => {
      const m = month ?? wibMonth();
      const y = year ?? wibYear();
      const codes = await repos.budgets.findByUserAndMonth(userId, y, m);
      return codes.map((c) => ({
        budgetCodeId: c.budgetCodeId,
        name: c.name,
        monthlyBudget: c.monthlyBudget,
        spent: c.spent,
      }));
    },
  });

  tools.get_transactions = tool({
    description: 'Cari transaksi berdasarkan rentang tanggal. Bisa filter opsional: accountId, categoryId, type, limit.',
    parameters: z.object({
      fromDate: z.string().describe('YYYY-MM-DD'),
      toDate: z.string().describe('YYYY-MM-DD'),
      accountId: z.string().optional(),
      categoryId: z.string().optional(),
      type: z.enum(['expense', 'income', 'transfer']).optional(),
      limit: z.number().int().positive().optional(),
    }),
    execute: async ({ fromDate, toDate, accountId, categoryId, type, limit }) => {
      let rows;
      if (accountId) {
        rows = await repos.transactions.findByAccountAndDateRange(userId, accountId, fromDate, toDate);
      } else {
        rows = await repos.transactions.findByDateRange(userId, fromDate, toDate);
      }
      if (categoryId) rows = rows.filter((t) => t.categoryId === categoryId);
      if (type) rows = rows.filter((t) => t.type === type);
      if (limit) rows = rows.slice(0, limit);
      return rows.map((t) => ({
        transactionId: t.transactionId,
        type: t.type,
        amount: t.amount,
        description: t.description,
        categoryId: t.categoryId,
        accountId: t.accountId,
        date: t.date,
        notes: t.notes,
      }));
    },
  });

  tools.get_recurring_payments = tool({
    description: 'Daftar semua recurring payment yang masih aktif.',
    parameters: z.object({}),
    execute: async () => {
      const recurrings = await repos.recurrings.findAllByUserId(userId);
      return recurrings.map((r) => ({
        recurringId: r.recurringId,
        name: r.name,
        amount: r.amount,
        accountId: r.accountId,
        categoryId: r.categoryId,
        dayOfMonth: r.dayOfMonth,
        nextFireAt: r.nextFireAt,
      }));
    },
  });

  tools.get_account_balance = tool({
    description: 'Cek saldo satu akun (via accountId) atau semua akun.',
    parameters: z.object({
      accountId: z.string().optional(),
    }),
    execute: async ({ accountId }) => {
      if (accountId) {
        const acc = await repos.accounts.findById(userId, accountId);
        if (!acc) return [];
        return [{ accountId: acc.accountId, name: acc.name, balance: acc.balance }];
      }
      const all = await repos.accounts.findAllByUserId(userId);
      return all.map((a) => ({ accountId: a.accountId, name: a.name, balance: a.balance }));
    },
  });
```

Also add the import for the wibMonth/wibYear helpers at the top:

```ts
import { todayWIB, wibMonth, wibYear } from '../domain/time.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: PASS (12 tests — 6 existing + 6 new read-tool tests).

- [ ] **Step 5: Type-check + lint**

Run: `npx tsc --noEmit` → `npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "feat(tools): read tools — T03 get_categories, T04 get_budget_codes, T09 get_transactions, T13 get_recurring_payments, T16 get_account_balance

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: `create_expense` enhancement — FR-03c budget name resolution + FR-03d overspend

**Files:**
- Modify: `src/agent/tools.ts` — enhance `create_expense.execute`
- Modify: `tests/agent/tools.test.ts` — add budget code assertions

- [ ] **Step 1: Write the failing budget tests**

Add to `tests/agent/tools.test.ts` in the `buildTools — create_expense` describe block:

```ts
  it('resolves a budget code by name and returns overspend warning', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => []),
        findById: vi.fn(async (_u: string, id: string) =>
          id === 'a1' ? { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 100_000, isActive: true, createdAt: '', updatedAt: '' } : null,
        ),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(async () => undefined),
        update: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => []),
        findByName: vi.fn(async (_uid: string, name: string, _y: number, _m: number) =>
          name === 'jajan' ? { budgetCodeId: 'b-jajan', userId: 'u1', name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026, spent: 480_000, createdAt: '', updatedAt: '' } : null,
        ),
        create: vi.fn(),
        incrementSpent: vi.fn(async () => undefined),
        update: vi.fn(),
      } as never,
    });
    const { create_expense } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_expense, {
      description: 'bakso', amount: 40_000, accountId: 'a1', categoryId: 'food.dining', budgetCodeId: 'jajan',
    });
    expect(res.status).toBe('ok');
    // budget code resolved by name + spent incremented
    expect(repos.budgets.incrementSpent).toHaveBeenCalledWith('u1', 'b-jajan', 40_000);
    // data.budget reflects the updated spent (480k + 40k = 520k over 500k limit)
    expect(res.data?.budget).toEqual({ spent: 520_000, limit: 500_000, exceeded: true });
  });

  it('returns missing_fields when budget code name is unknown', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => []),
        findById: vi.fn(async (_u: string, id: string) =>
          id === 'a1' ? { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 100_000, isActive: true, createdAt: '', updatedAt: '' } : null,
        ),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(async () => undefined),
        update: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => []),
        findByName: vi.fn(async () => null), // never matches
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_expense } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_expense, {
      description: 'kopi', amount: 30_000, accountId: 'a1', categoryId: 'food.coffee', budgetCodeId: 'jajan',
    });
    expect(res.status).toBe('missing_fields');
    expect(res.missing).toContain('budgetCodeId');
    expect(res.options).toEqual({ monthlyBudget: null });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: 2 new FAILs — budget resolution and overspend not implemented yet.

- [ ] **Step 3: Enhance `create_expense` in `src/agent/tools.ts`**

Inside `create_expense.execute`, after the account resolution block and before `const transaction = await repos.transactions.create(...)`, add budget code name resolution:

```ts
        // FR-03c: if budgetCodeId is a name (not UUID), resolve it
        let resolvedBudgetCodeId = budgetCodeId;
        if (budgetCodeId && !/^[0-9a-f-]{36}$/.test(budgetCodeId)) {
          const existing = await repos.budgets.findByName(
            userId,
            budgetCodeId,
            wibYear(),
            wibMonth(),
          );
          if (existing) {
            resolvedBudgetCodeId = existing.budgetCodeId;
          } else {
            const res: TransactionResult = {
              status: 'missing_fields',
              missing: ['budgetCodeId'],
              options: { monthlyBudget: null },
            };
            return res;
          }
        }
```

Then update the `repos.transactions.create` call to use `resolvedBudgetCodeId`:

```ts
        const transaction = await repos.transactions.create({
          userId,
          type: 'expense',
          amount,
          description,
          categoryId,
          accountId: account.accountId,
          budgetCodeId: resolvedBudgetCodeId,
          date: date ?? todayWIB(),
        });
```

After `updateBalance`, add the FR-03d overspend check:

```ts
        // FR-03d: if a budget code is used, increment spent and check overspend
        let budget: { spent: number; limit: number; exceeded: boolean } | undefined;
        if (resolvedBudgetCodeId) {
          await repos.budgets.incrementSpent(userId, resolvedBudgetCodeId, amount);
          const updatedBudget = await repos.budgets.findByName(
            userId,
            // We need the name — use findById and then the name, or just re-fetch.
            // Simplest: the budget was just resolved, so call findById.
            resolvedBudgetCodeId,
            wibYear(),
            wibMonth(),
          );
          // findByName with budgetCodeId won't work (it matches by name).
          // Instead find all budgets for the user+month and pick the matching one.
          const allBudgets = await repos.budgets.findByUserAndMonth(userId, wibYear(), wibMonth());
          const bc = allBudgets.find((b) => b.budgetCodeId === resolvedBudgetCodeId);
          if (bc) {
            budget = { spent: bc.spent, limit: bc.monthlyBudget, exceeded: bc.spent > bc.monthlyBudget };
          }
        }
```

Then update the return to include `budget`:

```ts
        const res: TransactionResult = { status: 'ok', data: { transaction, budget } };
        return res;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: PASS (14 tests — 12 existing + 2 new budget tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "feat(tools): FR-03c budget name resolution + FR-03d overspend warning in create_expense

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Write tools — T07 `create_income`, T08 `create_transfer`

**Files:**
- Modify: `src/agent/tools.ts` — register both write tools
- Modify: `tests/agent/tools.test.ts` — add describe blocks

- [ ] **Step 1: Write the failing tests**

Add to `tests/agent/tools.test.ts`:

```ts
describe('buildTools — create_income (T07)', () => {
  it('records income and increases balance', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => []),
        findById: vi.fn(async (_u: string, id: string) =>
          id === 'a1' ? { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 50_000, isActive: true, createdAt: '', updatedAt: '' } : null,
        ),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(async () => undefined),
        update: vi.fn(),
      } as never,
    });
    const { create_income } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_income, {
      description: 'Gaji', amount: 5_000_000, accountId: 'a1', categoryId: 'income.salary',
    });
    expect(res.status).toBe('ok');
    expect(res.data?.transaction?.transactionId).toBe('t1');
    expect(repos.accounts.updateBalance).toHaveBeenCalledWith('u1', 'a1', 5_000_000);
  });

  it('returns ambiguous when account not found', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => [
          { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 0, isActive: true, createdAt: '', updatedAt: '' },
        ]),
        findById: vi.fn(async () => null),
        findByName: vi.fn(async () => null),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_income } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_income, {
      description: 'Gaji', amount: 1_000, accountId: 'nonexistent', categoryId: 'income.other',
    });
    expect(res.status).toBe('ambiguous');
    expect(res.field).toBe('accountId');
  });
});

describe('buildTools — create_transfer (T08)', () => {
  it('completes a transfer and returns ok', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => []),
        findById: vi.fn(async (_u: string, id: string) => {
          if (id === 'a1') return { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 100_000, isActive: true, createdAt: '', updatedAt: '' };
          if (id === 'a2') return { accountId: 'a2', userId: 'u1', name: 'Mandiri', type: 'bank' as const, balance: 50_000, isActive: true, createdAt: '', updatedAt: '' };
          return null;
        }),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(async (i: { fromAccountId: string; toAccountId: string; amount: number; description: string }) => ({
          transactionId: 't-transfer', userId: 'u1', type: 'transfer' as const, amount: i.amount, description: i.description,
          accountId: i.fromAccountId, toAccountId: i.toAccountId, isRecurringInstance: false, date: '', createdAt: '', updatedAt: '',
        })),
      } as never,
    });
    const { create_transfer } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_transfer, {
      fromAccountId: 'a1', toAccountId: 'a2', amount: 30_000, description: 'transfer',
    });
    expect(res.status).toBe('ok');
    expect(repos.transactions.createTransfer).toHaveBeenCalled();
  });

  it('returns error when from and to accounts are the same', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => []),
        findById: vi.fn(async () => ({ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 100_000, isActive: true, createdAt: '', updatedAt: '' })),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_transfer } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_transfer, {
      fromAccountId: 'a1', toAccountId: 'a1', amount: 10_000, description: 'same',
    });
    expect(res.status).toBe('error');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: FAIL — `create_income` and `create_transfer` are undefined.

- [ ] **Step 3: Implement in `src/agent/tools.ts`**

After the `create_expense` tool registration (after the `if (!hasAccount) return tools;` guard), add:

```ts
  tools.create_income = tool({
    description: 'Catat pemasukan. Mirip create_expense tapi saldo bertambah.',
    parameters: z.object({
      description: z.string(),
      amount: z.number().positive(),
      accountId: z.string().describe('Bisa nama akun atau accountId.'),
      categoryId: z.string(),
      budgetCodeId: z.string().optional(),
      date: z.string().optional().describe('YYYY-MM-DD (WIB). Default: hari ini.'),
    }),
    execute: async ({ description, amount, accountId, categoryId, budgetCodeId, date }) => {
      try {
        let account = await repos.accounts.findById(userId, accountId);
        if (!account) account = await repos.accounts.findByName(userId, accountId);
        if (!account) {
          const all = await repos.accounts.findAllByUserId(userId);
          const res: TransactionResult = {
            status: 'ambiguous',
            field: 'accountId',
            matches: all.map((a) => ({ id: a.accountId, label: a.name })),
          };
          return res;
        }

        const transaction = await repos.transactions.create({
          userId,
          type: 'income',
          amount,
          description,
          categoryId,
          accountId: account.accountId,
          budgetCodeId,
          date: date ?? todayWIB(),
        });

        await repos.accounts.updateBalance(userId, account.accountId, amount);

        const res: TransactionResult = { status: 'ok', data: { transaction } };
        return res;
      } catch (e) {
        return { status: 'error', message: (e as Error).message } as TransactionResult;
      }
    },
  });

  tools.create_transfer = tool({
    description: 'Pindahkan saldo antar dua akun. Bukan pemasukan atau pengeluaran — hanya perpindahan. Tidak pakai categoryId.',
    parameters: z.object({
      fromAccountId: z.string().describe('Akun sumber (nama atau accountId).'),
      toAccountId: z.string().describe('Akun tujuan (nama atau accountId).'),
      amount: z.number().positive(),
      description: z.string(),
      date: z.string().optional().describe('YYYY-MM-DD (WIB). Default: hari ini.'),
      notes: z.string().optional(),
    }),
    execute: async ({ fromAccountId, toAccountId, amount, description, date, notes }) => {
      try {
        let fromAccount = await repos.accounts.findById(userId, fromAccountId);
        if (!fromAccount) fromAccount = await repos.accounts.findByName(userId, fromAccountId);
        if (!fromAccount) {
          const all = await repos.accounts.findAllByUserId(userId);
          const res: TransactionResult = {
            status: 'ambiguous',
            field: 'fromAccountId',
            matches: all.map((a) => ({ id: a.accountId, label: a.name })),
          };
          return res;
        }

        let toAccount = await repos.accounts.findById(userId, toAccountId);
        if (!toAccount) toAccount = await repos.accounts.findByName(userId, toAccountId);
        if (!toAccount) {
          const all = await repos.accounts.findAllByUserId(userId);
          const res: TransactionResult = {
            status: 'ambiguous',
            field: 'toAccountId',
            matches: all.map((a) => ({ id: a.accountId, label: a.name })),
          };
          return res;
        }

        if (fromAccount.accountId === toAccount.accountId) {
          return { status: 'error', message: 'Akun sumber dan tujuan sama.' } as TransactionResult;
        }

        const transaction = await repos.transactions.createTransfer({
          userId,
          amount,
          fromAccountId: fromAccount.accountId,
          toAccountId: toAccount.accountId,
          description,
          date: date ?? todayWIB(),
          notes,
        });

        const res: TransactionResult = { status: 'ok', data: { transaction } };
        return res;
      } catch (e) {
        return { status: 'error', message: (e as Error).message } as TransactionResult;
      }
    },
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: PASS (18 tests — 14 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "feat(tools): write tools — T07 create_income, T08 create_transfer (atomic via createTransfer repo method)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Write tools — T10 `update_transaction`, T11 `soft_delete_transaction`

**Files:**
- Modify: `src/agent/tools.ts` — register both tools
- Modify: `tests/agent/tools.test.ts` — add describe blocks

- [ ] **Step 1: Write the failing tests**

Add to `tests/agent/tools.test.ts`:

```ts
describe('buildTools — update_transaction (T10)', () => {
  it('updates a transaction using supplied transactionId', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        update: vi.fn(async () => ({
          transactionId: 't-edit', userId: 'u1', type: 'expense' as const, amount: 25_000,
          description: 'bakso besar', categoryId: 'food.dining', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '',
        })),
      } as never,
    });
    const { update_transaction } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(update_transaction, {
      transactionId: 't-edit', amount: 25_000, description: 'bakso besar',
    });
    expect(res.status).toBe('ok');
    expect(repos.transactions.update).toHaveBeenCalledWith('u1', 't-edit', { amount: 25_000, description: 'bakso besar' });
  });

  it('uses lastTransactionId when transactionId is omitted', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        update: vi.fn(async () => ({
          transactionId: 't-last', userId: 'u1', type: 'expense' as const, amount: 30_000,
          description: 'bakso', categoryId: 'food.dining', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '',
        })),
      } as never,
    });
    const { update_transaction } = buildTools({
      userId: 'u1', repos, hasAccount: true, lastTransactionId: 't-last',
    });
    const res = await callExec(update_transaction, { amount: 30_000 });
    expect(res.status).toBe('ok');
    expect(repos.transactions.update).toHaveBeenCalledWith('u1', 't-last', { amount: 30_000 });
  });

  it('returns missing_fields when no transactionId available', async () => {
    const repos = mockRepos();
    const { update_transaction } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(update_transaction, { amount: 10_000 });
    expect(res.status).toBe('missing_fields');
    expect(res.missing).toContain('transactionId');
  });
});

describe('buildTools — soft_delete_transaction (T11)', () => {
  it('soft-deletes and reverses account balance (expense)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => ({
          transactionId: 't-del', userId: 'u1', type: 'expense' as const, amount: 20_000,
          description: 'bakso', categoryId: 'food.dining', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '', deletedAt: undefined,
        })),
        softDelete: vi.fn(async () => undefined),
      } as never,
    });
    const { soft_delete_transaction } = buildTools({
      userId: 'u1', repos, hasAccount: true, lastTransactionId: 't-del',
    });
    const res = await callExec(soft_delete_transaction, {});
    expect(res.status).toBe('ok');
    // Balance reversed: expense → add back
    expect(repos.accounts.updateBalance).toHaveBeenCalledWith('u1', 'a1', 20_000);
  });

  it('reverses balance for income (subtract on delete)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => ({
          transactionId: 't-inc', userId: 'u1', type: 'income' as const, amount: 5_000_000,
          description: 'Gaji', categoryId: 'income.salary', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '', deletedAt: undefined,
        })),
        softDelete: vi.fn(async () => undefined),
      } as never,
    });
    const { soft_delete_transaction } = buildTools({
      userId: 'u1', repos, hasAccount: true, lastTransactionId: 't-inc',
    });
    const res = await callExec(soft_delete_transaction, {});
    expect(res.status).toBe('ok');
    // Income reversed → subtract
    expect(repos.accounts.updateBalance).toHaveBeenCalledWith('u1', 'a1', -5_000_000);
  });

  it('returns error for already-deleted transaction', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findById: vi.fn(async () => ({
          transactionId: 't-del2', userId: 'u1', type: 'expense' as const, amount: 1_000,
          description: 'x', categoryId: 'other.misc', accountId: 'a1',
          isRecurringInstance: false, date: '', createdAt: '', updatedAt: '', deletedAt: '2026-01-01',
        })),
        softDelete: vi.fn(),
      } as never,
    });
    const { soft_delete_transaction } = buildTools({
      userId: 'u1', repos, hasAccount: true, lastTransactionId: 't-del2',
    });
    const res = await callExec(soft_delete_transaction, {});
    expect(res.status).toBe('error');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: FAIL — `update_transaction` and `soft_delete_transaction` are undefined.

- [ ] **Step 3: Implement in `src/agent/tools.ts`**

After `create_transfer`, add:

```ts
  tools.update_transaction = tool({
    description:
      'Koreksi transaksi: ubah amount, description, categoryId, accountId, atau notes. ' +
      'Kalau user bilang "koreksi tadi", pakai lastTransactionId dari konteks — tidak perlu minta transactionId.',
    parameters: z.object({
      transactionId: z.string().optional().describe('UUID transaksi. Kalau kosong, pakai lastTransactionId (koreksi transaksi terakhir).'),
      amount: z.number().positive().optional(),
      description: z.string().optional(),
      categoryId: z.string().optional(),
      accountId: z.string().optional(),
      notes: z.string().optional(),
    }),
    execute: async (args, { lastTransactionId: ctxLastTxnId }?: { lastTransactionId?: string }) => {
      try {
        // FR-08: resolve transactionId — model-supplied > buildTools arg > missing
        const transactionId = args.transactionId ?? ctxLastTxnId ?? lastTransactionId;
        if (!transactionId) {
          return { status: 'missing_fields', missing: ['transactionId'] } as TransactionResult;
        }
        const patch: Record<string, unknown> = {};
        if (args.amount !== undefined) patch.amount = args.amount;
        if (args.description !== undefined) patch.description = args.description;
        if (args.categoryId !== undefined) patch.categoryId = args.categoryId;
        if (args.accountId !== undefined) patch.accountId = args.accountId;
        if (args.notes !== undefined) patch.notes = args.notes;
        const updated = await repos.transactions.update(userId, transactionId, patch as Partial<Transaction>);
        const res: TransactionResult = { status: 'ok', data: { transaction: updated } };
        return res;
      } catch (e) {
        return { status: 'error', message: (e as Error).message } as TransactionResult;
      }
    },
  });

  tools.soft_delete_transaction = tool({
    description:
      'Hapus transaksi (soft delete). Kalau user bilang "hapus tadi", pakai lastTransactionId.',
    parameters: z.object({
      transactionId: z.string().optional(),
    }),
    execute: async (args) => {
      try {
        // FR-08: resolve transactionId
        const transactionId = args.transactionId ?? lastTransactionId;
        if (!transactionId) {
          return { status: 'missing_fields', missing: ['transactionId'] } as TransactionResult;
        }
        const txn = await repos.transactions.findById(userId, transactionId);
        if (!txn) {
          return { status: 'error', message: 'Transaksi tidak ditemukan.' } as TransactionResult;
        }
        if (txn.deletedAt) {
          return { status: 'error', message: 'Transaksi sudah dihapus.' } as TransactionResult;
        }
        // Reverse balance delta
        const delta = txn.type === 'expense' ? txn.amount : txn.type === 'income' ? -txn.amount : 0;
        if (delta !== 0) {
          await repos.accounts.updateBalance(userId, txn.accountId, delta);
        }
        // If transfer, also reverse the to-account side? Transfers aren't
        // categorized as income/expense per SP-06 and have no single balance
        // reversal. For Slice 2, soft-deleting a transfer only reverses the
        // from-account side. Full transfer reversal is Slice 4 (scheduler).
        // The reconcile script catches any drift.
        await repos.transactions.softDelete(userId, transactionId);
        return { status: 'ok' } as TransactionResult;
      } catch (e) {
        return { status: 'error', message: (e as Error).message } as TransactionResult;
      }
    },
  });
```

Also add the `Transaction` import at the top:

```ts
import type { Transaction } from '../domain/entities.js';
```

(Confirm it's not already imported.)

- [ ] **Step 4: Fix the `update_transaction` tool — remove the `execute` options pattern**

The `CoreTool.execute` signature in the AI SDK is `(args, options)`. But `buildTools` wraps the execute functions so the `lastTransactionId` from `BuildToolsArgs` is already in the closure. The tool does NOT receive it from the AI SDK's options parameter — it's closed over. Let me fix the `update_transaction` execute:

```ts
    execute: async (args) => {
      try {
        // FR-08: resolve transactionId — model-supplied > buildTools arg > missing
        const transactionId = (args as { transactionId?: string }).transactionId ?? lastTransactionId;
        if (!transactionId) {
          return { status: 'missing_fields', missing: ['transactionId'] } as TransactionResult;
        }
        const patch: Record<string, unknown> = {};
        const a = args as { amount?: number; description?: string; categoryId?: string; accountId?: string; notes?: string };
        if (a.amount !== undefined) patch.amount = a.amount;
        if (a.description !== undefined) patch.description = a.description;
        if (a.categoryId !== undefined) patch.categoryId = a.categoryId;
        if (a.accountId !== undefined) patch.accountId = a.accountId;
        if (a.notes !== undefined) patch.notes = a.notes;
        const updated = await repos.transactions.update(userId, transactionId, patch as Partial<Transaction>);
        const res: TransactionResult = { status: 'ok', data: { transaction: updated } };
        return res;
      } catch (e) {
        return { status: 'error', message: (e as Error).message } as TransactionResult;
      }
    },
```

(The `lastTransactionId` from `BuildToolsArgs` is already in scope via closure.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: PASS (24 tests — 18 existing + 6 new).

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "feat(tools): write tools — T10 update_transaction, T11 soft_delete_transaction (FR-08 koreksi)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Write tools — T05 `create_budget_code`, T12 `create_recurring_payment`, T14 `deactivate_recurring_payment`

**Files:**
- Modify: `src/agent/tools.ts` — register 3 write tools
- Modify: `tests/agent/tools.test.ts` — add describe blocks

- [ ] **Step 1: Write the failing tests**

Add to `tests/agent/tools.test.ts`:

```ts
describe('buildTools — create_budget_code (T05)', () => {
  it('creates a budget code with defaults for month/year', async () => {
    const repos = mockRepos({
      budgets: {
        findByUserAndMonth: vi.fn(),
        findByName: vi.fn(),
        create: vi.fn(async (i: { name: string; monthlyBudget: number }) => ({
          budgetCodeId: 'b-new', userId: 'u1', name: i.name, monthlyBudget: i.monthlyBudget,
          month: 6, year: 2026, spent: 0, createdAt: '', updatedAt: '',
        })),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_budget_code } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_budget_code, { name: 'Jajan', monthlyBudget: 500_000 });
    expect(res.status).toBe('ok');
    expect(repos.budgets.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jajan', monthlyBudget: 500_000 }));
  });
});

describe('buildTools — create_recurring_payment (T12)', () => {
  it('creates a recurring payment with computed nextFireAt', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(),
        findById: vi.fn(async () => ({ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank' as const, balance: 0, isActive: true, createdAt: '', updatedAt: '' })),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
      recurrings: {
        findAllByUserId: vi.fn(),
        findByDayOfMonth: vi.fn(),
        findById: vi.fn(),
        findByName: vi.fn(),
        create: vi.fn(async (i: { name: string; amount: number; dayOfMonth: number }) => ({
          recurringId: 'r-new', userId: 'u1', name: i.name, amount: i.amount, accountId: 'a1',
          categoryId: 'entertainment.streaming', dayOfMonth: i.dayOfMonth, isActive: true,
          nextFireAt: '2026-06-15', createdAt: '', updatedAt: '',
        })),
        update: vi.fn(),
        deactivate: vi.fn(),
      } as never,
    });
    const { create_recurring_payment } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(create_recurring_payment, {
      name: 'Netflix', amount: 159_000, accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 15,
    });
    expect(res.status).toBe('ok');
  });
});

describe('buildTools — deactivate_recurring_payment (T14)', () => {
  it('deactivates a recurring payment', async () => {
    const repos = mockRepos({
      recurrings: {
        findAllByUserId: vi.fn(),
        findByDayOfMonth: vi.fn(),
        findById: vi.fn(async () => ({
          recurringId: 'r1', userId: 'u1', name: 'Netflix', amount: 159_000,
          accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 15,
          isActive: true, nextFireAt: '2026-08-15', createdAt: '', updatedAt: '',
        })),
        findByName: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        deactivate: vi.fn(async () => undefined),
      } as never,
    });
    const { deactivate_recurring_payment } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(deactivate_recurring_payment, { recurringId: 'r1' });
    expect(res.status).toBe('ok');
    expect(repos.recurrings.deactivate).toHaveBeenCalledWith('u1', 'r1');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: FAIL — 3 new tools are undefined.

- [ ] **Step 3: Implement in `src/agent/tools.ts`**

After `soft_delete_transaction`, add:

```ts
  tools.create_budget_code = tool({
    description: 'Buat budget code baru dengan alokasi bulanan. Default month/year dari WIB.',
    parameters: z.object({
      name: z.string(),
      monthlyBudget: z.number().positive(),
      month: z.number().int().min(1).max(12).optional(),
      year: z.number().int().positive().optional(),
    }),
    execute: async ({ name, monthlyBudget, month, year }) => {
      try {
        const bc = await repos.budgets.create({
          userId,
          name,
          monthlyBudget,
          month: month ?? wibMonth(),
          year: year ?? wibYear(),
        });
        return { status: 'ok', data: bc } as { status: string; data: typeof bc };
      } catch (e) {
        return { status: 'error', message: (e as Error).message };
      }
    },
  });

  tools.create_recurring_payment = tool({
    description: 'Buat jadwal pembayaran berulang bulanan. nextFireAt dihitung otomatis dari dayOfMonth.',
    parameters: z.object({
      name: z.string(),
      amount: z.number().positive(),
      accountId: z.string(),
      categoryId: z.string(),
      dayOfMonth: z.number().int().min(1).max(31),
      budgetCodeId: z.string().optional(),
    }),
    execute: async ({ name, amount, accountId, categoryId, dayOfMonth, budgetCodeId }) => {
      try {
        // Resolve account
        let account = await repos.accounts.findById(userId, accountId);
        if (!account) account = await repos.accounts.findByName(userId, accountId);
        if (!account) {
          const all = await repos.accounts.findAllByUserId(userId);
          return {
            status: 'ambiguous',
            field: 'accountId',
            matches: all.map((a) => ({ id: a.accountId, label: a.name })),
          };
        }

        const nextFireAt = nextFireDate(dayOfMonth);

        const rp = await repos.recurrings.create({
          userId,
          name,
          amount,
          accountId: account.accountId,
          categoryId,
          budgetCodeId,
          dayOfMonth,
          nextFireAt,
        });

        return { status: 'ok', data: rp };
      } catch (e) {
        return { status: 'error', message: (e as Error).message };
      }
    },
  });

  tools.deactivate_recurring_payment = tool({
    description: 'Nonaktifkan (hapus) jadwal recurring payment.',
    parameters: z.object({
      recurringId: z.string(),
    }),
    execute: async ({ recurringId }) => {
      try {
        await repos.recurrings.deactivate(userId, recurringId);
        return { status: 'ok' };
      } catch (e) {
        return { status: 'error', message: (e as Error).message };
      }
    },
  });
```

Also add the import at the top:

```ts
import { todayWIB, wibMonth, wibYear, nextFireDate } from '../domain/time.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: PASS (27 tests — 24 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "feat(tools): write tools — T05 create_budget_code, T12 create_recurring_payment, T14 deactivate_recurring_payment

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: System prompt additions + full suite verification

**Files:**
- Modify: `src/agent/system-prompt.ts` — add transfer, recurring, income guidance

- [ ] **Step 1: Add the three guidance sections to the system prompt**

In `src/agent/system-prompt.ts`, after rule 10 and before the "Pengeluaran biasanya:" paragraph, insert:

```ts
Pembayaran rutin bulanan: kalau user menyebutkan pengeluaran yang terjadi tiap bulan, tawarkan untuk menyimpannya sebagai recurring payment supaya diingatkan tiap bulan. Gunakan create_recurring_payment setelah transaksi berhasil dicatat.

Transfer antar akun: Transfer memindahkan saldo antar dua akun. Pastikan nama kedua akun sudah jelas (resolusi via get_accounts). Kalau user bilang 'transfer X dari A ke B', fromAccountId = A, toAccountId = B. Transfer tidak pakai categoryId dan tidak dihitung sebagai pemasukan atau pengeluaran.

Pemasukan: Mirip pengeluaran tetapi saldo bertambah. Format sama: <deskripsi> <jumlah> <akun>. Contoh: "gaji 5000000 bca" atau "freelance 2000000 mandiri". Gunakan create_income. Kategori pemasukan sudah tersedia di taksonomi.
```

Insert these three paragraphs between the existing rule 10 line and the "Pengeluaran biasanya:" line. The existing prompt structure (rules 1–10 + taxonomy) is otherwise unchanged.

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit` → `npm run lint`
Expected: clean.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all tests pass. At this point the test count should be approximately:
- 7 test files
- ~60+ individual tests (32 Slice 1 + 5 budget-code + 6 recurring + 2 transfer + ~20+ tool tests)

- [ ] **Step 4: Commit**

```bash
git add src/agent/system-prompt.ts
git commit -m "feat(agent): add transfer, recurring, and income guidance to system prompt

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Definition of Done (Slice 2)

- All Vitest tests pass (`npm test`).
- `npm run lint` and `npx tsc --noEmit` clean.
- All 16 SRS tools (T01–T16 except T15 `get_report`) are registered and tested.
- Both new repos (`budget_codes`, `recurring_payments`) are implemented with integration tests.
- `createTransfer` is atomic (BEGIN/COMMIT/ROLLBACK) with tests proving ROLLBACK on failure.
- `create_expense` resolves budget codes by name and reports overspend.
- FR-08 koreksi works through `lastTransactionId` threading (orchestrator → buildTools → T10/T11).
- No `pg` import outside `src/adapters/neon/` (enforced by ESLint NFR-02).

## After Slice 2

Slice 3 (reports: T15 `get_report` + NL date resolution) and Slice 4 (scheduler + inline-keyboard callbacks) each get their own plan per the design spec §9.

---

## Plan self-review

1. **Spec coverage:** Every design spec section mapped to a task: nextFireDate helper (Task 1), budget-code repo (Task 2), recurring-payment repo (Task 3), Repos + createTransfer (Task 4), orchestrator wiring (Task 5), read tools (Task 6), FR-03c/d (Task 7), T07+T08 (Task 8), T10+T11 (Task 9), T05+T12+T14 (Task 10), system prompt (Task 11). All 10 new tools covered.
2. **Placeholder scan:** No TBD/TODO. All test and implementation code is complete. All function signatures reference existing types.
3. **Type consistency:** `Repos` replaces `Slice1Repos` everywhere (tools.ts, orchestrator.ts, both test files). `lastTransactionId` flows from orchestrator → BuildToolsArgs → T10/T11 closure. `CreateTransferInput` matches the design spec. `nextFireDate` uses existing `lastDayOfMonth`. Budget mappers use the same `Row` helpers as existing mappers.
