# MoneyBot — Slice 0 + 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up MoneyBot's skeleton and a working vertical slice so that a Telegram message like `bakso 20000 bca` produces a fully categorized, persisted expense and an Indonesian confirmation reply.

**Architecture:** Always-on Node.js + grammY long-polling (no HTTP server) → Vercel AI SDK `generateText` ReAct loop → thin Zod-typed tools → repository interfaces → Neon Postgres via `pg`. Every layer is `userId`-scoped. Write tools never throw; they return discriminated `WriteResult` objects so the loop always continues.

**Tech Stack:** TypeScript 5, grammY, Vercel AI SDK (`ai` + `@ai-sdk/openai` against OpenRouter), `zod`, `pg` (Neon), `node-cron` (later slice), Vitest, ESLint, `tsx`, Docker (for the test Postgres).

**Scope of THIS plan:** Slice 0 (skeleton + infra) and Slice 1 (vertical slice). Produces working, testable software on its own. Subsequent slices (remaining tools, reports, scheduler, hardening) get their own plans.

**Reference:** Design spec at `docs/superpowers/specs/2026-06-14-moneybot-impl-design.md`. SRS at `docs/SRS.md`. Where this plan and the SRS differ, the design spec is authoritative (it records the deltas: `pg` over `@neondatabase/serverless`, grammY polling over webhooks, `processed_updates` dropped, `turns` stores full `CoreMessage[]`).

---

## File Structure (this plan's deliverables)

```
moneybot/
  package.json                      # deps + scripts
  tsconfig.json
  vitest.config.ts
  eslint.config.js
  docker-compose.yml                # local test Postgres
  .env.example
  migrations/
    001_init.sql                    # SRS §6.2 DDL minus processed_updates
  src/
    config/index.ts                 # zod-validated env
    domain/
      entities.ts                   # User, Account, Transaction, etc. + WriteResult + SessionContext
      categories.ts                 # CATEGORIES taxonomy (SRS §10) — single source of truth
      time.ts                       # WIB date helpers (NFR-10)
    repositories/
      interfaces.ts                 # SRS §7 contract (all 6 interfaces + input types + Repos)
    adapters/neon/
      pool.ts                       # pg Pool + WIB-safe date type parsers
      migrate.ts                    # migration runner
      seed.ts                       # category seeder
      mappers.ts                    # snake_case row → camelCase entity
      user.repository.ts            # implements IUserRepository
      account.repository.ts         # implements IAccountRepository
      transaction.repository.ts     # implements ITransactionRepository
      session.repository.ts         # implements ISessionRepository
      repos.ts                      # createRepos() — assemble implemented repos
    agent/
      run-agent.ts                  # AgentRunner seam wrapping generateText (testability)
      orchestrator-helpers.ts       # pure: isExpired, freshSession, trimTurns, extractLastTransactionId
      system-prompt.ts              # BASE_PROMPT + formatCategories(CATEGORIES)
      tools.ts                      # buildTools({ userId, repos, hasAccount })
      orchestrator.ts               # handleMessage({ text, chatId, repos, model, run, system })
    telegram/
      bot.ts                        # grammY Bot + registerMessageHandler
    index.ts                        # entry: migrate, seed, wire, bot.start
  tests/
    global-setup.ts                 # migrate + seed once per test run
    setup.ts                        # beforeEach resetDb
    helpers/
      db.ts                         # resetDb, query helper
    adapters/
      user.repository.test.ts
      account.repository.test.ts
      transaction.repository.test.ts
      session.repository.test.ts
    agent/
      orchestrator-helpers.test.ts
      tools.test.ts
      orchestrator.test.ts
```

**Design discipline:** Each file has one responsibility. `run-agent.ts` is a deliberate one-function seam so the orchestrator is fully unit-testable without SDK-version-specific mocks. `categories.ts` is the single source of truth consumed by both the seeder and the system prompt (DRY). The only place `pg` is imported is `adapters/neon/` (NFR-02).

---

## Task 1: Scaffold the project

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`
- Create dirs: `src/`, `src/{config,domain,repositories,adapters/neon,agent,telegram}`, `tests/`, `migrations/`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "moneybot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "migrate": "tsx src/adapters/neon/migrate.ts",
    "seed": "tsx src/adapters/neon/seed.ts",
    "reconcile": "tsx scripts/reconcile.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint ."
  },
  "dependencies": {
    "@ai-sdk/openai": "^1.0.0",
    "ai": "^4.0.0",
    "grammy": "^1.30.0",
    "pg": "^8.13.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/pg": "^8.11.0",
    "eslint": "^9.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"]
}
```

- [ ] **Step 3: Create directory structure**

Run:
```bash
mkdir -p src/config src/domain src/repositories src/adapters/neon src/agent src/telegram tests/helpers tests/adapters tests/agent migrations scripts
```

- [ ] **Step 4: Create `.env.example`**

```bash
# Postgres (Neon or local Docker — see docker-compose.yml)
DATABASE_URL=postgres://moneybot:moneybot@localhost:5433/moneybot

# Telegram
TELEGRAM_BOT_TOKEN=000000000:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# OpenRouter
OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENROUTER_MODEL=anthropic/claude-3-haiku

# Tunables
CONTEXT_WINDOW_TURNS=20
SESSION_IDLE_TIMEOUT_MINUTES=30
CRON_SCHEDULE=0 8 * * *
```

> The local Docker DB uses port 5433 to avoid clashing with any host Postgres.

- [ ] **Step 5: Install dependencies**

Run:
```bash
npm install
```
Expected: a `node_modules/` directory appears; `package-lock.json` is created. No errors.

- [ ] **Step 6: Verify TypeScript compiles (no source yet — should error cleanly)**

Run: `npx tsc --noEmit`
Expected: error `No inputs were found` (because no `.ts` yet) — this is fine; it confirms TS is wired. If you see a different error, fix config before continuing.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json .env.example
git commit -m "chore: scaffold moneybot project (package.json, tsconfig, .env.example)"
```

---

## Task 2: ESLint with the NFR-02 import rule

**Files:**
- Create: `eslint.config.js`

NFR-02 requires that `pg` (and any DB driver) is imported only inside `src/adapters/neon/`. We enforce this with ESLint `no-restricted-imports`. This rule is itself a test — it fails the build if the seam leaks.

- [ ] **Step 1: Create `eslint.config.js`**

```js
// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // NFR-02: no DB driver imports outside the Neon adapter
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pg', 'pg/*', '@neondatabase/serverless'],
              message:
                'DB drivers may only be imported inside src/adapters/neon/*.ts (NFR-02).',
              allowTypeImports: false,
            },
          ],
        },
      ],
    },
  },
  {
    // The adapter itself is allowed to import the driver
    files: ['src/adapters/neon/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
```

- [ ] **Step 2: Add ESLint typescript-eslint deps**

Run:
```bash
npm install -D @eslint/js typescript-eslint globals
```

- [ ] **Step 3: Run lint (expect success — no source yet that violates)**

Run: `npm run lint`
Expected: passes (no errors). If `eslint.config.js` itself errors on `@ts-check`, that's fine — it's just editor hinting.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.js package.json package-lock.json
git commit -m "chore: eslint with NFR-02 no-restricted-imports rule for db drivers"
```

---

## Task 3: Test infrastructure (Docker Postgres + Vitest setup)

**Files:**
- Create: `docker-compose.yml`
- Create: `vitest.config.ts`
- Create: `tests/global-setup.ts`
- Create: `tests/setup.ts`
- Create: `tests/helpers/db.ts`

Repository tests hit a **real Postgres** (no DB mocks — money correctness lives here). We spin a local Postgres via Docker Compose on port 5433, run migrations + seed once per test run (`global-setup.ts`), and truncate user-data tables before each test (`setup.ts`). Categories are seeded once and never truncated (transaction FKs need them).

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: moneybot
      POSTGRES_PASSWORD: moneybot
      POSTGRES_DB: moneybot
    ports:
      - "5433:5432"
    tmpfs:
      - /var/lib/postgresql/data
```

`tmpfs` keeps the test DB in RAM — fast, and it resets every container restart.

- [ ] **Step 2: Create `tests/helpers/db.ts`**

```ts
import { pool } from '../../src/adapters/neon/pool.js';

const USER_TABLES = [
  'session_contexts',
  'transactions',
  'budget_codes',
  'recurring_payments',
  'accounts',
  'users',
];

/** Truncate all user-data tables. Categories and _migrations are preserved. */
export async function resetDb(): Promise<void> {
  // CASCADE handles FK ordering
  await pool.query(`TRUNCATE ${USER_TABLES.join(', ')} CASCADE`);
}

export { pool };
```

> Note: `pool` is imported from the real adapter here. This file lives under `tests/` not `src/adapters/neon/`, so the ESLint rule (which scopes to `src/**`) does not flag it. We must NOT add `tests/**` to the rule's scope — tests legitimately touch `pool` for reset only.

- [ ] **Step 3: Create `tests/global-setup.ts`**

This runs once before the whole test suite: applies migrations and seeds categories.

```ts
import { migrate } from '../src/adapters/neon/migrate.js';
import { seed } from '../src/adapters/neon/seed.js';

export default async function globalSetup() {
  await migrate();
  await seed();
}
```

- [ ] **Step 4: Create `tests/setup.ts`**

Runs before every test file; `beforeEach` truncates user data.

```ts
import { beforeEach } from 'vitest';
import { resetDb } from './helpers/db.js';

beforeEach(async () => {
  await resetDb();
});
```

- [ ] **Step 5: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    // DB integration tests are I/O-bound; serialize to avoid pool contention noise
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
```

`singleFork: true` runs tests serially in one process — simpler reasoning about DB state and avoids running migrations multiple times.

- [ ] **Step 6: Start the test DB**

Run: `docker compose up -d`
Expected: a running `postgres` container. Verify with `docker compose ps`.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml vitest.config.ts tests/
git commit -m "test: vitest setup with real Postgres (docker-compose), global migrate+seed, per-test truncation"
```

> Tasks 1–3 create references to files (`pool.ts`, `migrate.ts`, `seed.ts`) that don't exist yet — that's expected. They are implemented in Tasks 4–9. The test suite cannot run until then.

---

## Task 4: Config module (zod-validated env, NFR-08)

**Files:**
- Create: `src/config/index.ts`

- [ ] **Step 1: Write `src/config/index.ts`**

```ts
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-3-haiku'),
  CONTEXT_WINDOW_TURNS: z.coerce.number().int().positive().default(20),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  CRON_SCHEDULE: z.string().default('0 8 * * *'),
});

export type AppConfig = z.infer<typeof schema>;

export const config: AppConfig = schema.parse(process.env);
```

If any required var is missing at import time, this throws immediately with a clear Zod error — fail fast on misconfiguration.

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config/index.ts
git commit -m "feat(config): zod-validated env config (NFR-08)"
```

---

## Task 5: Domain types — entities, WriteResult, SessionContext

**Files:**
- Create: `src/domain/entities.ts`
- Create: `src/domain/time.ts`

These match SRS §6.1, with the design-spec delta that `SessionContext.turns` holds `CoreMessage[]` (not the thin `ConversationTurn`).

- [ ] **Step 1: Write `src/domain/entities.ts`**

```ts
import type { CoreMessage } from 'ai';

export type AccountType = 'cash' | 'bank' | 'card';
export type TransactionType = 'expense' | 'income' | 'transfer';

export interface User {
  userId: string;
  telegramChatId: string;
  name: string;
  language: 'id' | 'en';
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  accountId: string;
  userId: string;
  name: string;
  type: AccountType;
  balance: number;
  creditLimit?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  categoryId: string; // slug, e.g. 'food.dining'
  name: string;
  nameEn: string;
  parentCategoryId?: string;
  icon: string;
  type: 'expense' | 'income' | 'both';
}

export interface BudgetCode {
  budgetCodeId: string;
  userId: string;
  name: string;
  monthlyBudget: number;
  month: number; // 1–12
  year: number;
  spent: number;
  createdAt: string;
  updatedAt: string;
}

export interface Transaction {
  transactionId: string;
  userId: string;
  type: TransactionType;
  amount: number;
  description: string;
  categoryId?: string;
  accountId: string;
  toAccountId?: string;
  budgetCodeId?: string;
  date: string; // 'YYYY-MM-DD' (WIB)
  notes?: string;
  isRecurringInstance: boolean;
  recurringId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface RecurringPayment {
  recurringId: string;
  userId: string;
  name: string;
  amount: number;
  accountId: string;
  categoryId: string;
  budgetCodeId?: string;
  dayOfMonth: number;
  isActive: boolean;
  lastFiredAt?: string;
  nextFireAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionContext {
  chatId: string;
  userId: string;
  turns: CoreMessage[];
  lastTransactionId?: string;
  pendingRecurringConfirmation?: {
    recurringId: string;
    expiresAt: string;
  };
  lastActivityAt: string;
}

/**
 * Discriminated result returned by every write tool. Tools NEVER throw across
 * this boundary — the ReAct loop reads the status and continues. See design §5.
 */
export type WriteResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'missing_fields'; missing: string[]; options?: Record<string, unknown> }
  | { status: 'ambiguous'; field: string; matches: { id: string; label: string }[] }
  | { status: 'error'; message: string };

export type AccountResult = WriteResult<Account>;
export type TransactionResult = WriteResult<{
  transaction: Transaction;
  budget?: { spent: number; limit: number; exceeded: boolean };
}>;
```

- [ ] **Step 2: Write `src/domain/time.ts`**

WIB-correct date helpers. The app computes today's date in Asia/Jakarta rather than relying on the DB's `CURRENT_DATE` (Neon's server clock is UTC — near midnight WIB this would be off by a day). NFR-10.

```ts
const TZ = 'Asia/Jakarta';

/** Today's date in WIB as 'YYYY-MM-DD'. */
export function todayWIB(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** ISO 8601 timestamp for "now" in WIB. */
export function nowWIB(now: Date = new Date()): string {
  // toISOString is UTC; that's fine for timestamps (TZ-aware). Use for created_at etc.
  return now.toISOString();
}

/** Last day of the month for a given year/month. */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate(); // day 0 of next month = last day of this month
}
```

- [ ] **Step 3: Verify type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/domain/entities.ts src/domain/time.ts
git commit -m "feat(domain): entities, WriteResult contract, WIB time helpers"
```

---

## Task 6: Category taxonomy (single source of truth)

**Files:**
- Create: `src/domain/categories.ts`

This array is consumed by BOTH the seeder (Task 9) and the system prompt (Task 15). Defining it once is DRY — never duplicate the taxonomy.

- [ ] **Step 1: Write `src/domain/categories.ts`**

```ts
import type { Category } from './entities.js';

// SRS §10. Single source of truth — consumed by seed.ts and system-prompt.ts.
export const CATEGORIES: ReadonlyArray<
  Omit<Category, 'parentCategoryId'> & { parentCategoryId?: string }
> = [
  // Expense
  { categoryId: 'food.dining', name: 'Makan di Luar', nameEn: 'Dining Out', icon: '🍜', type: 'expense' },
  { categoryId: 'food.groceries', name: 'Belanja Dapur', nameEn: 'Groceries', icon: '🛒', type: 'expense' },
  { categoryId: 'food.coffee', name: 'Kopi & Minuman', nameEn: 'Coffee & Drinks', icon: '☕', type: 'expense' },
  { categoryId: 'food.snacks', name: 'Jajanan', nameEn: 'Snacks', icon: '🍪', type: 'expense' },
  { categoryId: 'vehicle.fuel', name: 'Bensin', nameEn: 'Fuel', icon: '⛽', type: 'expense' },
  { categoryId: 'vehicle.parking', name: 'Parkir', nameEn: 'Parking', icon: '🅿️', type: 'expense' },
  { categoryId: 'vehicle.toll', name: 'Tol', nameEn: 'Toll', icon: '🛣️', type: 'expense' },
  { categoryId: 'vehicle.maintenance', name: 'Perawatan Kendaraan', nameEn: 'Vehicle Maintenance', icon: '🔧', type: 'expense' },
  { categoryId: 'vehicle.tax', name: 'Pajak Kendaraan', nameEn: 'Vehicle Tax', icon: '📋', type: 'expense' },
  { categoryId: 'transport.ridehail', name: 'Ojek / Ride-hailing', nameEn: 'Ride-hailing', icon: '🛵', type: 'expense' },
  { categoryId: 'transport.public', name: 'Transportasi Umum', nameEn: 'Public Transport', icon: '🚌', type: 'expense' },
  { categoryId: 'transport.flazz', name: 'Flazz', nameEn: 'Flazz', icon: '💳', type: 'expense' },
  { categoryId: 'transport.taxi', name: 'Taksi', nameEn: 'Taxi', icon: '🚕', type: 'expense' },
  { categoryId: 'shopping.clothing', name: 'Pakaian & Aksesoris', nameEn: 'Clothing & Accessories', icon: '👗', type: 'expense' },
  { categoryId: 'shopping.electronics', name: 'Elektronik', nameEn: 'Electronics', icon: '💻', type: 'expense' },
  { categoryId: 'shopping.personal_care', name: 'Perawatan Diri', nameEn: 'Personal Care', icon: '🧴', type: 'expense' },
  { categoryId: 'shopping.home', name: 'Rumah & Perabot', nameEn: 'Home & Living', icon: '🏠', type: 'expense' },
  { categoryId: 'shopping.online', name: 'Belanja Online', nameEn: 'Online Shopping', icon: '📦', type: 'expense' },
  { categoryId: 'entertainment.streaming', name: 'Streaming', nameEn: 'Streaming', icon: '📺', type: 'expense' },
  { categoryId: 'entertainment.gaming', name: 'Game', nameEn: 'Gaming', icon: '🎮', type: 'expense' },
  { categoryId: 'entertainment.cinema', name: 'Bioskop', nameEn: 'Cinema', icon: '🎬', type: 'expense' },
  { categoryId: 'entertainment.events', name: 'Acara & Hiburan', nameEn: 'Events', icon: '🎉', type: 'expense' },
  { categoryId: 'health.medicine', name: 'Obat-obatan', nameEn: 'Medicine', icon: '💊', type: 'expense' },
  { categoryId: 'health.doctor', name: 'Dokter & Klinik', nameEn: 'Doctor & Clinic', icon: '🏥', type: 'expense' },
  { categoryId: 'health.gym', name: 'Gym & Olahraga', nameEn: 'Gym & Sports', icon: '🏋️', type: 'expense' },
  { categoryId: 'health.insurance', name: 'Asuransi Kesehatan', nameEn: 'Health Insurance', icon: '🩺', type: 'expense' },
  { categoryId: 'health.skincare', name: 'Perawatan Kulit', nameEn: 'Skincare', icon: '✨', type: 'expense' },
  { categoryId: 'bills.electricity', name: 'Listrik', nameEn: 'Electricity', icon: '⚡', type: 'expense' },
  { categoryId: 'bills.internet', name: 'Internet', nameEn: 'Internet', icon: '🌐', type: 'expense' },
  { categoryId: 'bills.phone', name: 'Telepon', nameEn: 'Phone', icon: '📱', type: 'expense' },
  { categoryId: 'bills.water', name: 'Air (PDAM)', nameEn: 'Water', icon: '💧', type: 'expense' },
  { categoryId: 'bills.rent', name: 'Sewa', nameEn: 'Rent', icon: '🏘️', type: 'expense' },
  { categoryId: 'bills.subscription', name: 'Langganan', nameEn: 'Subscription', icon: '🔁', type: 'expense' },
  { categoryId: 'financial.savings', name: 'Tabungan', nameEn: 'Savings', icon: '🏦', type: 'expense' },
  { categoryId: 'financial.investment', name: 'Investasi', nameEn: 'Investment', icon: '📈', type: 'expense' },
  { categoryId: 'financial.loan', name: 'Cicilan', nameEn: 'Loan Payment', icon: '💳', type: 'expense' },
  { categoryId: 'financial.insurance', name: 'Asuransi', nameEn: 'Insurance', icon: '🛡️', type: 'expense' },
  { categoryId: 'education.courses', name: 'Kursus & Pelatihan', nameEn: 'Courses & Training', icon: '📚', type: 'expense' },
  { categoryId: 'education.books', name: 'Buku & Materi', nameEn: 'Books & Materials', icon: '📖', type: 'expense' },
  { categoryId: 'education.school', name: 'Biaya Sekolah', nameEn: 'School Fees', icon: '🎓', type: 'expense' },
  { categoryId: 'life.gifts', name: 'Hadiah', nameEn: 'Gifts', icon: '🎁', type: 'expense' },
  { categoryId: 'life.donations', name: 'Donasi', nameEn: 'Donations', icon: '❤️', type: 'expense' },
  { categoryId: 'life.family', name: 'Tunjangan Keluarga', nameEn: 'Family Support', icon: '👨‍👩‍👧', type: 'expense' },
  { categoryId: 'life.hobbies', name: 'Hobi', nameEn: 'Hobbies', icon: '🎨', type: 'expense' },
  { categoryId: 'life.events', name: 'Acara & Perayaan', nameEn: 'Events & Celebrations', icon: '🥳', type: 'expense' },
  { categoryId: 'life.terea', name: 'Rokok & Tembakau', nameEn: 'Tobacco', icon: '🚬', type: 'expense' },
  { categoryId: 'travel.accommodation', name: 'Akomodasi', nameEn: 'Accommodation', icon: '🏨', type: 'expense' },
  { categoryId: 'travel.flights', name: 'Tiket Pesawat', nameEn: 'Flights', icon: '✈️', type: 'expense' },
  { categoryId: 'travel.activities', name: 'Aktivitas Wisata', nameEn: 'Travel Activities', icon: '🗺️', type: 'expense' },
  { categoryId: 'business.supplies', name: 'Perlengkapan Kantor', nameEn: 'Office Supplies', icon: '🖊️', type: 'expense' },
  { categoryId: 'business.services', name: 'Layanan Bisnis', nameEn: 'Business Services', icon: '💼', type: 'expense' },
  { categoryId: 'other.misc', name: 'Lain-lain', nameEn: 'Miscellaneous', icon: '📌', type: 'expense' },
  // Income
  { categoryId: 'income.salary', name: 'Gaji', nameEn: 'Salary', icon: '💰', type: 'income' },
  { categoryId: 'income.freelance', name: 'Freelance', nameEn: 'Freelance', icon: '🧑‍💻', type: 'income' },
  { categoryId: 'income.investment_return', name: 'Hasil Investasi', nameEn: 'Investment Returns', icon: '📊', type: 'income' },
  { categoryId: 'income.selling', name: 'Penjualan', nameEn: 'Selling', icon: '🏷️', type: 'income' },
  { categoryId: 'income.bonus', name: 'Bonus', nameEn: 'Bonus', icon: '🎯', type: 'income' },
  { categoryId: 'income.other', name: 'Pendapatan Lain', nameEn: 'Other Income', icon: '💵', type: 'income' },
];
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/domain/categories.ts
git commit -m "feat(domain): seeded category taxonomy (SRS §10, single source of truth)"
```

---

## Task 7: Repository interfaces (SRS §7 contract)

**Files:**
- Create: `src/repositories/interfaces.ts`

This file defines the full SRS §7 contract. Slice 1 implements only the four repositories it needs; the remaining two (budget codes, recurring payments) are implemented in a later slice. The `Repos` type here includes all six so the contract is complete — Slice 1's `createRepos()` returns a partial that grows.

- [ ] **Step 1: Write `src/repositories/interfaces.ts`**

```ts
import type {
  User,
  Account,
  Transaction,
  BudgetCode,
  RecurringPayment,
  SessionContext,
  AccountType,
  TransactionType,
} from '../domain/entities.js';

// ---- Input types ----

export interface CreateUserInput {
  telegramChatId: string;
  name: string;
  language?: 'id' | 'en';
  timezone?: string;
}

export interface CreateAccountInput {
  userId: string;
  name: string;
  type: AccountType;
  creditLimit?: number;
  openingBalance?: number;
}

export interface CreateTransactionInput {
  userId: string;
  type: TransactionType;
  amount: number;
  description: string;
  categoryId?: string;
  accountId: string;
  toAccountId?: string;
  budgetCodeId?: string;
  date: string; // 'YYYY-MM-DD' (WIB)
  notes?: string;
  isRecurringInstance?: boolean;
  recurringId?: string;
}

export interface CreateBudgetCodeInput {
  userId: string;
  name: string;
  monthlyBudget: number;
  month: number;
  year: number;
}

export interface CreateRecurringPaymentInput {
  userId: string;
  name: string;
  amount: number;
  accountId: string;
  categoryId: string;
  budgetCodeId?: string;
  dayOfMonth: number;
  nextFireAt: string;
}

// ---- Repository interfaces (SRS §7) ----

export interface IUserRepository {
  findByTelegramChatId(chatId: string): Promise<User | null>;
  findById(userId: string): Promise<User | null>;
  create(input: CreateUserInput): Promise<User>;
  update(userId: string, patch: Partial<User>): Promise<User>;
}

export interface IAccountRepository {
  findAllByUserId(userId: string): Promise<Account[]>;
  findById(userId: string, accountId: string): Promise<Account | null>;
  findByName(userId: string, name: string): Promise<Account | null>;
  create(input: CreateAccountInput): Promise<Account>;
  updateBalance(userId: string, accountId: string, delta: number): Promise<void>;
  update(userId: string, accountId: string, patch: Partial<Account>): Promise<Account>;
}

export interface ITransactionRepository {
  create(input: CreateTransactionInput): Promise<Transaction>;
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

export interface IBudgetCodeRepository {
  findByUserAndMonth(userId: string, year: number, month: number): Promise<BudgetCode[]>;
  findByName(userId: string, name: string, year: number, month: number): Promise<BudgetCode | null>;
  create(input: CreateBudgetCodeInput): Promise<BudgetCode>;
  incrementSpent(userId: string, budgetCodeId: string, delta: number): Promise<void>;
  update(userId: string, budgetCodeId: string, patch: Partial<BudgetCode>): Promise<BudgetCode>;
}

export interface IRecurringPaymentRepository {
  findAllByUserId(userId: string): Promise<RecurringPayment[]>;
  findByDayOfMonth(dayOfMonth: number): Promise<RecurringPayment[]>;
  findById(userId: string, recurringId: string): Promise<RecurringPayment | null>;
  findByName(userId: string, name: string): Promise<RecurringPayment | null>;
  create(input: CreateRecurringPaymentInput): Promise<RecurringPayment>;
  update(userId: string, recurringId: string, patch: Partial<RecurringPayment>): Promise<RecurringPayment>;
  deactivate(userId: string, recurringId: string): Promise<void>;
}

export interface ISessionRepository {
  get(chatId: string): Promise<SessionContext | null>;
  set(context: SessionContext): Promise<void>;
  delete(chatId: string): Promise<void>;
}

/** Slice-1 repos — what's implemented so far. */
export interface Slice1Repos {
  users: IUserRepository;
  accounts: IAccountRepository;
  transactions: ITransactionRepository;
  sessions: ISessionRepository;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/repositories/interfaces.ts
git commit -m "feat(repositories): SRS §7 contract interfaces + input types"
```

---

## Task 8: Migration SQL

**Files:**
- Create: `migrations/001_init.sql`

The SRS §6.2 DDL, minus `processed_updates` (dropped per design §2 — NFR-04 is moot under grammY long-polling).

- [ ] **Step 1: Write `migrations/001_init.sql`**

```sql
-- Users
CREATE TABLE users (
  user_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id VARCHAR     UNIQUE NOT NULL,
  name             VARCHAR     NOT NULL,
  language         VARCHAR(2)  NOT NULL DEFAULT 'id',
  timezone         VARCHAR     NOT NULL DEFAULT 'Asia/Jakarta',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  category_id        VARCHAR PRIMARY KEY,
  name               VARCHAR NOT NULL,
  name_en            VARCHAR NOT NULL,
  parent_category_id VARCHAR REFERENCES categories(category_id),
  icon               VARCHAR NOT NULL,
  type               VARCHAR NOT NULL CHECK (type IN ('expense', 'income', 'both'))
);

-- Transactions
CREATE TABLE transactions (
  transaction_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES users(user_id),
  type                  VARCHAR     NOT NULL CHECK (type IN ('expense', 'income', 'transfer')),
  amount                NUMERIC     NOT NULL,
  description           VARCHAR     NOT NULL,
  category_id           VARCHAR     REFERENCES categories(category_id),
  account_id            UUID        NOT NULL REFERENCES accounts(account_id),
  to_account_id         UUID        REFERENCES accounts(account_id),
  budget_code_id        UUID,
  date                  DATE        NOT NULL,
  notes                 TEXT,
  is_recurring_instance BOOLEAN     NOT NULL DEFAULT false,
  recurring_id          UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ
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
  recurring_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(user_id),
  name           VARCHAR     NOT NULL,
  amount         NUMERIC     NOT NULL,
  account_id     UUID        NOT NULL REFERENCES accounts(account_id),
  category_id    VARCHAR     NOT NULL REFERENCES categories(category_id),
  budget_code_id UUID,
  day_of_month   SMALLINT    NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  last_fired_at  DATE,
  next_fire_at   DATE        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_recurring_day_active ON recurring_payments(day_of_month) WHERE is_active = true;

-- Session Contexts (turns stores CoreMessage[] as JSONB)
CREATE TABLE session_contexts (
  chat_id                        VARCHAR     PRIMARY KEY,
  user_id                        UUID        NOT NULL REFERENCES users(user_id),
  turns                          JSONB       NOT NULL DEFAULT '[]',
  last_transaction_id            UUID,
  pending_recurring_confirmation JSONB,
  last_activity_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

> Note: no default on `transactions.date` — the app always supplies a WIB-correct date explicitly (design NFR-10 / Task 5).

- [ ] **Step 2: Commit**

```bash
git add migrations/001_init.sql
git commit -m "feat(db): initial schema migration (SRS §6.2 minus processed_updates)"
```

---

## Task 9: pg Pool, migration runner, seeder

**Files:**
- Create: `src/adapters/neon/pool.ts`
- Create: `src/adapters/neon/migrate.ts`
- Create: `src/adapters/neon/seed.ts`

These are the only files (besides the repository implementations) that import `pg` — the ESLint rule (Task 2) allows it here.

- [ ] **Step 1: Write `src/adapters/neon/pool.ts`**

Date type parsers keep DATE/TIMESTAMP columns as ISO **strings** (no `Date` objects), avoiding UTC-shift surprises. This is the WIB-correctness foundation (NFR-10).

```ts
import pg from 'pg';
import pgTypes from 'pg';
import { config } from '../../config/index.js';

// DATE (OID 1082) -> 'YYYY-MM-DD' string (WIB-safe; no Date object)
// TIMESTAMPTZ (OID 1184) / TIMESTAMP (OID 1114) -> ISO string
const types = pgTypes.types;
types.setTypeParser(1082, (val: string) => val); // date
types.setTypeParser(1114, (val: string) => val); // timestamp
types.setTypeParser(1184, (val: string) => val); // timestamptz

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
```

- [ ] **Step 2: Write `src/adapters/neon/migrate.ts`**

A tiny idempotent runner: tracks applied files in a `_migrations` table.

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from './pool.js';

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const dir = join(process.cwd(), 'migrations');
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    } catch {
      files = [];
    }

    for (const file of files) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM _migrations WHERE name = $1',
        [file],
      );
      if ((rowCount ?? 0) > 0) continue;

      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

// Run directly via `tsx src/adapters/neon/migrate.ts`. pathToFileURL normalizes Windows paths.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
```

- [ ] **Step 3: Write `src/adapters/neon/seed.ts`**

Idempotent category seeder (`ON CONFLICT DO NOTHING`).

```ts
import { pool } from './pool.js';
import { CATEGORIES } from '../../domain/categories.js';
import { pathToFileURL } from 'node:url';

export async function seed(): Promise<void> {
  for (const c of CATEGORIES) {
    await pool.query(
      `INSERT INTO categories (category_id, name, name_en, parent_category_id, icon, type)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (category_id) DO NOTHING`,
      [c.categoryId, c.name, c.nameEn, c.parentCategoryId ?? null, c.icon, c.type],
    );
  }
  console.log(`[seed] ensured ${CATEGORIES.length} categories`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Apply migrations + seed against the running Docker DB**

Prerequisite: `docker compose up -d` is running and `.env` exists. Create `.env` from `.env.example` with real-ish values (the local DB defaults are fine; TELEGRAM_BOT_TOKEN and OPENROUTER_API_KEY can be placeholders for now).

Run:
```bash
cp .env.example .env
npm run migrate
npm run seed
```
Expected: `[migrate] applied 001_init.sql`, then `[seed] ensured 60 categories`.

- [ ] **Step 5: Verify with a quick query**

Run:
```bash
docker compose exec postgres psql -U moneybot -d moneybot -c "SELECT count(*) FROM categories;"
```
Expected: `60`.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/neon/pool.ts src/adapters/neon/migrate.ts src/adapters/neon/seed.ts
git commit -m "feat(db): pg pool with WIB-safe date parsers, migration runner, category seeder"
```

---

## Task 10: Row mappers + Neon user repository (TDD)

**Files:**
- Create: `src/adapters/neon/mappers.ts`
- Create: `src/adapters/neon/user.repository.ts`
- Test: `tests/adapters/user.repository.test.ts`

DB rows are snake_case; entities are camelCase. Centralize the conversion in `mappers.ts` so every repository stays clean.

- [ ] **Step 1: Write the failing test `tests/adapters/user.repository.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';

describe('NeonUserRepository', () => {
  it('creates a user and finds them by telegram chat id', async () => {
    const repo = new NeonUserRepository();
    const created = await repo.create({
      telegramChatId: '111',
      name: 'Devin',
    });
    expect(created.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.language).toBe('id');
    expect(created.timezone).toBe('Asia/Jakarta');

    const found = await repo.findByTelegramChatId('111');
    expect(found?.userId).toBe(created.userId);
    expect(found?.name).toBe('Devin');
  });

  it('returns null for an unknown chat id', async () => {
    const repo = new NeonUserRepository();
    expect(await repo.findByTelegramChatId('does-not-exist')).toBeNull();
  });

  it('finds by id and updates name', async () => {
    const repo = new NeonUserRepository();
    const created = await repo.create({ telegramChatId: '222', name: 'Old' });
    const updated = await repo.update(created.userId, { name: 'New' });
    expect(updated.name).toBe('New');
    const found = await repo.findById(created.userId);
    expect(found?.name).toBe('New');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/user.repository.test.ts`
Expected: FAIL — `Cannot find module '../../src/adapters/neon/user.repository.js'` (file doesn't exist yet).

- [ ] **Step 3: Write `src/adapters/neon/mappers.ts`**

```ts
import type {
  User,
  Account,
  Transaction,
  SessionContext,
} from '../../domain/entities.js';
import type { CoreMessage } from 'ai';

type Row = Record<string, unknown>;

function str(r: Row, k: string): string {
  return String(r[k]);
}
function num(r: Row, k: string): number {
  return Number(r[k]);
}
function bool(r: Row, k: string): boolean {
  return Boolean(r[k]);
}
function maybeStr(r: Row, k: string): string | undefined {
  const v = r[k];
  return v == null ? undefined : String(v);
}
function maybeNum(r: Row, k: string): number | undefined {
  const v = r[k];
  return v == null ? undefined : Number(v);
}

export function mapUser(r: Row): User {
  return {
    userId: str(r, 'user_id'),
    telegramChatId: str(r, 'telegram_chat_id'),
    name: str(r, 'name'),
    language: str(r, 'language') === 'en' ? 'en' : 'id',
    timezone: str(r, 'timezone'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  };
}

export function mapAccount(r: Row): Account {
  return {
    accountId: str(r, 'account_id'),
    userId: str(r, 'user_id'),
    name: str(r, 'name'),
    type: str(r, 'type') as Account['type'],
    balance: num(r, 'balance'),
    creditLimit: maybeNum(r, 'credit_limit'),
    isActive: bool(r, 'is_active'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  };
}

export function mapTransaction(r: Row): Transaction {
  return {
    transactionId: str(r, 'transaction_id'),
    userId: str(r, 'user_id'),
    type: str(r, 'type') as Transaction['type'],
    amount: num(r, 'amount'),
    description: str(r, 'description'),
    categoryId: maybeStr(r, 'category_id'),
    accountId: str(r, 'account_id'),
    toAccountId: maybeStr(r, 'to_account_id'),
    budgetCodeId: maybeStr(r, 'budget_code_id'),
    date: str(r, 'date'),
    notes: maybeStr(r, 'notes'),
    isRecurringInstance: bool(r, 'is_recurring_instance'),
    recurringId: maybeStr(r, 'recurring_id'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
    deletedAt: maybeStr(r, 'deleted_at'),
  };
}

export function mapSession(r: Row): SessionContext {
  const turns = (r['turns'] as CoreMessage[] | null) ?? [];
  const pending = r['pending_recurring_confirmation'] as
    | { recurringId: string; expiresAt: string }
    | null
    | undefined;
  return {
    chatId: str(r, 'chat_id'),
    userId: str(r, 'user_id'),
    turns,
    lastTransactionId: maybeStr(r, 'last_transaction_id'),
    pendingRecurringConfirmation: pending ?? undefined,
    lastActivityAt: str(r, 'last_activity_at'),
  };
}
```

- [ ] **Step 4: Write `src/adapters/neon/user.repository.ts`**

```ts
import { pool } from './pool.js';
import { mapUser } from './mappers.js';
import type { IUserRepository, CreateUserInput, User } from '../../repositories/interfaces.js';

export class NeonUserRepository implements IUserRepository {
  async findByTelegramChatId(chatId: string): Promise<User | null> {
    const { rows } = await pool.query('SELECT * FROM users WHERE telegram_chat_id = $1', [chatId]);
    return rows[0] ? mapUser(rows[0] as Record<string, unknown>) : null;
  }

  async findById(userId: string): Promise<User | null> {
    const { rows } = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    return rows[0] ? mapUser(rows[0] as Record<string, unknown>) : null;
  }

  async create(input: CreateUserInput): Promise<User> {
    const { rows } = await pool.query(
      `INSERT INTO users (telegram_chat_id, name, language, timezone)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.telegramChatId, input.name, input.language ?? 'id', input.timezone ?? 'Asia/Jakarta'],
    );
    return mapUser(rows[0] as Record<string, unknown>);
  }

  async update(userId: string, patch: Partial<User>): Promise<User> {
    const { rows } = await pool.query(
      `UPDATE users
       SET name = COALESCE($2, name),
           language = COALESCE($3, language),
           timezone = COALESCE($4, timezone),
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [userId, patch.name ?? null, patch.language ?? null, patch.timezone ?? null],
    );
    return mapUser(rows[0] as Record<string, unknown>);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/user.repository.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/neon/mappers.ts src/adapters/neon/user.repository.ts tests/adapters/user.repository.test.ts
git commit -m "feat(repos): user repository + row mappers"
```

---

## Task 11: Neon account repository (TDD)

**Files:**
- Create: `src/adapters/neon/account.repository.ts`
- Test: `tests/adapters/account.repository.test.ts`

- [ ] **Step 1: Write the failing test `tests/adapters/account.repository.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';

async function seedUser() {
  const users = new NeonUserRepository();
  return users.create({ telegramChatId: '1', name: 'U' });
}

describe('NeonAccountRepository', () => {
  it('creates an account with default balance 0', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    expect(acc.balance).toBe(0);
    expect(acc.isActive).toBe(true);
  });

  it('creates a card with a credit limit', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({
      userId: user.userId,
      name: 'BCA CC',
      type: 'card',
      creditLimit: 20_000_000,
    });
    expect(acc.creditLimit).toBe(20_000_000);
  });

  it('lists only the user accounts and respects active flag', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    await accounts.create({ userId: user.userId, name: 'Cash', type: 'cash' });
    const found = await accounts.findAllByUserId(user.userId);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('Cash');
  });

  it('applies a balance delta (expense decreases balance)', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank', openingBalance: 100_000 });
    await accounts.updateBalance(user.userId, acc.accountId, -20_000);
    const after = await accounts.findById(user.userId, acc.accountId);
    expect(after?.balance).toBe(80_000);
  });

  it('finds by name (case-insensitive)', async () => {
    const user = await seedUser();
    const accounts = new NeonAccountRepository();
    await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
    const found = await accounts.findByName(user.userId, 'bca');
    expect(found?.name).toBe('BCA');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/account.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/adapters/neon/account.repository.ts`**

```ts
import { pool } from './pool.js';
import { mapAccount } from './mappers.js';
import type {
  IAccountRepository,
  CreateAccountInput,
  Account,
} from '../../repositories/interfaces.js';

export class NeonAccountRepository implements IAccountRepository {
  async findAllByUserId(userId: string): Promise<Account[]> {
    const { rows } = await pool.query(
      'SELECT * FROM accounts WHERE user_id = $1 AND is_active = true ORDER BY created_at',
      [userId],
    );
    return rows.map((r) => mapAccount(r as Record<string, unknown>));
  }

  async findById(userId: string, accountId: string): Promise<Account | null> {
    const { rows } = await pool.query(
      'SELECT * FROM accounts WHERE user_id = $1 AND account_id = $2',
      [userId, accountId],
    );
    return rows[0] ? mapAccount(rows[0] as Record<string, unknown>) : null;
  }

  async findByName(userId: string, name: string): Promise<Account | null> {
    const { rows } = await pool.query(
      'SELECT * FROM accounts WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND is_active = true',
      [userId, name],
    );
    return rows[0] ? mapAccount(rows[0] as Record<string, unknown>) : null;
  }

  async create(input: CreateAccountInput): Promise<Account> {
    const { rows } = await pool.query(
      `INSERT INTO accounts (user_id, name, type, balance, credit_limit)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.userId,
        input.name,
        input.type,
        input.openingBalance ?? 0,
        input.creditLimit ?? null,
      ],
    );
    return mapAccount(rows[0] as Record<string, unknown>);
  }

  async updateBalance(userId: string, accountId: string, delta: number): Promise<void> {
    await pool.query(
      `UPDATE accounts
       SET balance = balance + $3, updated_at = NOW()
       WHERE user_id = $1 AND account_id = $2`,
      [userId, accountId, delta],
    );
  }

  async update(userId: string, accountId: string, patch: Partial<Account>): Promise<Account> {
    const { rows } = await pool.query(
      `UPDATE accounts
       SET name = COALESCE($3, name),
           is_active = COALESCE($4, is_active),
           updated_at = NOW()
       WHERE user_id = $1 AND account_id = $2
       RETURNING *`,
      [userId, accountId, patch.name ?? null, patch.isActive ?? null],
    );
    return mapAccount(rows[0] as Record<string, unknown>);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/account.repository.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/neon/account.repository.ts tests/adapters/account.repository.test.ts
git commit -m "feat(repos): account repository (create, findBy*, updateBalance)"
```

---

## Task 12: Neon transaction repository (TDD)

**Files:**
- Create: `src/adapters/neon/transaction.repository.ts`
- Test: `tests/adapters/transaction.repository.test.ts`

- [ ] **Step 1: Write the failing test `tests/adapters/transaction.repository.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
import { NeonTransactionRepository } from '../../src/adapters/neon/transaction.repository.js';
import { todayWIB } from '../../src/domain/time.js';

async function seed() {
  const users = new NeonUserRepository();
  const accounts = new NeonAccountRepository();
  const user = await users.create({ telegramChatId: '1', name: 'U' });
  const acc = await accounts.create({ userId: user.userId, name: 'BCA', type: 'bank' });
  return { user, acc };
}

describe('NeonTransactionRepository', () => {
  it('creates an expense', async () => {
    const { user, acc } = await seed();
    const txns = new NeonTransactionRepository();
    const t = await txns.create({
      userId: user.userId,
      type: 'expense',
      amount: 20_000,
      description: 'bakso',
      categoryId: 'food.dining',
      accountId: acc.accountId,
      date: todayWIB(),
    });
    expect(t.amount).toBe(20_000);
    expect(t.categoryId).toBe('food.dining');
    expect(t.deletedAt).toBeUndefined();
  });

  it('filters out soft-deleted transactions in date-range queries', async () => {
    const { user, acc } = await seed();
    const txns = new NeonTransactionRepository();
    const t = await txns.create({
      userId: user.userId,
      type: 'expense',
      amount: 5_000,
      description: 'kopi',
      categoryId: 'food.coffee',
      accountId: acc.accountId,
      date: todayWIB(),
    });
    await txns.softDelete(user.userId, t.transactionId);
    const found = await txns.findByDateRange(user.userId, todayWIB(), todayWIB());
    expect(found).toHaveLength(0);
  });

  it('finds latest by user, newest first', async () => {
    const { user, acc } = await seed();
    const txns = new NeonTransactionRepository();
    await txns.create({ userId: user.userId, type: 'expense', amount: 1_000, description: 'a', categoryId: 'other.misc', accountId: acc.accountId, date: '2026-06-01' });
    await txns.create({ userId: user.userId, type: 'expense', amount: 2_000, description: 'b', categoryId: 'other.misc', accountId: acc.accountId, date: '2026-06-02' });
    const latest = await txns.findLatestByUserId(user.userId, 1);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.description).toBe('b');
  });

  it('updates a transaction field', async () => {
    const { user, acc } = await seed();
    const txns = new NeonTransactionRepository();
    const t = await txns.create({ userId: user.userId, type: 'expense', amount: 10_000, description: 'x', categoryId: 'other.misc', accountId: acc.accountId, date: todayWIB() });
    const updated = await txns.update(user.userId, t.transactionId, { amount: 25_000 });
    expect(updated.amount).toBe(25_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/transaction.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/adapters/neon/transaction.repository.ts`**

```ts
import { pool } from './pool.js';
import { mapTransaction } from './mappers.js';
import type {
  ITransactionRepository,
  CreateTransactionInput,
  Transaction,
} from '../../repositories/interfaces.js';

export class NeonTransactionRepository implements ITransactionRepository {
  async create(input: CreateTransactionInput): Promise<Transaction> {
    const { rows } = await pool.query(
      `INSERT INTO transactions
        (user_id, type, amount, description, category_id, account_id,
         to_account_id, budget_code_id, date, notes,
         is_recurring_instance, recurring_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        input.userId,
        input.type,
        input.amount,
        input.description,
        input.categoryId ?? null,
        input.accountId,
        input.toAccountId ?? null,
        input.budgetCodeId ?? null,
        input.date,
        input.notes ?? null,
        input.isRecurringInstance ?? false,
        input.recurringId ?? null,
      ],
    );
    return mapTransaction(rows[0] as Record<string, unknown>);
  }

  async findByDateRange(userId: string, from: string, to: string): Promise<Transaction[]> {
    const { rows } = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id = $1 AND date BETWEEN $2 AND $3 AND deleted_at IS NULL
       ORDER BY date DESC, created_at DESC`,
      [userId, from, to],
    );
    return rows.map((r) => mapTransaction(r as Record<string, unknown>));
  }

  async findByAccountAndDateRange(
    userId: string,
    accountId: string,
    from: string,
    to: string,
  ): Promise<Transaction[]> {
    const { rows } = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id = $1 AND account_id = $2 AND date BETWEEN $3 AND $4 AND deleted_at IS NULL
       ORDER BY date DESC, created_at DESC`,
      [userId, accountId, from, to],
    );
    return rows.map((r) => mapTransaction(r as Record<string, unknown>));
  }

  async findLatestByUserId(userId: string, limit = 10): Promise<Transaction[]> {
    const { rows } = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY date DESC, created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => mapTransaction(r as Record<string, unknown>));
  }

  async findById(userId: string, transactionId: string): Promise<Transaction | null> {
    const { rows } = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 AND transaction_id = $2',
      [userId, transactionId],
    );
    return rows[0] ? mapTransaction(rows[0] as Record<string, unknown>) : null;
  }

  async update(
    userId: string,
    transactionId: string,
    patch: Partial<Transaction>,
  ): Promise<Transaction> {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [userId, transactionId];
    let i = 3;
    if (patch.amount !== undefined) { sets.push(`amount = $${i++}`); values.push(patch.amount); }
    if (patch.description !== undefined) { sets.push(`description = $${i++}`); values.push(patch.description); }
    if (patch.categoryId !== undefined) { sets.push(`category_id = $${i++}`); values.push(patch.categoryId); }
    if (patch.accountId !== undefined) { sets.push(`account_id = $${i++}`); values.push(patch.accountId); }
    if (patch.notes !== undefined) { sets.push(`notes = $${i++}`); values.push(patch.notes); }
    const { rows } = await pool.query(
      `UPDATE transactions SET ${sets.join(', ')} WHERE user_id = $1 AND transaction_id = $2 RETURNING *`,
      values,
    );
    return mapTransaction(rows[0] as Record<string, unknown>);
  }

  async softDelete(userId: string, transactionId: string): Promise<void> {
    await pool.query(
      'UPDATE transactions SET deleted_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND transaction_id = $2',
      [userId, transactionId],
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/transaction.repository.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/neon/transaction.repository.ts tests/adapters/transaction.repository.test.ts
git commit -m "feat(repos): transaction repository (create, range queries, soft delete)"
```

---

## Task 13: Neon session repository (TDD)

**Files:**
- Create: `src/adapters/neon/session.repository.ts`
- Test: `tests/adapters/session.repository.test.ts`

`turns` is `CoreMessage[]` stored as JSONB; round-trips through JSON.

- [ ] **Step 1: Write the failing test `tests/adapters/session.repository.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonSessionRepository } from '../../src/adapters/neon/session.repository.js';
import type { CoreMessage } from 'ai';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: '1', name: 'U' });
}

describe('NeonSessionRepository', () => {
  it('returns null when no session exists', async () => {
    const sessions = new NeonSessionRepository();
    expect(await sessions.get('nope')).toBeNull();
  });

  it('persists and reloads turns (CoreMessage[])', async () => {
    const user = await seedUser();
    const sessions = new NeonSessionRepository();
    const turns: CoreMessage[] = [
      { role: 'user', content: 'bakso 20000 bca' },
      { role: 'assistant', content: '✅ dicatat' },
    ];
    await sessions.set({
      chatId: '1',
      userId: user.userId,
      turns,
      lastTransactionId: undefined,
      lastActivityAt: new Date().toISOString(),
    });
    const loaded = await sessions.get('1');
    expect(loaded?.turns).toHaveLength(2);
    expect(loaded?.turns[0]).toMatchObject({ role: 'user', content: 'bakso 20000 bca' });
  });

  it('upserts (set twice replaces, not appends)', async () => {
    const user = await seedUser();
    const sessions = new NeonSessionRepository();
    await sessions.set({ chatId: '1', userId: user.userId, turns: [{ role: 'user', content: 'a' }], lastActivityAt: new Date().toISOString() });
    await sessions.set({ chatId: '1', userId: user.userId, turns: [{ role: 'user', content: 'b' }], lastActivityAt: new Date().toISOString() });
    const loaded = await sessions.get('1');
    expect(loaded?.turns).toHaveLength(1);
    expect((loaded!.turns[0] as { content: string }).content).toBe('b');
  });

  it('persists lastTransactionId and pendingRecurringConfirmation', async () => {
    const user = await seedUser();
    const sessions = new NeonSessionRepository();
    await sessions.set({
      chatId: '1',
      userId: user.userId,
      turns: [],
      lastTransactionId: '11111111-1111-1111-1111-111111111111',
      pendingRecurringConfirmation: { recurringId: '22222222-2222-2222-2222-222222222222', expiresAt: '2026-06-14T09:00:00Z' },
      lastActivityAt: new Date().toISOString(),
    });
    const loaded = await sessions.get('1');
    expect(loaded?.lastTransactionId).toBe('11111111-1111-1111-1111-111111111111');
    expect(loaded?.pendingRecurringConfirmation?.recurringId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('deletes a session', async () => {
    const user = await seedUser();
    const sessions = new NeonSessionRepository();
    await sessions.set({ chatId: '1', userId: user.userId, turns: [], lastActivityAt: new Date().toISOString() });
    await sessions.delete('1');
    expect(await sessions.get('1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/session.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/adapters/neon/session.repository.ts`**

```ts
import { pool } from './pool.js';
import { mapSession } from './mappers.js';
import type { ISessionRepository, SessionContext } from '../../repositories/interfaces.js';

export class NeonSessionRepository implements ISessionRepository {
  async get(chatId: string): Promise<SessionContext | null> {
    const { rows } = await pool.query('SELECT * FROM session_contexts WHERE chat_id = $1', [chatId]);
    return rows[0] ? mapSession(rows[0] as Record<string, unknown>) : null;
  }

  async set(context: SessionContext): Promise<void> {
    await pool.query(
      `INSERT INTO session_contexts
        (chat_id, user_id, turns, last_transaction_id, pending_recurring_confirmation, last_activity_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (chat_id) DO UPDATE SET
         turns = EXCLUDED.turns,
         last_transaction_id = EXCLUDED.last_transaction_id,
         pending_recurring_confirmation = EXCLUDED.pending_recurring_confirmation,
         last_activity_at = EXCLUDED.last_activity_at`,
      [
        context.chatId,
        context.userId,
        JSON.stringify(context.turns),
        context.lastTransactionId ?? null,
        context.pendingRecurringConfirmation ?? null,
        context.lastActivityAt,
      ],
    );
  }

  async delete(chatId: string): Promise<void> {
    await pool.query('DELETE FROM session_contexts WHERE chat_id = $1', [chatId]);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/session.repository.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Assemble `createRepos()` and run the full suite**

Create `src/adapters/neon/repos.ts`:

```ts
import { NeonUserRepository } from './user.repository.js';
import { NeonAccountRepository } from './account.repository.js';
import { NeonTransactionRepository } from './transaction.repository.js';
import { NeonSessionRepository } from './session.repository.js';
import type { Slice1Repos } from '../../repositories/interfaces.js';

export function createRepos(): Slice1Repos {
  return {
    users: new NeonUserRepository(),
    accounts: new NeonAccountRepository(),
    transactions: new NeonTransactionRepository(),
    sessions: new NeonSessionRepository(),
  };
}
```

Run: `npm test`
Expected: all repository tests PASS (17 total).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/neon/session.repository.ts src/adapters/neon/repos.ts tests/adapters/session.repository.test.ts
git commit -m "feat(repos): session repository (CoreMessage[] JSONB) + createRepos assembly"
```

---

## Task 14: runAgent seam + pure orchestrator helpers (TDD)

**Files:**
- Create: `src/agent/run-agent.ts`
- Create: `src/agent/orchestrator-helpers.ts`
- Test: `tests/agent/orchestrator-helpers.test.ts`

`run-agent.ts` is a deliberate one-function seam over `generateText` so the orchestrator is unit-testable without SDK-version-specific mocks. The pure helpers (`isExpired`, `freshSession`, `trimTurns`, `extractLastTransactionId`) carry the testable logic.

- [ ] **Step 1: Write `src/agent/run-agent.ts`**

```ts
import { generateText, type LanguageModel, type CoreMessage, type CoreTool } from 'ai';

export interface AgentRunResult {
  text: string;
  responseMessages: CoreMessage[];
  toolResults: Array<{ toolName: string; result: unknown }>;
}

export interface RunAgentArgs {
  system: string;
  messages: CoreMessage[];
  tools: Record<string, CoreTool>;
  maxSteps: number;
}

export type AgentRunner = (args: RunAgentArgs) => Promise<AgentRunResult>;

/**
 * Build the production runner. The model is captured in the closure so the
 * orchestrator stays decoupled from the SDK and is unit-testable with a fake
 * runner that needs no model at all.
 */
export function createRunner(model: LanguageModel): AgentRunner {
  return async ({ system, messages, tools, maxSteps }) => {
    const result = await generateText({ model, system, messages, tools, maxSteps });
    return {
      text: result.text,
      responseMessages: result.response.messages as CoreMessage[],
      toolResults: result.toolResults.map((tr) => ({ toolName: tr.toolName, result: tr.result })),
    };
  };
}
```

- [ ] **Step 2: Write the failing test `tests/agent/orchestrator-helpers.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { isExpired, freshSession, trimTurns, extractLastTransactionId } from '../../src/agent/orchestrator-helpers.js';
import type { CoreMessage } from 'ai';

describe('isExpired', () => {
  it('is expired when idle longer than the timeout', () => {
    const last = new Date('2026-06-14T10:00:00Z').toISOString();
    const now = new Date('2026-06-14T10:45:00Z').toISOString();
    expect(isExpired({ lastActivityAt: last }, 30, now)).toBe(true);
  });
  it('is not expired within the timeout', () => {
    const last = new Date('2026-06-14T10:00:00Z').toISOString();
    const now = new Date('2026-06-14T10:29:00Z').toISOString();
    expect(isExpired({ lastActivityAt: last }, 30, now)).toBe(false);
  });
});

describe('freshSession', () => {
  it('starts with empty turns and no lastTransactionId', () => {
    const s = freshSession('chat-1', 'user-1', new Date('2026-06-14T10:00:00Z').toISOString());
    expect(s.chatId).toBe('chat-1');
    expect(s.turns).toEqual([]);
    expect(s.lastTransactionId).toBeUndefined();
  });
});

describe('trimTurns', () => {
  it('drops whole turns from the front, never splitting a tool-call from its result', () => {
    // 3 turns: each = user + assistant(tool_call) + tool_result + assistant(final)
    const mk = (n: number): CoreMessage[] => [
      { role: 'user', content: `u${n}` },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `tc${n}`, toolName: 'x', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: `tc${n}`, toolName: 'x', result: {} }] },
      { role: 'assistant', content: `a${n}` },
    ];
    const messages: CoreMessage[] = [...mk(1), ...mk(2), ...mk(3)];
    const trimmed = trimTurns(messages, 2);
    // oldest turn (1) dropped entirely; remaining start with u2
    expect((trimmed[0] as { content: string }).content).toBe('u2');
    expect(trimmed).toHaveLength(8); // 2 turns * 4 messages
  });
});

describe('extractLastTransactionId', () => {
  it('returns the latest transactionId across tool results', () => {
    const results = [
      { toolName: 'create_account', result: { status: 'ok', data: { accountId: 'acc-1' } } },
      { toolName: 'create_expense', result: { status: 'ok', data: { transaction: { transactionId: 'txn-1' } } } },
      { toolName: 'create_expense', result: { status: 'ok', data: { transaction: { transactionId: 'txn-2' } } } },
    ];
    expect(extractLastTransactionId(results)).toBe('txn-2');
  });
  it('returns undefined when no write tool produced a transaction', () => {
    const results = [{ toolName: 'get_accounts', result: [] }];
    expect(extractLastTransactionId(results)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/agent/orchestrator-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/agent/orchestrator-helpers.ts`**

```ts
import type { CoreMessage } from 'ai';
import type { SessionContext } from '../domain/entities.js';

export function isExpired(
  session: { lastActivityAt: string },
  timeoutMinutes: number,
  nowIso: string = new Date().toISOString(),
): boolean {
  const last = Date.parse(session.lastActivityAt);
  const now = Date.parse(nowIso);
  return now - last > timeoutMinutes * 60_000;
}

export function freshSession(chatId: string, userId: string, nowIso: string): SessionContext {
  return {
    chatId,
    userId,
    turns: [],
    lastTransactionId: undefined,
    lastActivityAt: nowIso,
  };
}

/**
 * Trim to the last `maxTurns` turns. A turn = one user message + every following
 * message up to (not including) the next user message. Trimming removes whole
 * turns from the front so a tool-call is never split from its tool-result.
 */
export function trimTurns(messages: CoreMessage[], maxTurns: number): CoreMessage[] {
  // Indices where each turn starts (each user message begins a new turn)
  const turnStarts: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') turnStarts.push(i);
  });
  if (turnStarts.length <= maxTurns) return messages;
  const keepFrom = turnStarts[turnStarts.length - maxTurns]!;
  return messages.slice(keepFrom);
}

/**
 * Extract the most recent transactionId from write-tool results. Tools return
 * WriteResult objects; only `status: 'ok'` with a `transaction.transactionId`
 * (or a top-level transactionId) counts.
 */
export function extractLastTransactionId(
  toolResults: Array<{ toolName: string; result: unknown }>,
): string | undefined {
  let last: string | undefined;
  for (const { result } of toolResults) {
    const r = result as { status?: string; data?: { transaction?: { transactionId?: string } } };
    if (r && r.status === 'ok' && r.data?.transaction?.transactionId) {
      last = r.data.transaction.transactionId;
    }
  }
  return last;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/agent/orchestrator-helpers.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/agent/run-agent.ts src/agent/orchestrator-helpers.ts tests/agent/orchestrator-helpers.test.ts
git commit -m "feat(agent): runAgent seam + pure orchestrator helpers (trimTurns, extractLastTransactionId, isExpired)"
```

---

## Task 15: System prompt (SP-01…SP-10 + taxonomy)

**Files:**
- Create: `src/agent/system-prompt.ts`

The category list is generated from `CATEGORIES` (DRY with the seeder). The prompt encodes the SP-01…SP-10 hard constraints, including the write gate and the IDR format rule.

- [ ] **Step 1: Write `src/agent/system-prompt.ts`**

```ts
import { CATEGORIES } from '../domain/categories.js';

function formatCategories(): string {
  return CATEGORIES.map((c) => `- ${c.categoryId} — ${c.name} (${c.nameEn})`).join('\n');
}

export const BASE_PROMPT = `Kamu adalah asisten keuangan pribadi MoneyBot. Balas selalu dalam Bahasa Indonesia yang natural dan ringkas.

ATURAN WAJIB (tidak boleh dilanggar):
1. Jangan pernah mengasumsikan akun ada. Selalu panggil get_accounts dulu sebelum merujuk nama atau saldo akun.
2. GATE TULIS: JANGAN pernah memanggil tool tulis (create_*, update_*, delete_*, deactivate_*) kecuali SEMUA field wajib sudah diketahui dan tidak ambigu. Kalau ada field yang kurang, tanyakan SEMUA field yang kurang dalam satu pesan — jangan tanya satu per satu.
3. Setelah setiap tulis, jawab dengan ringkasan konfirmasi yang rapi dari hal yang baru saja dicatat.
4. Kalau sebuah budget sudah terlampaui setelah mencatat pengeluaran, tampilkan peringatan di respons yang sama.
5. Kategori selalu harus terlihat di konfirmasi supaya user bisa langsung mengoreksi kalau salah.
6. "Transfer" tidak pernah dikategorikan sebagai pemasukan atau pengeluaran. Itu hanya perpindahan saldo antar akun.
7. Saat user bilang "koreksi transaksi tadi", ambil lastTransactionId dari konteks. Kalau tidak ada, tanya: "Transaksi mana yang mau dikoreksi? Sebutin deskripsi atau tanggalnya."
8. Kamu punya otonomi penuh untuk merangkai beberapa tool call demi menyelesaikan tujuan. Jangan minta konfirmasi user di antara tool call intermediate — hanya konfirmasi sebelum tulis saat field wajib sudah terisi.
9. Format semua nominal pakai locale IDR: titik sebagai pemisah ribuan, tanpa simbol mata uang (contoh: 20.000, 1.500.000). JANGAN pernah output "Rp" atau "IDR".
10. Tanggal ditampilkan sebagai DD Mon YYYY (contoh: 07 Jun 2026).

Pengeluaran biasanya: <deskripsi> <jumlah> <akun>. Contoh: "bakso 20000 bca" → deskripsi=bakso, jumlah=20000, akun=BCA. Kategorikan otomatis berdasarkan taksonomi di bawah; pilih subkategori paling spesifik. Gunakan BOTH label Indonesia dan English saat menalar kategori.

TAKSONOMI KATEGORI (categoryId — Indonesia (English)):
${formatCategories()}`;

export const SYSTEM_PROMPT = BASE_PROMPT;
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/system-prompt.ts
git commit -m "feat(agent): system prompt (SP-01..SP-10 + generated category taxonomy)"
```

---

## Task 16: buildTools factory — create_account, get_accounts, create_expense (TDD)

**Files:**
- Create: `src/agent/tools.ts`
- Test: `tests/agent/tools.test.ts`

The critical assertions here: **write tools never throw**, and they return the correct `WriteResult` variant for missing/ambiguous/ok cases (the §5 loop-continuation guarantee). Repositories are mocked.

- [ ] **Step 1: Write the failing test `tests/agent/tools.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildTools } from '../../src/agent/tools.js';
import type { Slice1Repos } from '../../src/repositories/interfaces.js';

function mockRepos(overrides: Partial<Slice1Repos> = {}): Slice1Repos {
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
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    ...overrides,
  };
}

describe('buildTools — create_account', () => {
  it('returns missing_fields when a card has no creditLimit', async () => {
    const repos = mockRepos();
    const { create_account } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await create_account!.execute({ name: 'BCA CC', type: 'card' } as never);
    expect(res).toEqual({ status: 'missing_fields', missing: ['creditLimit'] });
  });

  it('creates the account on ok', async () => {
    const repos = mockRepos();
    const { create_account } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res: any = await create_account!.execute({ name: 'BCA', type: 'bank' } as never);
    expect(res.status).toBe('ok');
    expect(repos.accounts.create).toHaveBeenCalled();
  });
});

describe('buildTools — onboarding gating', () => {
  it('exposes ONLY create_account when hasAccount is false', () => {
    const tools = buildTools({ userId: 'u1', repos: mockRepos(), hasAccount: false });
    expect(tools.create_account).toBeDefined();
    expect(tools.get_accounts).toBeUndefined();
    expect(tools.create_expense).toBeUndefined();
  });

  it('exposes get_accounts + create_expense when hasAccount is true', () => {
    const tools = buildTools({ userId: 'u1', repos: mockRepos(), hasAccount: true });
    expect(tools.get_accounts).toBeDefined();
    expect(tools.create_expense).toBeDefined();
  });
});

describe('buildTools — create_expense (write gate)', () => {
  it('returns ambiguous when the account name matches nothing', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => [
          { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 0, isActive: true, createdAt: '', updatedAt: '' },
          { accountId: 'a2', userId: 'u1', name: 'BCA CC', type: 'card', balance: 0, isActive: true, createdAt: '', updatedAt: '' },
        ]),
        findById: vi.fn(async () => null),
        findByName: vi.fn(async () => null),
        create: vi.fn(),
        updateBalance: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { create_expense } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res: any = await create_expense!.execute({
      description: 'bakso', amount: 20_000, accountId: 'mandiri', categoryId: 'food.dining',
    } as never);
    expect(res.status).toBe('ambiguous');
    expect(res.field).toBe('accountId');
  });

  it('creates the expense + decrements balance on ok, and never throws', async () => {
    const repos = mockRepos({
      accounts: {
        findAllByUserId: vi.fn(async () => []),
        findById: vi.fn(async (_u: string, id: string) =>
          id === 'a1' ? { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 100_000, isActive: true, createdAt: '', updatedAt: '' } : null,
        ),
        findByName: vi.fn(),
        create: vi.fn(),
        updateBalance: vi.fn(async () => undefined),
        update: vi.fn(),
      } as never,
    });
    const { create_expense } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res: any = await create_expense!.execute({
      description: 'bakso', amount: 20_000, accountId: 'a1', categoryId: 'food.dining',
    } as never);
    expect(res.status).toBe('ok');
    expect(res.data.transaction.transactionId).toBe('t1');
    expect(repos.accounts.updateBalance).toHaveBeenCalledWith('u1', 'a1', -20_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/agent/tools.ts`**

```ts
import { tool, type CoreTool } from 'ai';
import { z } from 'zod';
import type { Slice1Repos } from '../repositories/interfaces.js';
import type { AccountResult, TransactionResult } from '../domain/entities.js';
import { todayWIB } from '../domain/time.js';

export interface BuildToolsArgs {
  userId: string;
  repos: Slice1Repos;
  hasAccount: boolean;
}

export function buildTools({ userId, repos, hasAccount }: BuildToolsArgs) {
  // CoreTool is the AI SDK's broad tool type; tool() returns a compatible object.
  // We type the container once so the orchestrator's RunAgentArgs.tools matches.
  const tools = {} as Record<string, CoreTool>;

  tools.create_account = tool({
    description: 'Buat akun baru (cash/bank/card). Wajib untuk card: creditLimit.',
    parameters: z.object({
      name: z.string().describe('Nama akun, mis. "BCA", "BCA CC", "Cash"'),
      type: z.enum(['cash', 'bank', 'card']),
      creditLimit: z.number().positive().optional(),
      openingBalance: z.number().optional(),
    }),
    execute: async ({ name, type, creditLimit, openingBalance }) => {
      if (type === 'card' && (creditLimit === undefined || creditLimit <= 0)) {
        const res: AccountResult = { status: 'missing_fields', missing: ['creditLimit'] };
        return res;
      }
      try {
        const account = await repos.accounts.create({
          userId,
          name,
          type,
          creditLimit,
          openingBalance,
        });
        const res: AccountResult = { status: 'ok', data: account };
        return res;
      } catch (e) {
        return { status: 'error', message: (e as Error).message } as AccountResult;
      }
    },
  });

  if (!hasAccount) return tools;

  tools.get_accounts = tool({
    description: 'Daftar semua akun user beserta saldo saat ini.',
    parameters: z.object({}),
    execute: async () => {
      const accounts = await repos.accounts.findAllByUserId(userId);
      return accounts.map((a) => ({
        accountId: a.accountId,
        name: a.name,
        type: a.type,
        balance: a.balance,
        creditLimit: a.creditLimit,
      }));
    },
  });

  const expenseSchema = z.object({
    description: z.string(),
    amount: z.number().positive(),
    accountId: z.string().describe('Bisa nama akun (mis. "bca") atau accountId. Resolve via get_accounts.'),
    categoryId: z.string(),
    budgetCodeId: z.string().optional(),
    date: z.string().optional().describe('YYYY-MM-DD (WIB). Default: hari ini.'),
  });

  tools.create_expense = tool({
    description: 'Catat pengeluaran. Resolve accountId via get_accounts bila ragu.',
    parameters: expenseSchema,
    execute: async ({ description, amount, accountId, categoryId, budgetCodeId, date }) => {
      try {
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

        const transaction = await repos.transactions.create({
          userId,
          type: 'expense',
          amount,
          description,
          categoryId,
          accountId: account.accountId,
          budgetCodeId,
          date: date ?? todayWIB(),
        });

        await repos.accounts.updateBalance(userId, account.accountId, -amount);

        const res: TransactionResult = { status: 'ok', data: { transaction } };
        return res;
      } catch (e) {
        return { status: 'error', message: (e as Error).message } as TransactionResult;
      }
    },
  });

  return tools;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: PASS (5 tests). The "never throws" property is implicit — every `execute` wraps in try/catch and returns a `WriteResult`; the test for the ok path confirms the happy flow, and the missing_fields/ambiguous tests confirm the structured-signal paths.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "feat(agent): buildTools (create_account, get_accounts, create_expense) with never-throw write gate"
```

---

## Task 17: Orchestrator `handleMessage` (TDD with a fake runner)

**Files:**
- Create: `src/agent/orchestrator.ts`
- Test: `tests/agent/orchestrator.test.ts`

The orchestrator depends on the `AgentRunner` seam (Task 14), so the test injects a **fake runner** — no real LLM, no SDK mock gymnastics. This validates: onboarding, session load/save, trimming, `lastTransactionId` extraction, and reply.

- [ ] **Step 1: Write the failing test `tests/agent/orchestrator.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { handleMessage } from '../../src/agent/orchestrator.js';
import type { Slice1Repos } from '../../src/repositories/interfaces.js';
import type { AgentRunner } from '../../src/agent/run-agent.js';
import type { CoreMessage } from 'ai';

function fakeRunner(reply: string, transactionId?: string): AgentRunner {
  return vi.fn(async () => {
    const responseMessages: CoreMessage[] = [{ role: 'assistant', content: reply }];
    const toolResults = transactionId
      ? [{ toolName: 'create_expense', result: { status: 'ok', data: { transaction: { transactionId } } } }]
      : [];
    return { text: reply, responseMessages, toolResults };
  });
}

function mockRepos(): Slice1Repos {
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
    transactions: { create: vi.fn(), findByDateRange: vi.fn(), findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn() } as never,
    sessions: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(),
    } as never,
  };
}

describe('handleMessage', () => {
  it('onboards an unknown user and replies with the onboarding prompt', async () => {
    const repos = mockRepos();
    const { reply, onboarded } = await handleMessage({
      text: 'hai',
      chatId: '999',
      repos,
      run: fakeRunner('Halo! Aku MoneyBot. Buat akun pertamamu dulu ya.'),
      system: 'sys',
      contextWindowTurns: 20,
      sessionIdleTimeoutMinutes: 30,
    });
    expect(onboarded).toBe(true);
    expect(repos.users.create).toHaveBeenCalledWith(expect.objectContaining({ telegramChatId: '999' }));
    expect(reply).toContain('MoneyBot');
  });

  it('persists session turns and lastTransactionId when a write produced a transaction', async () => {
    const repos = mockRepos();
    // known user + has an account
    (repos.users.findByTelegramChatId as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', telegramChatId: '1', name: 'Devin', language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
    });
    (repos.accounts.findAllByUserId as ReturnType<typeof vi.fn>).mockResolvedValue([
      { accountId: 'a1', userId: 'u1', name: 'BCA', type: 'bank', balance: 0, isActive: true, createdAt: '', updatedAt: '' },
    ]);
    const { reply } = await handleMessage({
      text: 'bakso 20000 bca',
      chatId: '1',
      repos,
      run: fakeRunner('✅ Pengeluaran dicatat', 'txn-9'),
      system: 'sys',
      contextWindowTurns: 20,
      sessionIdleTimeoutMinutes: 30,
    });
    expect(reply).toBe('✅ Pengeluaran dicatat');
    expect(repos.sessions.set).toHaveBeenCalledWith(expect.objectContaining({
      chatId: '1',
      lastTransactionId: 'txn-9',
    }));
  });

  it('starts a fresh session when the prior one expired', async () => {
    const repos = mockRepos();
    (repos.users.findByTelegramChatId as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 'u1', telegramChatId: '1', name: 'Devin', language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
    });
    (repos.sessions.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      chatId: '1', userId: 'u1', turns: [{ role: 'user', content: 'old' }], lastTransactionId: undefined,
      lastActivityAt: new Date('2020-01-01').toISOString(), // ancient
    });
    await handleMessage({
      text: 'halo',
      chatId: '1',
      repos,
      run: fakeRunner('halo balik'),
      system: 'sys',
      contextWindowTurns: 20,
      sessionIdleTimeoutMinutes: 30,
    });
    // The persisted turns must NOT include the ancient 'old' message
    const saved = (repos.sessions.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved.turns.some((m: CoreMessage) => (m as { content?: string }).content === 'old')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/agent/orchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/agent/orchestrator.ts`**

```ts
import type { CoreMessage } from 'ai';
import type { Slice1Repos } from '../repositories/interfaces.js';
import type { AgentRunner } from './run-agent.js';
import { buildTools } from './tools.js';
import { isExpired, freshSession, trimTurns, extractLastTransactionId } from './orchestrator-helpers.js';
import { nowWIB } from '../domain/time.js';

export interface HandleMessageArgs {
  text: string;
  chatId: string;
  repos: Slice1Repos;
  /** Injectable runner: production uses createRunner(model); tests pass a fake. */
  run: AgentRunner;
  system: string;
  contextWindowTurns: number;
  sessionIdleTimeoutMinutes: number;
  /** Stable clock injection for deterministic expiry checks. */
  now?: () => Date;
}

export interface HandleMessageResult {
  reply: string;
  onboarded: boolean;
}

export async function handleMessage(args: HandleMessageArgs): Promise<HandleMessageResult> {
  const now = args.now ?? (() => new Date());
  const nowIso = nowWIB(now());

  // 1. Resolve user (onboard if unknown)
  let user = await args.repos.users.findByTelegramChatId(args.chatId);
  let onboarded = false;
  if (!user) {
    user = await args.repos.users.create({ telegramChatId: args.chatId, name: 'Teman' });
    onboarded = true;
  }

  // 2. Load or reset session
  let session = await args.repos.sessions.get(args.chatId);
  if (!session || isExpired(session, args.sessionIdleTimeoutMinutes, nowIso)) {
    session = freshSession(args.chatId, user.userId, nowIso);
  }

  // 3. Append the user turn
  const messages: CoreMessage[] = [...session.turns, { role: 'user', content: args.text }];

  // 4. Build tools (gated by onboarding state)
  const accounts = await args.repos.accounts.findAllByUserId(user.userId);
  const hasAccount = accounts.length > 0;
  const tools = buildTools({ userId: user.userId, repos: args.repos, hasAccount });

  // 5. Run the agent (seam — real model in prod via createRunner; fake in tests)
  const result = await args.run({
    system: args.system,
    messages,
    tools,
    maxSteps: 10,
  });

  // 6. Append response messages + trim
  messages.push(...result.responseMessages);
  const trimmed = trimTurns(messages, args.contextWindowTurns);

  // 7. Persist session
  const lastTxnId = extractLastTransactionId(result.toolResults) ?? session.lastTransactionId;
  await args.repos.sessions.set({
    ...session,
    turns: trimmed,
    lastTransactionId: lastTxnId,
    lastActivityAt: nowIso,
  });

  return { reply: result.text, onboarded };
}
```

> The orchestrator never references `LanguageModel` — the runner closes over the model (Task 14's `createRunner`), so `handleMessage` is fully unit-testable with a fake runner and needs no SDK types.

- [ ] **Step 4: Run the orchestrator test to verify it passes**

Run: `npx vitest run tests/agent/orchestrator.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/run-agent.ts src/agent/orchestrator.ts tests/agent/orchestrator.test.ts
git commit -m "feat(agent): orchestrator handleMessage (onboarding, session, trimming, lastTransactionId) with injectable runner"
```

---

## Task 18: grammY bot wiring + entry point

**Files:**
- Create: `src/telegram/bot.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Write `src/telegram/bot.ts`**

```ts
import { Bot } from 'grammy';
import { config } from '../config/index.js';

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

/** Register the message handler. The `handle` closure returns the reply text. */
export function registerMessageHandler(
  handle: (text: string, chatId: string) => Promise<string>,
): void {
  bot.on('message:text', async (ctx) => {
    await ctx.replyWithChatAction('typing');
    try {
      const reply = await handle(ctx.message.text, String(ctx.chat.id));
      if (reply) await ctx.reply(reply);
    } catch (err) {
      console.error('[bot] message handler failed', err);
      await ctx.reply('Maaf, ada gangguan. Coba lagi ya.'); // NFR-09
    }
  });
}
```

- [ ] **Step 2: Write `src/index.ts`**

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { config } from './config/index.js';
import { migrate } from './adapters/neon/migrate.js';
import { seed } from './adapters/neon/seed.js';
import { pool } from './adapters/neon/pool.js';
import { createRepos } from './adapters/neon/repos.js';
import { createRunner } from './agent/run-agent.js';
import { handleMessage } from './agent/orchestrator.js';
import { SYSTEM_PROMPT } from './agent/system-prompt.js';
import { bot, registerMessageHandler } from './telegram/bot.js';

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
      system: SYSTEM_PROMPT,
      contextWindowTurns: config.CONTEXT_WINDOW_TURNS,
      sessionIdleTimeoutMinutes: config.SESSION_IDLE_TIMEOUT_MINUTES,
    });
    return reply;
  });

  console.log('[moneybot] starting long-polling…');
  await bot.start({
    allowed_updates: ['message', 'callback_query'], // callback_query used in Slice 4
    onStart: () => console.log('[moneybot] polling'),
  });
}

main().catch(async (err) => {
  console.error('[moneybot] fatal', err);
  await pool.end();
  process.exit(1);
});
```

- [ ] **Step 3: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no errors. This is the NFR-02 check — confirms no `pg` import leaked outside `src/adapters/neon/`.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/bot.ts src/index.ts
git commit -m "feat(app): grammY long-polling bot + entry point wiring (migrate, seed, agent)"
```

---

## Task 19: End-to-end manual smoke test

This validates the full seam that can't be asserted in CI: grammY → orchestrator → real model → tools → repos → Neon → Indonesian reply. Run against your real bot token and a real OpenRouter key.

**No new files.**

- [ ] **Step 1: Ensure Docker DB is running and migrated**

Run: `docker compose up -d && npm run migrate && npm run seed`
Expected: migrations + seed apply cleanly.

- [ ] **Step 2: Fill `.env` with real credentials**

Set real `TELEGRAM_BOT_TOKEN` and `OPENROUTER_API_KEY` in `.env`. Keep `DATABASE_URL` pointing at the local Docker DB (or a Neon dev branch).

- [ ] **Step 3: Start the bot**

Run: `npm run dev`
Expected log: `[moneybot] polling`.

- [ ] **Step 4: First message — onboarding (FR-01)**

Send any message to the bot from Telegram, e.g. `halo`.
Expected:
- The bot replies in Bahasa Indonesia, introducing itself and asking the user to create their first account.
- A `users` row exists: `docker compose exec postgres psql -U moneybot -d moneybot -c "SELECT * FROM users;"`.

- [ ] **Step 5: Create an account (FR-02a)**

Send: `tambah rekening BCA tabungan`
Expected: the model calls `create_account` and replies with a confirmation like `✅ Akun ditambahkan: 🏦 BCA — Bank`. An `accounts` row exists.

- [ ] **Step 6: Log an expense — the headline flow (FR-03a)**

Send: `bakso 20000 bca`
Expected:
- The model calls `get_accounts` (to resolve "bca"), then `create_expense`.
- Reply: a confirmation including the auto-category (e.g. `🍜 Makan di Luar`), the account, the date, and the amount formatted `20.000` (no `Rp`).
- A `transactions` row exists with `category_id = 'food.dining'`.
- The BCA account balance decreased by 20.000.

- [ ] **Step 7: Verify the write gate (SP-03 / FR-03b)**

Start a fresh chat (or wait 30 min for session expiry). Send: `beli parfum 449000 budget raissa`
Expected: the model asks for the missing account in a single message (it has no account to charge). It should **not** create a partial transaction.

- [ ] **Step 8: Verify "koreksi tadi" context (FR-08 readiness)**

Right after Step 6, send: `koreksi tadi, jumlahnya jadi 25000`
Expected: the model uses `lastTransactionId` (now stored in `session_contexts.last_transaction_id`) to update the transaction. (Full FR-08 correction with balance reversal is implemented in a later slice; for Slice 1 the `update_transaction` tool is wired, so the model can call it. If the balance isn't reversed, that's expected — it lands in the Slice 2 scope. Note any gap for the next plan.)

- [ ] **Step 9: Stop the bot**

`Ctrl-C`. Confirm the process exits cleanly.

- [ ] **Step 10: Commit the smoke-test notes (optional)**

If you recorded any behavioral gaps, note them in a follow-up issue or the next plan. Do not commit `.env`.

---

## Slice 0 + 1 — Definition of Done

- [ ] All Vitest tests pass (`npm test`)
- [ ] `npm run lint` is clean (NFR-02 enforced)
- [ ] `npx tsc --noEmit` is clean
- [ ] The bot runs (`npm run dev`), onboards an unknown user, creates an account, and logs a categorized expense with an Indonesian reply
- [ ] Write tools never throw (verified by tests + the try/catch contract)
- [ ] No `pg` import exists outside `src/adapters/neon/` (verified by ESLint)

## What this plan does NOT cover (later slices — separate plans)

- Slice 2: `create_income`, atomic `create_transfer` (BEGIN/COMMIT), `update_transaction` (with balance reversal), `soft_delete_transaction`, `get_transactions`, `get_account_balance`, `get_categories`, budget codes + overspend warning, recurring CRUD, full FR-08 correction
- Slice 3: `get_report` + NL date resolution
- Slice 4: scheduler (daily 08:00 + 5-min defer sweep) + inline-keyboard callbacks + `pendingRecurringConfirmation`
- Slice 5: observability/logging (NFR-07), Bahasa error sweep (NFR-09), reconcile script (OQ-03)
