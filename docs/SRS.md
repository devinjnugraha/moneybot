# Software Requirements Specification

## MoneyBot — Personal Finance LLM Agent (Telegram)

### Analysis Phase · v1.0

---

## Document Control

| Field            | Value                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Project          | MoneyBot                                                                                 |
| Phase            | Analysis                                                                                 |
| Version          | 1.0                                                                                      |
| Status           | Draft — Ready for Scaffolding                                                            |
| Primary Language | Bahasa Indonesia (agent) · English (codebase)                                            |
| Number Format    | IDR locale — dot as thousands separator, comma as decimal (e.g. `1.500.000` or `59.900`) |
| Timezone         | Asia/Jakarta (WIB)                                                                       |

---

## 1. Project Overview

MoneyBot is a personal finance management agent delivered exclusively through Telegram. Users interact in natural Bahasa Indonesia to log income and expenses, manage accounts, assign budget concern codes, run queries, and automate recurring payment reminders.

Design philosophy: **chat-first, zero-friction logging** — `bakso 20000 bca` is sufficient to produce a fully categorized, persisted expense record with no menus or manual category selection.

The agent is a **ReAct-pattern LLM agent** with full tool-calling autonomy: it categorizes transactions automatically, resolves missing fields via targeted follow-up, and never commits a write unless all required fields are confirmed. Every entity, query, and session is scoped by `userId` — the system is single-user today but **architecturally multi-user-ready** with no global mutable state.

---

## 2. Goals & Success Criteria

| #   | Goal                          | Measurable Criterion                                                                                      |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| G1  | Zero-friction logging         | User records a fully categorized expense in 1 message when account + amount + description are all present |
| G2  | Accurate auto-categorization  | Agent correctly categorizes ≥90% of common Indonesian spending descriptions without user correction       |
| G3  | Concern-based budgeting       | Budget codes tracked independently of categories; one code spans multiple categories                      |
| G4  | Correct account accounting    | CC balances are negative when debt exists; transfers correctly update both balances                       |
| G5  | Natural language reporting    | User can ask "pengeluaran minggu ini per kategori" and receive a correct, formatted breakdown             |
| G6  | Reliable recurring payments   | Recurring payments fire on the correct day with a confirmation prompt; user can skip or defer             |
| G7  | Inline transaction correction | User can correct the last recorded transaction without navigating a menu                                  |

---

## 3. Stakeholders

| Role         | Description                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| Primary User | Single owner; Telegram is the exclusive interface                                                           |
| Future Users | Architecture must support multi-user without structural refactoring (no hard-coded single-user assumptions) |
| Coding Agent | Primary downstream consumer of this SRS; must scaffold without resolving ambiguity                          |

---

## 4. System Context & Architecture

### 4.1 High-Level Component Diagram

```
[Telegram App]
      │
      │  HTTPS POST (webhook)
      ▼
[Telegram Bot Server]  ──  TypeScript / Node.js
      │
      ▼
[Agent Orchestrator]  ──  ReAct loop
      │                    OpenRouter → model configurable via env
      │
      ├──► [Tool Registry]  ──  typed TypeScript functions
      │          │
      │          ▼
      │    [Repository Layer]  ──  TypeScript interfaces (vendor-agnostic)
      │          │
      │          ▼
      │    [Neon Adapter]  ──  @neondatabase/serverless (swappable for any pg-compatible adapter)
      │
      └──► [Scheduler Service]  ──  daily cron (node-cron or AWS EventBridge)
                 │
                 ▼
           Sends Telegram confirmation prompts for due recurring payments
```

### 4.2 Architectural Decisions

| Decision            | Choice                                | Rationale                                                                                         |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Runtime             | TypeScript / Node.js                  | Strong typing for tool schemas; continuity with existing bot                                      |
| Transport           | Telegram Webhooks                     | Lower latency than long-polling; stateless                                                        |
| Database            | Neon (Serverless PostgreSQL)          | Scalable to multi-user; serverless connection pooling; full SQL expressiveness; swappable adapter |
| DB abstraction      | Repository interface layer            | Vendor-agnostic; any pg-compatible migration = new adapter only, zero agent/tool changes          |
| LLM provider        | OpenRouter                            | Model flexibility; single API key; swap models via env var                                        |
| Agent pattern       | ReAct (Reason + Act)                  | Tool-calling loop with internal chain-of-thought; handles multi-step resolution                   |
| Conversation memory | Rolling window (configurable N turns) | Balances context quality vs. token cost                                                           |
| Language (agent)    | Bahasa Indonesia                      | All prompts, responses, and error messages in Indonesian                                          |
| Language (codebase) | English                               | Variable names, comments, types in English throughout                                             |

### 4.3 Directory Structure

```
/src
  /adapters
    /neon           ← Neon PostgreSQL adapter implementations (only place db driver is imported)
    /postgresql     ← (future) alternative pg-compatible adapter
  /agent
    orchestrator.ts
    system-prompt.ts
    context.ts      ← Session context management
  /tools
    index.ts        ← Tool registry
    accounts.ts
    transactions.ts
    budgets.ts
    recurring.ts
    reports.ts
  /repositories
    interfaces.ts   ← IUserRepository, IAccountRepository, etc.
  /scheduler
    cron.ts
  /telegram
    webhook.ts
    formatter.ts    ← All Telegram message formatting
  /domain
    entities.ts
    categories.ts   ← Seeded category taxonomy
  /config
    index.ts        ← All env vars centralized
```

> **Hard rule**: `IRepository` interfaces defined in `/repositories/interfaces.ts`. The Neon adapter in `/adapters/neon/` implements them. The tool layer imports only from `/repositories/interfaces.ts` — never directly from an adapter. This is the seam for future database migration.

---

## 5. Assumptions & Constraints

| #   | Item                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Amounts stored as plain numbers. Display format: IDR locale, dot as thousands separator (e.g. `1.500.000`). Agent never outputs `Rp` or `IDR`. No multi-currency in v1. |
| A2  | One Telegram `chatId` maps to exactly one user profile.                                                                                                                 |
| A3  | Budget codes scoped per calendar month (year + month). Same name in different months = distinct record.                                                                 |
| A4  | Account balance cached on `Account` entity, updated on every write. Transaction log is source of truth; cached balance is a performance optimization.                   |
| A5  | Credit card (`card`) balances always ≤ 0 when outstanding debt exists. CC payment (transfer in) moves balance toward 0.                                                 |
| A6  | `transfer` type transactions excluded from all income/expense reports and budget calculations.                                                                          |
| A7  | Agent MUST NOT commit any write if one or more required fields are unknown or ambiguous. Asks for all missing fields in a single message before proceeding.             |
| A8  | Session context stored per `chatId`. Sessions expire after configurable idle timeout (default 30 min). After expiry, context clears and next message starts fresh.      |
| A9  | "Koreksi transaksi tadi" requires `lastTransactionId` to be present in active session context.                                                                          |
| A10 | Recurring payment scheduler runs as daily cron at 08:00 WIB. Checks for payments due today and sends Telegram confirmation prompts.                                     |
| A11 | Telegram Inline Keyboard buttons used for recurring payment confirmation prompts. Bot must handle `callbackQuery` events in addition to regular messages.               |
| A12 | All date arithmetic uses WIB (UTC+7) as the reference timezone.                                                                                                         |
| A13 | Categories are system-seeded at bootstrap; not user-configurable in v1.                                                                                                 |
| A14 | Telegram `update_id` must be deduplicated to prevent double-processing retried webhook deliveries.                                                                      |

---

## 6. Data Model

### 6.1 Entity Definitions

#### User

```typescript
interface User {
    userId: string; // UUID v4
    telegramChatId: string; // Telegram chat ID — unique
    name: string;
    language: "id" | "en"; // default: 'id'
    timezone: string; // default: 'Asia/Jakarta'
    createdAt: string; // ISO 8601
    updatedAt: string;
}
```

#### Account

```typescript
type AccountType = "cash" | "bank" | "card";

interface Account {
    accountId: string;
    userId: string;
    name: string; // e.g. "BCA", "BCA CC", "Cash", "GoPay"
    type: AccountType;
    balance: number; // cached balance; negative for CC with outstanding debt
    creditLimit?: number; // required only for type: 'card'
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
}
```

**Accounting invariants by account type:**

| Operation                      | `cash` / `bank`   | `card`                            |
| ------------------------------ | ----------------- | --------------------------------- |
| Expense recorded               | balance decreases | balance decreases (more negative) |
| Income recorded                | balance increases | not applicable                    |
| Transfer out                   | balance decreases | not applicable                    |
| Transfer in (incl. CC payment) | balance increases | balance increases (toward 0)      |

#### Category

```typescript
interface Category {
    categoryId: string; // slug, e.g. 'food.dining'
    name: string; // Indonesian label
    nameEn: string; // English label for LLM reasoning
    parentCategoryId?: string;
    icon: string; // emoji
    type: "expense" | "income" | "both";
}
```

> System-seeded at bootstrap. Full taxonomy in Section 10. Users cannot create or modify categories.

#### BudgetCode

```typescript
interface BudgetCode {
    budgetCodeId: string;
    userId: string;
    name: string; // e.g. "raissa", "family", "hobby" — lowercase
    monthlyBudget: number;
    month: number; // 1–12
    year: number;
    spent: number; // cached running total of expenses tagged to this code
    createdAt: string;
    updatedAt: string;
}
```

> Concern-based, not category-based. A single code ("raissa") may span food, shopping, entertainment, etc. Scoped per calendar month — same name in a different month is a separate record.

#### Transaction

```typescript
type TransactionType = "expense" | "income" | "transfer";

interface Transaction {
    transactionId: string;
    userId: string;
    type: TransactionType;
    amount: number; // always positive
    description: string;
    categoryId?: string; // required for expense/income; absent for transfer
    accountId: string; // source account (or sole account for expense/income)
    toAccountId?: string; // destination account; transfer only
    budgetCodeId?: string; // optional; expense only
    date: string; // ISO 8601 date, WIB; defaults to today
    notes?: string;
    isRecurringInstance: boolean;
    recurringId?: string; // populated if generated by the scheduler
    createdAt: string;
    updatedAt: string;
    deletedAt?: string; // soft delete; null = active
}
```

#### RecurringPayment

```typescript
interface RecurringPayment {
    recurringId: string;
    userId: string;
    name: string; // e.g. "Spotify", "Netflix", "Gym"
    amount: number;
    accountId: string;
    categoryId: string;
    budgetCodeId?: string;
    dayOfMonth: number; // 1–31; if > days in month, fire on last day of month
    isActive: boolean;
    lastFiredAt?: string; // ISO 8601 date of last confirmed instance
    nextFireAt: string; // computed date of next fire
    createdAt: string;
    updatedAt: string;
}
```

#### SessionContext _(in-memory / Neon with expiry check)_

```typescript
interface SessionContext {
    chatId: string;
    userId: string;
    turns: ConversationTurn[]; // rolling window of last N turns
    lastTransactionId?: string; // populated after any write; enables "koreksi tadi"
    pendingRecurringConfirmation?: {
        // set when a recurring prompt is in-flight
        recurringId: string;
        expiresAt: string;
    };
    lastActivityAt: string; // ISO 8601; used for idle timeout
}

interface ConversationTurn {
    role: "user" | "assistant";
    content: string;
    timestamp: string;
}
```

---

### 6.2 PostgreSQL Schema (Neon)

#### DDL

```sql
-- Users
CREATE TABLE users (
  user_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id VARCHAR   UNIQUE NOT NULL,
  name           VARCHAR     NOT NULL,
  language       VARCHAR(2)  NOT NULL DEFAULT 'id',
  timezone       VARCHAR     NOT NULL DEFAULT 'Asia/Jakarta',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_users_telegram ON users(telegram_chat_id);

-- Accounts
CREATE TABLE accounts (
  account_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(user_id),
  name         VARCHAR     NOT NULL,
  type         VARCHAR     NOT NULL CHECK (type IN ('cash', 'bank', 'card')),
  balance      NUMERIC     NOT NULL DEFAULT 0,
  credit_limit NUMERIC,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_accounts_user ON accounts(user_id);

-- Categories (system-seeded)
CREATE TABLE categories (
  category_id        VARCHAR PRIMARY KEY,  -- slug e.g. 'food.dining'
  name               VARCHAR NOT NULL,
  name_en            VARCHAR NOT NULL,
  parent_category_id VARCHAR REFERENCES categories(category_id),
  icon               VARCHAR NOT NULL,
  type               VARCHAR NOT NULL CHECK (type IN ('expense', 'income', 'both'))
);

-- Transactions
CREATE TABLE transactions (
  transaction_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES users(user_id),
  type                 VARCHAR     NOT NULL CHECK (type IN ('expense', 'income', 'transfer')),
  amount               NUMERIC     NOT NULL,
  description          VARCHAR     NOT NULL,
  category_id          VARCHAR     REFERENCES categories(category_id),
  account_id           UUID        NOT NULL REFERENCES accounts(account_id),
  to_account_id        UUID        REFERENCES accounts(account_id),
  budget_code_id       UUID,
  date                 DATE        NOT NULL DEFAULT CURRENT_DATE,
  notes                TEXT,
  is_recurring_instance BOOLEAN    NOT NULL DEFAULT false,
  recurring_id         UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX idx_txn_user_date    ON transactions(user_id, date);
CREATE INDEX idx_txn_account_date ON transactions(account_id, date);

-- Budget Codes
CREATE TABLE budget_codes (
  budget_code_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(user_id),
  name           VARCHAR     NOT NULL,
  monthly_budget NUMERIC     NOT NULL,
  month          SMALLINT    NOT NULL CHECK (month BETWEEN 1 AND 12),
  year           SMALLINT    NOT NULL,
  spent          NUMERIC     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name, year, month)
);
CREATE INDEX idx_budget_user_month ON budget_codes(user_id, year, month);

-- Recurring Payments
CREATE TABLE recurring_payments (
  recurring_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(user_id),
  name          VARCHAR     NOT NULL,
  amount        NUMERIC     NOT NULL,
  account_id    UUID        NOT NULL REFERENCES accounts(account_id),
  category_id   VARCHAR     NOT NULL REFERENCES categories(category_id),
  budget_code_id UUID,
  day_of_month  SMALLINT    NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  last_fired_at DATE,
  next_fire_at  DATE        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_recurring_day_active ON recurring_payments(day_of_month) WHERE is_active = true;

-- Session Contexts
CREATE TABLE session_contexts (
  chat_id                        VARCHAR     PRIMARY KEY,
  user_id                        UUID        NOT NULL REFERENCES users(user_id),
  turns                          JSONB       NOT NULL DEFAULT '[]',
  last_transaction_id            UUID,
  pending_recurring_confirmation JSONB,
  last_activity_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Telegram Webhook Idempotency
CREATE TABLE processed_updates (
  update_id    BIGINT      PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### Indexes Summary

| Index                      | Table                | Columns                          | Purpose                                                      |
| -------------------------- | -------------------- | -------------------------------- | ------------------------------------------------------------ |
| `idx_users_telegram`       | `users`              | `telegram_chat_id` (UNIQUE)      | Resolve userId from incoming Telegram chatId                 |
| `idx_accounts_user`        | `accounts`           | `user_id`                        | List accounts for a user                                     |
| `idx_txn_user_date`        | `transactions`       | `(user_id, date)`                | Date-range queries per user                                  |
| `idx_txn_account_date`     | `transactions`       | `(account_id, date)`             | Date-range queries per account                               |
| `idx_budget_user_month`    | `budget_codes`       | `(user_id, year, month)`         | Budget codes for a given month                               |
| `idx_recurring_day_active` | `recurring_payments` | `day_of_month` WHERE `is_active` | Scheduler: find active recurring payments due on a given day |

#### Access Patterns

| Pattern                                  | SQL                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Resolve user from Telegram chatId        | `SELECT * FROM users WHERE telegram_chat_id = $1`                                                                   |
| Get all accounts for user                | `SELECT * FROM accounts WHERE user_id = $1 AND is_active = true`                                                    |
| Get transactions by date range           | `SELECT * FROM transactions WHERE user_id = $1 AND date BETWEEN $2 AND $3 AND deleted_at IS NULL`                   |
| Get transactions by account + date range | `SELECT * FROM transactions WHERE account_id = $1 AND date BETWEEN $2 AND $3 AND deleted_at IS NULL`                |
| Get budget codes for user in a month     | `SELECT * FROM budget_codes WHERE user_id = $1 AND year = $2 AND month = $3`                                        |
| Get specific budget code by name         | Above + `AND name = $4`                                                                                             |
| Get recurring payments due today         | `SELECT * FROM recurring_payments WHERE day_of_month = $1 AND is_active = true`                                     |
| Get single transaction                   | `SELECT * FROM transactions WHERE user_id = $1 AND transaction_id = $2`                                             |
| Get latest N transactions                | `SELECT * FROM transactions WHERE user_id = $1 AND deleted_at IS NULL ORDER BY date DESC, created_at DESC LIMIT $2` |

---

## 7. Repository Layer Contract

These TypeScript interfaces are the **only** abstraction the tool layer and agent may depend on for data access. No `@neondatabase/serverless` or `pg` types may appear outside `/adapters/neon/`. A future migration requires only a new adapter implementing these interfaces.

```typescript
// /src/repositories/interfaces.ts

interface IUserRepository {
    findByTelegramChatId(chatId: string): Promise<User | null>;
    findById(userId: string): Promise<User | null>;
    create(input: CreateUserInput): Promise<User>;
    update(userId: string, patch: Partial<User>): Promise<User>;
}

interface IAccountRepository {
    findAllByUserId(userId: string): Promise<Account[]>;
    findById(userId: string, accountId: string): Promise<Account | null>;
    findByName(userId: string, name: string): Promise<Account | null>;
    create(input: CreateAccountInput): Promise<Account>;
    updateBalance(userId: string, accountId: string, delta: number): Promise<void>;
    update(userId: string, accountId: string, patch: Partial<Account>): Promise<Account>;
}

interface ITransactionRepository {
    create(input: CreateTransactionInput): Promise<Transaction>;
    findByDateRange(userId: string, from: string, to: string): Promise<Transaction[]>;
    findByAccountAndDateRange(userId: string, accountId: string, from: string, to: string): Promise<Transaction[]>;
    findLatestByUserId(userId: string, limit?: number): Promise<Transaction[]>;
    findById(userId: string, transactionId: string): Promise<Transaction | null>;
    update(userId: string, transactionId: string, patch: Partial<Transaction>): Promise<Transaction>;
    softDelete(userId: string, transactionId: string): Promise<void>;
}

interface IBudgetCodeRepository {
    findByUserAndMonth(userId: string, year: number, month: number): Promise<BudgetCode[]>;
    findByName(userId: string, name: string, year: number, month: number): Promise<BudgetCode | null>;
    create(input: CreateBudgetCodeInput): Promise<BudgetCode>;
    incrementSpent(userId: string, budgetCodeId: string, delta: number): Promise<void>;
    update(userId: string, budgetCodeId: string, patch: Partial<BudgetCode>): Promise<BudgetCode>;
}

interface IRecurringPaymentRepository {
    findAllByUserId(userId: string): Promise<RecurringPayment[]>;
    findByDayOfMonth(dayOfMonth: number): Promise<RecurringPayment[]>;
    findById(userId: string, recurringId: string): Promise<RecurringPayment | null>;
    findByName(userId: string, name: string): Promise<RecurringPayment | null>;
    create(input: CreateRecurringPaymentInput): Promise<RecurringPayment>;
    update(userId: string, recurringId: string, patch: Partial<RecurringPayment>): Promise<RecurringPayment>;
    deactivate(userId: string, recurringId: string): Promise<void>;
}

interface ISessionRepository {
    get(chatId: string): Promise<SessionContext | null>;
    set(context: SessionContext): Promise<void>;
    delete(chatId: string): Promise<void>;
}
```

---

## 8. Agent Architecture

### 8.1 ReAct Loop

```
Incoming Telegram message
        │
        ▼
  [1. Resolve User]
  Query users WHERE telegram_chat_id = chatId → userId
  If not found → trigger onboarding (FR-01)
        │
        ▼
  [2. Load Session Context]
  Get rolling conversation history + lastTransactionId
  If last_activity_at expired → treat as fresh session
        │
        ▼
  [3. Append user turn to context]
        │
        ▼
  [4. LLM Call (OpenRouter)]
  System prompt + conversation history + tool schemas → LLM
        │
        ├── LLM outputs tool call(s)
        │         │
        │         ▼
        │   [5. Execute Tool]
        │   Tool fn → Repository → Neon
        │         │
        │         ▼
        │   [6. Append tool result to context]
        │   Loop back to step 4
        │
        └── LLM outputs final text response
                  │
                  ▼
          [7. Send Telegram message]
          Persist session (lastTransactionId if write occurred; update lastActivityAt)
```

### 8.2 System Prompt Principles

The system prompt (`/src/agent/system-prompt.ts`) MUST enforce the following as hard constraints:

| #     | Rule                                                                                                                                                                                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SP-01 | "Kamu adalah asisten keuangan pribadi. Balas selalu dalam Bahasa Indonesia yang natural dan ringkas."                                                                                                                                                                                   |
| SP-02 | Never assume an account exists. Always verify via `get_accounts` before referencing account names or balances.                                                                                                                                                                          |
| SP-03 | **Write gate**: Never call any write tool (`create_*`, `update_*`, `delete_*`, `deactivate_*`) unless ALL required fields are known and unambiguous. If any required field is missing, ask for all missing fields in a single message — do not ask one at a time across multiple turns. |
| SP-04 | After every write, respond with a clean, formatted confirmation summary of exactly what was recorded.                                                                                                                                                                                   |
| SP-05 | If a budget code is over-allocated after an expense, proactively surface the warning in the same response.                                                                                                                                                                              |
| SP-06 | Categorization must always be visible in the confirmation response so the user can spot and correct errors.                                                                                                                                                                             |
| SP-07 | "Transfer" is never categorized as income or expense. It is a balance movement between accounts only.                                                                                                                                                                                   |
| SP-08 | When user says "koreksi transaksi tadi", retrieve `lastTransactionId` from session context. If absent, ask: "Transaksi mana yang mau dikoreksi? Sebutin deskripsi atau tanggalnya."                                                                                                     |
| SP-09 | Agent has full autonomy to chain multiple tool calls to complete a goal. Do not ask for user confirmation between intermediate tool calls — only confirm before final write operations when required fields are resolved.                                                               |
| SP-10 | Format all amounts using IDR locale: dot as thousands separator, no currency symbol (e.g. `20.000`, `1.500.000`). Never output `Rp` or `IDR`.                                                                                                                                           |

### 8.3 Tool Registry

All tools registered in `/src/tools/index.ts` with full JSON Schema definitions for the LLM.

| Tool ID | Function Name                  | Type  | Description                                                                        |
| ------- | ------------------------------ | ----- | ---------------------------------------------------------------------------------- |
| T01     | `get_accounts`                 | read  | List all accounts for the user with current balances                               |
| T02     | `create_account`               | write | Create a new account (cash / bank / card)                                          |
| T03     | `get_categories`               | read  | List all available system categories                                               |
| T04     | `get_budget_codes`             | read  | List all budget codes for a given month/year                                       |
| T05     | `create_budget_code`           | write | Create a new budget code with a monthly allocation                                 |
| T06     | `create_expense`               | write | Record an expense transaction                                                      |
| T07     | `create_income`                | write | Record an income transaction                                                       |
| T08     | `create_transfer`              | write | Move money between two accounts (including CC payment)                             |
| T09     | `get_transactions`             | read  | Query transactions with filters (date range, account, category, budget code, type) |
| T10     | `update_transaction`           | write | Correct a recorded transaction's fields                                            |
| T11     | `soft_delete_transaction`      | write | Soft-delete a transaction (sets `deletedAt`)                                       |
| T12     | `create_recurring_payment`     | write | Set up a recurring payment schedule                                                |
| T13     | `get_recurring_payments`       | read  | List all active recurring payment schedules                                        |
| T14     | `deactivate_recurring_payment` | write | Deactivate (remove) a recurring payment schedule                                   |
| T15     | `get_report`                   | read  | Generate summary report (period / category / budget code breakdown)                |
| T16     | `get_account_balance`          | read  | Get current balance for one or all accounts                                        |

### 8.4 `create_transfer` Implementation Notes

`create_transfer` must execute as a **single atomic PostgreSQL transaction**:

```
BEGIN
  1. INSERT INTO transactions (type: 'transfer', account_id: fromId, to_account_id: toId, amount)
  2. UPDATE accounts SET balance = balance - amount WHERE account_id = fromId
  3. UPDATE accounts SET balance = balance + amount WHERE account_id = toId
COMMIT  ← or ROLLBACK on any failure (automatic; no compensating writes needed)
```

PostgreSQL transaction semantics guarantee atomicity — partial failure causes full rollback with no manual compensation required.

### 8.5 Conversation Context Management

| Config               | Env Var                        | Default                    |
| -------------------- | ------------------------------ | -------------------------- |
| Max turns in context | `CONTEXT_WINDOW_TURNS`         | `20`                       |
| Session idle timeout | `SESSION_IDLE_TIMEOUT_MINUTES` | `30`                       |
| LLM model            | `OPENROUTER_MODEL`             | `anthropic/claude-3-haiku` |

Session storage: Neon `session_contexts` table. On each session load, if `last_activity_at + SESSION_IDLE_TIMEOUT_MINUTES < NOW()`, the row is deleted and a fresh session is initialized. The daily cron also purges any remaining stale sessions as a cleanup pass.

---

## 9. Functional Requirements

### FR-01 · User Onboarding

**Goal:** New Telegram user gets a profile and at least one account before transaction logging is possible.

**When:** Message received from `chatId` with no associated `User` record.

**Then:**

1. Create `User` record (`language: 'id'`, `timezone: 'Asia/Jakarta'`).
2. Send welcome message explaining MoneyBot in Bahasa Indonesia.
3. Immediately prompt user to create their first account (name + type).
4. Block all transaction tools until at least one active `Account` exists for the user.

---

### FR-02 · Account Management

#### FR-02a · Create Account

**When:** `"tambahkan rekening BCA tabungan"` / `"tambah kartu kredit BCA CC limit 20 juta"`

**Then:**

1. Extract: `name`, `type`, `creditLimit` (if `card`).
2. If `type = 'card'` and `creditLimit` absent → ask: `"Berapa limit kartu kredit BCA CC-nya?"`
3. Call `create_account`.
4. Respond:
    ```
    ✅ Akun ditambahkan:
    🏦 BCA CC — Kartu Kredit
    💳 Limit: 20.000.000
    Saldo awal: 0
    ```

#### FR-02b · List Accounts & Balances

**When:** `"lihat saldo"` / `"akun saya"` / `"cek semua rekening"`

**Then:**

1. Call `get_accounts`.
2. Return formatted list. CC accounts with negative balance labeled `(utang)`:
    ```
    💰 Akun Kamu:
    🏦 BCA Tabungan: 5.200.000
    💳 BCA CC: -1.450.000 (utang)
    💵 Cash: 300.000
    ```

---

### FR-03 · Expense Logging

#### FR-03a · Complete Input — All Fields Present

**When:** `"bakso 20000 bca"` (description + amount + account all present)

**Then:**

1. Extract: `description = "bakso"`, `amount = 20000`, `account ≈ "bca"`.
2. Call `get_accounts` to resolve "bca" → `BCA Tabungan (accountId: xyz)`.
3. Auto-categorize "bakso" → `food.dining` (Makan di Luar).
4. Call `create_expense`.
5. Update session: `lastTransactionId = <new id>`.
6. Respond:
    ```
    ✅ Pengeluaran dicatat:
    📝 Bakso — 20.000
    🏦 BCA Tabungan
    🏷️ Makan di Luar
    📅 07 Jun 2025
    ```

#### FR-03b · Missing Account — Agent Asks

**When:** `"beli parfum 449000 budget raissa"` (no account)

**Then:**

1. Extract: `description = "beli parfum"`, `amount = 449000`, `budgetCode = "raissa"`. Detect: `account` missing.
2. Call `get_accounts` for available options.
3. Ask: `"Untuk 'Beli Parfum 449.000', pakai akun mana? (BCA, BCA CC, Cash)"`
4. User replies → resolve account → proceed to FR-03c → then FR-03a steps 3–6.

#### FR-03c · Unregistered Budget Code — Agent Prompts

**When:** Budget code name in message not found in current month's `budget_codes`.

**Then:**

1. Call `get_budget_codes` for current month → name not found.
2. Ask:
    ```
    Budget 'raissa' belum ada untuk bulan ini.
    Mau aku buatkan sekarang? Kalau mau, berapa alokasi budget-nya bulan ini?
    ```
3. User replies amount → call `create_budget_code` (name="raissa", monthlyBudget, current month).
4. Proceed to log expense. Respond with combined confirmation:

    ```
    ✅ Budget 'raissa' dibuat: 2.000.000 / bulan

    ✅ Pengeluaran dicatat:
    📝 Beli Parfum — 449.000
    💳 BCA CC
    🏷️ Perawatan Diri · Budget: raissa
    📅 07 Jun 2025
    ```

#### FR-03d · Budget Overspend Warning

**When:** After `create_expense`, new `spent` total of associated `BudgetCode` exceeds `monthlyBudget`.

**Then:** Expense is recorded normally. Append to confirmation response:

```
⚠️ Budget 'raissa' bulan ini sudah terlampaui.
Terpakai: 2.150.000 dari alokasi 2.000.000
```

---

### FR-04 · Income Logging

**When:** `"terima gaji 8000000 bca"` / `"freelance masuk 2500000 gopay"`

**Then:**

1. Extract: description, amount, account.
2. Auto-categorize into appropriate income category (e.g. `income.salary`, `income.freelance`).
3. Call `create_income`. Update account balance positively.
4. Respond with confirmation summary.

> Income transactions may not have a `budgetCodeId`. Budget codes are for expense tracking only.

---

### FR-05 · Smart Categorization

**When:** Agent has a transaction description to categorize.

**Then:**

1. Use LLM internal reasoning against the full category taxonomy (Section 10) to determine best-fit `categoryId`.
2. Apply common Indonesian terms, brand names, and local context:
    - `"bakso"` → `food.dining`
    - `"gojek"`, `"grab"` → `transport.ridehail`
    - `"indomaret"`, `"alfamart"` → `food.groceries`
    - `"netflix"`, `"spotify"` → `entertainment.streaming`
    - `"bensin"`, `"pertamax"`, `"shell"` → `vehicle.fuel`
    - `"dokter"`, `"klinik"`, `"rumah sakit"` → `health.doctor`
3. Select the most specific subcategory available.
4. If description is genuinely ambiguous (e.g. `"topup"`), ask before proceeding: `"'Topup' ini untuk apa? (GoPay, OVO, game, dll)"`
5. Resolved category always shown in confirmation — this is the user's natural signal to correct it.

---

### FR-06 · Budget Code Management

#### FR-06a · Create Budget Code Explicitly

**When:** `"setup budget 'family' bulan ini 2000000"`

**Then:**

1. Extract: `name = "family"`, `monthlyBudget = 2000000`, `month = current`.
2. Call `create_budget_code`.
3. Respond:
    ```
    ✅ Budget 'family' untuk Juni 2025 dibuat.
    Alokasi: 2.000.000
    ```

#### FR-06b · View Budget Status

**When:** `"status budget bulan ini"` / `"budget raissa gimana?"`

**Then:**

1. Call `get_budget_codes` for current month.
2. Respond with spent, allocation, and percentage for each code:

    ```
    📊 Budget Juni 2025:

    family  : 800.000 / 2.000.000 (40%)
    raissa  : 1.450.000 / 2.000.000 (72.5%) ⚠️
    hobby   : 200.000 / 500.000 (40%)
    ```

#### FR-06c · Budget Code Scope Invariant

Enforced always:

- Scoped by `(userId, name, year, month)`. Same name in different month = different record.
- Agent defaults to current month unless user explicitly specifies another.
- Querying an upcoming month's budget correctly returns `spent = 0`.

---

### FR-07 · Transfers Between Accounts

**When:** `"transfer bca ke cash 500000"` / `"pindahin 200000 dari cash ke BCA"`

**Then:**

1. Extract: `fromAccount`, `toAccount`, `amount`.
2. Call `get_accounts` to resolve any ambiguous account names.
3. Call `create_transfer` — executes atomically (see §8.4): inserts transaction record + updates both balances in a single pg transaction.
4. Update session: `lastTransactionId = <new id>`.
5. Respond:
    ```
    ✅ Transfer dicatat:
    💸 BCA Tabungan → Cash
    💰 500.000
    📅 07 Jun 2025
    ```
6. Transfer transactions excluded from all income/expense reports and budget calculations.

#### FR-07a · Transfer to Credit Card = CC Payment

**When:** `toAccount` is `type: 'card'`

**Then:**

1. Same flow as FR-07. CC account balance delta is **positive** (reduces outstanding debt).
2. Label explicitly as a payment in the confirmation:

    ```
    ✅ Pembayaran CC dicatat:
    🏦 BCA Tabungan → BCA CC
    💰 1.000.000

    Saldo BCA CC sekarang: -450.000
    ```

---

### FR-08 · Transaction Correction

**When:** `"koreksi transaksi tadi"` / `"yang tadi salah, harusnya BCA CC bukan BCA"` / `"koreksi jumlahnya jadi 25000"`

**Then:**

1. Retrieve `lastTransactionId` from session context. If absent: `"Transaksi mana yang mau dikoreksi? Sebutin deskripsi atau tanggalnya."`
2. Call `get_transactions` by `transactionId` to retrieve current record.
3. Identify which fields to change from the correction message.
4. Confirm before applying:

    ```
    Mau koreksi transaksi ini:
    📝 Bakso — 20.000 — BCA Tabungan

    Jadi:
    📝 Bakso — 20.000 — BCA CC

    Betul?
    ```

5. User confirms → call `update_transaction` with corrected fields.
6. Reverse old balance delta and apply new: `updateBalance(oldAccountId, +amount)` then `updateBalance(newAccountId, -amount)`.
7. If `budgetCodeId` or `amount` changed → call `incrementSpent` to reconcile (negative delta for old code, positive for new).
8. Respond with updated transaction summary.

---

### FR-09 · Recurring Payments

#### FR-09a · Set Up Recurring Payment

**When:** `"setup recurring spotify pakai BCA CC setiap tanggal 25 59900"`

**Then:**

1. Extract: `name = "Spotify"`, `account = BCA CC`, `dayOfMonth = 25`, `amount = 59900`.
2. Auto-categorize: `"Spotify"` → `entertainment.streaming`.
3. Resolve account via `get_accounts`.
4. Call `create_recurring_payment`.
5. Respond:
    ```
    ✅ Tagihan rutin dicatat:
    🔁 Spotify — 59.900
    💳 BCA CC · setiap tanggal 25
    🏷️ Streaming
    ```

#### FR-09b · Recurring Payment Scheduler Fires

**When:** Daily cron at 08:00 WIB finds a `RecurringPayment` where `day_of_month = today`, `is_active = true`, and `last_fired_at` is not in the current month.

**Then:**

1. Send Telegram message with inline keyboard:

    ```
    🔔 Tagihan rutin jatuh tempo hari ini:
    Spotify — 59.900 via BCA CC

    Mau aku catat sekarang?
    ```

    **Buttons:** `[✅ Ya, catat]` · `[⏳ Tunda 1 jam]` · `[⏭️ Lewati bulan ini]`

2. **"Ya, catat"** → call `create_expense`, set `lastFiredAt = today`, send confirmation.
3. **"Tunda 1 jam"** → re-send prompt after 60 minutes.
4. **"Lewati bulan ini"** → no transaction created. Set `lastFiredAt = today` to prevent re-firing this month. Respond: `"Oke, Spotify bulan ini dilewati."`

> Edge case: if `dayOfMonth > days in current month` (e.g. day 31 in February), fire on last day of month.

#### FR-09c · View Recurring Payments

**When:** `"daftar tagihan rutin"` / `"recurring apa saja?"`

**Then:**

1. Call `get_recurring_payments`.
2. Respond:

    ```
    🔁 Tagihan Rutin Aktif:

    Spotify   — 59.900  (BCA CC, tgl 25)
    Netflix   — 75.000  (BCA CC, tgl 1)
    Gym       — 200.000 (BCA, tgl 10)
    ```

#### FR-09d · Remove Recurring Payment

**When:** `"hapus recurring spotify"` / `"hentikan tagihan netflix"`

**Then:**

1. Call `get_recurring_payments`, resolve target by name.
2. Confirm: `"Mau hapus recurring 'Spotify — 59.900 via BCA CC'? (Ya/Tidak)"`
3. User confirms → call `deactivate_recurring_payment`.
4. Respond: `"✅ Recurring Spotify dihapus. Tidak akan ada reminder lagi."`

---

### FR-10 · Reporting & Natural Language Queries

#### FR-10a · Period Summary

**When:** `"rekap pengeluaran bulan ini"` / `"total keluar minggu ini"`

**Then:**

1. Resolve natural language date range to absolute ISO dates (WIB):
    - `"bulan ini"` → `YYYY-MM-01` to today
    - `"minggu ini"` → most recent Monday to today
    - `"kemarin"` → yesterday's date
    - `"dari 25 juni sampai sekarang"` → `2025-06-25` to today
    - `"3 hari terakhir"` → today minus 2 days to today
2. Call `get_report` with resolved `from`, `to`, and `type`.
3. Respond:

    ```
    📊 Pengeluaran Juni 2025 (1–7 Jun):
    Total: 1.245.000

    Top Kategori:
    🍜 Makanan & Minuman  : 450.000
    🚗 Transportasi       : 200.000
    🛍️ Belanja            : 595.000
    ```

#### FR-10b · By Category Breakdown

**When:** `"pengeluaran per kategori bulan ini"`

**Then:** Call `get_report` with `groupBy: 'category'`. Return all categories with non-zero spend, sorted by amount descending, with percentage of total.

#### FR-10c · By Budget Code Breakdown

**When:** `"pengeluaran budget raissa bulan ini"` / `"semua transaksi budget family"`

**Then:**

1. Call `get_report` with `budgetCodeName: 'raissa'`, current month.
2. Return: total spent vs. allocation and remaining; individual transactions (date, description, amount, category).

#### FR-10d · Account Balance Snapshot

**When:** `"saldo semua akun"` / `"berapa sisa di BCA?"`

**Then:** Call `get_accounts` (all) or `get_account_balance` (single). CC balances displayed as negative with explicit debt label.

#### FR-10e · Reporting Invariants _(no exceptions)_

- `transfer` type transactions always excluded from income/expense reports and budget calculations.
- Soft-deleted transactions (`deleted_at IS NOT NULL`) always excluded.
- All amounts: IDR locale, dot as thousands separator, no currency symbol (e.g. `1.245.000`).
- All dates displayed as `DD Mon YYYY` in Indonesian (e.g. `07 Jun 2025`).
- Date range resolution always uses WIB (UTC+7).

---

## 10. Category Taxonomy

System-seeded at bootstrap. Not user-modifiable in v1. Agent uses both `name` (Indonesian) and `nameEn` (English) during reasoning.

### Expense Categories

| Slug                      | Indonesian          | English                | Icon |
| ------------------------- | ------------------- | ---------------------- | ---- |
| `food.dining`             | Makan di Luar       | Dining Out             | 🍜   |
| `food.groceries`          | Belanja Dapur       | Groceries              | 🛒   |
| `food.coffee`             | Kopi & Minuman      | Coffee & Drinks        | ☕   |
| `food.snacks`             | Jajanan             | Snacks                 | 🍪   |
| `vehicle.fuel`            | Bensin              | Fuel                   | ⛽   |
| `vehicle.parking`         | Parkir              | Parking                | 🅿️   |
| `vehicle.toll`            | Tol                 | Toll                   | 🛣️   |
| `vehicle.maintenance`     | Perawatan Kendaraan | Vehicle Maintenance    | 🔧   |
| `vehicle.tax`             | Pajak Kendaraan     | Vehicle Tax            | 📋   |
| `transport.ridehail`      | Ojek / Ride-hailing | Ride-hailing           | 🛵   |
| `transport.public`        | Transportasi Umum   | Public Transport       | 🚌   |
| `transport.flazz`         | Flazz               | Flazz                  | 💳   |
| `transport.taxi`          | Taksi               | Taxi                   | 🚕   |
| `shopping.clothing`       | Pakaian & Aksesoris | Clothing & Accessories | 👗   |
| `shopping.electronics`    | Elektronik          | Electronics            | 💻   |
| `shopping.personal_care`  | Perawatan Diri      | Personal Care          | 🧴   |
| `shopping.home`           | Rumah & Perabot     | Home & Living          | 🏠   |
| `shopping.online`         | Belanja Online      | Online Shopping        | 📦   |
| `entertainment.streaming` | Streaming           | Streaming              | 📺   |
| `entertainment.gaming`    | Game                | Gaming                 | 🎮   |
| `entertainment.cinema`    | Bioskop             | Cinema                 | 🎬   |
| `entertainment.events`    | Acara & Hiburan     | Events                 | 🎉   |
| `health.medicine`         | Obat-obatan         | Medicine               | 💊   |
| `health.doctor`           | Dokter & Klinik     | Doctor & Clinic        | 🏥   |
| `health.gym`              | Gym & Olahraga      | Gym & Sports           | 🏋️   |
| `health.insurance`        | Asuransi Kesehatan  | Health Insurance       | 🩺   |
| `health.skincare`         | Perawatan Kulit     | Skincare               | ✨   |
| `bills.electricity`       | Listrik             | Electricity            | ⚡   |
| `bills.internet`          | Internet            | Internet               | 🌐   |
| `bills.phone`             | Telepon             | Phone                  | 📱   |
| `bills.water`             | Air (PDAM)          | Water                  | 💧   |
| `bills.rent`              | Sewa                | Rent                   | 🏘️   |
| `bills.subscription`      | Langganan           | Subscription           | 🔁   |
| `financial.savings`       | Tabungan            | Savings                | 🏦   |
| `financial.investment`    | Investasi           | Investment             | 📈   |
| `financial.loan`          | Cicilan             | Loan Payment           | 💳   |
| `financial.insurance`     | Asuransi            | Insurance              | 🛡️   |
| `education.courses`       | Kursus & Pelatihan  | Courses & Training     | 📚   |
| `education.books`         | Buku & Materi       | Books & Materials      | 📖   |
| `education.school`        | Biaya Sekolah       | School Fees            | 🎓   |
| `life.gifts`              | Hadiah              | Gifts                  | 🎁   |
| `life.donations`          | Donasi              | Donations              | ❤️   |
| `life.family`             | Tunjangan Keluarga  | Family Support         | 👨‍👩‍👧   |
| `life.hobbies`            | Hobi                | Hobbies                | 🎨   |
| `life.events`             | Acara & Perayaan    | Events & Celebrations  | 🥳   |
| `life.terea`              | Rokok & Tembakau    | Tobacco                | 🚬   |
| `travel.accommodation`    | Akomodasi           | Accommodation          | 🏨   |
| `travel.flights`          | Tiket Pesawat       | Flights                | ✈️   |
| `travel.activities`       | Aktivitas Wisata    | Travel Activities      | 🗺️   |
| `business.supplies`       | Perlengkapan Kantor | Office Supplies        | 🖊️   |
| `business.services`       | Layanan Bisnis      | Business Services      | 💼   |
| `other.misc`              | Lain-lain           | Miscellaneous          | 📌   |

### Income Categories

| Slug                       | Indonesian      | English            | Icon |
| -------------------------- | --------------- | ------------------ | ---- |
| `income.salary`            | Gaji            | Salary             | 💰   |
| `income.freelance`         | Freelance       | Freelance          | 🧑‍💻   |
| `income.investment_return` | Hasil Investasi | Investment Returns | 📊   |
| `income.selling`           | Penjualan       | Selling            | 🏷️   |
| `income.bonus`             | Bonus           | Bonus              | 🎯   |
| `income.other`             | Pendapatan Lain | Other Income       | 💵   |

---

## 11. Non-Functional Requirements

| ID     | Requirement             | Target / Constraint                                                                                                                                                           |
| ------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-01 | Response latency        | Agent sends first Telegram response within 5 seconds for standard single-tool transactions                                                                                    |
| NFR-02 | Repository abstraction  | Zero `@neondatabase/serverless` or `pg` imports outside `/src/adapters/neon/`. Enforced via ESLint import rule.                                                               |
| NFR-03 | Multi-user architecture | `userId` present on every entity and every repository method signature. No shared mutable state between users.                                                                |
| NFR-04 | Idempotency             | Incoming Telegram `update_id` values tracked in `processed_updates` table (insert with `ON CONFLICT DO NOTHING`). A duplicate `update_id` is silently ignored.                |
| NFR-05 | Atomicity               | Balance updates on both accounts during a transfer must use a PostgreSQL transaction (`BEGIN/COMMIT`). Any failure causes automatic rollback — no manual compensation needed. |
| NFR-06 | Soft delete             | Transactions are never hard-deleted. `deleted_at` is set. All queries filter `deleted_at IS NULL`.                                                                            |
| NFR-07 | Observability           | All tool invocations, agent reasoning steps, and errors logged with `userId`, `chatId`, `transactionId` (if applicable), and timestamp.                                       |
| NFR-08 | Config via env          | Must be env vars — never hard-coded: `CONTEXT_WINDOW_TURNS`, `SESSION_IDLE_TIMEOUT_MINUTES`, `OPENROUTER_MODEL`, `OPENROUTER_API_KEY`, `CRON_SCHEDULE`, `DATABASE_URL`.       |
| NFR-09 | Error messages          | All user-facing error messages in Bahasa Indonesia. Technical errors logged but not exposed to user.                                                                          |
| NFR-10 | Timezone correctness    | All date defaults, cron scheduling, and date arithmetic must use WIB (Asia/Jakarta, UTC+7).                                                                                   |

---

## 12. Out of Scope (v1)

- Multi-currency support
- Export to CSV / Excel / PDF
- Web dashboard or mobile UI
- Debt tracking between people ("si A utang ke gue")
- Bank statement import or receipt OCR
- Investment portfolio tracking
- Sub-accounts or account grouping
- Category customization by user
- Multi-user UX (architecture is multi-user-ready; user management UI not built)

---

## 13. Open Questions / Risk Log

| #     | Question                                                                                                                | Risk   | Recommended Default                                                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-01 | Should budget codes auto-carry over to next month with same allocation, or require manual setup?                        | Medium | Pending. Recommend: opt-in carryover via `"salin budget bulan lalu"` command.                                                            |
| OQ-02 | If user sends a regular message while a recurring payment confirmation is unanswered, how to handle context collision?  | Medium | Treat as separate intent; keep recurring prompt visually pinned. Do not invalidate it.                                                   |
| OQ-03 | Source of truth for account balance when drift exists between cached `balance` and sum of transactions?                 | High   | Cached balance is operational source. A `reconcile_balance` developer utility tool re-derives and corrects balance from transaction sum. |
| OQ-04 | For recurring payments: if `dayOfMonth = 31` and month has only 28 days, fire on day 28?                                | Low    | Decided in A10: fire on last valid day of month.                                                                                         |
| OQ-05 | Should agent support correcting transactions beyond the last one in session (e.g. "koreksi transaksi Netflix kemarin")? | Low    | Out of scope for FR-08 v1; agent asks user to specify date/description if `lastTransactionId` is absent.                                 |

---

_End of SRS — MoneyBot v1.0 Analysis Phase_
_Next phase: System Design (data access layer scaffolding, agent prompt engineering, tool schema definitions)_
