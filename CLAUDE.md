# MoneyBot

Personal-finance LLM agent on Telegram (Bahasa Indonesia). TypeScript/Node, grammY long-polling, Vercel AI SDK ReAct loop, `pg` on Neon Postgres. `userId`-scoped everywhere; multi-user-ready.

- **SRS:** `docs/SRS.md` (requirements source of truth)
- **Design spec:** `docs/superpowers/specs/2026-06-14-moneybot-impl-design.md`
- **Implementation plan:** `docs/superpowers/plans/2026-06-14-moneybot-slice-0-1.md`

## ⚠️ Active work in progress

Accounts-mode toggle (FR-11, `set_accounts_mode` + virtual-consolidation "Dompet") shipped on `master` per `docs/superpowers/plans/2026-09-13-accounts-mode-toggle.md`. Also on `master`: budget removal (`docs/superpowers/plans/2026-08-18-budget-removal.md`) and the advisory layer (`docs/superpowers/plans/2026-08-16-advisory-layer.md`, whose local `feat/advisory-layer` branch is stale and can be deleted).

## Architecture seams (hard rules)

- Layering: `agent → tools → repositories/interfaces → adapters/neon → Postgres`.
- **NFR-02:** `pg` / db drivers may be imported ONLY inside `src/adapters/neon/`. Enforced by ESLint `no-restricted-imports`.
- Tools layer imports from `repositories/interfaces.ts`, never from an adapter.
- **Write tools never throw** — they return a discriminated `WriteResult` (`ok | missing_fields | ambiguous | error`) so the ReAct loop always continues.

## Common commands

```bash
# DB: Neon serverless Postgres. DATABASE_URL (in .env) points at the dev project;
#     `npm test` truncates it. Point DATABASE_URL at the prod URL only at deploy time.
npm run migrate                 # apply migrations/*.sql (idempotent)
npm run seed                    # seed categories (idempotent)
npm test                        # vitest run (singleFork; global migrate+seed; per-test truncate)
npm run lint                    # ESLint (flat config)
npx tsc --noEmit                # type-check (strict + noUncheckedIndexedAccess + verbatimModuleSyntax)
npm run dev                     # tsx watch src/index.ts (needs real env in .env for a live run)
```

Env is loaded via `dotenv` in `src/config/index.ts`. Copy `.env.example` → `.env`; put real `TELEGRAM_BOT_TOKEN` + `OPENROUTER_API_KEY` for a live run.

## Verification before claiming done

Every task must pass: `npx tsc --noEmit` AND `npm run lint` AND the relevant `npx vitest run`. Vitest strips types, so it can pass while tsc fails — always run tsc too.
