# Card Billing & Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add credit-card billing cycles (billing date, due date), proactive due prompts, and a single atomic `pay_card_bill` action, with a `card_statements` table whose figures are derived live from the transaction ledger.

**Architecture:** Card accounts gain `billing_day` + `due_in_days`. A new `card_statements` table stores only cycle identity; all figures (charges, FIFO-allocated payments, remaining due, status, paid-at, due date) are computed on read. A daily sweep (existing `00:05 WIB` cron + boot) ensures statement rows exist for ended cycles. `pay_card_bill` is a guarded transfer (source→card) reusing the atomic `createTransfer` txn — no separate "mark paid" write. Morning glance surfaces due/overdue statements as a deterministic block.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `pg` Pool on Neon Postgres, Vitest (real-Postgres integration for repos), grammY, Vercel AI SDK.

## Global Constraints

- **NFR-02:** `pg` / db drivers imported ONLY inside `src/adapters/neon/` (ESLint `no-restricted-imports`). Tools import from `repositories/interfaces.ts`, never an adapter.
- **Write tools never throw** — they return a discriminated `WriteResult` (`ok | missing_fields | ambiguous | error`) so the ReAct loop always continues.
- **TypeScript:** relative imports use `.js` extensions; type-only imports use `import type`. `noUncheckedIndexedAccess` is on (array access is `T | undefined`).
- **Dates:** all billing logic is WIB. Reuse `todayWIB`, `addDays`, `lastDayOfMonth` from `src/domain/time.ts`. Date strings are `'YYYY-MM-DD'`; lexicographic compare equals chronological compare.
- **Tests:** real Postgres (Neon dev); isolate with `uniqueChatId()` (no auto-truncate). Verify each task with `npx tsc --noEmit` AND `npm run lint` AND the relevant `npx vitest run` — Vitest strips types, so tsc is mandatory.
- **Derived-figure model:** under pure FIFO, a statement's "amount due at cut" is simply its `newCharges`; payments are allocated FIFO across statements. So the derived set is `{ newCharges, amountPaid, remainingDue, status, dueDate, paidAt, overdue }` (no stored `openingBalance`/`closingBalance`/`statementBalance`).

## File Structure

**New:**
- `migrations/006_card_billing.sql` — accounts ALTER + `card_statements` table.
- `src/adapters/neon/card-statement.repository.ts` — `NeonCardStatementRepository` (sweep ensure + derived-figure reads).
- `src/scheduler/card-statements.ts` — `sweepCardStatements(repos, now)`.
- `tests/adapters/card-statement.repository.test.ts` — integration.
- `tests/scheduler/card-statements.test.ts` — sweep, mocked repos.
- `tests/agent/tools-card.test.ts` — `pay_card_bill`, `get_card_statements`, `update_account`, `get_accounts` enrichment.
- `tests/domain/time-billing.test.ts` — billing-cut helpers.

**Modified:**
- `src/domain/entities.ts` — `Account.billingDay/dueInDays`; `CardStatement`, `CardStatementWithFigures`, `CardStatementStatus`.
- `src/domain/time.ts` — `billingCut`, `lastBillingCutOnOrBefore`, `previousBillingCut`.
- `src/repositories/interfaces.ts` — `CreateAccountInput`, `ICardStatementRepository`, `Repos.cardStatements`.
- `src/adapters/neon/account.repository.ts` — `create`/`update` for the new columns.
- `src/adapters/neon/mappers.ts` — `mapAccount`, `mapCardStatement`.
- `src/adapters/neon/repos.ts` — instantiate `cardStatements`.
- `src/agent/tools.ts` — `pay_card_bill` (+ `payCardBillCore`), `get_card_statements`, `update_account`; enrich `get_accounts`; pass `billingDay/dueInDays` in `create_account`.
- `src/agent/system-prompt.ts` — card-billing rules.
- `src/scheduler/cron.ts` — call `sweepCardStatements` in the daily cron block.
- `src/index.ts` — boot reconcile for card statements.
- `src/proactive/triggers/morning-glance.ts` — `cardDue` slice.
- `src/proactive/composers/template.ts` — `renderCardBills` + wire into `renderMorningGlanceBlock`.
- `tests/helpers/db.ts` — add `card_statements` to `USER_TABLES`.
- `tests/agent/system-prompt.test.ts`, `tests/proactive/triggers/morning-glance.test.ts`, `tests/proactive/composers/template.test.ts` — updated.

---

## Task 1: Schema + account billing fields

**Files:**
- Create: `migrations/006_card_billing.sql`
- Modify: `src/domain/entities.ts` (Account fields only here), `src/repositories/interfaces.ts` (`CreateAccountInput`), `src/adapters/neon/mappers.ts` (`mapAccount`), `src/adapters/neon/account.repository.ts` (`create`, `update`), `tests/helpers/db.ts` (`USER_TABLES`), `tests/adapters/account.repository.test.ts`

**Interfaces:**
- Produces: `Account` gains `billingDay?: number` and `dueInDays?: number`; `CreateAccountInput` gains `billingDay?: number` and `dueInDays?: number`; `mapAccount` populates them; `accounts.create/update` persist them.

- [ ] **Step 1: Write the migration**

`migrations/006_card_billing.sql`:
```sql
-- Card billing cycle fields on accounts.
ALTER TABLE accounts
  ADD COLUMN billing_day SMALLINT,
  ADD COLUMN due_in_days  SMALLINT NOT NULL DEFAULT 15,
  ADD CONSTRAINT accounts_billing_day_range
    CHECK (billing_day IS NULL OR billing_day BETWEEN 1 AND 31);

-- Billing metadata: one row per card per ended billing cycle. All financial
-- figures and the due date are DERIVED on read (see getWithFigures), so this
-- table holds only cycle identity.
CREATE TABLE card_statements (
  statement_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(user_id),
  account_id    UUID        NOT NULL REFERENCES accounts(account_id),
  cycle_start   DATE        NOT NULL,
  cycle_end     DATE        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, cycle_end)
);
CREATE INDEX idx_card_statements_user_account ON card_statements(user_id, account_id, cycle_end);
```

- [ ] **Step 2: Add the failing test**

Append to `tests/adapters/account.repository.test.ts` (inside the existing `describe`):
```ts
it('persists billing_day and due_in_days on a card and defaults due_in_days to 15', async () => {
  const user = await seedUser();
  const accounts = new NeonAccountRepository();
  const card = await accounts.create({
    userId: user.userId, name: 'BCA CC', type: 'card',
    creditLimit: 5_000_000, billingDay: 5,
  });
  expect(card.billingDay).toBe(5);
  expect(card.dueInDays).toBe(15);

  const plain = await accounts.create({
    userId: user.userId, name: 'Cash', type: 'cash',
  });
  expect(plain.billingDay).toBeUndefined();
  expect(plain.dueInDays).toBe(15);
});

it('update patches billing_day and due_in_days', async () => {
  const user = await seedUser();
  const accounts = new NeonAccountRepository();
  const card = await accounts.create({
    userId: user.userId, name: 'B CC', type: 'card', creditLimit: 1_000_000,
  });
  const updated = await accounts.update(user.userId, card.accountId, { billingDay: 20, dueInDays: 10 });
  expect(updated.billingDay).toBe(20);
  expect(updated.dueInDays).toBe(10);
});
```
If `seedUser`/`NeonAccountRepository` are not already imported at the top of this file, add them following the pattern in `tests/adapters/budget-code.repository.test.ts`:
```ts
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { uniqueChatId } from '../helpers/db.js';
async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/account.repository.test.ts`
Expected: FAIL — `billingDay`/`dueInDays` are `undefined` (columns/entity/mapper not wired), and `accounts.create` does not yet accept `billingDay`.

- [ ] **Step 4: Extend the `Account` entity**

In `src/domain/entities.ts`, add to the `Account` interface (after `creditLimit?`):
```ts
  billingDay?: number;  // 1–31, statement cut day; only meaningful for cards
  dueInDays?: number;   // grace period; default 15
```

- [ ] **Step 5: Extend `CreateAccountInput`**

In `src/repositories/interfaces.ts`, add to `CreateAccountInput` (after `creditLimit?`):
```ts
  billingDay?: number;
  dueInDays?: number;
```

- [ ] **Step 6: Update `mapAccount`**

In `src/adapters/neon/mappers.ts`, add inside the returned object of `mapAccount` (after `creditLimit: maybeNum(r, 'credit_limit'),`):
```ts
    billingDay: maybeNum(r, 'billing_day'),
    dueInDays: maybeNum(r, 'due_in_days') ?? 15,
```

- [ ] **Step 7: Update `account.repository.ts` `create`**

In `src/adapters/neon/account.repository.ts`, replace the `create` method body:
```ts
  async create(input: CreateAccountInput): Promise<Account> {
    const { rows } = await pool.query(
      `INSERT INTO accounts (user_id, name, type, balance, credit_limit, billing_day, due_in_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.userId,
        input.name,
        input.type,
        input.openingBalance ?? 0,
        input.creditLimit ?? null,
        input.billingDay ?? null,
        input.dueInDays ?? 15,
      ],
    );
    return mapAccount(rows[0] as Record<string, unknown>);
  }
```

- [ ] **Step 8: Update `account.repository.ts` `update`**

Replace the `update` method body:
```ts
  async update(userId: string, accountId: string, patch: Partial<Account>): Promise<Account> {
    const { rows } = await pool.query(
      `UPDATE accounts
       SET name = COALESCE($3, name),
           is_active = COALESCE($4, is_active),
           billing_day = COALESCE($5, billing_day),
           due_in_days = COALESCE($6, due_in_days),
           updated_at = NOW()
       WHERE user_id = $1 AND account_id = $2
       RETURNING *`,
      [
        userId, accountId,
        patch.name ?? null, patch.isActive ?? null,
        patch.billingDay ?? null, patch.dueInDays ?? null,
      ],
    );
    return mapAccount(rows[0] as Record<string, unknown>);
  }
```

- [ ] **Step 9: Add `card_statements` to the test truncate list**

In `tests/helpers/db.ts`, insert `'card_statements'` at the top of `USER_TABLES` (before `'session_contexts'`):
```ts
const USER_TABLES = [
  'card_statements',
  'session_contexts',
  'transactions',
  'budget_codes',
  'recurring_payments',
  'user_preferences',
  'accounts',
  'users',
];
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/account.repository.test.ts`
Expected: PASS (the global-setup `migrate()` applies `006_card_billing.sql`; the two new tests pass).

- [ ] **Step 11: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add migrations/006_card_billing.sql src/domain/entities.ts src/repositories/interfaces.ts src/adapters/neon/mappers.ts src/adapters/neon/account.repository.ts tests/helpers/db.ts tests/adapters/account.repository.test.ts
git commit -m "feat: add card billing_day/due_in_days + card_statements table"
```

---

## Task 2: Billing-cycle time helpers

**Files:**
- Modify: `src/domain/time.ts`
- Test: `tests/domain/time-billing.test.ts`

**Interfaces:**
- Produces: `billingCut(billingDay, year, month): string`, `lastBillingCutOnOrBefore(billingDay, today): string`, `previousBillingCut(billingDay, cut): string` — all pure, `'YYYY-MM-DD'` in/out.

- [ ] **Step 1: Write the failing test**

`tests/domain/time-billing.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { billingCut, lastBillingCutOnOrBefore, previousBillingCut } from '../../src/domain/time.js';

describe('billingCut', () => {
  it('returns the billing day clamped to the month length (day-31 in Feb)', () => {
    expect(billingCut(5, 2026, 7)).toBe('2026-07-05');
    expect(billingCut(31, 2026, 2)).toBe('2026-02-28');
    expect(billingCut(31, 2024, 2)).toBe('2024-02-29'); // leap year
  });
});

describe('lastBillingCutOnOrBefore', () => {
  it('returns this month cut when on/before today, else previous month', () => {
    expect(lastBillingCutOnOrBefore(5, '2026-07-20')).toBe('2026-07-05');
    expect(lastBillingCutOnOrBefore(5, '2026-07-05')).toBe('2026-07-05');
    expect(lastBillingCutOnOrBefore(5, '2026-07-04')).toBe('2026-06-05');
  });
  it('wraps the year in January', () => {
    expect(lastBillingCutOnOrBefore(5, '2026-01-03')).toBe('2025-12-05');
  });
  it('clamps day-31 in a short month', () => {
    expect(lastBillingCutOnOrBefore(31, '2026-02-15')).toBe('2026-01-31');
  });
});

describe('previousBillingCut', () => {
  it('returns the prior month cut', () => {
    expect(previousBillingCut(5, '2026-07-05')).toBe('2026-06-05');
    expect(previousBillingCut(31, '2026-03-31')).toBe('2026-02-28');
  });
  it('wraps the year in January', () => {
    expect(previousBillingCut(5, '2026-01-05')).toBe('2025-12-05');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/domain/time-billing.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

Append to `src/domain/time.ts`:
```ts
/** The billing cut date for a given (year, month): day-31 → last day of month. */
export function billingCut(billingDay: number, year: number, month: number): string {
  const d = Math.min(billingDay, lastDayOfMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Most recent billing cut on or before `today` ('YYYY-MM-DD'). */
export function lastBillingCutOnOrBefore(billingDay: number, today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const thisCut = billingCut(billingDay, y, m);
  if (thisCut <= today) return thisCut;
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return billingCut(billingDay, py, pm);
}

/** The billing cut in the month before the given `cut` ('YYYY-MM-DD'). */
export function previousBillingCut(billingDay: number, cut: string): string {
  const y = Number(cut.slice(0, 4));
  const m = Number(cut.slice(5, 7));
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return billingCut(billingDay, py, pm);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/domain/time-billing.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check + lint + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/domain/time.ts tests/domain/time-billing.test.ts
git commit -m "feat: add billing-cut time helpers"
```

---

## Task 3: CardStatement types, interface, Repos wiring, `ensureEndedCycles`

**Files:**
- Modify: `src/domain/entities.ts`, `src/repositories/interfaces.ts`, `src/adapters/neon/mappers.ts`, `src/adapters/neon/repos.ts`
- Create: `src/adapters/neon/card-statement.repository.ts`
- Test: `tests/adapters/card-statement.repository.test.ts`

**Interfaces:**
- Consumes: `billingCut`, `lastBillingCutOnOrBefore`, `previousBillingCut`, `todayWIB` (from `domain/time.ts`); `pool` (from `./pool.js`).
- Produces: `CardStatement`, `CardStatementWithFigures`, `CardStatementStatus` (entities); `ICardStatementRepository` with `ensureEndedCycles(userId, accountId, billingDay, cardCreatedAt, asOf): Promise<number>` (later tasks add `getWithFigures`); `Repos.cardStatements`; `mapCardStatement`; `NeonCardStatementRepository`.

- [ ] **Step 1: Add entity types**

In `src/domain/entities.ts`, append:
```ts
export type CardStatementStatus = 'open' | 'partially_paid' | 'paid';

export interface CardStatement {
  statementId: string;
  userId: string;
  accountId: string;
  cycleStart: string;  // 'YYYY-MM-DD'
  cycleEnd: string;    // the billing date (cut)
  createdAt: string;
  updatedAt: string;
}

/**
 * CardStatement + figures derived on read (never stored). Under pure FIFO,
 * amount-due-at-cut == newCharges; payments are allocated FIFO across statements.
 */
export interface CardStatementWithFigures extends CardStatement {
  newCharges: number;     // Σ expenses in (cycleStart, cycleEnd]
  amountPaid: number;     // FIFO-allocated payments
  remainingDue: number;   // max(0, newCharges - amountPaid)
  status: CardStatementStatus;
  dueDate: string;        // addDays(cycleEnd, account.dueInDays)
  paidAt?: string;        // timestamp of the payment that settled it
  overdue: boolean;       // dueDate < today(WIB) AND remainingDue > 0
}
```

- [ ] **Step 2: Add the interface + Repos field**

In `src/repositories/interfaces.ts`, append the interface and add `cardStatements` to `Repos` (no entity import needed yet — `ensureEndedCycles` returns `number`; Task 4 imports `CardStatementWithFigures` when it adds `getWithFigures`):
```ts
export interface ICardStatementRepository {
  /**
   * Insert statement rows for every ended billing cycle (from the card's
   * creation up through the most recent cut on/before `asOf`) that has no row
   * yet. Idempotent via UNIQUE(account_id, cycle_end). Skips cycles whose
   * cycle_end predates the card's creation. Returns the number of rows inserted.
   */
  ensureEndedCycles(
    userId: string,
    accountId: string,
    billingDay: number,
    cardCreatedAt: string,
    asOf: Date,
  ): Promise<number>;
  // getWithFigures(...) is added to this interface in Task 4.
}
```
Add to the `Repos` interface (after `recurrings`):
```ts
  cardStatements: ICardStatementRepository;
```

- [ ] **Step 3: Add the mapper**

In `src/adapters/neon/mappers.ts`, add `CardStatement` to the entity import and append:
```ts
export function mapCardStatement(r: Row): CardStatement {
  return {
    statementId: str(r, 'statement_id'),
    userId: str(r, 'user_id'),
    accountId: str(r, 'account_id'),
    cycleStart: str(r, 'cycle_start'),
    cycleEnd: str(r, 'cycle_end'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  };
}
```

- [ ] **Step 4: Write the failing test for `ensureEndedCycles`**

`tests/adapters/card-statement.repository.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
import { NeonCardStatementRepository } from '../../src/adapters/neon/card-statement.repository.js';
import { uniqueChatId, pool } from '../helpers/db.js';
import type { Account } from '../../src/domain/entities.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
}

/** Create a card and pin its created_at so cycle math is deterministic (the card's
 *  live created_at is ~now, which would otherwise make lastCut < created → 0 inserts). */
async function createCard(userId: string, opts: { billingDay: number; createdAt: string }): Promise<Account> {
  const accounts = new NeonAccountRepository();
  const card = await accounts.create({
    userId, name: 'CC', type: 'card', creditLimit: 5_000_000, billingDay: opts.billingDay,
  });
  await pool.query('UPDATE accounts SET created_at = $1 WHERE account_id = $2', [opts.createdAt, card.accountId]);
  return card;
}

describe('NeonCardStatementRepository.ensureEndedCycles', () => {
  it('creates a row for the cycle ending on the most recent cut, with cycle_start = previous cut', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 5, createdAt: '2026-06-10' });
    const repo = new NeonCardStatementRepository();
    // asOf 2026-07-20 → last cut 2026-07-05; cycle_start 2026-06-05
    const created = await repo.ensureEndedCycles(
      user.userId, card.accountId, 5, '2026-06-10', new Date('2026-07-20T03:00:00Z'),
    );
    expect(created).toBe(1);
    const { rows } = await pool.query(
      'SELECT cycle_start, cycle_end FROM card_statements WHERE account_id = $1', [card.accountId],
    );
    expect(rows[0]!.cycle_start).toBe('2026-06-05');
    expect(rows[0]!.cycle_end).toBe('2026-07-05');
  });

  it('is idempotent (second call inserts nothing)', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 5, createdAt: '2026-06-10' });
    const repo = new NeonCardStatementRepository();
    const asOf = new Date('2026-07-20T03:00:00Z');
    await repo.ensureEndedCycles(user.userId, card.accountId, 5, '2026-06-10', asOf);
    const second = await repo.ensureEndedCycles(user.userId, card.accountId, 5, '2026-06-10', asOf);
    expect(second).toBe(0);
  });

  it('returns 0 when the most recent cut predates the card creation', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 5, createdAt: '2026-07-10' });
    const repo = new NeonCardStatementRepository();
    // asOf 2026-07-20 → last cut 2026-07-05 < created 2026-07-10 → nothing to freeze yet.
    const created = await repo.ensureEndedCycles(
      user.userId, card.accountId, 5, '2026-07-10', new Date('2026-07-20T03:00:00Z'),
    );
    expect(created).toBe(0);
    const { rows } = await pool.query(
      'SELECT cycle_end FROM card_statements WHERE account_id = $1', [card.accountId],
    );
    expect(rows).toHaveLength(0);
  });

  it('self-heals multi-month gaps (inserts each missed cycle up to the last cut)', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 5, createdAt: '2026-04-10' });
    const repo = new NeonCardStatementRepository();
    // First run to 2026-05-20 → last cut 2026-05-05 (one row: cycle 2026-04-05..2026-05-05).
    await repo.ensureEndedCycles(user.userId, card.accountId, 5, '2026-04-10', new Date('2026-05-20T03:00:00Z'));
    // Second run to 2026-07-20 → must backfill cuts 2026-06-05 and 2026-07-05.
    const created = await repo.ensureEndedCycles(user.userId, card.accountId, 5, '2026-04-10', new Date('2026-07-20T03:00:00Z'));
    expect(created).toBe(2);
    const { rows } = await pool.query(
      'SELECT cycle_end FROM card_statements WHERE account_id = $1 ORDER BY cycle_end', [card.accountId],
    );
    expect(rows.map((r) => String(r.cycle_end))).toEqual(['2026-05-05', '2026-06-05', '2026-07-05']);
  });

  it('clamps a day-31 billing day to month length', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 31, createdAt: '2026-01-10' });
    const repo = new NeonCardStatementRepository();
    await repo.ensureEndedCycles(user.userId, card.accountId, 31, '2026-01-10', new Date('2026-03-15T03:00:00Z'));
    const { rows } = await pool.query(
      'SELECT cycle_end FROM card_statements WHERE account_id = $1', [card.accountId],
    );
    expect(rows.map((r) => String(r.cycle_end))).toContain('2026-02-28');
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/card-statement.repository.test.ts`
Expected: FAIL — `NeonCardStatementRepository` does not exist.

- [ ] **Step 6: Implement the repository**

`src/adapters/neon/card-statement.repository.ts`:
```ts
import { pool } from './pool.js';
import { todayWIB, billingCut, lastBillingCutOnOrBefore, previousBillingCut } from '../../domain/time.js';
import type { ICardStatementRepository } from '../../repositories/interfaces.js';

export class NeonCardStatementRepository implements ICardStatementRepository {
  async ensureEndedCycles(
    userId: string,
    accountId: string,
    billingDay: number,
    cardCreatedAt: string,
    asOf: Date,
  ): Promise<number> {
    const today = todayWIB(asOf);
    const lastCut = lastBillingCutOnOrBefore(billingDay, today);
    const created = cardCreatedAt.slice(0, 10); // 'YYYY-MM-DD'
    if (lastCut < created) return 0;

    let inserted = 0;
    let y = Number(created.slice(0, 4));
    let m = Number(created.slice(5, 7));
    // Cap at 120 months as a safety valve against runaway loops.
    for (let i = 0; i < 120; i++) {
      const cut = billingCut(billingDay, y, m);
      if (cut > lastCut) break;
      if (cut >= created) {
        const prevCut = previousBillingCut(billingDay, cut);
        const result = await pool.query(
          `INSERT INTO card_statements (user_id, account_id, cycle_start, cycle_end)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (account_id, cycle_end) DO NOTHING`,
          [userId, accountId, prevCut, cut],
        );
        inserted += result.rowCount ?? 0;
      }
      if (m === 12) { m = 1; y++; } else m++;
    }
    return inserted;
  }

}
```
(Task 4 adds `getWithFigures` to both the interface and this class, plus the `mapCardStatement`/`mapTransaction`/`addDays` imports it needs. This Task 3 file is intentionally minimal so `npm run lint` passes with no unused imports.)

- [ ] **Step 7: Wire into `createRepos`**

In `src/adapters/neon/repos.ts`, add the import and the field:
```ts
import { NeonCardStatementRepository } from './card-statement.repository.js';
```
and inside the returned object (after `recurrings: new NeonRecurringPaymentRepository(),`):
```ts
    cardStatements: new NeonCardStatementRepository(),
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/card-statement.repository.test.ts`
Expected: PASS.

- [ ] **Step 9: Type-check + lint + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/domain/entities.ts src/repositories/interfaces.ts src/adapters/neon/mappers.ts src/adapters/neon/repos.ts src/adapters/neon/card-statement.repository.ts tests/adapters/card-statement.repository.test.ts
git commit -m "feat: card_statements repo + ensureEndedCycles (daily-sweep row ensure)"
```

---

## Task 4: Derived figures + FIFO allocation (`getWithFigures`)

**Files:**
- Modify: `src/adapters/neon/card-statement.repository.ts` (implement `getWithFigures`)
- Test: `tests/adapters/card-statement.repository.test.ts` (append)

**Interfaces:**
- Consumes: `mapCardStatement`, `mapTransaction` (from `./mappers.js`), `addDays`, `todayWIB` (from `domain/time.js`).
- Produces: adds `getWithFigures(userId, accountId, asOf?): Promise<CardStatementWithFigures[]>` to `ICardStatementRepository` and the class — FIFO allocation, live-derived figures, backdated/soft-delete sensitivity. `asOf` (default `new Date()`) makes "overdue" deterministic in tests.

- [ ] **Step 1: Add `getWithFigures` to the interface**

In `src/repositories/interfaces.ts`, add `CardStatementWithFigures` to the `import type { ... } from '../domain/entities.js'` list, and add the method to `ICardStatementRepository` (replacing the `// getWithFigures(...) is added to this interface in Task 4.` comment):
```ts
  /** All statements for a card with figures derived live (FIFO). `asOf` defaults to now. */
  getWithFigures(userId: string, accountId: string, asOf?: Date): Promise<CardStatementWithFigures[]>;
```

- [ ] **Step 2: Add the transaction import to the test file**

At the top of `tests/adapters/card-statement.repository.test.ts`, add to the existing import block (Task 3 imported `NeonUserRepository`, `NeonAccountRepository`, `NeonCardStatementRepository`, `{ uniqueChatId, pool }`):
```ts
import { NeonTransactionRepository } from '../../src/adapters/neon/transaction.repository.js';
```

- [ ] **Step 3: Write the failing tests (append to the test file)**

```ts
describe('NeonCardStatementRepository.getWithFigures', () => {
  async function setupCardWithCycle(opts: { billingDay: number; asOf: string; created: string }) {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const card = await accounts.create({
      userId: user.userId, name: 'CC', type: 'card', creditLimit: 5_000_000, billingDay: opts.billingDay, dueInDays: 15,
    });
    // Pin the card's creation date so cycle math is deterministic.
    await pool.query('UPDATE accounts SET created_at = $1 WHERE account_id = $2', [opts.created, card.accountId]);
    const stmts = new NeonCardStatementRepository();
    await stmts.ensureEndedCycles(user.userId, card.accountId, opts.billingDay, opts.created, new Date(opts.asOf));
    return { user, card, stmts };
  }
  // `getWithFigures` computes figures from transactions, not from accounts.balance, so the
  // tests below do not manually adjust the card balance (raw repo.create does not either).

  it('derives newCharges from expenses in the cycle window, status open, dueDate', async () => {
    const { user, card, stmts } = await setupCardWithCycle({ billingDay: 5, created: '2026-05-01', asOf: '2026-07-20T03:00:00Z' });
    const txns = new NeonTransactionRepository();
    // Expense in the 2026-06-05..2026-07-05 cycle window.
    await txns.create({ userId: user.userId, type: 'expense', amount: 300_000, description: 'x', accountId: card.accountId, categoryId: 'food.dining', date: '2026-06-20' });
    const figures = await stmts.getWithFigures(user.userId, card.accountId, new Date('2026-07-10T03:00:00Z'));
    const july = figures.find((s) => s.cycleEnd === '2026-07-05')!;
    expect(july.newCharges).toBe(300_000);
    expect(july.amountPaid).toBe(0);
    expect(july.remainingDue).toBe(300_000);
    expect(july.status).toBe('open');
    expect(july.dueDate).toBe('2026-07-20');
  });

  it('allocates a payment FIFO to the oldest open statement and marks it paid with paidAt', async () => {
    const { user, card, stmts } = await setupCardWithCycle({ billingDay: 5, created: '2026-05-01', asOf: '2026-07-20T03:00:00Z' });
    const accounts = new NeonAccountRepository();
    const fund = await accounts.create({ userId: user.userId, name: 'Bank', type: 'bank', openingBalance: 1_000_000 });
    const txns = new NeonTransactionRepository();
    await txns.create({ userId: user.userId, type: 'expense', amount: 100_000, description: 'a', accountId: card.accountId, categoryId: 'food.dining', date: '2026-05-10' });
    await txns.create({ userId: user.userId, type: 'expense', amount: 200_000, description: 'b', accountId: card.accountId, categoryId: 'food.dining', date: '2026-06-20' });
    // Pay 100_000 after the 07-05 cut → FIFO-settles the oldest (2026-06-05) statement.
    await txns.createTransfer({ userId: user.userId, amount: 100_000, fromAccountId: fund.accountId, toAccountId: card.accountId, description: 'pay', date: '2026-07-10' });
    const figures = await stmts.getWithFigures(user.userId, card.accountId, new Date('2026-07-12T03:00:00Z'));
    const oldest = figures.find((s) => s.cycleEnd === '2026-06-05')!;
    expect(oldest.remainingDue).toBe(0);
    expect(oldest.status).toBe('paid');
    expect(oldest.paidAt).toBeTruthy();
    const next = figures.find((s) => s.cycleEnd === '2026-07-05')!;
    expect(next.remainingDue).toBe(200_000);
    expect(next.status).toBe('open');
  });

  it('splits an over-paying single payment across two statements FIFO', async () => {
    const { user, card, stmts } = await setupCardWithCycle({ billingDay: 5, created: '2026-05-01', asOf: '2026-07-20T03:00:00Z' });
    const accounts = new NeonAccountRepository();
    const fund = await accounts.create({ userId: user.userId, name: 'Bank', type: 'bank', openingBalance: 1_000_000 });
    const txns = new NeonTransactionRepository();
    await txns.create({ userId: user.userId, type: 'expense', amount: 100_000, description: 'a', accountId: card.accountId, categoryId: 'food.dining', date: '2026-05-10' });
    await txns.create({ userId: user.userId, type: 'expense', amount: 100_000, description: 'b', accountId: card.accountId, categoryId: 'food.dining', date: '2026-06-20' });
    // One 150_000 payment settles the oldest (100k) + 50k of the next.
    await txns.createTransfer({ userId: user.userId, amount: 150_000, fromAccountId: fund.accountId, toAccountId: card.accountId, description: 'pay', date: '2026-07-10' });
    const figures = await stmts.getWithFigures(user.userId, card.accountId, new Date('2026-07-12T03:00:00Z'));
    const oldest = figures.find((s) => s.cycleEnd === '2026-06-05')!;
    const next = figures.find((s) => s.cycleEnd === '2026-07-05')!;
    expect(oldest.status).toBe('paid');
    expect(next.amountPaid).toBe(50_000);
    expect(next.remainingDue).toBe(50_000);
    expect(next.status).toBe('partially_paid');
  });

  it('updates figures when an expense is backdated into a paid cycle (un-pays it)', async () => {
    const { user, card, stmts } = await setupCardWithCycle({ billingDay: 5, created: '2026-05-01', asOf: '2026-07-20T03:00:00Z' });
    const accounts = new NeonAccountRepository();
    const fund = await accounts.create({ userId: user.userId, name: 'Bank', type: 'bank', openingBalance: 1_000_000 });
    const txns = new NeonTransactionRepository();
    const asOf = new Date('2026-07-12T03:00:00Z');
    await txns.create({ userId: user.userId, type: 'expense', amount: 100_000, description: 'a', accountId: card.accountId, categoryId: 'food.dining', date: '2026-05-10' });
    await txns.createTransfer({ userId: user.userId, amount: 100_000, fromAccountId: fund.accountId, toAccountId: card.accountId, description: 'pay', date: '2026-07-10' });
    // Before backdate: oldest is paid.
    expect((await stmts.getWithFigures(user.userId, card.accountId, asOf)).find((s) => s.cycleEnd === '2026-06-05')!.status).toBe('paid');
    // Backdate another charge into that same oldest cycle window.
    await txns.create({ userId: user.userId, type: 'expense', amount: 50_000, description: 'late', accountId: card.accountId, categoryId: 'food.dining', date: '2026-05-15' });
    const oldest = (await stmts.getWithFigures(user.userId, card.accountId, asOf)).find((s) => s.cycleEnd === '2026-06-05')!;
    expect(oldest.newCharges).toBe(150_000);
    expect(oldest.remainingDue).toBe(50_000);
    expect(oldest.status).toBe('partially_paid');
    expect(oldest.paidAt).toBeUndefined();
  });

  it('marks overdue when dueDate < asOf and still owed', async () => {
    const { user, card, stmts } = await setupCardWithCycle({ billingDay: 5, created: '2026-04-01', asOf: '2026-09-20T03:00:00Z' });
    const txns = new NeonTransactionRepository();
    await txns.create({ userId: user.userId, type: 'expense', amount: 100_000, description: 'a', accountId: card.accountId, categoryId: 'food.dining', date: '2026-06-10' });
    const figures = await stmts.getWithFigures(user.userId, card.accountId, new Date('2026-08-01T03:00:00Z'));
    const old = figures.find((s) => s.cycleEnd === '2026-07-05')!;
    expect(old.overdue).toBe(true);
    expect(old.dueDate).toBe('2026-07-20');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/adapters/card-statement.repository.test.ts`
Expected: FAIL — `getWithFigures` does not yet exist on the class (TypeScript/`as never` in tests hides it, so it fails at runtime: `stmts.getWithFigures is not a function`).

- [ ] **Step 5: Implement `getWithFigures`**

In `src/adapters/neon/card-statement.repository.ts`, update the imports at the top of the file to:
```ts
import { pool } from './pool.js';
import { mapCardStatement, mapTransaction } from './mappers.js';
import { todayWIB, addDays, billingCut, lastBillingCutOnOrBefore, previousBillingCut } from '../../domain/time.js';
import type { ICardStatementRepository } from '../../repositories/interfaces.js';
import type { CardStatementWithFigures } from '../../domain/entities.js';
```
Then add this method to `NeonCardStatementRepository` (after `ensureEndedCycles`, before the closing class brace):
```ts
  async getWithFigures(userId: string, accountId: string, asOf: Date = new Date()): Promise<CardStatementWithFigures[]> {
    const accRes = await pool.query(
      'SELECT due_in_days FROM accounts WHERE user_id = $1 AND account_id = $2',
      [userId, accountId],
    );
    if ((accRes.rowCount ?? 0) === 0) return [];
    const dueInDays = Number((accRes.rows[0] as Record<string, unknown>).due_in_days) || 15;

    const stmtRes = await pool.query(
      'SELECT * FROM card_statements WHERE user_id = $1 AND account_id = $2 ORDER BY cycle_end',
      [userId, accountId],
    );
    const stmts = stmtRes.rows.map((r) => mapCardStatement(r as Record<string, unknown>));
    if (stmts.length === 0) return [];

    const txnRes = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id = $1 AND deleted_at IS NULL
         AND ((type = 'expense' AND account_id = $2)
              OR (type = 'transfer' AND to_account_id = $2))
       ORDER BY date, created_at`,
      [userId, accountId],
    );
    const txns = txnRes.rows.map((r) => mapTransaction(r as Record<string, unknown>));
    const expenses = txns.filter((t) => t.type === 'expense');
    // Local mutable copies so FIFO can consume remainders.
    const payments = txns
      .filter((t) => t.type === 'transfer')
      .map((t) => ({ amount: t.amount, createdAt: t.createdAt }));

    const today = todayWIB(asOf);
    const result: CardStatementWithFigures[] = stmts.map((s) => {
      const newCharges = expenses
        .filter((t) => t.date > s.cycleStart && t.date <= s.cycleEnd)
        .reduce((sum, t) => sum + t.amount, 0);
      return {
        ...s,
        newCharges,
        amountPaid: 0,
        remainingDue: newCharges,
        status: 'open',
        dueDate: addDays(s.cycleEnd, dueInDays),
        paidAt: undefined,
        overdue: false,
      };
    });

    let payIdx = 0;
    for (const s of result) {
      let need = s.newCharges;
      let settledAt: string | undefined;
      while (need > 0 && payIdx < payments.length) {
        const p = payments[payIdx]!;
        if (p.amount <= 0) { payIdx++; continue; }
        const applied = Math.min(need, p.amount);
        s.amountPaid += applied;
        need -= applied;
        p.amount -= applied;
        settledAt = p.createdAt;
        if (p.amount <= 0) payIdx++;
        if (need <= 0) break;
      }
      s.remainingDue = Math.max(0, s.newCharges - s.amountPaid);
      if (s.newCharges > 0 && s.remainingDue === 0) {
        s.status = 'paid';
        s.paidAt = settledAt;
      } else if (s.amountPaid > 0) {
        s.status = 'partially_paid';
      } else {
        s.status = 'open';
      }
      s.overdue = s.dueDate < today && s.remainingDue > 0;
    }
    return result;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/adapters/card-statement.repository.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check + lint + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/repositories/interfaces.ts src/adapters/neon/card-statement.repository.ts tests/adapters/card-statement.repository.test.ts
git commit -m "feat: derive card statement figures + FIFO payment allocation"
```

---

## Task 5: `pay_card_bill` tool

**Files:**
- Modify: `src/agent/tools.ts` (add `payCardBillCore` + `pay_card_bill`; add `cardStatements` to nothing here — it's on `repos`)
- Test: `tests/agent/tools-card.test.ts`

**Interfaces:**
- Consumes: `repos.accounts.findById/findByName/findAllByUserId`, `repos.transactions.createTransfer`, `repos.cardStatements.getWithFigures`; `todayWIB`; `WriteResult`, `Account`, `Transaction`.
- Produces: `payCardBillCore({ userId, card, fromAccount, amount?, repos })` and the `pay_card_bill` tool (gated behind `hasAccount`). Returns `WriteResult<{ transaction; card; settledStatements; nextDue? }>` and never throws.

- [ ] **Step 1: Write the failing test**

`tests/agent/tools-card.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { buildTools } from '../../src/agent/tools.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { Account, Transaction } from '../../src/domain/entities.js';

vi.mock('../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));

function card(over: Partial<Account> = {}): Account {
  return {
    accountId: 'card1', userId: 'u', name: 'BCA CC', type: 'card',
    balance: -300_000, creditLimit: 5_000_000, billingDay: 5, dueInDays: 15,
    isActive: true, createdAt: '', updatedAt: '', ...over,
  };
}
function fund(): Account {
  return {
    accountId: 'bank1', userId: 'u', name: 'BCA', type: 'bank',
    balance: 1_000_000, isActive: true, createdAt: '', updatedAt: '',
  };
}
function mockRepos(over: Partial<Repos> = {}): Repos {
  const accountsById = new Map<string, Account>([['card1', card()], ['bank1', fund()]]);
  return {
    users: {} as never,
    accounts: {
      findById: vi.fn(async (_u: string, id: string) => accountsById.get(id) ?? null),
      findByName: vi.fn(async (_u: string, name: string) =>
        [...accountsById.values()].find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null),
      findAllByUserId: vi.fn(async () => [...accountsById.values()]),
      create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
    } as never,
    transactions: {
      createTransfer: vi.fn(async (i: { amount: number; fromAccountId: string; toAccountId: string }) => ({
        transactionId: 't1', userId: 'u', type: 'transfer' as const, amount: i.amount,
        description: '', accountId: i.fromAccountId, toAccountId: i.toAccountId,
        date: '', createdAt: '', updatedAt: '', isRecurringInstance: false,
      }) as Transaction),
      create: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(),
      findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    cardStatements: {
      ensureEndedCycles: vi.fn(),
      getWithFigures: vi.fn(async () => []),
    } as never,
    sessions: {} as never, budgets: {} as never, recurrings: {} as never,
    preferences: {} as never, outreach: {} as never, proactiveSettings: {} as never,
    ...over,
  } as never;
}

async function callExec(t: unknown, args: unknown): Promise<any> {
  return (t as any).execute!(args, {});
}

describe('pay_card_bill', () => {
  it('defaults amount to the full outstanding and returns ok', async () => {
    const repos = mockRepos();
    const { pay_card_bill } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(pay_card_bill, { cardAccountId: 'card1', fromAccountId: 'bank1' });
    expect(res.status).toBe('ok');
    expect(repos.transactions.createTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 300_000, toAccountId: 'card1' }));
    expect(res.data.card.paidAmount).toBe(300_000);
    expect(res.data.card.remainingOwed).toBe(0);
  });

  it('rejects a non-card / no-billing-day target with error', async () => {
    const repos = mockRepos();
    const accountsById = new Map<string, Account>([
      ['card1', card({ billingDay: undefined })],
      ['bank1', fund()],
    ]);
    (repos.accounts.findById as any) = vi.fn(async (_u: string, id: string) => accountsById.get(id) ?? null);
    const { pay_card_bill } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(pay_card_bill, { cardAccountId: 'card1', fromAccountId: 'bank1' });
    expect(res.status).toBe('error');
    expect(repos.transactions.createTransfer).not.toHaveBeenCalled();
  });

  it('rejects overpayment (> totalOwed) with error and never throws', async () => {
    const repos = mockRepos();
    const { pay_card_bill } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(pay_card_bill, { cardAccountId: 'card1', fromAccountId: 'bank1', amount: 999_999 });
    expect(res.status).toBe('error');
  });

  it('returns error when nothing is owed', async () => {
    const repos = mockRepos();
    const accountsById = new Map<string, Account>([
      ['card1', card({ balance: 0 })],
      ['bank1', fund()],
    ]);
    (repos.accounts.findById as any) = vi.fn(async (_u: string, id: string) => accountsById.get(id) ?? null);
    const { pay_card_bill } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(pay_card_bill, { cardAccountId: 'card1', fromAccountId: 'bank1' });
    expect(res.status).toBe('error');
  });

  it('returns ambiguous when the from-account is unknown', async () => {
    const repos = mockRepos();
    const { pay_card_bill } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(pay_card_bill, { cardAccountId: 'card1', fromAccountId: 'nope' });
    expect(res.status).toBe('ambiguous');
    expect(res.field).toBe('fromAccountId');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/agent/tools-card.test.ts`
Expected: FAIL — `pay_card_bill` is `undefined`.

- [ ] **Step 3: Add `payCardBillCore` + the tool**

In `src/agent/tools.ts`, add these imports to the existing `import type { ... } from '../domain/entities.js'` line if not present: ensure `Account` is imported (it is). Add `todayWIB` is already imported.

Add the result type near the other result aliases (after `TransactionResult`) — in `src/domain/entities.ts`:
```ts
export interface PayCardBillOk {
  transaction: Transaction;
  card: { name: string; paidAmount: number; remainingOwed: number; availableLimit: number };
  settledStatements: { cycleEnd: string }[];
  nextDue?: { cycleEnd: string; dueDate: string; amount: number };
}
export type CardPaymentResult = WriteResult<PayCardBillOk>;
```

In `src/agent/tools.ts`, add the import of the new types:
```ts
import type { AccountResult, TransactionResult, Transaction, User, InsightContext, PayCardBillOk, CardPaymentResult } from '../domain/entities.js';
```

Add `payCardBillCore` after `createExpenseCore`:
```ts
/** Atomic card-bill payment: a guarded transfer (source→card) that reuses the
 *  createTransfer txn. Paid-ness is derived (getWithFigures), so there is no
 *  separate "mark paid" write. Never throws. */
export async function payCardBillCore(params: {
  userId: string;
  card: Account;
  fromAccount: Account;
  amount?: number; // undefined => pay full outstanding
  repos: Repos;
}): Promise<CardPaymentResult> {
  const { userId, card, fromAccount, repos } = params;
  try {
    if (card.type !== 'card' || card.billingDay == null) {
      return { status: 'error', message: 'Akun tujuan bukan kartu dengan billing date.' } as CardPaymentResult;
    }
    if (fromAccount.accountId === card.accountId) {
      return { status: 'error', message: 'Akun sumber dan kartu sama.' } as CardPaymentResult;
    }
    const totalOwed = Math.max(0, -card.balance);
    if (totalOwed === 0) {
      return { status: 'error', message: 'Tidak ada tagihan tertunggak.' } as CardPaymentResult;
    }
    const amount = params.amount ?? totalOwed;
    if (amount > totalOwed) {
      return {
        status: 'error',
        message: `Tidak bisa bayar lebih dari tagihan ${totalOwed}. Pakai create_transfer untuk memindahkan dana bebas.`,
      } as CardPaymentResult;
    }

    const transaction = await repos.transactions.createTransfer({
      userId,
      amount,
      fromAccountId: fromAccount.accountId,
      toAccountId: card.accountId,
      description: `Bayar tagihan ${card.name}`,
      date: todayWIB(),
    });

    const stmts = await repos.cardStatements.getWithFigures(userId, card.accountId);
    const settledStatements = stmts
      .filter((s) => s.status === 'paid' && s.amountPaid > 0)
      .map((s) => ({ cycleEnd: s.cycleEnd }));
    const nextDueStmt = stmts.find((s) => s.remainingDue > 0);
    const remainingOwed = Math.max(0, totalOwed - amount);
    const availableLimit = (card.creditLimit ?? 0) + card.balance + amount;

    const ok: PayCardBillOk = {
      transaction,
      card: { name: card.name, paidAmount: amount, remainingOwed, availableLimit },
      settledStatements,
      nextDue: nextDueStmt
        ? { cycleEnd: nextDueStmt.cycleEnd, dueDate: nextDueStmt.dueDate, amount: nextDueStmt.remainingDue }
        : undefined,
    };
    return { status: 'ok', data: ok };
  } catch (e) {
    logEvent('error', 'pay_card_bill failed', { userId, error: (e as Error).message });
    return { status: 'error', message: 'Gagal membayar tagihan kartu. Coba lagi.' } as CardPaymentResult;
  }
}
```

Add the tool inside `buildTools`, after the `create_transfer` tool definition (so it's gated behind `hasAccount` like the other writes):
```ts
  tools.pay_card_bill = tool({
    description:
      'Bayar tagihan kartu kredit — transfer dana dari akun sumber ke kartu (atomik). ' +
      'Default amount = lunasi semua tagihan tertunggak. Bukan create_transfer; ini khusus bayar kartu.',
    parameters: z.object({
      cardAccountId: z.string().describe('Kartu (nama atau accountId).'),
      fromAccountId: z.string().describe('Akun sumber dana (nama atau accountId).'),
      amount: z.number().positive().optional().describe('Jumlah bayar. Kosong = lunasi semua tagihan.'),
    }),
    execute: async ({ cardAccountId, fromAccountId, amount }) => {
      try {
        let cardAcc = await repos.accounts.findById(userId, cardAccountId);
        if (!cardAcc) cardAcc = await repos.accounts.findByName(userId, cardAccountId);
        if (!cardAcc) {
          const all = await repos.accounts.findAllByUserId(userId);
          return {
            status: 'ambiguous', field: 'cardAccountId',
            matches: all.map((a) => ({ id: a.accountId, label: a.name })),
          } as CardPaymentResult;
        }
        let fromAcc = await repos.accounts.findById(userId, fromAccountId);
        if (!fromAcc) fromAcc = await repos.accounts.findByName(userId, fromAccountId);
        if (!fromAcc) {
          const all = await repos.accounts.findAllByUserId(userId);
          return {
            status: 'ambiguous', field: 'fromAccountId',
            matches: all.map((a) => ({ id: a.accountId, label: a.name })),
          } as CardPaymentResult;
        }
        return payCardBillCore({ userId, card: cardAcc, fromAccount: fromAcc, amount, repos });
      } catch (e) {
        logEvent('error', 'pay_card_bill failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal membayar tagihan kartu. Coba lagi.' } as CardPaymentResult;
      }
    },
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/agent/tools-card.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check + lint + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/domain/entities.ts src/agent/tools.ts tests/agent/tools-card.test.ts
git commit -m "feat: add atomic pay_card_bill tool"
```

---

## Task 6: `get_card_statements`, `update_account`, `get_accounts` enrichment, `create_account` billing passthrough

**Files:**
- Modify: `src/agent/tools.ts`, `tests/agent/tools-card.test.ts` (append), `tests/agent/tools.test.ts` (mock + create_account/get_accounts assertions)

**Interfaces:**
- Produces: read tool `get_card_statements({ cardAccountId?, includePaid? })` (always available); write tool `update_account({ accountId, billingDay?, dueInDays?, name?, isActive? })` (gated); `get_accounts` returns `billingDay/dueInDays/availableLimit/owed` for cards; `create_account` accepts + passes `billingDay?`/`dueInDays?`.

- [ ] **Step 1: Write failing tests (append to `tests/agent/tools-card.test.ts`)**

```ts
describe('get_card_statements', () => {
  it('returns derived statements for cards, excluding paid by default', async () => {
    const repos = mockRepos({
      cardStatements: {
        ensureEndedCycles: vi.fn(),
        getWithFigures: vi.fn(async () => [
          { statementId: 's1', userId: 'u', accountId: 'card1', cycleStart: '2026-06-05', cycleEnd: '2026-07-05', createdAt: '', updatedAt: '', newCharges: 300_000, amountPaid: 0, remainingDue: 300_000, status: 'open', dueDate: '2026-07-20', overdue: false },
          { statementId: 's2', userId: 'u', accountId: 'card1', cycleStart: '2026-05-05', cycleEnd: '2026-06-05', createdAt: '', updatedAt: '', newCharges: 100_000, amountPaid: 100_000, remainingDue: 0, status: 'paid', dueDate: '2026-06-20', overdue: false },
        ]),
      } as never,
    });
    const { get_card_statements } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(get_card_statements, {});
    expect(res).toHaveLength(1);
    expect(res[0].remainingDue).toBe(300_000);
    const withPaid = await callExec(get_card_statements, { includePaid: true });
    expect(withPaid).toHaveLength(2);
  });
});

describe('update_account', () => {
  it('patches billingDay/dueInDays and returns ok', async () => {
    const update = vi.fn(async (_u: string, _id: string, patch: Record<string, unknown>) => ({ accountId: 'card1', billingDay: patch.billingDay, dueInDays: patch.dueInDays })) as never;
    const repos = mockRepos({ accounts: { findById: vi.fn(async () => card()), findByName: vi.fn(), findAllByUserId: vi.fn(async () => []), create: vi.fn(), updateBalance: vi.fn(), update } as never });
    const { update_account } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(update_account, { accountId: 'card1', billingDay: 10, dueInDays: 20 });
    expect(res.status).toBe('ok');
    expect(update).toHaveBeenCalled();
  });

  it('returns missing_fields when no field is given', async () => {
    const repos = mockRepos();
    const { update_account } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(update_account, { accountId: 'card1' });
    expect(res.status).toBe('missing_fields');
  });
});

describe('get_accounts enrichment', () => {
  it('exposes billingDay/dueInDays/availableLimit/owed for cards only', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => [card(), fund()]),
        findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
      } as never,
    });
    const { get_accounts } = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await callExec(get_accounts, {});
    const c = res.find((a: any) => a.type === 'card');
    expect(c.billingDay).toBe(5);
    expect(c.availableLimit).toBe(4_700_000);
    expect(c.owed).toBe(300_000);
    const b = res.find((a: any) => a.type === 'bank');
    expect(b.billingDay).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent/tools-card.test.ts`
Expected: FAIL — the new tools/fields do not exist.

- [ ] **Step 3: Add `get_card_statements` (read tool, before the `hasAccount` gate)**

In `src/agent/tools.ts`, add after the `get_account_balance` tool:
```ts
  tools.get_card_statements = tool({
    description:
      'Daftar statement (tagihan) kartu dengan figurasinya: tagihan, sudah dibayar, sisa, jatuh tempo, status. ' +
      'Bisa filter ke satu kartu. Default: sembunyikan yang sudah lunas.',
    parameters: z.object({
      cardAccountId: z.string().optional().describe('Kartu (nama atau accountId). Kosong = semua kartu.'),
      includePaid: z.boolean().optional().describe('Termasuk yang sudah lunas. Default false.'),
    }),
    execute: async ({ cardAccountId, includePaid }) => {
      const all = await repos.accounts.findAllByUserId(userId);
      const cards = all.filter((a) => a.type === 'card' && a.billingDay != null);
      const target = cardAccountId
        ? cards.filter(
            (c) => c.accountId === cardAccountId || c.name.toLowerCase() === cardAccountId.toLowerCase(),
          )
        : cards;
      const out: Array<Record<string, unknown>> = [];
      for (const c of target) {
        const stmts = await repos.cardStatements.getWithFigures(userId, c.accountId);
        for (const s of stmts) {
          if (!includePaid && (s.status === 'paid' || s.remainingDue === 0)) continue;
          out.push({
            cardName: c.name,
            cycleEnd: s.cycleEnd,
            dueDate: s.dueDate,
            newCharges: s.newCharges,
            amountPaid: s.amountPaid,
            remainingDue: s.remainingDue,
            status: s.status,
            overdue: s.overdue,
          });
        }
      }
      return out;
    },
  });
```

- [ ] **Step 4: Add `update_account` (write tool, after `pay_card_bill`)**

```ts
  tools.update_account = tool({
    description:
      'Perbarui akun: billingDay/dueInDays (kartu), name, isActive. Minimal satu field harus diisi.',
    parameters: z.object({
      accountId: z.string(),
      billingDay: z.number().int().min(1).max(31).optional(),
      dueInDays: z.number().int().min(0).optional(),
      name: z.string().optional(),
      isActive: z.boolean().optional(),
    }),
    execute: async ({ accountId, billingDay, dueInDays, name, isActive }) => {
      if (billingDay === undefined && dueInDays === undefined && name === undefined && isActive === undefined) {
        return { status: 'missing_fields', missing: ['billingDay', 'dueInDays', 'name', 'isActive'] };
      }
      try {
        let acc = await repos.accounts.findById(userId, accountId);
        if (!acc) acc = await repos.accounts.findByName(userId, accountId);
        if (!acc) {
          const all = await repos.accounts.findAllByUserId(userId);
          return { status: 'ambiguous', field: 'accountId', matches: all.map((a) => ({ id: a.accountId, label: a.name })) };
        }
        const updated = await repos.accounts.update(userId, acc.accountId, { billingDay, dueInDays, name, isActive });
        return { status: 'ok', data: updated };
      } catch (e) {
        logEvent('error', 'update_account failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal memperbarui akun. Coba lagi.' };
      }
    },
  });
```

- [ ] **Step 5: Enrich `get_accounts` and pass billing fields in `create_account`**

In the `get_accounts` `execute`, replace the returned `accounts.map(...)` with:
```ts
      return accounts.map((a) => {
        const base = {
          accountId: a.accountId,
          name: a.name,
          type: a.type,
          balance: a.balance,
          creditLimit: a.creditLimit,
        };
        if (a.type !== 'card') return base;
        return {
          ...base,
          billingDay: a.billingDay,
          dueInDays: a.dueInDays,
          availableLimit: (a.creditLimit ?? 0) + a.balance,
          owed: Math.max(0, -a.balance),
        };
      });
```
In the `create_account` tool, add to the `parameters` schema (after `openingBalance`):
```ts
      billingDay: z.number().int().min(1).max(31).optional(),
      dueInDays: z.number().int().min(0).optional(),
```
and pass them through in the `execute`:
```ts
      try {
        const account = await repos.accounts.create({
          userId,
          name,
          type,
          creditLimit,
          openingBalance,
          billingDay,
          dueInDays,
        });
```
(Add `billingDay, dueInDays` to the `execute: async ({ name, type, creditLimit, openingBalance }) =>` destructuring so they are in scope.)

- [ ] **Step 6: Update `tools.test.ts` mock to include `cardStatements`**

In `tests/agent/tools.test.ts`, add to the `mockRepos` return object (after `proactiveSettings`):
```ts
    cardStatements: {
      ensureEndedCycles: vi.fn(),
      getWithFigures: vi.fn(async () => []),
    } as never,
```
This prevents existing `buildTools` tests from throwing if they exercise code paths that read `repos.cardStatements`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/agent/tools-card.test.ts tests/agent/tools.test.ts`
Expected: PASS.

- [ ] **Step 8: Type-check + lint + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/agent/tools.ts tests/agent/tools-card.test.ts tests/agent/tools.test.ts
git commit -m "feat: get_card_statements + update_account tools; enrich get_accounts; pass billing in create_account"
```

---

## Task 7: `sweepCardStatements` + cron wiring + boot reconcile

**Files:**
- Create: `src/scheduler/card-statements.ts`
- Modify: `src/scheduler/cron.ts`, `src/index.ts`
- Test: `tests/scheduler/card-statements.test.ts`

**Interfaces:**
- Consumes: `repos.users.findAll`, `repos.accounts.findAllByUserId`, `repos.cardStatements.ensureEndedCycles`.
- Produces: `sweepCardStatements(repos, now?)` — iterates users → active cards with `billingDay` → ensures their ended cycles; per-user and per-account error isolation.

- [ ] **Step 1: Write the failing test**

`tests/scheduler/card-statements.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sweepCardStatements } from '../../src/scheduler/card-statements.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { Account, User } from '../../src/domain/entities.js';

vi.mock('../../src/utils/logger.js', () => ({ logEvent: vi.fn() }));

function mkUser(id: string): User {
  return { userId: id, telegramChatId: `c-${id}`, name: 'U', language: 'id', timezone: 'Asia/Jakarta', status: 'approved', createdAt: '2026-01-01', updatedAt: '' };
}
function mkCard(over: Partial<Account>): Account {
  return { accountId: 'card', userId: 'u', name: 'CC', type: 'card', balance: 0, billingDay: 5, dueInDays: 15, isActive: true, createdAt: '2026-01-01', updatedAt: '', ...over };
}

function mockRepos(opts: { users: User[]; cards: Account[]; ensure: ReturnType<typeof vi.fn> }): Repos {
  return {
    users: { findAll: vi.fn(async () => opts.users) } as never,
    accounts: { findAllByUserId: vi.fn(async () => opts.cards) } as never,
    cardStatements: { ensureEndedCycles: opts.ensure, getWithFigures: vi.fn(async () => []) } as never,
  } as never;
}

describe('sweepCardStatements', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ensures ended cycles for every active card with a billing day', async () => {
    const ensure = vi.fn(async () => 1);
    const repos = mockRepos({
      users: [mkUser('u1')],
      cards: [mkCard({ accountId: 'c1', billingDay: 5 })],
      ensure,
    });
    await sweepCardStatements(repos, new Date('2026-07-20T00:05:00Z'));
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith('u1', 'c1', 5, '2026-01-01', new Date('2026-07-20T00:05:00Z'));
  });

  it('skips cards without a billing day and non-card accounts', async () => {
    const ensure = vi.fn(async () => 0);
    const repos = mockRepos({
      users: [mkUser('u1')],
      cards: [mkCard({ accountId: 'c1', billingDay: undefined }), { ...mkCard({ accountId: 'b' }), type: 'bank', billingDay: undefined }],
      ensure,
    });
    await sweepCardStatements(repos, new Date('2026-07-20T00:05:00Z'));
    expect(ensure).not.toHaveBeenCalled();
  });

  it('continues when one user throws', async () => {
    const ensure = vi.fn(async () => 1);
    const reposA = mockRepos({ users: [mkUser('u1')], cards: [mkCard({ accountId: 'c1' })], ensure });
    // Force findAllByUserId to throw for the first call then resolve.
    let call = 0;
    (reposA.accounts.findAllByUserId as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error('boom');
      return [mkCard({ accountId: 'c2' })];
    });
    await expect(sweepCardStatements(reposA, new Date('2026-07-20T00:05:00Z'))).resolves.toBeUndefined();
  });

  it('is a no-op when there are no users', async () => {
    const ensure = vi.fn(async () => 0);
    const repos = mockRepos({ users: [], cards: [], ensure });
    await sweepCardStatements(repos, new Date('2026-07-20T00:05:00Z'));
    expect(ensure).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/scheduler/card-statements.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sweep**

`src/scheduler/card-statements.ts`:
```ts
import type { Repos } from '../repositories/interfaces.js';
import { logEvent } from '../utils/logger.js';

/**
 * Ensure every user's active card (with a billing day) has statement rows for
 * all ended billing cycles up to `now`. Per-user and per-account errors are
 * logged and skipped so one failure never blocks the rest. Driven by the daily
 * BUDGET_ROLLOVER_CRON and a one-shot reconcile on boot (mirrors budget rollover).
 */
export async function sweepCardStatements(repos: Repos, now: Date = new Date()): Promise<void> {
  const users = await repos.users.findAll();
  for (const user of users) {
    try {
      const accounts = await repos.accounts.findAllByUserId(user.userId);
      const cards = accounts.filter((a) => a.type === 'card' && a.billingDay != null);
      for (const card of cards) {
        try {
          const created = await repos.cardStatements.ensureEndedCycles(
            user.userId, card.accountId, card.billingDay as number, card.createdAt, now,
          );
          if (created > 0) {
            logEvent('info', 'card statements ensured', { userId: user.userId, accountId: card.accountId, created });
          }
        } catch (err) {
          logEvent('error', 'card statement ensure failed for account', {
            userId: user.userId, accountId: card.accountId, error: (err as Error).message,
          });
        }
      }
    } catch (err) {
      logEvent('error', 'card statement sweep failed for user', {
        userId: user.userId, error: (err as Error).message,
      });
    }
  }
}
```

- [ ] **Step 4: Wire into the daily cron**

In `src/scheduler/cron.ts`, add the import:
```ts
import { sweepCardStatements } from './card-statements.js';
```
In the `cron.schedule(config.BUDGET_ROLLOVER_CRON, ...)` callback, add a second sweep alongside the existing `sweepBudgetRollover(repos)`:
```ts
  cron.schedule(config.BUDGET_ROLLOVER_CRON, () => {
    sweepBudgetRollover(repos).catch((err) =>
      logEvent('error', 'budget rollover cron error', { error: (err as Error).message }),
    );
    sweepCardStatements(repos).catch((err) =>
      logEvent('error', 'card statements cron error', { error: (err as Error).message }),
    );
  }, { timezone: 'Asia/Jakarta' });
```

- [ ] **Step 5: Wire the boot reconcile**

In `src/index.ts`, add the import:
```ts
import { sweepCardStatements } from './scheduler/card-statements.js';
```
and after the existing boot `sweepBudgetRollover(repos)` block:
```ts
  await sweepCardStatements(repos).catch((err) =>
    logEvent('error', 'boot card statements failed', { error: (err as Error).message }),
  );
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/scheduler/card-statements.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check + lint + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/scheduler/card-statements.ts src/scheduler/cron.ts src/index.ts tests/scheduler/card-statements.test.ts
git commit -m "feat: daily sweep ensures card statement rows; boot reconcile"
```

---

## Task 8: Morning-glance card-dues slice + deterministic block

**Files:**
- Modify: `src/proactive/triggers/morning-glance.ts`, `src/proactive/composers/template.ts`
- Test: `tests/proactive/triggers/morning-glance.test.ts`, `tests/proactive/composers/template.test.ts`

**Interfaces:**
- Consumes: `repos.cardStatements.getWithFigures`, `addDays`, `todayWIB`.
- Produces: detector adds `cardDue: { account; cycleEnd; dueDate; remainingDue; overdue }[]` to the payload (unpaid statements with `overdue` OR `dueDate <= today+7`); `renderCardBills(cards)` deterministic block wired into `renderMorningGlanceBlock`.

- [ ] **Step 1: Add the failing detector test**

In `tests/proactive/triggers/morning-glance.test.ts`, add `cardStatements` to the `mockRepos` return (after `proactiveSettings`):
```ts
    cardStatements: { ensureEndedCycles: vi.fn(), getWithFigures: vi.fn(async () => []) } as never,
```
Then append a new test inside the `describe`:
```ts
  it('surfaces unpaid card statements due within 7 days or overdue as cardDue', async () => {
    const due = { statementId: 's', userId: 'u', accountId: 'cc', cycleStart: '', cycleEnd: '2026-07-05', createdAt: '', updatedAt: '', newCharges: 300_000, amountPaid: 0, remainingDue: 300_000, status: 'open', dueDate: '2026-06-25', overdue: true };
    // mkAccount doesn't model card billing fields, so use a card literal.
    const card: Account = { accountId: 'cc', userId: 'u', name: 'BCA CC', type: 'card', balance: -300_000, creditLimit: 5_000_000, billingDay: 5, dueInDays: 15, isActive: true, createdAt: '', updatedAt: '' };
    const repos = mockRepos({ accounts: [card] });
    ;(repos.cardStatements as { getWithFigures: (u: string, a: string, t?: Date) => Promise<unknown[]> }).getWithFigures =
      vi.fn(async () => [due]);
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { cardDue: { account: string; remainingDue: number; overdue: boolean }[] };
    expect(data.cardDue).toHaveLength(1);
    expect(data.cardDue[0]).toMatchObject({ account: 'BCA CC', remainingDue: 300_000, overdue: true });
  });
```
Add `Account` to the import from `domain/entities.js` in this test file if not present.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/triggers/morning-glance.test.ts`
Expected: FAIL — `cardDue` is `undefined` (detector doesn't compute it).

- [ ] **Step 3: Extend the detector**

In `src/proactive/triggers/morning-glance.ts`, `addDays` is already imported (used for `plus7`), so no import change is needed. After the `budgets` computation (before building `payload`), add:
```ts
  // Card statements: unpaid, due within 7 days or overdue (FIFO-derived figures).
  interface CardDue { account: string; cycleEnd: string; dueDate: string; remainingDue: number; overdue: boolean }
  const cardDue: CardDue[] = [];
  for (const a of accounts.filter((a) => a.type === 'card' && a.billingDay != null)) {
    const stmts = await repos.cardStatements.getWithFigures(userId, a.accountId, now);
    for (const s of stmts) {
      if (s.remainingDue > 0 && (s.overdue || s.dueDate <= plus7)) {
        cardDue.push({ account: a.name, cycleEnd: s.cycleEnd, dueDate: s.dueDate, remainingDue: s.remainingDue, overdue: s.overdue });
      }
    }
  }
  cardDue.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
```
Add `cardDue` to the payload `data` object (alongside `balances, upcoming, yesterday, todayDueBills, budgets`).

- [ ] **Step 4: Add the failing template test**

In `tests/proactive/composers/template.test.ts`, append:
```ts
import { renderCardBills, renderMorningGlanceBlock } from '../../../src/proactive/composers/template.js';

describe('renderCardBills', () => {
  it('returns "" when empty', () => {
    expect(renderCardBills([])).toBe('');
  });
  it('renders one bullet per card due with overdue marker', () => {
    const out = renderCardBills([
      { account: 'BCA CC', cycleEnd: '2026-07-05', dueDate: '2026-07-20', remainingDue: 300_000, overdue: false },
      { account: 'Mandiri CC', cycleEnd: '2026-07-05', dueDate: '2026-07-18', remainingDue: 150_000, overdue: true },
    ]);
    expect(out).toContain('💳 Tagihan kartu');
    expect(out).toContain('BCA CC — 300.000, jatuh tempo 2026-07-20');
    expect(out).toContain('Mandiri CC — 150.000, jatuh tempo 2026-07-18 (terlambat)');
  });
  it('renderMorningGlanceBlock includes the card block when cardDue is present', () => {
    const block = renderMorningGlanceBlock({ triggerType: 'morning_glance', dedupKey: '', channel: 'llm', data: { cardDue: [{ account: 'BCA CC', cycleEnd: '', dueDate: '2026-07-20', remainingDue: 300_000, overdue: false }] } });
    expect(block).toContain('💳 Tagihan kartu');
  });
});
```
(If `renderMorningGlanceBlock` is not already imported in that file, add it to the import line.)

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: FAIL — `renderCardBills` not exported.

- [ ] **Step 6: Add `renderCardBills` and wire it in**

In `src/proactive/composers/template.ts`, add the interface + renderer (near `renderTodayDue`):
```ts
interface MGCardDue {
  account: string
  cycleEnd: string
  dueDate: string
  remainingDue: number
  overdue: boolean
}

/** Render due/overdue card statements as bullets. '' when empty. */
export function renderCardBills (cards: readonly MGCardDue[]): string {
  if (cards.length === 0) return ''
  const lines = cards.map((c) => {
    const late = c.overdue ? ' (terlambat)' : ''
    return `• ${c.account} — ${idr(c.remainingDue)}, jatuh tempo ${c.dueDate}${late}`
  })
  return `💳 Tagihan kartu\n${lines.join('\n')}`
}
```
In `renderMorningGlanceBlock`, add `MGCardDue[]` to the cast type (`cardDue?: MGCardDue[]`) and include `renderCardBills(d.cardDue ?? [])` in the assembled array (e.g., after `renderTodayDue(d.todayDueBills ?? [])`).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/proactive/triggers/morning-glance.test.ts tests/proactive/composers/template.test.ts`
Expected: PASS.

- [ ] **Step 8: Type-check + lint + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/proactive/triggers/morning-glance.ts src/proactive/composers/template.ts tests/proactive/triggers/morning-glance.test.ts tests/proactive/composers/template.test.ts
git commit -m "feat: morning-glance card-dues slice + deterministic tagihan-kartu block"
```

---

## Task 9: System-prompt card-billing rules

**Files:**
- Modify: `src/agent/system-prompt.ts`, `tests/agent/system-prompt.test.ts`

**Interfaces:**
- Produces: prompt gains a `KARTU KREDIT (billing)` section and a `pay_card_bill` line in the write-gate field list.

- [ ] **Step 1: Write the failing test**

Append to `tests/agent/system-prompt.test.ts`:
```ts
describe('buildSystemPrompt — card billing rules', () => {
  const prompt = buildSystemPrompt('2026-07-26');

  it('documents pay_card_bill and get_card_statements', () => {
    expect(prompt).toContain('pay_card_bill');
    expect(prompt).toContain('get_card_statements');
  });

  it('tells the model to ask for billingDay at card creation', () => {
    expect(prompt).toMatch(/billingDay/i);
  });

  it('forbids create_transfer for card payments (use pay_card_bill)', () => {
    expect(prompt).toContain('pay_card_bill');
    expect(prompt).toContain('BUKAN create_transfer');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/agent/system-prompt.test.ts`
Expected: FAIL — the strings are absent.

- [ ] **Step 3: Add the prompt section**

In `src/agent/system-prompt.ts`, inside the template literal, add a `pay_card_bill` line to the TOOL WRITE GATE field list:
```
- pay_card_bill: cardAccountId, fromAccountId, amount (opsional, kosong = lunas).
```
And add a new section before `TAKSONOMI KATEGORI:`:
```
KARTU KREDIT (billing):
- Kartu punya billingDay (tanggal tagihan tiap bulan) + due date (billingDay + dueInDays, default 15). Statement dibuat otomatis tiap billing date oleh sistem.
- Untuk bayar tagihan kartu, panggil pay_card_bill (BUKAN create_transfer). Sebutkan akun sumber dananya. Kosongkan amount = lunasi semua; "lunas"/"bayar semua" = kosongkan amount.
- Untuk cek tagihan/jatuh tempo kartu, panggil get_card_statements.
- Saat membuat kartu (create_account), tanya billingDay. Untuk kartu yang belum punya billingDay, bisa diisi via update_account.
- availableLimit = creditLimit + saldo kartu; owed = -saldo kalau saldo negatif.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/agent/system-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check + lint + commit**

```bash
npx tsc --noEmit && npm run lint
git add src/agent/system-prompt.ts tests/agent/system-prompt.test.ts
git commit -m "feat: system-prompt card-billing rules (pay_card_bill, get_card_statements, billingDay)"
```

---

## Task 10: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Full lint**

Run: `npm run lint`
Expected: clean (NFR-02 holds — no `pg` import outside `src/adapters/neon/`).

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all green, including the new files:
`tests/domain/time-billing.test.ts`, `tests/adapters/card-statement.repository.test.ts`, `tests/agent/tools-card.test.ts`, `tests/scheduler/card-statements.test.ts`, plus the updated `account.repository.test.ts`, `tools.test.ts`, `morning-glance.test.ts`, `template.test.ts`, `system-prompt.test.ts`.

- [ ] **Step 4: Commit any remaining test-list/snapshot drift**

If `npm test` surfaces unrelated pre-existing drift, do not fix it here — note it. Only commit changes that belong to this feature.

---

## Self-Review notes (spec → plan coverage)

- **Spec §2 data model** → Task 1 (accounts columns, `card_statements`). The spec listed stored `due_date` and several figure columns; the plan drops them all in favor of derivation (spec §1 decision 5 "live-derived"), and `due_date` is derived (`addDays(cycleEnd, dueInDays)`) so `due_in_days` edits never go stale. Covered: Tasks 1, 3, 4.
- **Spec §3 lifecycle (daily sweep, freeze-once)** → replaced by "ensure rows only" (no freeze, per user feedback "no need to freeze"). Task 3 (`ensureEndedCycles`) + Task 7 (`sweepCardStatements`).
- **Spec §4 derived figures + FIFO** → Task 4. Field set simplified to `{ newCharges, amountPaid, remainingDue, status, dueDate, paidAt, overdue }` (under pure FIFO, `statementBalance` ≡ `newCharges`; `openingBalance`/`closingBalance` are not meaningful).
- **Spec §5 `pay_card_bill`** → Task 5.
- **Spec §6 read/account tools** → Task 6.
- **Spec §7 proactive prompting** → Task 8.
- **Spec §8 system prompt** → Task 9.
- **Spec §9 edge cases** → covered by Task 4 tests (backdated un-pays, soft-delete via `deleted_at IS NULL`, overdue) and Task 5 tests (non-card/no-billing-day, overpayment, nothing-owed, ambiguous).
- **Spec §10 testing** → integration (Tasks 1, 3, 4), unit (Tasks 5, 6, 7, 8, 9), full suite (Task 10).
