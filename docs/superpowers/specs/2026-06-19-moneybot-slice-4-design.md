# MoneyBot — Slice 4 Design Spec (Scheduler & Inline Callbacks)

**Status:** Draft
**References:** SRS §FR-09, §FR-09b, §11 (NFR-10); impl design §6, §9

## 1. Goal

Add the recurring payment scheduler — daily 08:00 WIB cron, 5-minute defer sweep, Telegram inline-keyboard callbacks (confirm/defer/skip), and durable `pendingRecurringConfirmation` session state — so recurring payments fire on the correct day with user-facing confirmation prompts.

## 2. Architecture

Two in-process `node-cron` jobs (`timezone: 'Asia/Jakarta'` per NFR-10) + a grammY `callback_query` handler:

```
src/scheduler/
  cron.ts             ← registers both cron jobs
  recurring-fire.ts   ← daily 08:00 due-payment firing
  defer-sweep.ts      ← 5-min deferred-prompt re-fire

src/telegram/
  bot.ts              ← existing; gains callback_query registration
  callback-query.ts   ← inline-keyboard handler (confirm/defer/skip)
  formatter.ts        ← recurring-prompt template + inline keyboard + formatIDR
```

### 2.1 Cron jobs

Both run in-process alongside the grammY long-polling loop. On restart, both re-register — `node-cron` handles dedup via its internal registry.

### 2.2 Dependency injection

The cron jobs and callback handler need:

| Dependency | Source |
|---|---|
| `IRecurringPaymentRepository` | `Repos.recurrings` |
| `IUserRepository` (resolve chatId) | `Repos.users` |
| `ISessionRepository` (defer state) | `Repos.sessions` |
| `ITransactionRepository` (confirm → create expense) | `Repos.transactions` |
| `IAccountRepository` (balance update on confirm) | `Repos.accounts` |
| `IBudgetCodeRepository` (overspend check on confirm) | `Repos.budgets` |
| `Bot` instance (sendMessage, editMessageText) | `src/telegram/bot.ts` |
| `createExpenseExecute` (the tool's execute fn) | extracted from `buildTools` |

The `create_expense` execute function is extracted into a standalone factory so both `buildTools` and the callback handler can call it without duplicating logic.

## 3. Day-of-Month Overflow

On day `D` of a month with `M` days, the selection query fires payments where:

- `day_of_month = D`, **or**
- `day_of_month > M` AND `D = M` (last-day rule)

A day-31 subscription fires on Feb 28. `lastFiredAt` is set to the **actual fire date** (Feb 28). The "not in current month" check then correctly prevents re-firing in February while allowing the normal March 31 fire.

### Method signature (on IRecurringPaymentRepository):

```ts
findDueToday(wibYear: number, wibMonth: number, wibDay: number): Promise<RecurringPayment[]>
```

The scheduler layer computes `wibYear`, `wibMonth`, `wibDay`, and `daysInMonth` from the existing `src/domain/time.ts` helpers, then passes them to the adapter. The adapter uses **only the passed values** — no `CURRENT_DATE` or server-time dependence.

### Selection query:

```sql
SELECT * FROM recurring_payments
WHERE is_active = true
AND (
  day_of_month = $D
  OR (day_of_month > $M_DAYS AND $D = $M_DAYS)
)
AND (
  last_fired_at IS NULL
  OR EXTRACT(MONTH FROM last_fired_at) != $MONTH
  OR EXTRACT(YEAR FROM last_fired_at) != $YEAR
);
```

Parameters: `$D` = `wibDay`, `$M_DAYS` = `lastDayOfMonth(wibYear, wibMonth)`, `$MONTH` = `wibMonth`, `$YEAR` = `wibYear`.

The scheduler layer then resolves `userId → telegramChatId` via `users.findById()` for each result (cached in a Map for multi-payment users).

## 4. Inline Keyboard Format

**Prompt template** (FR-09b):

```
🔔 Tagihan rutin jatuh tempo hari ini:
{rp.name} — {formatIDR(rp.amount)} via {accountName}

Mau aku catat sekarang?
```

**Buttons (3 in a row):**

`[✅ Ya, catat]` · `[⏳ Tunda 1 jam]` · `[⏭️ Lewati bulan ini]`

**Callback data:** `rec:{recurringId}:{action}` where action ∈ `{confirm, defer, skip}`.

## 5. Callback Handlers

### 5.1 Confirm (`rec:{recurringId}:confirm`)

1. Resolve `RecurringPayment` by `recurringId` from the callback data
2. Call the extracted `createExpenseExecute` with:
   - `userId`, `amount`, `description` = `rp.name`, `categoryId` = `rp.categoryId`, `accountId` = `rp.accountId`, `budgetCodeId` = `rp.budgetCodeId`, `date` = today (WIB), `isRecurringInstance = true`, `recurringId = rp.recurringId`
3. Update `rp.lastFiredAt = today` (WIB) via `recurrings.update`
4. `answerCallbackQuery` with text "✅ Dicatat!"
5. `editMessageText` to replace the prompt with a confirmation (same text minus keyboard)

### 5.2 Defer (`rec:{recurringId}:defer`)

1. Resolve `RecurringPayment` → get `userId`
2. Resolve `telegramChatId` from `users.findById(userId)`
3. Read current session: `sessions.get(chatId)`
4. Write `pendingRecurringConfirmation = { recurringId, expiresAt: now + 1h }` via `sessions.set`
5. `answerCallbackQuery` with text "⏳ Nanti diingatkan lagi 1 jam lagi."

### 5.3 Skip (`rec:{recurringId}:skip`)

1. Resolve `RecurringPayment` by `recurringId`
2. Update `rp.lastFiredAt = today` (WIB) via `recurrings.update` — blocks re-fire this month
3. No transaction created
4. `answerCallbackQuery` with text "⏭️ Dilewati bulan ini."
5. `editMessageText` to replace prompt with "⏭️ {name} bulan ini dilewati." (no keyboard)

### 5.4 Error/race conditions

- If `recurringId` not found → `answerCallbackQuery("Tagihan ini sudah dihapus.", alert: true)`, no further action
- If `lastFiredAt` already in current month (double-tap) → `answerCallbackQuery("Sudah diproses sebelumnya.", alert: true)`, no further action
- If session row missing on defer → `answerCallbackQuery("Sesi tidak ditemukan, coba lagi.", alert: true)`

## 6. Defer Sweep (5-minute cron)

1. Query all `session_contexts` where `pendingRecurringConfirmation.expiresAt <= NOW()`
2. For each:
   a. Resolve `RecurringPayment` by `pendingRecurringConfirmation.recurringId`
   b. Re-send the prompt + keyboard (same format as daily fire)
   c. Clear `pendingRecurringConfirmation` (`sessions.set` with `pendingRecurringConfirmation: undefined`)
   d. If `RecurringPayment` is inactive or deleted since the defer was set, skip (no prompt, just clear the field)

This makes defer **durable across restarts** — state lives in `session_contexts`, not in a `setTimeout`. Each defer re-prompts at most once; a second "Tunda" creates a fresh `expiresAt`. If the user ignores the re-prompt, no further auto-prompts that day.

## 7. createExpenseExecute Extraction

The `create_expense` tool's execute function is extracted from `src/agent/tools.ts` into a standalone helper:

```ts
// src/tools/create-expense-execute.ts (or kept in tools.ts as an exported function)

export async function createExpenseExecute(params: {
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
}): Promise<TransactionResult>
```

This function is what the T06 tool calls, and what the callback handler calls. No logic duplication.

## 8. Wiring in src/index.ts

```ts
// After bot.start() or before — cron starts with the process
startCronJobs(repos);

// Register callback query handler
registerCallbackHandler(repos);
```

`registerCallbackHandler` is exported from `src/telegram/callback-query.ts`; it calls `bot.callbackQuery(...)` for the `rec:` pattern.

`startCronJobs` is exported from `src/scheduler/cron.ts`; it registers both `node-cron` jobs with `timezone: 'Asia/Jakarta'`.

## 9. Repository Changes

**`IRecurringPaymentRepository`** — no new methods needed. `findByDayOfMonth` already exists; the overflow query is SQL inside the adapter (new method `findDueToday`), or the selection logic lives in the scheduler layer using existing `findByDayOfMonth` + last-day filtering in application code.

**Decision:** Add `findDueToday(wibYear, wibMonth, wibDay)` to the recurring payment repository interface and adapter. The adapter handles the overflow SQL; the scheduler layer passes WIB values computed from `src/domain/time.ts` and resolves `userId → telegramChatId` via `users.findById` (cached per user for efficiency).

**`ISessionRepository`** — no changes. Existing `get`/`set` handle `pendingRecurringConfirmation` already (it's on the `SessionContext` type).

**`IUserRepository`** — no changes needed. `findById` already exists; the scheduler calls it to resolve chat IDs.

## 10. Test Plan

| Suite | What it tests | DB |
|---|---|---|
| `tests/scheduler/recurring-fire.test.ts` | Correct payments selected (normal day, overflow, already-fired-this-month excluded); correct messages sent with keyboard | Mocked repos + bot |
| `tests/scheduler/defer-sweep.test.ts` | Only expired `pendingRecurringConfirmation` rows re-prompted; cleared after re-fire; inactive recurrings skipped | Mocked repos |
| `tests/telegram/callback-query.test.ts` | `confirm` creates expense + updates lastFiredAt; `defer` writes session state; `skip` only updates lastFiredAt; error cases (not found, double-tap) | Mocked repos |
| `tests/telegram/formatter.test.ts` | `formatIDR` output; recurring prompt text and keyboard structure | None |
| `tests/adapters/recurring-payment.repository.test.ts` | `findDueToday` with overflow cases | Real DB |

## 11. Non-Functional Requirements

| NFR | How satisfied |
|---|---|
| NFR-02 (no `pg` outside adapters) | `findDueToday` is in the adapter; scheduler layer calls it via interface |
| NFR-07 (observability) | Cron fires and callback actions logged with `userId` + `recurringId` |
| NFR-08 (config via env) | `CRON_SCHEDULE` already in `src/config/index.ts` |
| NFR-09 (Bahasa errors) | All callback answers are in Indonesian |
| NFR-10 (timezone) | Cron jobs use `timezone: 'Asia/Jakarta'`; date arithmetic uses existing WIB helpers |

## 12. Out of Scope (Slice 5)

- Observability logging (NFR-07) — proper structured logging added in Slice 5
- Reconcile script (OQ-03)
- Soft-delete audit pass (NFR-06)
