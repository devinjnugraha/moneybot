# MoneyBot — Slice 4 Implementation Plan (Scheduler & Inline Callbacks)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the recurring payment scheduler — daily 08:00 WIB cron, 5-minute defer sweep, Telegram inline-keyboard callbacks (confirm/defer/skip), and durable `pendingRecurringConfirmation` session state.

**Architecture:** Two in-process `node-cron` jobs + a grammY `callback_query` handler. The create_expense tool's execute logic is extracted into a reusable `createExpenseCore` function so both the agent tool and the callback handler share the same write path. A new `findDueToday` repository method handles the day-of-month overflow query in the adapter.

**Tech Stack:** TypeScript 5, grammY, `node-cron`, Vercel AI SDK, `zod`, `pg` (Neon), Vitest, ESLint, `tsx`.

**Reference:** Design spec at `docs/superpowers/specs/2026-06-19-moneybot-slice-4-design.md`. SRS at `docs/SRS.md` (FR-09, FR-09b, NFR-10).

---

## File Structure (this plan's deliverables)

```
Create:
  src/scheduler/cron.ts
  src/scheduler/recurring-fire.ts
  src/scheduler/defer-sweep.ts
  src/telegram/callback-query.ts
  src/telegram/formatter.ts
  tests/scheduler/recurring-fire.test.ts
  tests/scheduler/defer-sweep.test.ts
  tests/telegram/callback-query.test.ts
  tests/telegram/formatter.test.ts
Modify:
  package.json                                     ← add node-cron + @types/node-cron
  src/repositories/interfaces.ts                   ← add findDueToday to IRecurringPaymentRepository
  src/adapters/neon/recurring-payment.repository.ts ← implement findDueToday
  src/agent/tools.ts                               ← extract createExpenseCore, call it from T06
  src/telegram/bot.ts                              ← add registerCallbackHandler
  src/index.ts                                     ← wire cron + callback handler
  tests/adapters/recurring-payment.repository.test.ts ← add findDueToday describe block
```

---

## Task 1: Install `node-cron`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install node-cron and its types**

```bash
npm install node-cron && npm install -D @types/node-cron
```

Expected: packages added to `package.json` and `node_modules/`.

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add node-cron and @types/node-cron for Slice 4 scheduler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: `findDueToday` — repository interface + adapter (TDD)

**Files:**
- Modify: `src/repositories/interfaces.ts`
- Modify: `src/adapters/neon/recurring-payment.repository.ts`
- Modify: `tests/adapters/recurring-payment.repository.test.ts`

### Background

The scheduler needs to find active recurring payments due on a given WIB day, handling the last-day-of-month overflow rule (day 31 → Feb 28). The method receives WIB year/month/day so the adapter never depends on server time.

- [ ] **Step 1: Add `findDueToday` to the repository interface**

In `src/repositories/interfaces.ts`, in the `IRecurringPaymentRepository` interface (after `findByDayOfMonth`):

```ts
  findDueToday(wibYear: number, wibMonth: number, wibDay: number): Promise<RecurringPayment[]>;
```

- [ ] **Step 2: Write the failing tests**

Add to the end of `tests/adapters/recurring-payment.repository.test.ts` (before the closing of the file, after the last `it(...)` block):

```ts
describe('findDueToday — day-of-month overflow', () => {
  async function seedUser() {
    return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
  }

  it('returns a payment when dayOfMonth matches today', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    const recurrings = new NeonRecurringPaymentRepository();
    await recurrings.create({
      userId: user.userId, name: 'Spotify', amount: 54_990,
      accountId: acc.accountId, categoryId: 'entertainment.streaming',
      dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    // June 15, 2026 → day 15 = match
    const due = await recurrings.findDueToday(2026, 6, 15);
    expect(due).toHaveLength(1);
    expect(due[0]!.name).toBe('Spotify');
  });

  it('does not return a payment that already fired this month', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    const recurrings = new NeonRecurringPaymentRepository();
    const rp = await recurrings.create({
      userId: user.userId, name: 'Netflix', amount: 159_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming',
      dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    // Simulate already fired this month — set lastFiredAt to June 15
    await recurrings.update(user.userId, rp.recurringId, { lastFiredAt: '2026-06-15' });
    const due = await recurrings.findDueToday(2026, 6, 20);
    expect(due).toHaveLength(0);
  });

  it('fires on last day of month for dayOfMonth=31 in February', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    const recurrings = new NeonRecurringPaymentRepository();
    await recurrings.create({
      userId: user.userId, name: 'Day31Sub', amount: 100_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming',
      dayOfMonth: 31, nextFireAt: '2026-02-28',
    });
    // Feb 28, 2026 — day 31 overflow should fire
    const due = await recurrings.findDueToday(2026, 2, 28);
    expect(due.find((r) => r.name === 'Day31Sub')).toBeTruthy();
  });

  it('does not fire day-31 payment on a normal March 28', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    const recurrings = new NeonRecurringPaymentRepository();
    await recurrings.create({
      userId: user.userId, name: 'Day31Sub', amount: 100_000,
      accountId: acc.accountId, categoryId: 'entertainment.streaming',
      dayOfMonth: 31, nextFireAt: '2026-03-31',
    });
    // March 28 — has 31 days, dayOfMonth=31 should NOT fire on 28
    const due = await recurrings.findDueToday(2026, 3, 28);
    expect(due).toHaveLength(0);
  });

  it('excludes inactive payments', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    const recurrings = new NeonRecurringPaymentRepository();
    const rp = await recurrings.create({
      userId: user.userId, name: 'Spotify', amount: 54_990,
      accountId: acc.accountId, categoryId: 'entertainment.streaming',
      dayOfMonth: 15, nextFireAt: '2026-06-15',
    });
    await recurrings.deactivate(user.userId, rp.recurringId);
    const due = await recurrings.findDueToday(2026, 6, 15);
    expect(due).toHaveLength(0);
  });
});
```

Also add the missing imports at the top of the file. Replace the existing import line:

```ts
import { uniqueChatId } from '../helpers/db.js';
```

should already be there. If not, add it. The test also needs `NeonAccountRepository` — verify the import at the top of the file already imports `NeonAccountRepository` (it does, via the existing `seed()` function).

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run tests/adapters/recurring-payment.repository.test.ts
```

Expected: FAIL — `TypeError: recurrings.findDueToday is not a function` (5 new tests fail, 6 existing pass).

- [ ] **Step 4: Implement `findDueToday` in the Neon adapter**

In `src/adapters/neon/recurring-payment.repository.ts`, add the method to the class (after `findByDayOfMonth`):

```ts
  async findDueToday(wibYear: number, wibMonth: number, wibDay: number): Promise<RecurringPayment[]> {
    const daysInMonth = new Date(wibYear, wibMonth, 0).getDate(); // day 0 of next month = last day
    const { rows } = await pool.query(
      `SELECT * FROM recurring_payments
       WHERE is_active = true
       AND (
         day_of_month = $1
         OR (day_of_month > $2 AND $1 = $2)
       )
       AND (
         last_fired_at IS NULL
         OR EXTRACT(MONTH FROM last_fired_at) != $3
         OR EXTRACT(YEAR FROM last_fired_at) != $4
       )`,
      [wibDay, daysInMonth, wibMonth, wibYear],
    );
    return rows.map((r) => mapRecurringPayment(r as Record<string, unknown>));
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/adapters/recurring-payment.repository.test.ts
```

Expected: PASS (11 tests — 6 existing + 5 new).

- [ ] **Step 6: Type-check + lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/repositories/interfaces.ts src/adapters/neon/recurring-payment.repository.ts tests/adapters/recurring-payment.repository.test.ts
git commit -m "feat(repos): add findDueToday with day-of-month overflow rule

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Extract `createExpenseCore` from `buildTools`

**Files:**
- Modify: `src/agent/tools.ts`

### Background

The callback handler (Task 5) needs to create expenses with pre-resolved account + budget IDs. Extract the core write logic (create transaction → update balance → increment spent → check overspend) into an exported function. The tool's `execute` still handles name→ID resolution, then delegates to the core.

- [ ] **Step 1: Extract `createExpenseCore` and add it above `buildTools`**

In `src/agent/tools.ts`, add this function after the imports and before the `buildTools` function definition (after line 14, before line 15):

```ts
/** Core expense-creation logic shared by T06 create_expense and the
 *  Slice 4 callback handler (confirm). All IDs must be pre-resolved. */
export async function createExpenseCore(params: {
  userId: string;
  amount: number;
  description: string;
  categoryId: string;
  accountId: string;
  budgetCodeId?: string;
  date: string;
  isRecurringInstance?: boolean;
  recurringId?: string;
  repos: Repos;
}): Promise<TransactionResult> {
  try {
    const transaction = await params.repos.transactions.create({
      userId: params.userId,
      type: 'expense',
      amount: params.amount,
      description: params.description,
      categoryId: params.categoryId,
      accountId: params.accountId,
      budgetCodeId: params.budgetCodeId,
      date: params.date,
      isRecurringInstance: params.isRecurringInstance,
      recurringId: params.recurringId,
    });

    await params.repos.accounts.updateBalance(params.userId, params.accountId, -params.amount);

    let budget: { spent: number; limit: number; exceeded: boolean } | undefined;
    if (params.budgetCodeId) {
      await params.repos.budgets.incrementSpent(params.userId, params.budgetCodeId, params.amount);
      const allBudgets = await params.repos.budgets.findByUserAndMonth(
        params.userId,
        wibYear(),
        wibMonth(),
      );
      const bc = allBudgets.find((b) => b.budgetCodeId === params.budgetCodeId);
      if (bc) {
        budget = { spent: bc.spent, limit: bc.monthlyBudget, exceeded: bc.spent > bc.monthlyBudget };
      }
    }

    return { status: 'ok', data: { transaction, budget } };
  } catch (e) {
    return { status: 'error', message: (e as Error).message } as TransactionResult;
  }
}
```

- [ ] **Step 2: Refactor `create_expense` execute to call `createExpenseCore`**

Replace the entire `tools.create_expense = tool({...})` block (lines 267–336) with this streamlined version:

```ts
  tools.create_expense = tool({
    description: 'Catat pengeluaran. Resolve accountId via get_accounts bila ragu.',
    parameters: expenseSchema,
    execute: async ({ description, amount, accountId, categoryId, budgetCodeId, date }) => {
      // Resolve account: accept accountId or account name
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

      // FR-03c: if budgetCodeId is a name (not UUID), resolve it
      let resolvedBudgetCodeId = budgetCodeId;
      if (budgetCodeId && !/^[0-9a-f-]{36}$/.test(budgetCodeId)) {
        const existing = await repos.budgets.findByName(
          userId, budgetCodeId, wibYear(), wibMonth(),
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

      return createExpenseCore({
        userId,
        amount,
        description,
        categoryId,
        accountId: account.accountId,
        budgetCodeId: resolvedBudgetCodeId,
        date: date ?? todayWIB(),
        repos,
      });
    },
  });
```

- [ ] **Step 3: Run tests to verify nothing broke**

```bash
npx vitest run tests/agent/tools.test.ts
```

Expected: PASS — all 33 tests still pass (the `create_expense` describe block uses mocked repos; the refactor doesn't change behavior).

- [ ] **Step 4: Type-check + lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts
git commit -m "refactor(tools): extract createExpenseCore for Slice 4 callback handler reuse

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Formatter — `formatIDR` + recurring prompt template

**Files:**
- Create: `src/telegram/formatter.ts`
- Create: `tests/telegram/formatter.test.ts`

- [ ] **Step 1: Write the formatter module**

Create `src/telegram/formatter.ts`:

```ts
import type { RecurringPayment } from '../domain/entities.js';
import type { InlineKeyboardMarkup } from 'grammy';

/** Format a number as IDR locale: dot as thousands separator, no currency symbol. */
export function formatIDR(n: number): string {
  return n.toLocaleString('id-ID');
}

/** Build the recurring-payment due prompt + inline keyboard (FR-09b). */
export function recurringPrompt(
  rp: RecurringPayment,
  accountName: string,
): { text: string; keyboard: InlineKeyboardMarkup } {
  const text =
    `🔔 Tagihan rutin jatuh tempo hari ini:\n` +
    `${rp.name} — ${formatIDR(rp.amount)} via ${accountName}\n\n` +
    `Mau aku catat sekarang?`;

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: '✅ Ya, catat', callback_data: `rec:${rp.recurringId}:confirm` },
        { text: '⏳ Tunda 1 jam', callback_data: `rec:${rp.recurringId}:defer` },
        { text: '⏭️ Lewati bulan ini', callback_data: `rec:${rp.recurringId}:skip` },
      ],
    ],
  };

  return { text, keyboard };
}
```

- [ ] **Step 2: Write the test**

Create `tests/telegram/formatter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatIDR, recurringPrompt } from '../../src/telegram/formatter.js';
import type { RecurringPayment } from '../../src/domain/entities.js';

describe('formatIDR', () => {
  it('formats using Indonesian thousands separator', () => {
    expect(formatIDR(159_000)).toBe('159.000');
    expect(formatIDR(1_500_000)).toBe('1.500.000');
    expect(formatIDR(0)).toBe('0');
    expect(formatIDR(59_900)).toBe('59.900');
  });
});

describe('recurringPrompt', () => {
  const rp: RecurringPayment = {
    recurringId: 'rp-1',
    userId: 'u1',
    name: 'Spotify',
    amount: 59_900,
    accountId: 'a1',
    categoryId: 'entertainment.streaming',
    dayOfMonth: 25,
    isActive: true,
    nextFireAt: '2026-06-25',
    createdAt: '',
    updatedAt: '',
  };

  it('produces a prompt with name, formatted amount, and account', () => {
    const { text } = recurringPrompt(rp, 'BCA CC');
    expect(text).toContain('Spotify');
    expect(text).toContain('59.900');
    expect(text).toContain('BCA CC');
    expect(text).toContain('Mau aku catat sekarang?');
  });

  it('produces an inline keyboard with 3 buttons in a single row', () => {
    const { keyboard } = recurringPrompt(rp, 'BCA CC');
    const row = keyboard.inline_keyboard[0]!;
    expect(row).toHaveLength(3);
    expect(row[0]!.text).toBe('✅ Ya, catat');
    expect(row[0]!.callback_data).toBe('rec:rp-1:confirm');
    expect(row[1]!.text).toBe('⏳ Tunda 1 jam');
    expect(row[1]!.callback_data).toBe('rec:rp-1:defer');
    expect(row[2]!.text).toBe('⏭️ Lewati bulan ini');
    expect(row[2]!.callback_data).toBe('rec:rp-1:skip');
  });
});
```

- [ ] **Step 3: Run formatter tests**

```bash
npx vitest run tests/telegram/formatter.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 4: Type-check + lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/formatter.ts tests/telegram/formatter.test.ts
git commit -m "feat(telegram): add formatIDR + recurringPrompt with inline keyboard

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Callback query handler (`rec:...`)

**Files:**
- Create: `src/telegram/callback-query.ts`
- Create: `tests/telegram/callback-query.test.ts`

### Background

The callback handler parses `callback_data` in format `rec:{recurringId}:{action}`, resolves the recurring payment, and dispatches to confirm/defer/skip. It depends on `Repos`, `createExpenseCore`, `todayWIB`, and the `bot` instance.

- [ ] **Step 1: Write the callback handler**

Create `src/telegram/callback-query.ts`:

```ts
import { bot } from './bot.js';
import { createExpenseCore } from '../agent/tools.js';
import { todayWIB } from '../domain/time.js';
import type { Repos } from '../repositories/interfaces.js';

interface CallbackParts {
  recurringId: string;
  action: 'confirm' | 'defer' | 'skip';
}

function parse(callbackData: string): CallbackParts | null {
  const parts = callbackData.split(':');
  if (parts.length !== 3 || parts[0] !== 'rec') return null;
  const action = parts[2];
  if (action !== 'confirm' && action !== 'defer' && action !== 'skip') return null;
  return { recurringId: parts[1]!, action };
}

export function registerCallbackHandler(repos: Repos): void {
  bot.callbackQuery(/^rec:.+/, async (ctx) => {
    const parsed = parse(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCallbackQuery('Data callback tidak valid.');
      return;
    }

    const rp = await repos.recurrings.findById(
      ctx.callbackQuery.from.id.toString(),
      parsed.recurringId,
      // Note: callbackQuery.from.id is Telegram's user ID (number), but our
      // userId is a UUID. We resolve the user via the same chatId mechanism:
      // the chatId from callbackQuery.message.chat.id.
    );

    // Resolve the recurring payment across all users (scheduler needs it anyway).
    // Since recurringId is a UUID, it's globally unique — no userId filter needed.
    // But our repository requires userId. Instead, find the user first from chatId.
    const chatId = String(ctx.callbackQuery.message?.chat?.id ?? '');
    if (!chatId) {
      await ctx.answerCallbackQuery('Chat tidak ditemukan.');
      return;
    }

    const user = await repos.users.findByTelegramChatId(chatId);
    if (!user) {
      await ctx.answerCallbackQuery('User tidak ditemukan.');
      return;
    }

    const recurring = await repos.recurrings.findById(user.userId, parsed.recurringId);
    if (!recurring || !recurring.isActive) {
      await ctx.answerCallbackQuery({ text: 'Tagihan ini sudah dihapus.', show_alert: true });
      return;
    }

    switch (parsed.action) {
      case 'confirm': {
        // Idempotency: don't double-fire in same month
        if (recurring.lastFiredAt) {
          const [y, m] = recurring.lastFiredAt.split('-').map(Number) as [number, number];
          const today = todayWIB().split('-').map(Number) as [number, number, number];
          if (y === today[0] && m === today[1]) {
            await ctx.answerCallbackQuery({ text: 'Sudah diproses sebelumnya.', show_alert: true });
            return;
          }
        }

        const result = await createExpenseCore({
          userId: user.userId,
          amount: recurring.amount,
          description: recurring.name,
          categoryId: recurring.categoryId,
          accountId: recurring.accountId,
          budgetCodeId: recurring.budgetCodeId,
          date: todayWIB(),
          isRecurringInstance: true,
          recurringId: recurring.recurringId,
          repos,
        });

        if (result.status === 'ok') {
          await repos.recurrings.update(user.userId, recurring.recurringId, {
            lastFiredAt: todayWIB(),
          });
          await ctx.answerCallbackQuery('✅ Dicatat!');
          await ctx.editMessageText(
            `✅ ${recurring.name} — ${recurring.amount.toLocaleString('id-ID')} dicatat.`,
          );
        } else {
          await ctx.answerCallbackQuery({ text: `Gagal: ${result.message}`, show_alert: true });
        }
        break;
      }

      case 'defer': {
        const session = await repos.sessions.get(chatId);
        await repos.sessions.set({
          chatId,
          userId: user.userId,
          turns: session?.turns ?? [],
          pendingRecurringConfirmation: {
            recurringId: recurring.recurringId,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
          lastActivityAt: new Date().toISOString(),
        });
        await ctx.answerCallbackQuery('⏳ Nanti diingatkan lagi 1 jam lagi.');
        break;
      }

      case 'skip': {
        await repos.recurrings.update(user.userId, recurring.recurringId, {
          lastFiredAt: todayWIB(),
        });
        await ctx.answerCallbackQuery('⏭️ Dilewati bulan ini.');
        await ctx.editMessageText(`⏭️ ${recurring.name} bulan ini dilewati.`);
        break;
      }
    }
  });
}
```

- [ ] **Step 2: Write tests for the callback handler**

Create `tests/telegram/callback-query.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { RecurringPayment } from '../../src/domain/entities.js';

// The callback handler depends on `bot` which is a grammY Bot instance.
// We mock bot.callbackQuery to capture the registered handler, then call it
// with synthetic ctx objects. This avoids needing a real Telegram connection.

// Instead of testing the handler inline (which requires grammY ctx types),
// we test the logic via an extracted handler function that we export for
// testing. Refactor: the real registerCallbackHandler exports both the
// registrar AND a testable handleRecCallback function.

// For now, the test verifies the core behaviors via direct unit tests of
// the createExpenseCore path, formatter, and scheduler — all of which are
// covered in other test suites. The callback handler's integration with
// grammY is verified via the manual smoke test in Slice 5.

// Updated approach: test the parsing and dispatch logic directly.
// We export handleRecCallback for testing.
```

Wait — the plan needs a testable callback handler. Let me redesign `callback-query.ts` to export the handler function separately so tests can call it without grammY wiring.

Actually, grammY ctx can be constructed in tests. But the simplest approach is to extract the core dispatch logic into a pure function that takes the parsed data + repos + userId + chatId and returns what to do. The grammY wiring just calls this function and then calls the ctx methods.

Replace Step 1's `callback-query.ts` with this testable version:

```ts
import { bot } from './bot.js';
import { createExpenseCore } from '../agent/tools.js';
import { todayWIB } from '../domain/time.js';
import type { Repos } from '../repositories/interfaces.js';

interface CallbackParts {
  recurringId: string;
  action: 'confirm' | 'defer' | 'skip';
}

function parseCallbackData(callbackData: string): CallbackParts | null {
  const parts = callbackData.split(':');
  if (parts.length !== 3 || parts[0] !== 'rec') return null;
  const action = parts[2];
  if (action !== 'confirm' && action !== 'defer' && action !== 'skip') return null;
  return { recurringId: parts[1]!, action };
}

export type CallbackActionResult =
  | { kind: 'answer'; text: string; alert?: boolean }
  | { kind: 'edit'; text: string }
  | { kind: 'answer_and_edit'; answerText: string; editText: string };

/**
 * Pure dispatch function — testable without grammY wiring.
 * Returns the actions to take; the caller applies them via ctx methods.
 */
export async function dispatchRecCallback(
  parsed: CallbackParts,
  chatId: string,
  repos: Repos,
): Promise<CallbackActionResult[]> {
  const user = await repos.users.findByTelegramChatId(chatId);
  if (!user) return [{ kind: 'answer', text: 'User tidak ditemukan.' }];

  const rp = await repos.recurrings.findById(user.userId, parsed.recurringId);
  if (!rp || !rp.isActive) {
    return [{ kind: 'answer', text: 'Tagihan ini sudah dihapus.', alert: true }];
  }

  switch (parsed.action) {
    case 'confirm': {
      // Idempotency: check lastFiredAt is not in current month
      if (rp.lastFiredAt) {
        const [y, m] = rp.lastFiredAt.split('-').map(Number) as [number, number];
        const today = todayWIB().split('-').map(Number) as [number, number, number];
        if (y === today[0] && m === today[1]) {
          return [{ kind: 'answer', text: 'Sudah diproses sebelumnya.', alert: true }];
        }
      }

      const result = await createExpenseCore({
        userId: user.userId,
        amount: rp.amount,
        description: rp.name,
        categoryId: rp.categoryId,
        accountId: rp.accountId,
        budgetCodeId: rp.budgetCodeId,
        date: todayWIB(),
        isRecurringInstance: true,
        recurringId: rp.recurringId,
        repos,
      });

      if (result.status === 'ok') {
        await repos.recurrings.update(user.userId, rp.recurringId, {
          lastFiredAt: todayWIB(),
        });
        return [
          { kind: 'answer', text: '✅ Dicatat!' },
          { kind: 'edit', text: `✅ ${rp.name} — ${rp.amount.toLocaleString('id-ID')} dicatat.` },
        ];
      }
      return [{ kind: 'answer', text: `Gagal: ${result.message}`, alert: true }];
    }

    case 'defer': {
      const session = await repos.sessions.get(chatId);
      await repos.sessions.set({
        chatId,
        userId: user.userId,
        turns: session?.turns ?? [],
        pendingRecurringConfirmation: {
          recurringId: rp.recurringId,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        lastActivityAt: new Date().toISOString(),
      });
      return [{ kind: 'answer', text: '⏳ Nanti diingatkan lagi 1 jam lagi.' }];
    }

    case 'skip': {
      await repos.recurrings.update(user.userId, rp.recurringId, {
        lastFiredAt: todayWIB(),
      });
      return [
        { kind: 'answer', text: '⏭️ Dilewati bulan ini.' },
        { kind: 'edit', text: `⏭️ ${rp.name} bulan ini dilewati.` },
      ];
    }
  }
}

export function registerCallbackHandler(repos: Repos): void {
  bot.callbackQuery(/^rec:.+/, async (ctx) => {
    const parsed = parseCallbackData(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCallbackQuery('Data callback tidak valid.');
      return;
    }

    const chatId = String(ctx.callbackQuery.message?.chat?.id ?? '');
    if (!chatId) {
      await ctx.answerCallbackQuery('Chat tidak ditemukan.');
      return;
    }

    const actions = await dispatchRecCallback(parsed, chatId, repos);
    for (const action of actions) {
      switch (action.kind) {
        case 'answer':
          await ctx.answerCallbackQuery({ text: action.text, show_alert: action.alert });
          break;
        case 'edit':
          await ctx.editMessageText(action.text);
          break;
        case 'answer_and_edit':
          await ctx.answerCallbackQuery(action.answerText);
          await ctx.editMessageText(action.editText);
          break;
      }
    }
  });
}
```

- [ ] **Step 2 (revised): Write the test for `dispatchRecCallback`**

Create `tests/telegram/callback-query.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { dispatchRecCallback } from '../../src/telegram/callback-query.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { RecurringPayment, SessionContext } from '../../src/domain/entities.js';

function mockRepos(overrides: Partial<{
  user: { userId: string; telegramChatId: string };
  rp: RecurringPayment | null;
  createExpenseResult: 'ok' | 'error';
  existingSession: SessionContext | null;
}> = {}): Repos {
  const user = overrides.user ?? { userId: 'u1', telegramChatId: '123' };
  const rp: RecurringPayment | null = overrides.rp ?? {
    recurringId: 'rp-1', userId: 'u1', name: 'Spotify', amount: 59_900,
    accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25,
    isActive: true, nextFireAt: '2026-06-25', createdAt: '', updatedAt: '',
  };
  return {
    users: {
      findByTelegramChatId: vi.fn(async () => user),
      findById: vi.fn(), create: vi.fn(), update: vi.fn(),
    } as never,
    accounts: {
      findAllByUserId: vi.fn(), findById: vi.fn(async () => ({ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 1_000_000, isActive: true, createdAt: '', updatedAt: '' })),
      findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
    } as never,
    transactions: {
      create: vi.fn(async (i: Record<string, unknown>) => ({
        transactionId: 'txn-1', userId: i.userId, type: 'expense', amount: i.amount,
        description: i.description, categoryId: i.categoryId, accountId: i.accountId,
        budgetCodeId: i.budgetCodeId, date: i.date, isRecurringInstance: !!i.isRecurringInstance,
        recurringId: i.recurringId, createdAt: '', updatedAt: '',
      })),
      createTransfer: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(),
      findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: {
      get: vi.fn(async () => overrides.existingSession ?? null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(),
    } as never,
    budgets: {
      findByUserAndMonth: vi.fn(async () => []),
      findByName: vi.fn(async () => null),
      create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn(),
    } as never,
    recurrings: {
      findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(),
      findById: vi.fn(async () => rp),
      findByName: vi.fn(), create: vi.fn(),
      update: vi.fn(async () => ({ ...rp!, lastFiredAt: '2026-06-19' })),
      deactivate: vi.fn(),
    } as never,
  };
}

describe('dispatchRecCallback', () => {
  it('confirm: creates expense and updates lastFiredAt', async () => {
    const repos = mockRepos();
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'confirm' }, '123', repos,
    );
    expect(repos.transactions.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Spotify', isRecurringInstance: true }),
    );
    expect(repos.recurrings.update).toHaveBeenCalledWith('u1', 'rp-1', expect.objectContaining({ lastFiredAt: expect.any(String) }));
    expect(actions[0]!.kind).toBe('answer');
    expect(actions[0]!.text).toBe('✅ Dicatat!');
  });

  it('confirm: blocks double-fire same month', async () => {
    const repos = mockRepos({
      rp: { recurringId: 'rp-1', userId: 'u1', name: 'Spotify', amount: 59_900, accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25, isActive: true, nextFireAt: '2026-06-25', lastFiredAt: '2026-06-19', createdAt: '', updatedAt: '' },
    });
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'confirm' }, '123', repos,
    );
    expect(actions[0]!.text).toBe('Sudah diproses sebelumnya.');
    expect(repos.transactions.create).not.toHaveBeenCalled();
  });

  it('defer: writes pendingRecurringConfirmation to session', async () => {
    const repos = mockRepos();
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'defer' }, '123', repos,
    );
    expect(repos.sessions.set).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingRecurringConfirmation: expect.objectContaining({ recurringId: 'rp-1' }),
      }),
    );
    expect(actions[0]!.text).toContain('Nanti diingatkan lagi');
  });

  it('skip: updates lastFiredAt without creating expense', async () => {
    const repos = mockRepos();
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'skip' }, '123', repos,
    );
    expect(repos.recurrings.update).toHaveBeenCalledWith('u1', 'rp-1', expect.objectContaining({ lastFiredAt: expect.any(String) }));
    expect(repos.transactions.create).not.toHaveBeenCalled();
    expect(actions[0]!.text).toContain('Dilewati');
  });

  it('returns alert when recurring payment is inactive', async () => {
    const repos = mockRepos({ rp: { recurringId: 'rp-1', userId: 'u1', name: 'Spotify', amount: 59_900, accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25, isActive: false, nextFireAt: '2026-06-25', createdAt: '', updatedAt: '' } });
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'confirm' }, '123', repos,
    );
    expect(actions[0]!.text).toBe('Tagihan ini sudah dihapus.');
  });

  it('returns alert when user not found', async () => {
    const repos = mockRepos({ user: null as never });
    const actions = await dispatchRecCallback(
      { recurringId: 'rp-1', action: 'confirm' }, 'ghost', repos,
    );
    expect(actions[0]!.text).toBe('User tidak ditemukan.');
  });
});
```

- [ ] **Step 3: Run callback tests**

```bash
npx vitest run tests/telegram/callback-query.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 4: Type-check + lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/callback-query.ts tests/telegram/callback-query.test.ts
git commit -m "feat(telegram): add rec: callback handler (confirm/defer/skip)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Daily 08:00 recurring fire

**Files:**
- Create: `src/scheduler/recurring-fire.ts`
- Create: `tests/scheduler/recurring-fire.test.ts`

- [ ] **Step 1: Write the recurring fire module**

Create `src/scheduler/recurring-fire.ts`:

```ts
import { bot } from '../telegram/bot.js';
import { recurringPrompt } from '../telegram/formatter.js';
import { wibYear, wibMonth, wibDay, todayWIB } from '../domain/time.js';
import type { Repos } from '../repositories/interfaces.js';

/** Fire recurring payment prompts for all due payments today (WIB). */
export async function fireRecurringPayments(repos: Repos): Promise<void> {
  const year = wibYear();
  const month = wibMonth();
  const day = wibDay();
  const due = await repos.recurrings.findDueToday(year, month, day);

  // Resolve telegramChatId per user (cached — single user may have many payments)
  const chatIdCache = new Map<string, string>();

  for (const rp of due) {
    try {
      let chatId = chatIdCache.get(rp.userId);
      if (!chatId) {
        const user = await repos.users.findById(rp.userId);
        if (!user) {
          console.error(`[recurring-fire] user not found for userId=${rp.userId}`);
          continue;
        }
        chatId = user.telegramChatId;
        chatIdCache.set(rp.userId, chatId);
      }

      const account = await repos.accounts.findById(rp.userId, rp.accountId);
      const accountName = account?.name ?? rp.accountId;

      const { text, keyboard } = recurringPrompt(rp, accountName);
      await bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
      console.log(`[recurring-fire] sent prompt for recurringId=${rp.recurringId} userId=${rp.userId}`);
    } catch (err) {
      console.error(`[recurring-fire] failed for recurringId=${rp.recurringId}`, err);
    }
  }
}
```

Wait — `wibDay()` doesn't exist yet. Let me add it to `src/domain/time.ts`. Actually, let me check — `todayWIB()` returns 'YYYY-MM-DD', and the scheduler just needs to extract the day component. We can compute it from the same `wibDateParts` internal function.

Add `wibDay` to `src/domain/time.ts` (in this task or as a small pre-step):

In `src/domain/time.ts`, add after `wibYear`:

```ts
/** Current day (1–31) in WIB. */
export function wibDay(now: Date = new Date()): number {
  return wibDateParts(now).day;
}
```

- [ ] **Step 2: Write the test**

Create `tests/scheduler/recurring-fire.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { fireRecurringPayments } from '../../src/scheduler/recurring-fire.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { RecurringPayment } from '../../src/domain/entities.js';

// We mock bot.api.sendMessage to avoid real Telegram calls.
import { bot } from '../../src/telegram/bot.js';
vi.mock('../../src/telegram/bot.js', () => ({
  bot: { api: { sendMessage: vi.fn() } },
}));

function mockRepos(due: RecurringPayment[] = []): Repos {
  return {
    users: {
      findByTelegramChatId: vi.fn(),
      findById: vi.fn(async (userId: string) => ({
        userId, telegramChatId: `chat-${userId}`, name: 'U', language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
      })),
      create: vi.fn(), update: vi.fn(),
    } as never,
    accounts: {
      findAllByUserId: vi.fn(),
      findById: vi.fn(async () => ({ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 0, isActive: true, createdAt: '', updatedAt: '' })),
      findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
    } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(),
      update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: {
      get: vi.fn(), set: vi.fn(), delete: vi.fn(),
    } as never,
    budgets: {
      findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(),
      incrementSpent: vi.fn(), update: vi.fn(),
    } as never,
    recurrings: {
      findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(),
      findDueToday: vi.fn(async () => due),
      findById: vi.fn(), findByName: vi.fn(), create: vi.fn(),
      update: vi.fn(), deactivate: vi.fn(),
    } as never,
  };
}

describe('fireRecurringPayments', () => {
  it('sends a prompt for each due payment', async () => {
    const rp: RecurringPayment = {
      recurringId: 'rp-1', userId: 'u1', name: 'Spotify', amount: 59_900,
      accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25,
      isActive: true, nextFireAt: '2026-06-25', createdAt: '', updatedAt: '',
    };
    const repos = mockRepos([rp]);
    await fireRecurringPayments(repos);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      'chat-u1',
      expect.stringContaining('Spotify'),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
  });

  it('caches chatId per user for multiple payments', async () => {
    const rp1: RecurringPayment = { recurringId: 'rp-1', userId: 'u1', name: 'Spotify', amount: 59_900, accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25, isActive: true, nextFireAt: '2026-06-25', createdAt: '', updatedAt: '' };
    const rp2: RecurringPayment = { recurringId: 'rp-2', userId: 'u1', name: 'Netflix', amount: 159_000, accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25, isActive: true, nextFireAt: '2026-06-25', createdAt: '', updatedAt: '' };
    const repos = mockRepos([rp1, rp2]);
    await fireRecurringPayments(repos);
    // findById called only once for 'u1' (cached)
    expect(repos.users.findById).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('skips payments for unknown users', async () => {
    const repos = mockRepos([{ recurringId: 'rp-1', userId: 'ghost', name: 'X', amount: 1, accountId: 'a1', categoryId: 'other.misc', dayOfMonth: 1, isActive: true, nextFireAt: '2026-06-01', createdAt: '', updatedAt: '' }]);
    (repos.users.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await fireRecurringPayments(repos);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Add `wibDay` to `src/domain/time.ts`**

In `src/domain/time.ts`, add after line 44 (after `wibYear`):

```ts
/** Current day (1–31) in WIB. */
export function wibDay(now: Date = new Date()): number {
  return wibDateParts(now).day;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/scheduler/recurring-fire.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Type-check + lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/recurring-fire.ts tests/scheduler/recurring-fire.test.ts src/domain/time.ts
git commit -m "feat(scheduler): daily recurring payment fire with WIB day-of-month resolution

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 5-minute defer sweep

**Files:**
- Create: `src/scheduler/defer-sweep.ts`
- Create: `tests/scheduler/defer-sweep.test.ts`

- [ ] **Step 1: Write the defer sweep module**

Create `src/scheduler/defer-sweep.ts`:

```ts
import { bot } from '../telegram/bot.js';
import { recurringPrompt } from '../telegram/formatter.js';
import type { Repos } from '../repositories/interfaces.js';

/**
 * Sweep expired pendingRecurringConfirmation rows and re-prompt.
 * Each defer re-prompts at most once; a second defer sets a fresh expiresAt.
 */
export async function sweepDeferredPayments(repos: Repos): Promise<void> {
  // No direct query for sessions with expired pendingRecurringConfirmation —
  // we can't scan all sessions efficiently. Instead, the adapter provides
  // a method. For now, the scheduler layer iterates: the repository doesn't
  // have a "find all sessions" method.

  // Solution: add findExpiredDeferrals to ISessionRepository, or use a raw
  // query in the adapter. Since sessions are per-chatId and for a single user
  // there's only one session, the simpler path: use the existing
  // pendingRecurringConfirmation on the loaded session.

  // Actually: we need to query ALL sessions (multi-user) for expired deferrals.
  // This requires a new repository method or adapter-level query.
  // Let's add findExpiredDeferrals to ISessionRepository.
}
```

Wait — this task needs a new repository method. The spec says the 5-min sweep queries all `session_contexts` for expired `pendingRecurringConfirmation`. The `ISessionRepository` currently only has `get(chatId)`, `set(context)`, `delete(chatId)`. We need a way to find sessions with expired deferrals.

Let me add `findExpiredDeferrals` to the interface and adapter. This is a clean addition that follows the existing pattern.

Update the plan for Task 7:

- [ ] **Step 1: Add `findExpiredDeferrals` to the session repository interface**

In `src/repositories/interfaces.ts`, in `ISessionRepository`:

```ts
  /** Find all sessions with an expired pendingRecurringConfirmation. */
  findExpiredDeferrals(): Promise<SessionContext[]>;
```

- [ ] **Step 2: Implement in the Neon adapter**

In `src/adapters/neon/session.repository.ts`, add the method:

```ts
  async findExpiredDeferrals(): Promise<SessionContext[]> {
    const { rows } = await pool.query(
      `SELECT * FROM session_contexts
       WHERE pending_recurring_confirmation IS NOT NULL
       AND (pending_recurring_confirmation->>'expiresAt')::timestamptz <= NOW()`,
    );
    return rows.map((r) => mapSession(r as Record<string, unknown>));
  }
```

- [ ] **Step 3: Write the defer sweep module**

Create `src/scheduler/defer-sweep.ts`:

```ts
import { bot } from '../telegram/bot.js';
import { recurringPrompt } from '../telegram/formatter.js';
import type { Repos } from '../repositories/interfaces.js';

/**
 * Sweep expired pendingRecurringConfirmation rows and re-prompt.
 * Each defer re-prompts at most once; a second defer sets a fresh expiresAt.
 * If the user ignores the re-prompt, no further auto-prompts that day.
 */
export async function sweepDeferredPayments(repos: Repos): Promise<void> {
  const expired = await repos.sessions.findExpiredDeferrals();

  for (const session of expired) {
    if (!session.pendingRecurringConfirmation) continue;

    const { recurringId } = session.pendingRecurringConfirmation;

    try {
      const rp = await repos.recurrings.findById(session.userId, recurringId);
      if (!rp || !rp.isActive) {
        // Recurring deleted since defer — just clear the state
        await repos.sessions.set({
          ...session,
          pendingRecurringConfirmation: undefined,
          lastActivityAt: new Date().toISOString(),
        });
        continue;
      }

      const account = await repos.accounts.findById(rp.userId, rp.accountId);
      const accountName = account?.name ?? rp.accountId;

      const { text, keyboard } = recurringPrompt(rp, accountName);
      await bot.api.sendMessage(session.chatId, text, { reply_markup: keyboard });

      // Clear pending so this defers at most once
      await repos.sessions.set({
        ...session,
        pendingRecurringConfirmation: undefined,
        lastActivityAt: new Date().toISOString(),
      });

      console.log(`[defer-sweep] re-prompted recurringId=${recurringId} chatId=${session.chatId}`);
    } catch (err) {
      console.error(`[defer-sweep] failed for recurringId=${recurringId}`, err);
    }
  }
}
```

- [ ] **Step 4: Write the test**

Create `tests/scheduler/defer-sweep.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { sweepDeferredPayments } from '../../src/scheduler/defer-sweep.js';
import type { Repos } from '../../src/repositories/interfaces.js';
import type { SessionContext, RecurringPayment } from '../../src/domain/entities.js';
import { bot } from '../../src/telegram/bot.js';

vi.mock('../../src/telegram/bot.js', () => ({
  bot: { api: { sendMessage: vi.fn() } },
}));

function mockRepos(expiredSessions: SessionContext[] = []): Repos {
  return {
    users: {
      findByTelegramChatId: vi.fn(), findById: vi.fn(), create: vi.fn(), update: vi.fn(),
    } as never,
    accounts: {
      findAllByUserId: vi.fn(),
      findById: vi.fn(async () => ({ accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 0, isActive: true, createdAt: '', updatedAt: '' })),
      findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn(),
    } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(), findByDateRange: vi.fn(),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(),
      update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: {
      get: vi.fn(),
      set: vi.fn(async () => undefined),
      delete: vi.fn(),
      findExpiredDeferrals: vi.fn(async () => expiredSessions),
    } as never,
    budgets: {
      findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(),
      incrementSpent: vi.fn(), update: vi.fn(),
    } as never,
    recurrings: {
      findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(),
      findById: vi.fn(async () => ({
        recurringId: 'rp-1', userId: 'u1', name: 'Spotify', amount: 59_900,
        accountId: 'a1', categoryId: 'entertainment.streaming', dayOfMonth: 25,
        isActive: true, nextFireAt: '2026-06-25', createdAt: '', updatedAt: '',
      })),
      findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn(),
    } as never,
  };
}

describe('sweepDeferredPayments', () => {
  it('re-prompts for expired deferrals and clears the state', async () => {
    const session: SessionContext = {
      chatId: '123', userId: 'u1', turns: [], lastActivityAt: '',
      pendingRecurringConfirmation: { recurringId: 'rp-1', expiresAt: '2026-06-19T08:00:00Z' },
    };
    const repos = mockRepos([session]);
    await sweepDeferredPayments(repos);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '123', expect.stringContaining('Spotify'), expect.any(Object),
    );
    // pendingRecurringConfirmation cleared
    expect(repos.sessions.set).toHaveBeenCalledWith(
      expect.objectContaining({ pendingRecurringConfirmation: undefined }),
    );
  });

  it('clears state without re-prompting when recurring is inactive', async () => {
    const session: SessionContext = {
      chatId: '123', userId: 'u1', turns: [], lastActivityAt: '',
      pendingRecurringConfirmation: { recurringId: 'rp-1', expiresAt: '2026-06-19T08:00:00Z' },
    };
    const repos = mockRepos([session]);
    (repos.recurrings.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await sweepDeferredPayments(repos);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(repos.sessions.set).toHaveBeenCalledWith(
      expect.objectContaining({ pendingRecurringConfirmation: undefined }),
    );
  });

  it('handles empty sweep (no expired deferrals)', async () => {
    const repos = mockRepos([]);
    await sweepDeferredPayments(repos);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/scheduler/defer-sweep.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Add the session adapter test for `findExpiredDeferrals`**

In `tests/adapters/session.repository.test.ts`, add a test:

```ts
  it('finds sessions with expired deferrals', async () => {
    const user = await seedUser();
    const sessions = new NeonSessionRepository();
    await sessions.set({
      chatId: 'defer-test', userId: user.userId, turns: [],
      pendingRecurringConfirmation: { recurringId: 'rp-x', expiresAt: '2020-01-01T00:00:00Z' },
      lastActivityAt: new Date().toISOString(),
    });
    const expired = await sessions.findExpiredDeferrals();
    expect(expired.find((s) => s.chatId === 'defer-test')).toBeTruthy();
    // Cleanup
    await sessions.delete('defer-test');
  });
```

- [ ] **Step 7: Run all tests**

```bash
npx vitest run tests/scheduler/defer-sweep.test.ts tests/adapters/session.repository.test.ts
```

Expected: all pass.

- [ ] **Step 8: Type-check + lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/repositories/interfaces.ts src/adapters/neon/session.repository.ts src/scheduler/defer-sweep.ts tests/scheduler/defer-sweep.test.ts tests/adapters/session.repository.test.ts
git commit -m "feat(scheduler): 5-min defer sweep with findExpiredDeferrals

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Cron wiring + bot callback registration + index entry point

**Files:**
- Create: `src/scheduler/cron.ts`
- Modify: `src/index.ts`
- (No changes to `src/telegram/bot.ts` — `registerCallbackHandler` already exists in `callback-query.ts`)

- [ ] **Step 1: Write the cron registration module**

Create `src/scheduler/cron.ts`:

```ts
import cron from 'node-cron';
import { fireRecurringPayments } from './recurring-fire.js';
import { sweepDeferredPayments } from './defer-sweep.js';
import { config } from '../config/index.js';
import type { Repos } from '../repositories/interfaces.js';

/** Start both in-process cron jobs (timezone WIB per NFR-10). */
export function startCronJobs(repos: Repos): void {
  // Daily 08:00 WIB — fire recurring payment prompts
  cron.schedule(config.CRON_SCHEDULE, () => {
    fireRecurringPayments(repos).catch((err) =>
      console.error('[cron] recurring-fire error', err),
    );
  }, { timezone: 'Asia/Jakarta' });

  // Every 5 minutes — sweep deferred payments
  cron.schedule('*/5 * * * *', () => {
    sweepDeferredPayments(repos).catch((err) =>
      console.error('[cron] defer-sweep error', err),
    );
  }, { timezone: 'Asia/Jakarta' });

  console.log('[cron] registered daily fire + 5-min defer sweep');
}
```

- [ ] **Step 2: Update `src/index.ts` to wire cron and callback handler**

In `src/index.ts`, add imports:

```ts
import { startCronJobs } from './scheduler/cron.js';
import { registerCallbackHandler } from './telegram/callback-query.js';
```

Then in `main()`, after `registerMessageHandler(...)` and before `bot.start(...)`, add:

```ts
  startCronJobs(repos);
  registerCallbackHandler(repos);
```

The full `main()` function becomes:

```ts
async function main() {
  await migrate();
  await seed();

  const openrouter = createOpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: config.OPENROUTER_API_KEY,
  });
  const model = openrouter(config.OPENROUTER_MODEL);
  const run = createRunner(model);
  const repos = createRepos();

  registerMessageHandler(async (text, chatId) => {
    const { reply } = await handleMessage({
      text,
      chatId,
      repos,
      run,
      system: buildSystemPrompt(todayWIB()),
      contextWindowTurns: config.CONTEXT_WINDOW_TURNS,
      sessionIdleTimeoutMinutes: config.SESSION_IDLE_TIMEOUT_MINUTES,
    });
    return reply;
  });

  startCronJobs(repos);
  registerCallbackHandler(repos);

  console.log('[moneybot] starting long-polling…');
  await bot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: () => console.log('[moneybot] polling'),
  });
}
```

- [ ] **Step 3: Type-check + lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/cron.ts src/index.ts
git commit -m "feat: wire cron jobs + callback handler into entry point

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Full suite verification

**Files:** None new.

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass (existing 72 + new tests from Tasks 2, 4, 5, 6, 7).

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Lint**

```bash
npm run lint
```

Expected: no errors (NFR-02 enforced).

- [ ] **Step 4: Commit (if any fixups needed)**

If clean, no commit needed. If small fixups:

```bash
git add -u && git commit -m "chore: Slice 4 final verification

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Definition of Done (Slice 4)

- [ ] All Vitest tests pass (`npm test`)
- [ ] `npm run lint` and `npx tsc --noEmit` clean
- [ ] `findDueToday` implemented with day-of-month overflow rule, 5 tests
- [ ] `createExpenseCore` extracted and shared between T06 tool and callback handler
- [ ] Formatter (`formatIDR` + `recurringPrompt` + inline keyboard) tested
- [ ] Callback handler (`confirm`/`defer`/`skip`) tested with pure `dispatchRecCallback`
- [ ] Daily fire job sends prompts for due payments, caches chatId per user
- [ ] Defer sweep re-prompts expired deferrals, clears state, skips inactive
- [ ] Cron jobs registered with `timezone: 'Asia/Jakarta'` (NFR-10)
- [ ] `allowed_updates: ['message', 'callback_query']` in `bot.start()` (was already present)
- [ ] No `pg` import outside `src/adapters/neon/` (NFR-02)

## After Slice 4

Slice 5 (Hardening): observability/logging (NFR-07), Bahasa error messages audit (NFR-09), soft-delete filtering everywhere (NFR-06), reconcile script (OQ-03).

---
