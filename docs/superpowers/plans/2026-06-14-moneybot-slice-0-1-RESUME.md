# MoneyBot — Slice 0+1 Build · RESUME HERE

> **Read this first.** This file is the handoff for any Claude session continuing the MoneyBot build. It captures exactly where work stopped, the decisions/fixes a fresh session must carry forward, and how to resume safely. The plan and spec are linked below.

- **Last updated:** 2026-06-15
- **Branch:** `feat/slice-0-1`
- **Last commit:** `1bfbdf0 feat(agent): buildTools (create_account, get_accounts, create_expense) with never-throw write gate`
- **Working tree:** clean (only untracked `.claude/`, which is tooling — leave it)

## Where we are

The Slice 0+1 plan has **19 tasks**. **Tasks 1–16 are done and committed. Tasks 17–19 remain.**

| # | Task | Status |
|---|------|--------|
| 1 | Scaffold (package.json, tsconfig, dirs, .env.example) | ✅ `cdd602d` |
| 2 | ESLint + NFR-02 `no-restricted-imports` | ✅ `1500445` |
| 3 | Test infra (docker-compose, vitest, global-setup, setup, resetDb) | ✅ `d7a00ea` |
| 4 | Config module (zod + dotenv) | ✅ `8186c34` |
| 5 | Domain types (entities, WriteResult, time helpers) | ✅ `be7c8cb` |
| 6 | Category taxonomy (58 categories — see note below) | ✅ `1070815` |
| 7 | Repository interfaces (SRS §7) | ✅ `81623b5` |
| 8 | Migration SQL (001_init.sql) | ✅ `6641275` |
| 9 | pg Pool, migrate, seed | ✅ `5762243` |
| 10 | User repository + row mappers | ✅ `4427430` |
| 11 | Account repository (TDD) | ✅ `0b677d3` |
| 12 | Transaction repository (TDD) | ✅ `2d76694` |
| 13 | Session repository + `createRepos()` (TDD) | ✅ `99b0580` |
| 14 | `runAgent` seam + orchestrator helpers (TDD) | ✅ `82ab9e4` |
| 15 | System prompt | ✅ `1974fef` |
| 16 | `buildTools` factory (TDD) | ✅ `1bfbdf0` |
| 17 | Orchestrator `handleMessage` (TDD) | ⬜ next |
| 18 | grammY bot + entry point | ⬜ |
| 19 | End-to-end smoke test (manual — needs real env vars + Telegram bot) | ⬜ |

## Reference docs (read before continuing)

- **Plan (full task text, TDD steps, exact code):** `docs/superpowers/plans/2026-06-14-moneybot-slice-0-1.md`
- **Design spec (architecture decisions, deltas from SRS):** `docs/superpowers/specs/2026-06-14-moneybot-impl-design.md`
- **SRS (requirements source of truth):** `docs/SRS.md`

## ⚠️ CRITICAL — deviations from the plan you MUST apply

The plan was written before implementation. These issues were found during the build. When a task's code conflicts with what's below, **follow this doc, not the plan.**

1. **Entity types come from `entities.ts`, not `interfaces.ts`.**
   The plan's repository files import entity types (`Account`, `Transaction`, `SessionContext`) from `interfaces.ts`, but `interfaces.ts` imports those types **without re-exporting them** → `tsc` error `TS2459: declares 'X' locally, but it is not exported`.
   **Fix pattern (already applied to `user.repository.ts`; apply identically to Tasks 11–13):**
   ```ts
   import type { IAccountRepository, CreateAccountInput } from '../../repositories/interfaces.js';
   import type { Account } from '../../domain/entities.js';
   ```
   (Keep the interface + input-type imports from `interfaces.js`; move the entity type to `entities.js`.)

2. **`pool.ts` uses a single `pg` import.** The plan imports `pg` twice (`pg` + `pgTypes`), which fails ESLint's `no-duplicate-imports` (in `eslint:recommended`). Implemented as:
   ```ts
   import pg from 'pg';
   pg.types.setTypeParser(1082, (val: string) => val); // date
   pg.types.setTypeParser(1114, (val: string) => val); // timestamp
   pg.types.setTypeParser(1184, (val: string) => val); // timestamptz
   export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
   ```

3. **Direct-run guard uses `pathToFileURL(process.argv[1] ?? '')`.** The plan's `import.meta.url === pathToFileURL(process.argv[1]).href` fails `tsc` under `noUncheckedIndexedAccess` (`process.argv[1]` is `string | undefined`). The `?? ''` is required. Already applied in `migrate.ts` and `seed.ts`.

4. **`dotenv` was added (plan omitted env loading).** `src/config/index.ts` starts with `import 'dotenv/config';` so `schema.parse(process.env)` works in app, tests, and scripts. `dotenv` is in `package.json` deps. **Do not remove it.**

5. **Category count is 58, not 60.** The plan says "60 categories" in several spots (Task 6 commit msg, Task 9 expected output/verify). The SRS §10 actually has **58** (52 expense + 6 income). The implementation correctly seeds 58. **Do not "fix" the count to 60** — 58 is right. (If you re-run seed, expect `[seed] ensured 58 categories`.)

6. **AI SDK v4.3.19: tool-call parts use `args` (not `input`); generic toolsets collapse `toolResults` to `never`.** Two SDK-version realities the plan got wrong (discovered Task 14):
   - `ToolCallPart` uses **`args`** for call arguments (`node_modules/ai/dist/index.d.ts:690`), **not `input`** (a v5-ism). The plan's Task 14 test wrote `input: {}`; corrected to `args`. **Tasks 16/17**: when constructing tool-call / tool-result `CoreMessage`s, use `args`. (`ToolResultPart` correctly uses `result`.)
   - `generateText`'s `result.toolResults` is typed via a mapped conditional over the toolset's *concrete* keys (`ToolResultUnion<TOOLS>`), so it resolves to `never[]` when `tools` is the seam's generic `Record<string, CoreTool>`. `createRunner` widens it at the boundary: `(result.toolResults as Array<{ toolName: string; result: unknown }>).map(...)`. Don't rely on `toolResults` element typing through a non-concrete toolset.
   - `CoreTool.execute` is `(args, options)` (**2 params**) and **optional** (`execute?`). The plan's Task 16 test called `tool.execute(args)` with 1 arg and no non-null assertion → tsc errors (TS2554 / TS2722). Fix: route direct test calls through a helper: `t!.execute!(args as never, {} as never)`. **Production `tools.ts` is unaffected** — `generateText` calls `execute` with both args and the impls ignore `options`. **Test-only concern.** Also: project ESLint forbids `no-explicit-any`, so the plan's `: any` test annotations were replaced with a narrow result type.

## Environment & ops notes

- **Platform:** Windows 11, shell is git-bash. Use forward slashes in paths; `mkdir -p` works. `LF will be replaced by CRLF` git warnings are benign.
- **Docker is required for all repository tests** (real Postgres, no mocks — money correctness). Docker Desktop (v28.3.3) is installed but the **daemon is not always running**. To start it:
   ```bash
   powershell.exe -Command "Start-Process -FilePath 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"
   # then poll until ready:
   for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 5; done
   docker compose up -d
   # wait for pg:
   for i in $(seq 1 40); do docker compose exec -T postgres pg_isready -U moneybot >/dev/null 2>&1 && break; sleep 2; done
   ```
- **`.env`** exists locally (gitignored), copied from `.env.example` with **dummy placeholder** values. Fine for tests. **For Task 19 (smoke test) the user must put a real `TELEGRAM_BOT_TOKEN` and `OPENROUTER_API_KEY` in `.env`.**
- **Test harness:** `vitest.config.ts` uses `pool:'forks', singleFork:true`. `tests/global-setup.ts` runs `migrate()` + `seed()` once per run; `tests/setup.ts` truncates user-data tables `beforeEach` (categories + `_migrations` preserved). The Docker DB must be up before `npm test`.
- **pg date type parsers** keep DATE/TIMESTAMP as ISO strings (no `Date` objects) — WIB correctness (NFR-10).

## Verification — run these after every task

```bash
npx tsc --noEmit        # type-check (strict, noUncheckedIndexedAccess, verbatimModuleSyntax)
npm run lint            # ESLint flat config; NFR-02 fails if a db driver leaks outside src/adapters/neon/
npx vitest run <path>   # the task's test file
```
A task is done only when all three are clean/green. **Vitest can pass while tsc fails** (it strips types without checking) — so always run `tsc` too.

## Execution mode

- **Inline, TDD, one commit per task.** The user pivoted from subagent-driven to inline execution with the max-effort model. Continue inline.
- TDD cycle per task: write the failing test → run it (confirm it fails for the right reason) → implement → run (pass) → `tsc` + `lint` → commit with the plan's message.
- Commit messages are conventional (`feat(...)`, `test:`, `chore:`). Match the plan's per-task messages.

## Remaining task content

The full TDD steps + exact code for each remaining task are in the plan:
- **Task 11** Account repo → plan lines ~1318–1478. *(apply entity-import fix #1)*
- **Task 12** Transaction repo → plan lines ~1480–1686. *(apply entity-import fix #1)*
- **Task 13** Session repo + `createRepos()` → plan lines ~1688–1850. *(apply entity-import fix #1 — `SessionContext` from `entities.js`)*
- **Task 14** `runAgent` seam (`createRunner` factory) + pure helpers (`isExpired`, `freshSession`, `trimTurns`, `extractLastTransactionId`) → plan lines ~1852–2038.
- **Task 15** System prompt (`BASE_PROMPT` + `formatCategories(CATEGORIES)`) → plan lines ~2040–2090.
- **Task 16** `buildTools` factory (`create_account`, `get_accounts`, `create_expense`; never-throw write gate) → plan lines ~2092–2340.
- **Task 17** Orchestrator `handleMessage` (tested with a fake runner) → plan lines ~2342–2562.
- **Task 18** grammY bot + entry point (`src/index.ts`) → plan lines ~2564–2665.
- **Task 19** End-to-end smoke test (manual) → plan lines ~2667–end.

## Definition of Done (Slice 0+1)

- All Vitest tests pass (`npm test`).
- `npm run lint` and `npx tsc --noEmit` clean.
- Bot runs (`npm run dev`): onboards an unknown user, creates an account, logs a categorized expense (`bakso 20000 bca`) with an Indonesian reply.
- No `pg` import outside `src/adapters/neon/` (enforced by ESLint NFR-02).

## After Slice 0+1

Subsequent slices (remaining tools incl. atomic `create_transfer` & full FR-08 correction; reports; scheduler + inline-keyboard callbacks; hardening/logging) each get their own plan. The design spec §9 outlines the slice breakdown.
