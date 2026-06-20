# MoneyBot — User Preferences Memory · Design

- **Date:** 2026-06-20
- **Status:** Design — ready for implementation planning
- **SRS reference:** supports the personal-finance agent's "zero-friction, remembers the user" goal (SRS §1); does not alter any FR/NFR
- **Authoritative for:** implementation of the preferences-memory feature. Where this doc and the SRS differ on existing behavior, the SRS stands; this doc only adds new surface.

## Purpose

Give the agent durable, per-user memory of stated preferences so it stops
re-asking things the user already told it ("pakai BCA aja bukan CC",
"gue gajian tanggal 25", "jangan kategorikan kopi sebagai jajanan"). The
memory is free-form key/value the LLM writes itself and is injected into the
system prompt on every turn, so the agent always "knows" the user's
preferences with no extra tool calls.

Non-goals (YAGNI, explicitly out of scope):
- Structured preference schemas (typed currency, salary day, etc.). Key and
  value are both free text; the LLM chooses labels.
- A `get_preferences` tool — unnecessary because preferences are injected
  every turn.
- Hard caps on value length or row count. A single user will not generate
  enough to matter; the tool description instructs the model to keep each
  preference short. (Revisit only if real abuse appears.)
- Cross-user or shared preferences. The app is `userId`-scoped; preferences
  are per-user.

## Architecture

Follows the existing layering unchanged (`agent → tools → repositories →
adapters/neon → Postgres`) and the existing seams:

- A new `IUserPreferenceRepository` joins the `Repos` bag in
  `src/repositories/interfaces.ts`; a Neon implementation lives in
  `src/adapters/neon/user-preference.repository.ts`; `createRepos()`
  assembles it.
- Two new write tools are registered in `src/agent/tools.ts` via the existing
  `buildTools` factory. They follow the **write tools never throw** rule —
  they return a discriminated result and surface Bahasa Indonesia on error
  (NFR-09), like every other write tool.
- Retrieval is **inject-every-turn**: the orchestrator appends a
  `PREFERENSI USER` block to the system prompt after it resolves the user.
  `buildSystemPrompt(todayWib)` and `src/index.ts` are unchanged — they own
  the user-independent base prompt; per-user enrichment belongs in the
  orchestrator, which already has `userId` + `repos`.

## Data model

### Entity (`src/domain/entities.ts`)

```ts
export interface UserPreference {
  userId: string;
  key: string;
  value: string;
  updatedAt: string;
}
```

### Schema (`migrations/002_user_preferences.sql`)

```sql
CREATE TABLE user_preferences (
  user_id    UUID        NOT NULL REFERENCES users(user_id),
  key        VARCHAR(96) NOT NULL,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);
```

- Composite primary key `(user_id, key)` — upserts by key replace the value;
  no duplicate or conflicting rows can accumulate.
- `key` capped at 96 chars to keep labels short; `value` is free `TEXT`.
- No index beyond the PK: the only access pattern is "all preferences for one
  user," served by the PK prefix on `user_id`.

## Repository contract

New interface in `src/repositories/interfaces.ts`; added to `Repos`:

```ts
export interface IUserPreferenceRepository {
  findAllByUserId(userId: string): Promise<UserPreference[]>;
  upsert(userId: string, key: string, value: string): Promise<UserPreference>;
  delete(userId: string, key: string): Promise<void>; // idempotent
}

export interface Repos {
  // ...existing six repos...
  preferences: IUserPreferenceRepository;
}
```

Neon implementation mirrors the existing repositories (snake_case columns →
camelCase entity via a new `mapUserPreference` in `mappers.ts`). `delete` is
idempotent: deleting a key that does not exist is a no-op (no row, no error).

## Tools

Registered in `buildTools` **always** (not gated behind onboarding —
preferences are not financial writes; a brand-new user may state a preference
before creating an account). They follow the existing `WriteResult` pattern
and never throw.

### `remember_preference` (write)

- Parameters: `{ key: string, value: string }`.
- Empty/whitespace `key` → `{ status: 'missing_fields', missing: ['key'] }`.
- Otherwise upserts and returns `{ status: 'ok', data: { key, value, updatedAt } }`.
- On repository error: logs via `logEvent` and returns
  `{ status: 'error', message: 'Gagal menyimpan preferensi. Coba lagi.' }` (NFR-09).

### `forget_preference` (write)

- Parameters: `{ key: string }`.
- Deletes the key (idempotent) and returns `{ status: 'ok', data: { key } }`.
- On repository error: logs and returns
  `{ status: 'error', message: 'Gagal menghapus preferensi. Coba lagi.' }` (NFR-09).

## Retrieval — system-prompt injection

In `handleMessage` (`src/agent/orchestrator.ts`), after user resolution and
**before** building tools, fetch the user's preferences and append a block to
the system prompt:

```ts
const prefs = await args.repos.preferences.findAllByUserId(user.userId);
const system = prefs.length
  ? `${args.system}\n\nPREFERENSI USER (sudah diketahui — jangan tanya ulang):\n` +
    prefs.map((p) => `- ${p.key}: ${p.value}`).join('\n')
  : args.system;
```

The enriched `system` is passed to `args.run({ system, ... })`. When the user
has no preferences, the prompt is untouched (no empty header is injected).

A short instruction is added to the base prompt in
`src/agent/system-prompt.ts`:

> Kalau user menyatakan preferensi (akun favorit, tanggal gajian, kebiasaan
> kategorisasi, dll.), simpan dengan `remember_preference`. Jangan tanya
> ulang hal yang sudah ada di PREFERENSI USER. Kalau user bilang "lupain" /
> "ga perlu lagi", hapus dengan `forget_preference`.

## Error handling

- Write tools never throw (existing invariant): all repository failures are
  caught, logged with `logEvent` (NFR-07), and returned as a Bahasa
  `error` result (NFR-09).
- `findAllByUserId` failure in the orchestrator: **graceful degradation.**
  Preferences are optional enrichment, not essential to the request — a
  transient DB error reading them must not block the user from, say, logging
  an expense. The orchestrator wraps the prefs fetch in try/catch: on
  failure it logs via `logEvent` and proceeds with the base prompt (no
  `PREFERENSI USER` block), so the agent still answers. (Contrast: essential
  reads like `accounts.findAllByUserId` propagate, because onboarding gating
  depends on them.)

## Testing

- **Repository (integration, real Postgres):** `findAllByUserId` empty → `[]`;
  `upsert` inserts then updates (same key replaces value, still one row);
  `delete` removes; `delete` of missing key is a no-op; isolation across
  users (one user's prefs invisible to another). Pattern matches
  `tests/adapters/*.repository.test.ts`.
- **Tools (unit, mocked repos):** `remember_preference` upserts and returns
  `ok`; empty key → `missing_fields`; repository throw → Bahasa `error` and
  `logEvent` called (NFR-09). `forget_preference` returns `ok` and calls
  `delete`; repository throw → Bahasa `error`. Pattern matches the existing
  `tests/agent/tools.test.ts` blocks (incl. the NFR-09 error-message suite).
- **Orchestrator (unit, fake runner):** when the mock repo returns ≥1 pref,
  the runner is called with a `system` containing the `PREFERENSI USER` block
  and the key/value pair; when it returns `[]`, the `system` equals the input
  base prompt unchanged.
- **Blast radius:** every mock-`Repos` factory in the test suite gains a
  `preferences` field (orchestrator, tools, callback-query, recurring-fire,
  defer-sweep). Mechanical; keeps `Repos` honest.

## Verification (end-to-end, after implementation)

1. `npx tsc --noEmit` clean.
2. `npm run lint` clean (NFR-02: no driver import outside `src/adapters/neon/`).
3. `npm test` green.
4. `npm run migrate` applies `002_user_preferences.sql`.
5. Manual smoke (`npm run dev`): tell the bot a preference in one turn
   ("buat sementara aku selalu pakai BCA"), confirm it replies acknowledging
   it, then in a later turn ask something where the preference should apply
   and confirm it is honored without re-asking. Then "lupain preference
   default_account" and confirm removal.

## Scope for the implementation plan

Single plan, single slice. Deliverables:

```
Create:
  migrations/002_user_preferences.sql
  src/adapters/neon/user-preference.repository.ts
  tests/adapters/user-preference.repository.test.ts
Modify:
  src/domain/entities.ts                      ← add UserPreference
  src/repositories/interfaces.ts              ← IUserPreferenceRepository + add to Repos
  src/adapters/neon/mappers.ts                ← mapUserPreference
  src/adapters/neon/repos.ts                  ← assemble preferences repo
  src/agent/tools.ts                          ← remember_preference, forget_preference
  src/agent/orchestrator.ts                   ← inject PREFERENSI USER block
  src/agent/system-prompt.ts                  ← preference instructions
  tests/agent/tools.test.ts                   ← tool tests + preferences mock
  tests/agent/orchestrator.test.ts            ← injection test + preferences mock
  tests/telegram/callback-query.test.ts       ← preferences mock
  tests/scheduler/recurring-fire.test.ts      ← preferences mock
  tests/scheduler/defer-sweep.test.ts         ← preferences mock
```
