# MoneyBot — Slice 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the final SRS tool T15 `get_report` with category/budget grouping, plus NL date resolution so users can ask "pengeluaran bulan ini per kategori" and get a correct, formatted breakdown.

**Architecture:** `get_report` is a read tool that queries transactions via `findByDateRange`, aggregates in-memory by category or budget code, and returns structured totals + percentages. NL date resolution is model-driven: the system prompt embeds today's WIB date and resolution rules so the model computes `from`/`to` itself. No new repository methods needed — the existing date-range query is sufficient.

**Tech Stack:** TypeScript 5, Vercel AI SDK (`ai` + `@ai-sdk/openai` via OpenRouter), `zod`, `pg` (Neon), Vitest, ESLint, `tsx`.

**Reference:** Design spec at `docs/superpowers/specs/2026-06-14-moneybot-impl-design.md` (§9 Slice 3). SRS at `docs/SRS.md` (FR-10, T15, G5). Slice 2 plan at `docs/superpowers/plans/2026-06-18-moneybot-slice-2.md`.

---

## File Structure (this plan's deliverables — new + modified)

```
Modify:
  src/agent/system-prompt.ts       ← embed current WIB date + NL date resolution rules + reporting guidance
  src/agent/tools.ts               ← add get_report (T15)
  tests/agent/tools.test.ts        ← add get_report describe block
```

**Design discipline:** `get_report` is a read tool — it returns data, never a `WriteResult`. Aggregation happens in the tool layer over results from the existing `findByDateRange` (which already filters `deleted_at IS NULL` per NFR-06). Transfers and soft-deleted transactions are excluded automatically by the query/type filter (FR-10e). No new repository methods. No DB changes.

---

## Task 1: System prompt — reporting + NL date resolution + dynamic WIB today

**Files:**
- Modify: `src/agent/system-prompt.ts`

The system prompt currently has a static `BASE_PROMPT`. We need to:
1. Make it a function that accepts today's WIB date string
2. Add NL date resolution rules (the model computes `from`/`to` itself)
3. Add `get_report` usage guidance

- [ ] **Step 1: Update `src/agent/system-prompt.ts`**

Replace the file contents with:

```ts
import { CATEGORIES } from '../domain/categories.js';

function formatCategories(): string {
  return CATEGORIES.map((c) => `- ${c.categoryId} — ${c.name} (${c.nameEn})`).join('\n');
}

/**
 * Build the system prompt with the current WIB date embedded so the model can
 * resolve NL date expressions ("bulan ini", "minggu ini") without a tool call.
 */
export function buildSystemPrompt(todayWib: string): string {
  return `Kamu adalah asisten keuangan pribadi MoneyBot. Balas selalu dalam Bahasa Indonesia yang natural dan ringkas.

Hari ini (WIB): ${todayWib}

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

RESOLUSI TANGGAL NATURAL LANGUAGE (WIB):
Saat user minta laporan dengan frasa seperti "bulan ini", "minggu ini", "kemarin", "3 hari terakhir", dsb., kamu harus menghitung sendiri rentang tanggalnya (from dan to dalam format YYYY-MM-DD). Gunakan "Hari ini (WIB)" di atas sebagai acuan.

Aturan resolusi:
- "hari ini" → from = to = hari ini
- "kemarin" → from = to = hari ini dikurangi 1 hari
- "minggu ini" → from = Senin minggu ini, to = hari ini
- "minggu lalu" → from = Senin minggu lalu, to = Minggu minggu lalu
- "bulan ini" → from = hari pertama bulan ini (YYYY-MM-01), to = hari ini
- "bulan lalu" → from = hari pertama bulan lalu, to = hari terakhir bulan lalu
- "tahun ini" → from = YYYY-01-01, to = hari ini
- "N hari terakhir" → from = hari ini dikurangi (N-1) hari, to = hari ini
- "dari <tanggal> sampai <tanggal>" → parse langsung dari input user

Setelah menghitung from dan to, panggil get_report dengan nilai tersebut.

LAPORAN (get_report):
Gunakan get_report untuk laporan agregat. Kalau user minta detail transaksi per transaksi, gunakan get_transactions.
- "pengeluaran bulan ini" → get_report(type: 'expense', from, to)
- "pengeluaran per kategori" → get_report(type: 'expense', from, to, groupBy: 'category')
- "pengeluaran budget X" → get_report(type: 'expense', from, to, budgetCodeId: '<resolved>'): resolve dulu nama budget code ke budgetCodeId via get_budget_codes

Pembayaran rutin bulanan: kalau user menyebutkan pengeluaran yang terjadi tiap bulan, tawarkan untuk menyimpannya sebagai recurring payment supaya diingatkan tiap bulan. Gunakan create_recurring_payment setelah transaksi berhasil dicatat.

Transfer antar akun: Transfer memindahkan saldo antar dua akun. Pastikan nama kedua akun sudah jelas (resolusi via get_accounts). Kalau user bilang 'transfer X dari A ke B', fromAccountId = A, toAccountId = B. Transfer tidak pakai categoryId dan tidak dihitung sebagai pemasukan atau pengeluaran.

Pemasukan: Mirip pengeluaran tetapi saldo bertambah. Format sama: <deskripsi> <jumlah> <akun>. Contoh: "gaji 5000000 bca" atau "freelance 2000000 mandiri". Gunakan create_income. Kategori pemasukan sudah tersedia di taksonomi.

Pengeluaran biasanya: <deskripsi> <jumlah> <akun>. Contoh: "bakso 20000 bca" → deskripsi=bakso, jumlah=20000, akun=BCA. Kategorikan otomatis berdasarkan taksonomi di bawah; pilih subkategori paling spesifik. Gunakan BOTH label Indonesia dan English saat menalar kategori.

TAKSONOMI KATEGORI (categoryId — Indonesia (English)):
${formatCategories()}`;
}

/** Static fallback for contexts that don't have a WIB date (legacy). */
export const BASE_PROMPT = buildSystemPrompt('2026-01-01');

/** Legacy export — use buildSystemPrompt(todayWib) instead. */
export const SYSTEM_PROMPT = BASE_PROMPT;
```

- [ ] **Step 2: Update `src/index.ts` to use `buildSystemPrompt`**

The entry point passes `SYSTEM_PROMPT` to `handleMessage`. It should now pass a dynamically-built prompt. Modify the import and the `handleMessage` call:

Change the import from:
```ts
import { SYSTEM_PROMPT } from './agent/system-prompt.js';
```
to:
```ts
import { buildSystemPrompt } from './agent/system-prompt.js';
import { todayWIB } from './domain/time.js';
```

Then in the `registerMessageHandler` callback, compute the system prompt per-request:
```ts
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
```

- [ ] **Step 3: Type-check + lint + full suite**

Run: `npx tsc --noEmit` → `npm run lint` → `npm test`
Expected: all clean, all 66 existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/agent/system-prompt.ts src/index.ts
git commit -m "feat(agent): dynamic WIB today in system prompt + NL date resolution rules + reporting guidance

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: `get_report` tool — T15 (TDD)

**Files:**
- Modify: `src/agent/tools.ts` — register `get_report`
- Modify: `tests/agent/tools.test.ts` — add `get_report` describe block

T15 `get_report` is the final SRS tool. It queries transactions for a date range, aggregates by category or budget code, and returns totals with percentages. It is a **read tool** — returns data, never a `WriteResult`.

- [ ] **Step 1: Write the failing test**

Add to `tests/agent/tools.test.ts` after the last existing describe block (before the closing of the file):

```ts
describe('buildTools — get_report (T15)', () => {
  const txn = (overrides: Partial<{
    transactionId: string; type: string; amount: number; description: string;
    categoryId: string; accountId: string; budgetCodeId: string; date: string;
  }> = {}) => ({
    transactionId: overrides.transactionId ?? 't1',
    userId: 'u1',
    type: (overrides.type as 'expense' | 'income' | 'transfer') ?? 'expense',
    amount: overrides.amount ?? 20_000,
    description: overrides.description ?? 'bakso',
    categoryId: overrides.categoryId ?? 'food.dining',
    accountId: overrides.accountId ?? 'a1',
    budgetCodeId: overrides.budgetCodeId ?? null,
    date: overrides.date ?? '2026-06-15',
    isRecurringInstance: false,
    createdAt: '', updatedAt: '', notes: null, toAccountId: null, recurringId: null, deletedAt: null,
  });

  it('returns total + count for a date range (no grouping)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          txn({ transactionId: 't1', amount: 20_000, categoryId: 'food.dining' }),
          txn({ transactionId: 't2', amount: 50_000, categoryId: 'transport.ridehail' }),
          txn({ transactionId: 't3', amount: 30_000, categoryId: 'food.dining' }),
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => []),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_report } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_report, { from: '2026-06-01', to: '2026-06-30', type: 'expense' });
    expect(res).toEqual({ total: 100_000, count: 3, groups: undefined });
  });

  it('groups by category and returns percentages sorted descending', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          txn({ transactionId: 't1', amount: 20_000, categoryId: 'food.dining' }),
          txn({ transactionId: 't2', amount: 50_000, categoryId: 'transport.ridehail' }),
          txn({ transactionId: 't3', amount: 30_000, categoryId: 'food.dining' }),
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => []),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_report } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_report, { from: '2026-06-01', to: '2026-06-30', type: 'expense', groupBy: 'category' });
    expect(res.total).toBe(100_000);
    expect(res.groups).toHaveLength(2);
    // Sorted by amount desc: transport.ridehail (50k) then food.dining (50k combined)
    expect(res.groups![0]!.groupKey).toBe('transport.ridehail');
    expect(res.groups![0]!.total).toBe(50_000);
    expect(res.groups![0]!.percentage).toBe(50);
    expect(res.groups![1]!.groupKey).toBe('food.dining');
    expect(res.groups![1]!.total).toBe(50_000);
    expect(res.groups![1]!.percentage).toBe(50);
  });

  it('groups by budget code', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          txn({ transactionId: 't1', amount: 20_000, budgetCodeId: 'b-jajan' }),
          txn({ transactionId: 't2', amount: 80_000, budgetCodeId: 'b-jajan' }),
          txn({ transactionId: 't3', amount: 30_000, budgetCodeId: null }),
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => [
          { budgetCodeId: 'b-jajan', userId: 'u1', name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026, spent: 0, createdAt: '', updatedAt: '' },
        ]),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_report } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_report, { from: '2026-06-01', to: '2026-06-30', type: 'expense', groupBy: 'budget' });
    expect(res.total).toBe(130_000);
    expect(res.groups).toHaveLength(2);
    // "Tanpa Budget" group for null budgetCodeId
    const withoutBudget = res.groups!.find((g: { groupKey: string }) => g.groupKey === '__none__');
    expect(withoutBudget!.total).toBe(30_000);
    expect(withoutBudget!.label).toBe('Tanpa Budget');
    const jajan = res.groups!.find((g: { groupKey: string }) => g.groupKey === 'b-jajan');
    expect(jajan!.total).toBe(100_000);
  });

  it('filters by budgetCodeId for drill-down (FR-10c)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          txn({ transactionId: 't1', amount: 20_000, budgetCodeId: 'b-jajan', categoryId: 'food.dining', description: 'bakso' }),
          txn({ transactionId: 't2', amount: 80_000, budgetCodeId: 'b-jajan', categoryId: 'shopping.online', description: 'belanja' }),
          txn({ transactionId: 't3', amount: 30_000, budgetCodeId: 'b-family', categoryId: 'food.groceries', description: 'sayur' }),
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => [
          { budgetCodeId: 'b-jajan', userId: 'u1', name: 'Jajan', monthlyBudget: 500_000, month: 6, year: 2026, spent: 100_000, createdAt: '', updatedAt: '' },
        ]),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_report } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_report, {
      from: '2026-06-01', to: '2026-06-30', type: 'expense', budgetCodeId: 'b-jajan',
    });
    // Only the two jajan transactions included
    expect(res.total).toBe(100_000);
    expect(res.count).toBe(2);
    // With budgetCodeId filter, groups are still returned for category breakdown
    expect(res.groups).toHaveLength(2);
  });

  it('excludes transfers (FR-10e)', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          txn({ transactionId: 't1', amount: 20_000, type: 'expense' }),
          txn({ transactionId: 't2', amount: 30_000, type: 'transfer' }),
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => []),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_report } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_report, { from: '2026-06-01', to: '2026-06-30', type: 'expense' });
    // Transfer excluded — only the expense counted
    expect(res.total).toBe(20_000);
    expect(res.count).toBe(1);
  });

  it('resolves category icons from CATEGORIES taxonomy', async () => {
    const repos = mockRepos({
      transactions: {
        create: vi.fn(),
        createTransfer: vi.fn(),
        findByDateRange: vi.fn(async () => [
          txn({ transactionId: 't1', amount: 20_000, categoryId: 'food.dining' }),
        ]),
        findByAccountAndDateRange: vi.fn(),
        findLatestByUserId: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        softDelete: vi.fn(),
      } as never,
      budgets: {
        findByUserAndMonth: vi.fn(async () => []),
        findByName: vi.fn(),
        create: vi.fn(),
        incrementSpent: vi.fn(),
        update: vi.fn(),
      } as never,
    });
    const { get_report } = buildTools({ userId: 'u1', repos, hasAccount: true });
    const res = await callExec(get_report, { from: '2026-06-01', to: '2026-06-30', type: 'expense', groupBy: 'category' });
    expect(res.groups![0]!.icon).toBe('🍜');
    expect(res.groups![0]!.label).toBe('Makan di Luar');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: FAIL — `get_report` is undefined (`buildTools` doesn't register it yet).

- [ ] **Step 3: Implement `get_report` in `src/agent/tools.ts`**

Add the import for `CATEGORIES` at the top (already imported). Add after `get_account_balance` (line ~166, before the `if (!hasAccount) return tools;` gate — it's a read tool, always available post-onboarding):

```ts
  tools.get_report = tool({
    description:
      'Laporan agregat pengeluaran/pemasukan untuk rentang tanggal. ' +
      'Bisa dikelompokkan per kategori atau budget code, atau difilter ke budget code tertentu. ' +
      'Transfer SELALU dikecualikan dari laporan (FR-10e).',
    parameters: z.object({
      from: z.string().describe('YYYY-MM-DD (WIB), inklusif.'),
      to: z.string().describe('YYYY-MM-DD (WIB), inklusif.'),
      type: z.enum(['expense', 'income']).optional().default('expense'),
      groupBy: z.enum(['category', 'budget']).optional(),
      budgetCodeId: z.string().optional().describe('Filter ke satu budget code (untuk drill-down).'),
    }),
    execute: async ({ from, to, type, groupBy, budgetCodeId }) => {
      const rows = await repos.transactions.findByDateRange(userId, from, to);

      // Filter: exclude transfers + soft-deleted (findByDateRange already
      // filters deleted_at IS NULL), match type, optionally by budgetCodeId.
      const filtered = rows.filter((t) => {
        if (t.type !== type) return false;
        if (budgetCodeId && t.budgetCodeId !== budgetCodeId) return false;
        return true;
      });

      const total = filtered.reduce((sum, t) => sum + t.amount, 0);
      const count = filtered.length;

      if (!groupBy) {
        return { total, count, groups: undefined };
      }

      // Aggregate by groupKey
      const groups = new Map<string, { total: number; count: number }>();
      for (const t of filtered) {
        const key = groupBy === 'category'
          ? (t.categoryId ?? '__uncategorized__')
          : (t.budgetCodeId ?? '__none__');
        const g = groups.get(key) ?? { total: 0, count: 0 };
        g.total += t.amount;
        g.count += 1;
        groups.set(key, g);
      }

      // Build result array sorted by total descending
      const categoryMap = new Map(CATEGORIES.map((c) => [c.categoryId, c]));
      const budgetMap = groupBy === 'budget'
        ? new Map(
            (await repos.budgets.findByUserAndMonth(
              userId,
              Number(from.slice(0, 4)),
              Number(from.slice(5, 7)),
            )).map((b) => [b.budgetCodeId, b]),
          )
        : new Map();

      const result = Array.from(groups.entries())
        .map(([groupKey, g]) => {
          let label: string;
          let icon: string | undefined;
          if (groupBy === 'category') {
            const cat = groupKey !== '__uncategorized__' ? categoryMap.get(groupKey) : undefined;
            label = cat?.name ?? 'Tanpa Kategori';
            icon = cat?.icon;
          } else {
            const bc = groupKey !== '__none__' ? budgetMap.get(groupKey) : undefined;
            label = bc?.name ?? 'Tanpa Budget';
            icon = undefined;
          }
          return {
            groupKey,
            label,
            icon,
            total: g.total,
            percentage: total > 0 ? Math.round((g.total / total) * 100) : 0,
            count: g.count,
          };
        })
        .sort((a, b) => b.total - a.total);

      return { total, count, groups: result };
    },
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: PASS (33 tests — 27 existing + 6 new).

- [ ] **Step 5: Type-check + lint**

Run: `npx tsc --noEmit` → `npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "feat(tools): T15 get_report — aggregate reports with category/budget grouping (FR-10)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Full suite verification

**Files:** None new — verify everything is clean.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all 72 tests pass (66 existing + 6 new).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors (NFR-02 enforced — no `pg` import outside `src/adapters/neon/`).

- [ ] **Step 4: Commit (if any fixups needed)**

If all clean, no commit needed (Task 2 already committed). If small fixups were needed:

```bash
git add -u
git commit -m "chore: Slice 3 final verification — all tests, types, lint pass

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Definition of Done (Slice 3)

- [ ] All Vitest tests pass (`npm test`) — 72 tests
- [ ] `npm run lint` and `npx tsc --noEmit` clean
- [ ] T15 `get_report` is registered and tested with:
  - Period summary (total + count)
  - Category grouping (sorted by amount, with percentages and icons)
  - Budget code grouping (with "Tanpa Budget" for null budgetCodeId)
  - Budget code drill-down filter (FR-10c)
  - Transfer exclusion (FR-10e)
- [ ] System prompt embeds dynamic WIB today + NL date resolution rules
- [ ] `buildSystemPrompt(todayWib)` replaces the static `SYSTEM_PROMPT` in `src/index.ts`
- [ ] All 16 SRS tools (T01–T16) are now registered
- [ ] No `pg` import outside `src/adapters/neon/` (enforced by ESLint NFR-02)

## After Slice 3

Slice 4 (scheduler: daily cron + 5-min defer sweep + inline-keyboard callbacks + `pendingRecurringConfirmation`) gets its own plan per the design spec §9.

---

## Plan self-review

1. **Spec coverage:** FR-10a (period summary) → Task 2 `get_report` no-grouping; FR-10b (by category) → Task 2 `get_report` groupBy category; FR-10c (by budget code) → Task 2 `get_report` budgetCodeId filter + groupBy budget; FR-10d (account balance) → already covered by T16 in Slice 2; FR-10e (invariants: no transfers, no soft-deleted, IDR format, DD Mon YYYY) → Task 2 filter logic + system prompt rules 9–10. T15 → Task 2. NL date resolution → Task 1 system prompt. G5 (NL reporting) → Task 1 + Task 2 together.

2. **Placeholder scan:** No TBD/TODO. All test and implementation code is complete. All function signatures reference existing types. The `get_report` execute body uses concrete filter logic — no "implement later" stubs.

3. **Type consistency:** `get_report` returns `{ total: number; count: number; groups?: Array<{...}> }` — a plain object, not `WriteResult` (it's a read tool). The `callExec` helper in the test is typed as `ToolCallResult` which has `status: string`, but `get_report` returns `{ total, count, groups }` without a `status` field. The tests need a separate type for read-tool results. **Fix:** In the test, the `callExec` return type needs updating, or we use a separate helper for read tools. The plan's test calls use `res.total`, `res.groups` etc. which don't exist on `ToolCallResult`. 

**Self-review fix:** The test file's `ToolCallResult` type and `callExec` helper are typed for write tools (expecting `status`). Read tools return arbitrary data. The `callExec` return type needs widening. Let me fix this in the plan.

**Correction to Task 2 Step 1:** The `callExec` helper's return type needs to accommodate read-tool results. Update the type definition in the test file:

```ts
type ToolCallResult = {
  status?: string;
  missing?: string[];
  field?: string;
  matches?: unknown[];
  options?: Record<string, unknown> | null;
  data?: { transaction?: { transactionId?: string }; budget?: { spent: number; limit: number; exceeded: boolean } };
  // get_report (T15) fields:
  total?: number;
  count?: number;
  groups?: Array<{
    groupKey: string;
    label: string;
    icon?: string;
    total: number;
    percentage: number;
    count: number;
  }>;
};
```

Add these optional fields to the existing `ToolCallResult` type at line 42-49 of `tests/agent/tools.test.ts`. The test assertions use `res.total`, `res.count`, `res.groups` which will now type-check.
