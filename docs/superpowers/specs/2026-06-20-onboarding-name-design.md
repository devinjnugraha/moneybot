# MoneyBot — Onboarding Name Collection · Design

- **Date:** 2026-06-20
- **Status:** Design — ready for implementation planning
- **Prior art:** SRS (`docs/SRS.md`), impl design (`docs/superpowers/specs/2026-06-14-moneybot-impl-design.md`), FR-01

## Purpose

Fix the onboarding flow so the agent collects the user's name via conversation instead of hardcoding `name: 'Teman'` for every new user. The fix is LLM-driven (chat-first philosophy): the orchestrator creates the user with an empty name, the system prompt guides the model to ask, and a new `update_profile` tool lets the model persist the name once collected.

## Flow

```
New chatId → orchestrator creates User with name: '' (empty)
           → system prompt tells model: user is new, greet & ask name
           → model converses naturally, collects name
           → model calls update_profile({ name: 'Devin' })
           → model prompts for first account ("mau pakai akun apa?")
           → model calls create_account, then optionally create_budget_code
           → hasAccount becomes true → write tools unlock
```

The existing `hasAccount` gate in `buildTools` (line 353: `if (!hasAccount) return tools`) already blocks all write tools except `create_account` + read tools until ≥1 account exists. The only change: don't hardcode the name.

## Changes

Three files touched. One new tool. No migration needed.

### 1. `src/agent/orchestrator.ts` — one-line change

```ts
// Before:
user = await args.repos.users.create({ telegramChatId: args.chatId, name: 'Teman' });
// After:
user = await args.repos.users.create({ telegramChatId: args.chatId, name: '' });
```

### 2. `src/agent/tools.ts` — new `update_profile` tool

Always available (not gated behind `hasAccount`). Registered before the write gate.

```ts
tools.update_profile = tool({
  description: 'Perbarui profil user (nama, bahasa, timezone). Paling tidak satu field harus diisi.',
  parameters: z.object({
    name: z.string().optional(),
    language: z.enum(['id', 'en']).optional(),
    timezone: z.string().optional(),
  }),
  execute: async ({ name, language, timezone }) => {
    if (!name && !language && !timezone) {
      return { status: 'missing_fields', missing: ['name'] };
    }
    try {
      const patch: Record<string, unknown> = {};
      if (name !== undefined) patch.name = name;
      if (language !== undefined) patch.language = language;
      if (timezone !== undefined) patch.timezone = timezone;
      const updated = await repos.users.update(userId, patch);
      return { status: 'ok', data: updated };
    } catch (e) {
      logEvent('error', 'update_profile failed', { userId, error: (e as Error).message });
      return { status: 'error', message: 'Gagal memperbarui profil. Coba lagi.' };
    }
  },
});
```

Uses the existing `repos.users.update(userId, patch)` — no new repository method needed. Follows the write-tools-never-throw invariant.

### 3. `src/agent/system-prompt.ts` — onboarding guidance

Add to the mandatory rules block:

> 11. Saat pertama kali ngobrol dengan user baru (user belum punya akun dan namanya masih kosong), sapa dan tanyakan namanya. Simpan dengan `update_profile`. Kalau user belum mau kasih nama, panggil mereka 'Teman' sementara. Setelah nama tersimpan, arahkan user untuk membuat akun pertama.

## Edge cases

- **User refuses to give name:** Model instructed to use 'Teman' temporarily and proceed to account creation. `update_profile` can be called later.
- **User gives name mid-conversation later:** `update_profile` is always available, so `"panggil aku Budi"` works at any time.
- **`update_profile` called with no fields:** Zod validates presence; returns `missing_fields` if nothing provided.
- **Existing users unaffected:** The prompt condition is `name === '' AND hasAccount === false` — existing users with names skip the onboarding guidance.

## Testing

- **Tools (unit, mocked repos):** `update_profile` returns `ok` with updated user; empty params → `missing_fields`; repo throw → Bahasa `error`. Pattern matches existing tool test blocks.
- **Orchestrator (unit, fake runner):** assert new user created with `name: ''` (not `'Teman'`); existing user flow unchanged.
- **Full suite:** `npx tsc --noEmit`, `npm run lint`, `npm test` must all pass.

## Verification

1. `npx tsc --noEmit` clean
2. `npm run lint` clean
3. `npm test` green
4. Manual smoke (`npm run dev`): new Telegram user → bot asks name → user replies → bot saves name via `update_profile` → bot prompts for first account
