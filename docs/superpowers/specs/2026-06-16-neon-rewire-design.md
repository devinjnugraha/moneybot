# Neon Postgres Rewire — Design

- **Date:** 2026-06-16
- **Status:** Implemented & verified
- **Branch:** `feat/slice-0-1`
- **Supersedes the Docker-based test DB** described in `2026-06-14-moneybot-slice-0-1.md` (that plan is left as a historical record).

## Context

MoneyBot ran its Postgres on local Docker (`docker-compose.yml`, `postgres:16` on `:5433`, tmpfs). Docker Desktop on Windows was flaky/heavy for the user, who asked to move to **serverless Postgres on Neon** and stop using Docker entirely. The existing architecture was already Neon-shaped (`src/adapters/neon/`), so this is a connection-string + teardown change, not a code change.

## Decisions

1. **Keep the `pg` driver over TCP.** MoneyBot is a grammY long-polling bot — a long-running Node process that holds a warm `pg.Pool`. Neon's pooled (`-pooler`) endpoint speaks plain Postgres-over-TLS, so `pg` works as-is. We did **not** switch to `@neondatabase/serverless` (the HTTP/WebSocket driver): that is only needed for serverless/edge deployments where each invocation is cold and can't hold a socket. No new dependency, no code change. (If the deploy target ever goes serverless, the swap is one file inside `src/adapters/neon/` — ESLint NFR-02 already permits `@neondatabase/serverless` there.)

2. **One env var, `DATABASE_URL`, unchanged in name.** The user swaps its value between contexts manually — no `DATABASE_URL_TEST`, no test-harness code change, no extra config machinery. This matches the user's minimal-infra preference.

3. **Two separate Neon projects** (cleaner isolation than the earlier "two DBs in one project" sketch):
   - **Dev** — `ep-silent-night-aodlewjl-pooler` — lives in `.env` as `DATABASE_URL`. Used by `npm run dev`, `npm run migrate`/`seed`, and `npm test`.
   - **Prod** — `ep-summer-mud-aoj9s5ma-pooler` — used only at deploy time via a `DATABASE_URL` env override. Not stored in `.env`.
   Both are on `ap-southeast-1`, database `neondb`.

4. **Tests run against the dev DB.** `tests/setup.ts` truncates every user-data table `beforeEach`; categories + `_migrations` are preserved. Because dev is throwaway, this is safe. **Prod is never touched by tests** — the spec/`.env.example` call this out loudly.

## What changed in the repo

- `.env` → `DATABASE_URL` now points at the Neon dev pooled connection string.
- `.env.example` → Neon-shaped placeholder with the SSL and "tests truncate this" warnings.
- `docker-compose.yml` → **deleted**.
- `CLAUDE.md` → removed the `docker compose up -d` command; replaced with a Neon note.
- `docs/superpowers/plans/2026-06-14-moneybot-slice-0-1-RESUME.md` → the "Docker required / how to start Docker Desktop" block replaced with a Neon block.
- **`src/` untouched.** Zero source-code changes. No `vitest.config.ts` change.

## Verified gotchas (these are why this doc exists)

All verified by running migrate+seed+`npm test` against Neon on 2026-06-16.

1. **SSL is mandatory; keep `?sslmode=require`.** `pg` honors it from the URI; strip it and Neon refuses the connection. Verified working.
   - `pg-connection-string` prints a deprecation **warning**: today `sslmode=require`/`prefer`/`verify-ca` are treated as the *stronger* `verify-full`; in `pg-connection-string` v3 / `pg` v9 they will adopt standard (weaker) libpq semantics. **To keep the current strong behavior and silence the warning**, change to `sslmode=verify-full` (Neon's cert chain + hostname match satisfy it). Left as-is for now because the connection works; flagged for a later tidy.

2. **Pooled endpoint = PgBouncer transaction mode.** Safe for our query pattern: every call is anonymous `pool.query(sql, [vals])` (unnamed prepared statement, one statement per call) and transactions are single checked-out `client` blocks (`migrate.ts`). It would only break if we ever used **named** prepared statements or held session state across transactions — we don't. **32/32 tests pass** over the pooler.

3. **`channel_binding=require` did not block `pg`.** `pg` connects fine with the param present. (If a future `pg`/Neon change ever rejects it, dropping `&channel_binding=require` and keeping `sslmode=require` is the fallback.)

4. **Free-tier compute auto-suspends after idle** (~5 min). The first `npm test` / first bot query after a quiet stretch eats a ~1–3s cold start. Not breaking. Switch the compute to "always-on" on a paid plan if the latency annoys.

## Verification (2026-06-16)

| Check | Result |
|---|---|
| `npm run migrate` + `npm run seed` (dev) | ✅ `001_init.sql` applied, 58 categories seeded |
| `npm run migrate` + `npm run seed` (prod, env override) | ✅ same |
| `npm test` (against dev) | ✅ 7 files, **32/32 pass** (~5s of tests) |
| `npx tsc --noEmit` | ✅ clean |
| `npm run lint` | ✅ clean |

The migrate/seed/test run **is** the connection validation: if SSL, the pooler, or the connection string were wrong, the suite would fail immediately. It didn't.
