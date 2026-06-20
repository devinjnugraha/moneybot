# Onboarding Name Collection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix onboarding so the LLM collects the user's name instead of hardcoding `'Teman'` for every new user.

**Architecture:** Create user with `name: ''`, let the LLM drive the conversation per the system-prompt onboarding rule, persist via a new `update_profile` tool. No migration. The existing `hasAccount` gate still controls all write-tool access.

**Tech Stack:** TypeScript, Vitest, mocked repos (tools tests), fake runner (orchestrator tests).

**Spec:** `docs/superpowers/specs/2026-06-20-onboarding-name-design.md`

---

### Task 1: Orchestrator — create user with empty name

**Files:**
- Modify: `tests/agent/orchestrator.test.ts` (add assertion)
- Modify: `src/agent/orchestrator.ts:35` (one-line change)

- [ ] **Step 1: Strengthen the orchestrator test — assert empty name on onboarding**

The existing test at `tests/agent/orchestrator.test.ts:71-88` already checks `repos.users.create` is called with `{ telegramChatId: '999' }`, but only uses `expect.objectContaining` so it wouldn't catch a hardcoded name. Add an explicit assertion that `name` is `''` (empty string, not `'Teman'`).

In `tests/agent/orchestrator.test.ts`, find the test `'onboards an unknown user and replies with the onboarding prompt'` (line 71). After line 82 (`expect(onboarded).toBe(true);`), add:

```ts
// Verify user is created with empty name — the LLM collects it via conversation
const createCall = (repos.users.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { name: string };
expect(createCall.name).toBe('');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/agent/orchestrator.test.ts -t "onboards an unknown user"
```

Expected: FAIL — the test expects `name: ''` but the code currently passes `name: 'Teman'`.

- [ ] **Step 3: Change the hardcoded name to empty string**

In `src/agent/orchestrator.ts`, line 35, change:

```ts
// Before:
user = await args.repos.users.create({ telegramChatId: args.chatId, name: 'Teman' });
// After:
user = await args.repos.users.create({ telegramChatId: args.chatId, name: '' });
```

- [ ] **Step 4: Run orchestrator tests to verify they pass**

```bash
npx vitest run tests/agent/orchestrator.test.ts
```

Expected: all orchestrator tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/agent/orchestrator.test.ts src/agent/orchestrator.ts
git commit -m "fix(agent): create new users with empty name instead of 'Teman'"
```

---

### Task 2: `update_profile` tool (TDD)

**Files:**
- Modify: `tests/agent/tools.test.ts` (add test block)
- Modify: `src/agent/tools.ts` (add tool definition)

- [ ] **Step 1: Write the failing tests for `update_profile`**

In `tests/agent/tools.test.ts`, add a new `describe` block before the final `describe('buildTools — remember_preference / forget_preference', ...)` block (before line 1129). Insert after the last `deactivate_recurring_payment` error test (after line 1127):

```ts
describe('buildTools — update_profile', () => {
  it('updates the user name and returns ok', async () => {
    const repos = mockRepos({
      users: {
        create: vi.fn(),
        update: vi.fn(async (_uid: string, patch: Record<string, unknown>) => ({
          userId: 'u1', telegramChatId: '999', name: patch.name ?? '',
          language: 'id' as const, timezone: 'Asia/Jakarta', createdAt: '', updatedAt: '',
        })),
      } as never,
    });
    const { update_profile } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(update_profile, { name: 'Devin' });
    expect(res.status).toBe('ok');
    expect(res.data).toMatchObject({ name: 'Devin' });
    expect((repos.users.update as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('u1', { name: 'Devin' });
  });

  it('updates language and timezone', async () => {
    const repos = mockRepos({
      users: {
        create: vi.fn(),
        update: vi.fn(async () => ({
          userId: 'u1', telegramChatId: '999', name: 'Devin',
          language: 'en', timezone: 'Asia/Makassar', createdAt: '', updatedAt: '',
        })),
      } as never,
    });
    const { update_profile } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(update_profile, { language: 'en', timezone: 'Asia/Makassar' });
    expect(res.status).toBe('ok');
    expect((repos.users.update as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('u1', { language: 'en', timezone: 'Asia/Makassar' });
  });

  it('returns missing_fields when no fields are provided', async () => {
    const repos = mockRepos();
    const { update_profile } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(update_profile, {});
    expect(res.status).toBe('missing_fields');
    expect(res.missing).toContain('name');
  });

  it('returns Bahasa error when the repo throws (NFR-09)', async () => {
    const repos = mockRepos({
      users: {
        create: vi.fn(),
        update: vi.fn(async () => { throw new Error('DB DOWN'); }),
      } as never,
    });
    const { update_profile } = buildTools({ userId: 'u1', repos, hasAccount: false });
    const res = await callExec(update_profile, { name: 'Devin' });
    expect(res).toEqual({ status: 'error', message: 'Gagal memperbarui profil. Coba lagi.' });
    expect(logEvent).toHaveBeenCalledWith('error', expect.any(String), expect.objectContaining({ userId: 'u1' }));
  });

  it('is always available (not gated by hasAccount)', () => {
    const tools = buildTools({ userId: 'u1', repos: mockRepos(), hasAccount: false });
    expect(tools.update_profile).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tool tests to verify they fail**

```bash
npx vitest run tests/agent/tools.test.ts -t "update_profile"
```

Expected: FAIL — `update_profile` is undefined; `buildTools` doesn't register it yet.

- [ ] **Step 3: Add `update_profile` tool to `buildTools`**

In `src/agent/tools.ts`, add the `update_profile` tool before the `remember_preference` tool (before line 221, `tools.remember_preference = tool({...`).

Insert after the `get_account_balance` tool block (after line 219) and before `remember_preference`:

```ts
  tools.update_profile = tool({
    description:
      'Perbarui profil user (nama, bahasa, timezone). Paling tidak satu field harus diisi. ' +
      'Panggil ini untuk menyimpan nama user saat onboarding.',
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

- [ ] **Step 4: Run tool tests to verify they pass**

```bash
npx vitest run tests/agent/tools.test.ts -t "update_profile"
```

Expected: all `update_profile` tests PASS.

- [ ] **Step 5: Run the full tools test suite to check no regressions**

```bash
npx vitest run tests/agent/tools.test.ts
```

Expected: all tests PASS (including existing onboarding gating tests — `update_profile` is always registered so it doesn't break the gating assertions on `create_expense` being undefined).

- [ ] **Step 6: Commit**

```bash
git add tests/agent/tools.test.ts src/agent/tools.ts
git commit -m "feat(tools): add update_profile tool for LLM-driven name collection"
```

---

### Task 3: System prompt onboarding guidance + full verification

**Files:**
- Modify: `src/agent/system-prompt.ts` (add rule 11)

- [ ] **Step 1: Add onboarding rule to the system prompt**

In `src/agent/system-prompt.ts`, in `buildSystemPrompt`, after rule 10 (line that ends with `JANGAN pernah output "Rp" atau "IDR".`), add rule 11:

```ts
11. Saat pertama kali ngobrol dengan user baru (user belum punya akun dan namanya masih kosong), sapa dan tanyakan namanya. Simpan dengan update_profile. Kalau user belum mau kasih nama, panggil mereka 'Teman' sementara. Setelah nama tersimpan, arahkan user untuk membuat akun pertama.
```

The exact edit point: in the `buildSystemPrompt` function, locate line 26 (rule 10 ending with `JANGAN pernah output "Rp" atau "IDR".`). Insert a blank line after it, then the new rule.

Full context of the change:

```
10. Format semua nominal pakai locale IDR: titik sebagai pemisah ribuan, tanpa simbol mata uang (contoh: 20.000, 1.500.000). JANGAN pernah output "Rp" atau "IDR".
11. Saat pertama kali ngobrol dengan user baru (user belum punya akun dan namanya masih kosong), sapa dan tanyakan namanya. Simpan dengan update_profile. Kalau user belum mau kasih nama, panggil mereka 'Teman' sementara. Setelah nama tersimpan, arahkan user untuk membuat akun pertama.

RESOLUSI TANGGAL NATURAL LANGUAGE (WIB):
```

- [ ] **Step 2: Run the test suite to check no regressions**

```bash
npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: clean, no errors.

- [ ] **Step 4: Lint**

```bash
npm run lint
```

Expected: clean, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent/system-prompt.ts
git commit -m "feat(agent): add onboarding guidance (rule 11) — collect user name via update_profile"
```

---

## Verification (after all tasks)

```bash
npx tsc --noEmit        # type-check
npm run lint            # ESLint
npm test                # full suite
```

All three must be clean/green. Manual smoke (`npm run dev`): new Telegram user → bot greets and asks name → user replies → bot saves name via `update_profile` → bot prompts for first account.
