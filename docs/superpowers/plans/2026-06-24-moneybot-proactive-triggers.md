# Proactive Triggers — "Watching Me" Layer (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a merged morning glance (glance text + today's due-bill confirm buttons in one engine-routed message) and a reactive inline post-write insight, making MoneyBot feel like an observant companion.

**Architecture:** Additive to the existing proactive engine. (1) Widen the engine's `Composer`/`send` to carry an optional inline keyboard so one morning message can hold glance text + due-bill buttons (callback data reuses the existing `rec:` format → tap handler unchanged). (2) A new morning-glance detector + dedicated composer + cron, retiring the standalone `fireRecurringPayments` cron. (3) Enrich write-tool results with an `insightContext` snapshot and generalize system-prompt rule 4 so the reactive agent adds one observational line after writes.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), grammY, Vercel AI SDK (`generateText`), `node-cron`, Vitest, Neon Postgres.

**Spec:** `docs/superpowers/specs/2026-06-24-moneybot-proactive-triggers-design.md`

---

## File Structure

**Create:**
- `src/proactive/triggers/morning-glance.ts` — `detectMorningGlance` detector (balances + week's upcoming + yesterday + today's due bills).
- `src/proactive/composers/morning-glance.ts` — `createMorningGlanceComposer(model)` (LLM text + programmatic keyboard, template fallback).
- `tests/proactive/triggers/morning-glance.test.ts` — detector unit tests.
- `tests/proactive/composers/morning-glance.test.ts` — composer unit tests.
- `tests/agent/tools-insight-disabled.test.ts` — `PROACTIVE_INSIGHT_ENABLED=false` gating.

**Modify:**
- `src/proactive/types.ts` — add `ComposerOutput`, widen `Composer` return type.
- `src/proactive/dispatcher.ts` — widen `send`, normalize composer output → text + optional replyMarkup.
- `src/proactive/composers/template.ts` — add `morningGlanceTemplate` + switch case.
- `src/proactive/prompt.ts` — add `MORNING_GLANCE_SYSTEM_PROMPT`.
- `src/domain/entities.ts` — add `morning_glance` trigger type, `InsightContext`, extend `TransactionResult`.
- `src/telegram/formatter.ts` — add `dueBillsKeyboard`.
- `src/agent/tools.ts` — add `computeInsightContext`, wire into 4 write paths (gated by `PROACTIVE_INSIGHT_ENABLED`).
- `src/agent/system-prompt.ts` — generalize rule 4.
- `src/scheduler/cron.ts` — widen `send` lambda; register morning-glance cron; remove recurring-fire cron + import.
- `src/config/index.ts` — add `PROACTIVE_MORNING_GLANCE_CRON`, `PROACTIVE_INSIGHT_ENABLED`; remove `CRON_SCHEDULE`.
- `.env.example` — add new vars; remove `CRON_SCHEDULE`.
- `tests/proactive/dispatcher.test.ts` — update send-arg assertions; add replyMarkup test.
- `tests/telegram/formatter.test.ts` — add `dueBillsKeyboard` tests.
- `tests/proactive/composers/template.test.ts` — add morning-glance template test.
- `tests/agent/system-prompt.test.ts` — add rule-4 insight assertion.
- `tests/agent/tools.test.ts` — add `insightContext` assertions.

**Delete:**
- `src/scheduler/recurring-fire.ts` (no remaining caller after cron change).
- `tests/scheduler/recurring-fire.test.ts`.

---

## Task 1: Engine — optional `reply_markup` support

**Files:**
- Modify: `src/proactive/types.ts`
- Modify: `src/proactive/dispatcher.ts`
- Modify: `src/scheduler/cron.ts`
- Modify: `tests/proactive/dispatcher.test.ts`

- [ ] **Step 1: Widen the Composer contract (`src/proactive/types.ts`)**

Add the `InlineKeyboardMarkup` import and a `ComposerOutput` type, then widen `Composer` to allow returning it. After the existing `ComposerCtx` interface and replacing the `Composer` line:

```typescript
import type { LanguageModel } from 'ai';
import type { InlineKeyboardMarkup } from '@grammyjs/types';
import type { ProactiveTriggerType } from '../domain/entities.js';
import type { Repos } from '../repositories/interfaces.js';

export type ComposerChannel = 'llm' | 'template';

export interface ProactivePayload {
  triggerType: ProactiveTriggerType;
  dedupKey: string;
  channel: ComposerChannel;
  data: Record<string, unknown>;
}

export interface ComposerCtx {
  now: Date;
}

/** A composed message: text always; an optional inline keyboard (e.g. due-bill buttons). */
export interface ComposerOutput {
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
}

/**
 * Turns one payload into the user-facing Bahasa Indonesia message. May return a
 * bare string (plain message) or `{ text, replyMarkup? }` when buttons are needed.
 */
export type Composer = (
  payload: ProactivePayload,
  ctx: ComposerCtx,
) => Promise<string | ComposerOutput>;
```

- [ ] **Step 2: Normalize composer output in the dispatcher (`src/proactive/dispatcher.ts`)**

Add the `InlineKeyboardMarkup` import, widen the `send` type in `RunProactivePassOptions`, and extract `text`/`replyMarkup` from the composer result. Replace the `send` line in `RunProactivePassOptions` and the compose/send block in the loop:

```typescript
import type { InlineKeyboardMarkup } from '@grammyjs/types';
// ...existing imports...

export interface RunProactivePassOptions {
  detector: Detector;
  composer: Composer;
  repos: Repos;
  policy: ProactivePolicy;
  now: Date;
  send: (chatId: string, text: string, replyMarkup?: InlineKeyboardMarkup) => Promise<void>;
}
```

Inside `runProactivePass`, replace `const text = await o.composer(payload, { now: o.now });\n await o.send(user.telegramChatId, text);` with:

```typescript
        const out = await o.composer(payload, { now: o.now });
        const { text, replyMarkup } =
          typeof out === 'string' ? { text: out } : out;
        await o.send(user.telegramChatId, text, replyMarkup);
```

(`seedAssistantTurn` already receives `text`; the existing call site passes the local `text` variable, which still exists — leave it.)

- [ ] **Step 3: Widen the `send` lambda (`src/scheduler/cron.ts`)**

Add the import and thread `reply_markup` through. Add to imports:

```typescript
import type { InlineKeyboardMarkup } from '@grammyjs/types';
```

Replace the `send` definition with:

```typescript
  const send = async (
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> => {
    await bot.api.sendMessage(chatId, markdownToTelegramHTML(text), {
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  };
```

- [ ] **Step 4: Update dispatcher tests (`tests/proactive/dispatcher.test.ts`)**

`send` is now always called with 3 args. Update the two arg assertions (replace the existing lines):

```typescript
    expect(send).toHaveBeenCalledWith('c1', 'COMPOSED', undefined);
```

```typescript
    expect(send).toHaveBeenCalledWith('c2', 'OK', undefined);
```

Add a new test inside the `describe('runProactivePass', ...)` block (after the "records [] payload" test) asserting a composer that returns `{ text, replyMarkup }` flows the markup to `send`:

```typescript
  it('forwards a composer replyMarkup to send (button-bearing messages)', async () => {
    const repos = mockRepos();
    const send = vi.fn(async () => undefined);
    const kb = { inline_keyboard: [[{ text: '✅', callback_data: 'rec:x:confirm' }]] };
    const detector = vi.fn(async () => [summaryPayload]);
    const composer = vi.fn(async () => ({ text: 'GLANCE', replyMarkup: kb }));
    await runProactivePass({ detector, composer, repos, policy: POLICY, now: NOW, send });
    expect(send).toHaveBeenCalledWith('c1', 'GLANCE', kb);
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/proactive/dispatcher.test.ts`
Expected: PASS (all dispatcher tests, including the new one).

- [ ] **Step 6: Commit**

```bash
git add src/proactive/types.ts src/proactive/dispatcher.ts src/scheduler/cron.ts tests/proactive/dispatcher.test.ts
git commit -m "refactor(proactive): engine supports optional reply_markup on composed messages"
```

---

## Task 2: `morning_glance` type + multi-bill keyboard builder

**Files:**
- Modify: `src/domain/entities.ts`
- Modify: `src/telegram/formatter.ts`
- Modify: `tests/telegram/formatter.test.ts`

- [ ] **Step 1: Add the trigger type (`src/domain/entities.ts`)**

Add `morning_glance` to the union:

```typescript
export type ProactiveTriggerType =
  | 'scheduled_summary'
  | 'budget_threshold'
  | 'logging_gap'
  | 'anomaly'
  | 'morning_glance';
```

- [ ] **Step 2: Write the failing test for `dueBillsKeyboard` (`tests/telegram/formatter.test.ts`)**

Add to the imports line at the top:

```typescript
import { formatIDR, recurringPrompt, markdownToTelegramHTML, dueBillsKeyboard } from '../../src/telegram/formatter.js';
```

Add a new describe block at the end of the file:

```typescript
describe('dueBillsKeyboard', () => {
  it('returns undefined when there are no due bills', () => {
    expect(dueBillsKeyboard([])).toBeUndefined();
  });

  it('builds one row per bill with rec:<id>:<action> callbacks', () => {
    const kb = dueBillsKeyboard([
      { recurringId: 'r1', name: 'Spotify' },
      { recurringId: 'r2', name: 'Netflix' },
    ])!;
    expect(kb.inline_keyboard).toHaveLength(2);
    const row0 = kb.inline_keyboard[0]!.map((b) => (b as InlineKeyboardButton.CallbackButton).callback_data);
    expect(row0).toEqual(['rec:r1:confirm', 'rec:r1:defer', 'rec:r1:skip']);
    const row1 = kb.inline_keyboard[1]!.map((b) => (b as InlineKeyboardButton.CallbackButton).callback_data);
    expect(row1).toEqual(['rec:r2:confirm', 'rec:r2:defer', 'rec:r2:skip']);
  });

  it('prefixes button labels with the bill name when more than one bill is due', () => {
    const kb = dueBillsKeyboard([
      { recurringId: 'r1', name: 'Spotify' },
      { recurringId: 'r2', name: 'Netflix' },
    ])!;
    expect((kb.inline_keyboard[0]![0] as InlineKeyboardButton.CallbackButton).text).toContain('Spotify');
  });

  it('omits the name prefix when exactly one bill is due (matches recurringPrompt style)', () => {
    const kb = dueBillsKeyboard([{ recurringId: 'r1', name: 'Spotify' }])!;
    expect((kb.inline_keyboard[0]![0] as InlineKeyboardButton.CallbackButton).text).toBe('✅ Catat');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/telegram/formatter.test.ts`
Expected: FAIL (`dueBillsKeyboard` is not exported).

- [ ] **Step 4: Implement `dueBillsKeyboard` (`src/telegram/formatter.ts`)**

Add at the end of the file:

```typescript
/**
 * Build an inline keyboard with one row per due bill (morning glance). Each row
 * is [Catat][Tunda][Lewati] using the SAME rec:<id>:<action> format as
 * recurringPrompt, so callback-query.ts handles taps unchanged. When more than
 * one bill is due, each label is prefixed with the bill name to disambiguate.
 * Returns undefined when there are no due bills (plain-text glance, no keyboard).
 */
export function dueBillsKeyboard(
  bills: { recurringId: string; name: string }[],
): InlineKeyboardMarkup | undefined {
  if (bills.length === 0) return undefined;
  const multi = bills.length > 1;
  const rows = bills.map((b) => {
    const lbl = (t: string) => (multi ? `${b.name} ${t}` : t);
    return [
      { text: lbl('✅ Catat'), callback_data: `rec:${b.recurringId}:confirm` },
      { text: lbl('⏳ Tunda'), callback_data: `rec:${b.recurringId}:defer` },
      { text: lbl('⏭️ Lewati'), callback_data: `rec:${b.recurringId}:skip` },
    ];
  });
  return { inline_keyboard: rows };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/telegram/formatter.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/entities.ts src/telegram/formatter.ts tests/telegram/formatter.test.ts
git commit -m "feat(proactive): morning_glance trigger type + multi-bill due keyboard"
```

---

## Task 3: Morning-glance template fallback

**Files:**
- Modify: `src/proactive/composers/template.ts`
- Modify: `tests/proactive/composers/template.test.ts`

- [ ] **Step 1: Write the failing test (`tests/proactive/composers/template.test.ts`)**

Add at the end of the file (the existing file tests the other templates via `templateCompose`):

```typescript
describe('morningGlanceTemplate', () => {
  const payload = (data: unknown) =>
    ({ triggerType: 'morning_glance', dedupKey: 'morning-glance:2026-06-22', channel: 'llm', data }) as ProactivePayload;

  it('renders balances, upcoming bills, due-today bills, and yesterday activity', () => {
    const out = templateCompose(payload({
      balances: [{ name: 'BCA', type: 'bank', balance: 5_200_000 }],
      upcoming: [{ name: 'Spotify', amount: 59_900, account: 'BCA CC', dueDate: '2026-06-25' }],
      yesterday: { count: 2, totalSpend: 85_000 },
      todayDueBills: [{ name: 'Netflix', amount: 75_000, account: 'BCA CC' }],
    }));
    expect(out).toContain('BCA');
    expect(out).toContain('5.200.000');
    expect(out).toContain('Spotify');
    expect(out).toContain('Netflix');
    expect(out).toContain('75.000');
    expect(out).toContain('2 catatan');
  });

  it('notes the logging gap when yesterday had no expenses', () => {
    const out = templateCompose(payload({
      balances: [{ name: 'Cash', type: 'cash', balance: 300_000 }],
      upcoming: [], yesterday: null, todayDueBills: [],
    }));
    expect(out).toContain('belum ada catatan');
  });
});
```

Ensure `ProactivePayload` is imported at the top of the test file (add to the existing import from `../../../src/proactive/types.js` if not present).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: FAIL (falls through to default `(tidak ada pesan)`).

- [ ] **Step 3: Implement the template (`src/proactive/composers/template.ts`)**

Add the data interface and template function before `templateCompose`, and a new case in the switch:

```typescript
interface MorningGlanceBalance { name: string; type: string; balance: number }
interface MorningGlanceUpcoming { name: string; amount: number; account: string; dueDate: string }
interface MorningGlanceDue { name: string; amount: number; account: string }
interface MorningGlanceData {
  balances: MorningGlanceBalance[];
  upcoming: MorningGlanceUpcoming[];
  yesterday: { count: number; totalSpend: number } | null;
  todayDueBills: MorningGlanceDue[];
}

/** Deterministic LLM-fallback for the morning glance. */
export function morningGlanceTemplate(payload: ProactivePayload): string {
  const d = payload.data as unknown as MorningGlanceData;
  const lines: string[] = ['🌅 Pagi!'];
  if (d.balances.length > 0) {
    lines.push('Saldo: ' + d.balances.map((b) => `${b.name} ${idr(b.balance)}`).join(' · '));
  }
  if (d.upcoming.length > 0) {
    lines.push('Tagihan minggu ini:');
    for (const u of d.upcoming) lines.push(`• ${u.name} — ${idr(u.amount)} via ${u.account} (${u.dueDate})`);
  }
  if (d.todayDueBills.length > 0) {
    lines.push('Jatuh tempo hari ini:');
    for (const b of d.todayDueBills) lines.push(`• ${b.name} — ${idr(b.amount)} via ${b.account}`);
  }
  lines.push(
    d.yesterday
      ? `Kemarin: ${d.yesterday.count} catatan, total ${idr(d.yesterday.totalSpend)}.`
      : 'Kemarin belum ada catatan — ada yang mau diinput?',
  );
  return lines.join('\n');
}
```

In `templateCompose`, add the case (before `default`):

```typescript
    case 'morning_glance':
      return morningGlanceTemplate(payload);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/proactive/composers/template.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proactive/composers/template.ts tests/proactive/composers/template.test.ts
git commit -m "feat(proactive): morning glance template fallback"
```

---

## Task 4: Morning-glance system prompt + detector + composer

**Files:**
- Create: `src/proactive/triggers/morning-glance.ts`
- Create: `src/proactive/composers/morning-glance.ts`
- Modify: `src/proactive/prompt.ts`
- Create: `tests/proactive/triggers/morning-glance.test.ts`
- Create: `tests/proactive/composers/morning-glance.test.ts`

- [ ] **Step 1: Add the morning-glance system prompt (`src/proactive/prompt.ts`)**

Append after `PROACTIVE_SYSTEM_PROMPT`:

```typescript
/** System prompt for the morning glance (forward-looking AM message). */
export const MORNING_GLANCE_SYSTEM_PROMPT = `Kamu menulis PESAN PAGI MoneyBot (morning glance) — sapaan pagi ringkas dan ramah berisi posisi keuangan dan tagihan yang akan datang. Tulis selalu dalam Bahasa Indonesia yang natural, hangat, dan ringkas (maks 5 baris).

ATURAN:
1. Tulis HANYA pesan final, tanpa prefiks, tanpa menjelaskan bahwa kamu AI.
2. Format nominal pakai locale IDR: titik sebagai pemisah ribuan, tanpa simbol. JANGAN tulis "Rp" atau "IDR".
3. Mulai dengan sapaan pagi singkat, lalu sebutkan saldo akun ringkas (nama akun + nominal).
4. Sebutkan tagihan jatuh tempo minggu ini kalau ada; kalau tidak ada, bilang singkat "tagihan minggu ini aman".
5. Sebutkan aktivitas kemarin (jumlah catatan + total) atau, kalau kosong, satu kalimat ringan.
6. Jangan mengarang angka — pakai HANYA data yang diberikan. Lewati bagian yang datanya kosong.
7. Kalau ada tagihan jatuh tempo HARI INI, akhiri dengan satu kalimat yang mengarahkan ke tombol di bawah (mis. "Tagihan hari ini tinggal dipencet di bawah ya 👇"). Tombolnya sudah otomatis — jangan minta user mengetik.
8. Boleh pakai **tebal** untuk satu atau dua angka penting.`;
```

- [ ] **Step 2: Write the failing detector test (`tests/proactive/triggers/morning-glance.test.ts`)**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { detectMorningGlance } from '../../../src/proactive/triggers/morning-glance.js';
import type { Repos } from '../../../src/repositories/interfaces.js';
import type { Account, RecurringPayment, Transaction } from '../../../src/domain/entities.js';

// 2026-06-22T14:00:00Z == 21:00 WIB → WIB today = 2026-06-22.
const NOW = new Date('2026-06-22T14:00:00Z');

function mkAccount(over: Partial<Account>): Account {
  return { accountId: 'a', userId: 'u', name: '', type: 'bank', balance: 0, isActive: true, createdAt: '', updatedAt: '', ...over };
}
function mkRecurring(over: Partial<RecurringPayment>): RecurringPayment {
  return { recurringId: 'r', userId: 'u', name: '', amount: 0, accountId: 'a', categoryId: 'c', dayOfMonth: 1, isActive: true, nextFireAt: '2026-06-22', createdAt: '', updatedAt: '', ...over };
}
function mkTxn(over: Partial<Transaction>): Transaction {
  return { transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '', accountId: 'a', date: '2026-06-21', isRecurringInstance: false, createdAt: '', updatedAt: '', ...over };
}

function mockRepos(opts: { accounts?: Account[]; recurrings?: RecurringPayment[]; yesterday?: Transaction[] } = {}): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: { findAllByUserId: vi.fn(async () => opts.accounts ?? []), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateBalance: vi.fn(), update: vi.fn() } as never,
    transactions: {
      create: vi.fn(), createTransfer: vi.fn(),
      findByDateRange: vi.fn(async () => opts.yesterday ?? []),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(async () => opts.recurrings ?? []), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

describe('detectMorningGlance', () => {
  it('returns [] when the user has no active accounts (nothing to glance at)', async () => {
    const repos = mockRepos({ accounts: [] });
    expect(await detectMorningGlance({ userId: 'u', repos, now: NOW })).toEqual([]);
  });

  it('partitions recurrings into todayDueBills vs upcoming, excluding today from upcoming', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca', name: 'BCA' })],
      recurrings: [
        mkRecurring({ recurringId: 'r1', name: 'Spotify', amount: 59_900, accountId: 'bca', nextFireAt: '2026-06-22' }), // today
        mkRecurring({ recurringId: 'r2', name: 'Netflix', amount: 75_000, accountId: 'bca', nextFireAt: '2026-06-25' }), // upcoming
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    expect(out).toHaveLength(1);
    const data = out[0]!.data as { todayDueBills: { recurringId: string }[]; upcoming: { name: string }[] };
    expect(data.todayDueBills.map((b) => b.recurringId)).toEqual(['r1']);
    expect(data.upcoming.map((b) => b.name)).toEqual(['Netflix']);
  });

  it('excludes a bill already processed this month (lastFiredAt this month) from todayDueBills', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca', name: 'BCA' })],
      recurrings: [
        mkRecurring({ recurringId: 'r1', name: 'Spotify', nextFireAt: '2026-06-22', lastFiredAt: '2026-06-22' }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { todayDueBills: unknown[] };
    expect(data.todayDueBills).toEqual([]);
  });

  it('keeps a bill fired in a previous month eligible again', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca', name: 'BCA' })],
      recurrings: [
        mkRecurring({ recurringId: 'r1', name: 'Spotify', nextFireAt: '2026-06-22', lastFiredAt: '2026-05-22' }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { todayDueBills: { recurringId: string }[] };
    expect(data.todayDueBills.map((b) => b.recurringId)).toEqual(['r1']);
  });

  it('builds dedup key from the WIB date and selects the llm channel', async () => {
    const repos = mockRepos({ accounts: [mkAccount({ accountId: 'bca' })] });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    expect(out[0]!.dedupKey).toBe('morning-glance:2026-06-22');
    expect(out[0]!.channel).toBe('llm');
    expect(out[0]!.triggerType).toBe('morning_glance');
  });

  it('sums only expenses for yesterday and nulls when none', async () => {
    const repos = mockRepos({
      accounts: [mkAccount({ accountId: 'bca' })],
      yesterday: [
        mkTxn({ type: 'expense', amount: 30_000 }),
        mkTxn({ type: 'transfer', amount: 500_000 }),
        mkTxn({ type: 'expense', amount: 20_000 }),
      ],
    });
    const out = await detectMorningGlance({ userId: 'u', repos, now: NOW });
    const data = out[0]!.data as { yesterday: { count: number; totalSpend: number } | null };
    expect(data.yesterday).toEqual({ count: 2, totalSpend: 50_000 });

    const reposEmpty = mockRepos({ accounts: [mkAccount({ accountId: 'bca' })], yesterday: [] });
    const empty = await detectMorningGlance({ userId: 'u', repos: reposEmpty, now: NOW });
    expect((empty[0]!.data as { yesterday: unknown }).yesterday).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/proactive/triggers/morning-glance.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the detector (`src/proactive/triggers/morning-glance.ts`)**

```typescript
import { todayWIB, addDays, wibYear, wibMonth } from '../../domain/time.js';
import type { Detector, ProactivePayload } from '../types.js';

interface DueBill { recurringId: string; name: string; amount: number; account: string }
interface Upcoming { name: string; amount: number; account: string; dueDate: string }

/**
 * Morning glance detector (design §5). Always returns one payload per user with
 * an active account — the day's forward-looking "she's watching" touch. Gathers:
 * active-account balances, recurring bills due tomorrow..+7d (upcoming, text),
 * recurring bills due today & not yet processed this month (todayDueBills → get
 * inline buttons in the composer), and yesterday's expense activity.
 */
export const detectMorningGlance: Detector = async ({ userId, repos, now }) => {
  const today = todayWIB(now);
  const tomorrow = addDays(today, 1);
  const plus7 = addDays(today, 7);
  const year = wibYear(now);
  const month = wibMonth(now);
  const monthTag = `${year}-${String(month).padStart(2, '0')}`;

  const accounts = (await repos.accounts.findAllByUserId(userId)).filter((a) => a.isActive);
  if (accounts.length === 0) return []; // onboarding incomplete — nothing to glance at

  const balances = accounts.map((a) => ({ name: a.name, type: a.type, balance: a.balance }));

  // Resolve recurring bill account names (cache; active accounts are pre-seeded).
  const accName = new Map<string, string>(accounts.map((a) => [a.accountId, a.name]));
  const nameOf = async (accountId: string): Promise<string> => {
    const cached = accName.get(accountId);
    if (cached) return cached;
    const a = await repos.accounts.findById(userId, accountId);
    const n = a?.name ?? accountId;
    accName.set(accountId, n);
    return n;
  };

  const todayDueBills: DueBill[] = [];
  const upcoming: Upcoming[] = [];
  for (const r of await repos.recurrings.findAllByUserId(userId)) {
    if (!r.isActive) continue;
    const firedThisMonth = !!r.lastFiredAt && r.lastFiredAt.startsWith(monthTag);
    if (r.nextFireAt === today && !firedThisMonth) {
      todayDueBills.push({ recurringId: r.recurringId, name: r.name, amount: r.amount, account: await nameOf(r.accountId) });
    } else if (r.nextFireAt >= tomorrow && r.nextFireAt <= plus7) {
      upcoming.push({ name: r.name, amount: r.amount, account: await nameOf(r.accountId), dueDate: r.nextFireAt });
    }
  }
  upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const yesterdayRows = await repos.transactions.findByDateRange(userId, addDays(today, -1), addDays(today, -1));
  const yExp = yesterdayRows.filter((t) => t.type === 'expense');
  const yesterday = yExp.length > 0
    ? { count: yExp.length, totalSpend: yExp.reduce((s, t) => s + t.amount, 0) }
    : null;

  const payload: ProactivePayload = {
    triggerType: 'morning_glance',
    dedupKey: `morning-glance:${today}`,
    channel: 'llm',
    data: { balances, upcoming, yesterday, todayDueBills },
  };
  return [payload];
};
```

- [ ] **Step 5: Run detector test to verify it passes**

Run: `npx vitest run tests/proactive/triggers/morning-glance.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing composer test (`tests/proactive/composers/morning-glance.test.ts`)**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateText = vi.fn();
vi.mock('ai', () => ({ generateText: (...args: unknown[]) => generateText(...args) }));

import { createMorningGlanceComposer } from '../../../src/proactive/composers/morning-glance.js';
import type { ProactivePayload } from '../../../src/proactive/types.js';

const model = {} as never;
const payload = (todayDueBills: { recurringId: string; name: string }[]): ProactivePayload => ({
  triggerType: 'morning_glance',
  dedupKey: 'morning-glance:2026-06-22',
  channel: 'llm',
  data: { balances: [], upcoming: [], yesterday: null, todayDueBills },
});

describe('createMorningGlanceComposer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns LLM text plus a keyboard built from todayDueBills', async () => {
    generateText.mockResolvedValue({ text: 'Pagi!' });
    const compose = createMorningGlanceComposer(model);
    const out = await compose(payload([{ recurringId: 'r1', name: 'Spotify' }]), { now: new Date('2026-06-22T14:00:00Z') });
    expect(typeof out).toBe('object');
    const o = out as { text: string; replyMarkup?: { inline_keyboard: unknown[][] } };
    expect(o.text).toBe('Pagi!');
    expect(o.replyMarkup?.inline_keyboard).toHaveLength(1);
  });

  it('omits replyMarkup when there are no due bills', async () => {
    generateText.mockResolvedValue({ text: 'Pagi tenang!' });
    const compose = createMorningGlanceComposer(model);
    const out = await compose(payload([]), { now: new Date('2026-06-22T14:00:00Z') });
    expect((out as { replyMarkup?: unknown }).replyMarkup).toBeUndefined();
  });

  it('falls back to the template when generateText throws', async () => {
    generateText.mockRejectedValue(new Error('model down'));
    const compose = createMorningGlanceComposer(model);
    const out = await compose(payload([]), { now: new Date('2026-06-22T14:00:00Z') });
    expect((out as { text: string }).text).toContain('Pagi');
  });
});
```

- [ ] **Step 7: Run composer test to verify it fails**

Run: `npx vitest run tests/proactive/composers/morning-glance.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 8: Implement the composer (`src/proactive/composers/morning-glance.ts`)**

```typescript
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { MORNING_GLANCE_SYSTEM_PROMPT } from '../prompt.js';
import { dueBillsKeyboard } from '../../telegram/formatter.js';
import { morningGlanceTemplate } from './template.js';
import { logEvent } from '../../utils/logger.js';
import type { Composer, ComposerOutput } from '../types.js';

/** Compose the morning glance: LLM text + a programmatic due-bills keyboard. */
export function createMorningGlanceComposer(model: LanguageModel): Composer {
  return async (payload) => {
    const bills = (payload.data as { todayDueBills?: { recurringId: string; name: string }[] }).todayDueBills ?? [];
    const replyMarkup = dueBillsKeyboard(bills);

    let text: string;
    try {
      const { text: out } = await generateText({
        model,
        system: MORNING_GLANCE_SYSTEM_PROMPT,
        prompt: `Tulis pesan pagi (morning glance) untuk data berikut:\n\n${JSON.stringify(payload.data, null, 2)}`,
      });
      text = out;
    } catch (err) {
      logEvent('warn', 'morning glance llm failed; falling back to template', { error: (err as Error).message });
      text = morningGlanceTemplate(payload);
    }

    const result: ComposerOutput = { text };
    if (replyMarkup) result.replyMarkup = replyMarkup;
    return result;
  };
}
```

- [ ] **Step 9: Run composer test to verify it passes**

Run: `npx vitest run tests/proactive/composers/morning-glance.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/proactive/prompt.ts src/proactive/triggers/morning-glance.ts src/proactive/composers/morning-glance.ts tests/proactive/triggers/morning-glance.test.ts tests/proactive/composers/morning-glance.test.ts
git commit -m "feat(proactive): morning glance detector + LLM composer with due-bill keyboard"
```

---

## Task 5: Wire the morning-glance cron + retire recurring-fire

**Files:**
- Modify: `src/config/index.ts`
- Modify: `src/scheduler/cron.ts`
- Modify: `.env.example`
- Delete: `src/scheduler/recurring-fire.ts`
- Delete: `tests/scheduler/recurring-fire.test.ts`

- [ ] **Step 1: Update config (`src/config/index.ts`)**

Remove the `CRON_SCHEDULE` line and add the two new keys. Replace the `CRON_SCHEDULE` line:

```typescript
  PROACTIVE_MORNING_GLANCE_CRON: z.string().default('0 8 * * *'),
  PROACTIVE_INSIGHT_ENABLED: z.string().default('true').transform((v) => v === 'true'),
```

- [ ] **Step 2: Rewire crons (`src/scheduler/cron.ts`)**

Imports: **delete** the line `import { fireRecurringPayments } from './recurring-fire.js';`. **Add** these two imports alongside the existing proactive imports (the other imports — `runProactivePass`, `createComposer`, `detectScheduledSummary`, the three detector factories, `sweepDeferredPayments`, etc. — already exist; do not duplicate them):

```typescript
import { detectMorningGlance } from '../proactive/triggers/morning-glance.js';
import { createMorningGlanceComposer } from '../proactive/composers/morning-glance.js';
```

Replace the daily 08:00 recurring-fire cron block (the `cron.schedule(config.CRON_SCHEDULE, ...)` block) with the merged morning-glance cron:

```typescript
  // Daily ~08:00 WIB — merged morning glance (balances + week's bills + yesterday)
  // and today's due-bill confirm buttons in one engine-routed message. Replaces
  // the old standalone recurring-fire ping (design §5.4).
  cron.schedule(config.PROACTIVE_MORNING_GLANCE_CRON, () => {
    runProactivePass({
      detector: detectMorningGlance,
      composer: createMorningGlanceComposer(model),
      repos, policy, now: new Date(), send,
    }).catch((err) => logEvent('error', 'morning glance error', { error: (err as Error).message }));
  }, { timezone: 'Asia/Jakarta' });
```

Update the `logEvent('info', 'cron jobs registered', { schedules: [...] })` array to drop `config.CRON_SCHEDULE` and add `config.PROACTIVE_MORNING_GLANCE_CRON`:

```typescript
    schedules: ['*/5 * * * *', config.PROACTIVE_MORNING_GLANCE_CRON, config.PROACTIVE_SUMMARY_CRON, config.PROACTIVE_SWEEP_CRON, config.PROACTIVE_ANOMALY_CRON],
```

- [ ] **Step 3: Update `.env.example`**

Replace the line `CRON_SCHEDULE=0 8 * * *` with:

```
# Proactive outreach (slice "watching me" — merged morning glance at ~08:00 WIB)
PROACTIVE_MORNING_GLANCE_CRON=0 8 * * *
PROACTIVE_INSIGHT_ENABLED=true
```

- [ ] **Step 4: Delete the retired recurring-fire files**

```bash
git rm src/scheduler/recurring-fire.ts tests/scheduler/recurring-fire.test.ts
```

- [ ] **Step 5: Verify no dangling references**

Run: `git grep -n "fireRecurringPayments\|CRON_SCHEDULE" -- src tests`
Expected: no output (all references removed from `src` and `tests`). (Historical references under `docs/` are fine.)

- [ ] **Step 6: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 7: Run scheduler + proactive tests**

Run: `npx vitest run tests/scheduler tests/proactive`
Expected: PASS (defer-sweep still green; recurring-fire tests removed; morning-glance + dispatcher green).

- [ ] **Step 8: Commit**

```bash
git add src/config/index.ts src/scheduler/cron.ts .env.example
git commit -m "feat(proactive): merge morning glance with recurring cron; retire fireRecurringPayments"
```

---

## Task 6: Inline insight — type + helper + write-tool wiring

**Files:**
- Modify: `src/domain/entities.ts`
- Modify: `src/agent/tools.ts`
- Modify: `tests/agent/tools.test.ts`
- Create: `tests/agent/tools-insight-disabled.test.ts`

- [ ] **Step 1: Add `InsightContext` and extend `TransactionResult` (`src/domain/entities.ts`)**

Add the interface near `WriteResult`, and add `insightContext?` to the `TransactionResult` data:

```typescript
/**
 * Post-write context snapshot returned on the `ok` variant of write tools so the
 * reactive agent can append a one-line observational insight (design §6). Absent
 * when PROACTIVE_INSIGHT_ENABLED=false or not applicable (e.g. transfer).
 */
export interface InsightContext {
  balanceAfter: number;
  todayCountInCategory: number;
  todaySpendInCategory: number;
  weekSpendInCategory: number;
  budgetSpentPct?: number;
  budgetRemaining?: number;
}

export type TransactionResult = WriteResult<{
  transaction: Transaction;
  budget?: { spent: number; limit: number; exceeded: boolean };
  insightContext?: InsightContext;
}>;
```

- [ ] **Step 2: Add the failing test for `insightContext` on `create_expense` (`tests/agent/tools.test.ts`)**

Near the top, ensure these are imported (add `todayWIB` if not already, and reference the existing `buildTools`/`mockRepos` helpers used in that file). Append a describe block (adapt the mock factory already used in the file — it must stub `transactions.findByDateRange` and `accounts.findById`):

```typescript
describe('insightContext (PROACTIVE_INSIGHT_ENABLED default true)', () => {
  it('create_expense ok result carries balanceAfter + today/week category context', async () => {
    // Use the file's existing mockRepos/buildTools helpers; ensure:
    //  - accounts.findById returns { accountId, name, balance: 80_000 } (balanceAfter)
    //  - transactions.findByDateRange returns one same-category expense dated today
    const tools = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await (tools.create_expense!.execute as (a: unknown) => unknown)({
      description: 'kopi', amount: 25_000, accountId: 'a1', categoryId: 'food.coffee',
    });
    const ok = res as { status: string; data: { insightContext?: InsightContext } };
    expect(ok.status).toBe('ok');
    expect(ok.data.insightContext).toBeDefined();
    expect(ok.data.insightContext!.balanceAfter).toBe(80_000);
    expect(ok.data.insightContext!.todayCountInCategory).toBeGreaterThanOrEqual(1);
  });
});
```

> The executor should align this test with the existing `mockRepos` shape in `tests/agent/tools.test.ts` (which already mocks the repos methods `createExpenseCore` needs). The assertion target is that `insightContext` is present and populated.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: FAIL (`insightContext` undefined).

- [ ] **Step 4: Implement `computeInsightContext` and wire it in (`src/agent/tools.ts`)**

Add imports (extend the existing `domain/time` import; add the `config` import and the `InsightContext` type):

```typescript
import { todayWIB, wibMonth, wibYear, nextFireDate, wibISOWeekMonday } from '../domain/time.js';
import { config } from '../config/index.js';
import type { AccountResult, TransactionResult, Transaction, User, InsightContext } from '../domain/entities.js';
```

Add the helper above `buildTools` (it reads NO config — pure, for testability):

```typescript
/**
 * Snapshot the user's situation right after a write so the reactive agent can
 * append a one-line insight (design §6). today/week context only applies when a
 * categoryId is present (expense/income); transfer omits it.
 */
export async function computeInsightContext(args: {
  userId: string;
  repos: Repos;
  accountId: string;
  categoryId?: string;
  now: Date;
  budget?: { spent: number; limit: number; exceeded: boolean };
}): Promise<InsightContext> {
  const today = todayWIB(args.now);
  const acc = await args.repos.accounts.findById(args.userId, args.accountId);
  const balanceAfter = acc?.balance ?? 0;

  let todayCount = 0;
  let todaySpend = 0;
  let weekSpend = 0;
  if (args.categoryId) {
    const weekStart = wibISOWeekMonday(args.now);
    const rows = await args.repos.transactions.findByDateRange(args.userId, weekStart, today);
    const same = rows.filter((t) => t.type === 'expense' && t.categoryId === args.categoryId);
    weekSpend = same.reduce((s, t) => s + t.amount, 0);
    const todays = same.filter((t) => t.date === today);
    todayCount = todays.length;
    todaySpend = todays.reduce((s, t) => s + t.amount, 0);
  }

  const ctx: InsightContext = {
    balanceAfter,
    todayCountInCategory: todayCount,
    todaySpendInCategory: todaySpend,
    weekSpendInCategory: weekSpend,
  };
  if (args.budget && args.budget.limit > 0) {
    ctx.budgetSpentPct = args.budget.spent / args.budget.limit;
    ctx.budgetRemaining = args.budget.limit - args.budget.spent;
  }
  return ctx;
}
```

Wire it into `createExpenseCore` — after the `budget` block, before `return { status: 'ok', data: { transaction, budget } };`:

```typescript
    let insightContext: InsightContext | undefined;
    if (config.PROACTIVE_INSIGHT_ENABLED) {
      insightContext = await computeInsightContext({
        userId: params.userId, repos: params.repos, accountId: params.accountId,
        categoryId: params.categoryId, now: new Date(), budget,
      });
    }

    return { status: 'ok', data: { transaction, budget, insightContext } };
```

Wire it into `create_income` — replace `const res: TransactionResult = { status: 'ok', data: { transaction } };` with:

```typescript
        let insightContext: InsightContext | undefined;
        if (config.PROACTIVE_INSIGHT_ENABLED) {
          insightContext = await computeInsightContext({
            userId, repos, accountId: account.accountId, categoryId, now: new Date(),
          });
        }
        const res: TransactionResult = { status: 'ok', data: { transaction, insightContext } };
```

Wire it into `create_transfer` — replace `const res: TransactionResult = { status: 'ok', data: { transaction } };` with:

```typescript
        let insightContext: InsightContext | undefined;
        if (config.PROACTIVE_INSIGHT_ENABLED) {
          insightContext = await computeInsightContext({
            userId, repos, accountId: fromAccount.accountId, now: new Date(),
          });
        }
        const res: TransactionResult = { status: 'ok', data: { transaction, insightContext } };
```

Wire it into `update_transaction` — after `const updated = await repos.transactions.update(...)` and before `const res`:

```typescript
        const newCategoryId = a.categoryId ?? existing.categoryId;
        let insightContext: InsightContext | undefined;
        if (config.PROACTIVE_INSIGHT_ENABLED) {
          insightContext = await computeInsightContext({
            userId, repos, accountId: newAccountId, categoryId: newCategoryId, now: new Date(),
          });
        }
        const res: TransactionResult = { status: 'ok', data: { transaction: updated, insightContext } };
```

(Replace the existing `const res: TransactionResult = { status: 'ok', data: { transaction: updated } };` line.)

- [ ] **Step 5: Run tools test to verify it passes**

Run: `npx vitest run tests/agent/tools.test.ts`
Expected: PASS. (If existing `create_income`/`create_transfer`/`update_transaction` tests now require `accounts.findById` / `transactions.findByDateRange` mocks, add `findById: vi.fn(async () => ({ balance: 0 }))` and `findByDateRange: vi.fn(async () => [])` to that file's `mockRepos` — they already exist for the transactions repo mock in most setups; add if missing.)

- [ ] **Step 6: Write the disabled-flag test (`tests/agent/tools-insight-disabled.test.ts`)**

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/index.js', () => ({
  config: { PROACTIVE_INSIGHT_ENABLED: false },
}));

// buildTools imports config transitively; the mock above supplies the flag.
import { buildTools } from '../../src/agent/tools.js';
import type { Repos } from '../../src/repositories/interfaces.js';

function mockRepos(): Repos {
  return {
    users: { findByTelegramChatId: vi.fn(), findById: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() } as never,
    accounts: {
      findAllByUserId: vi.fn(async () => []),
      findById: vi.fn(async () => ({ accountId: 'a1', name: 'BCA', balance: 0 })),
      findByName: vi.fn(async () => ({ accountId: 'a1', name: 'BCA', balance: 0 })) as never,
      create: vi.fn(), updateBalance: vi.fn(async () => undefined), update: vi.fn(),
    } as never,
    transactions: {
      create: vi.fn(async (i: { userId: string }) => ({ transactionId: 't1', userId: i.userId, type: 'expense', amount: 0, description: '', accountId: 'a1', date: '2026-06-22', isRecurringInstance: false, createdAt: '', updatedAt: '' })),
      createTransfer: vi.fn(), findByDateRange: vi.fn(async () => []),
      findByAccountAndDateRange: vi.fn(), findLatestByUserId: vi.fn(), findById: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
    } as never,
    sessions: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
    budgets: { findByUserAndMonth: vi.fn(async () => []), findByName: vi.fn(), create: vi.fn(), incrementSpent: vi.fn(), update: vi.fn() } as never,
    recurrings: { findAllByUserId: vi.fn(), findByDayOfMonth: vi.fn(), findDueToday: vi.fn(), findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as never,
    preferences: { findAllByUserId: vi.fn(), upsert: vi.fn(), delete: vi.fn() } as never,
    outreach: { record: vi.fn(), existsKey: vi.fn(), countSince: vi.fn() } as never,
    proactiveSettings: { get: vi.fn(), setMuted: vi.fn() } as never,
  };
}

describe('insightContext disabled (PROACTIVE_INSIGHT_ENABLED=false)', () => {
  it('omits insightContext and does not query category history', async () => {
    const repos = mockRepos();
    const tools = buildTools({ userId: 'u', repos, hasAccount: true });
    const res = await (tools.create_expense!.execute as (a: unknown) => unknown)({
      description: 'kopi', amount: 25_000, accountId: 'a1', categoryId: 'food.coffee',
    });
    expect((res as { data: { insightContext?: unknown } }).data.insightContext).toBeUndefined();
    expect(repos.transactions.findByDateRange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run disabled-flag test to verify it passes**

Run: `npx vitest run tests/agent/tools-insight-disabled.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain/entities.ts src/agent/tools.ts tests/agent/tools.test.ts tests/agent/tools-insight-disabled.test.ts
git commit -m "feat(agent): enrich write-tool results with insightContext snapshot"
```

---

## Task 7: Generalize system-prompt rule 4

**Files:**
- Modify: `src/agent/system-prompt.ts`
- Modify: `tests/agent/system-prompt.test.ts`

- [ ] **Step 1: Write the failing test (`tests/agent/system-prompt.test.ts`)**

Add a new describe block:

```typescript
describe('buildSystemPrompt — post-write insight (rule 4)', () => {
  const prompt = buildSystemPrompt('2026-06-22');

  it('mentions insightContext and the optional one-line insight palette', () => {
    expect(prompt).toContain('insightContext');
    expect(prompt).toMatch(/INSIGHT PASCA-TULIS/);
  });

  it('keeps budget-status mandatory when a transaction is budgeted', () => {
    expect(prompt).toMatch(/budget/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/system-prompt.test.ts`
Expected: FAIL (no `insightContext` in prompt).

- [ ] **Step 3: Generalize rule 4 (`src/agent/system-prompt.ts`)**

Replace the existing rule 4 line (`4. Kalau sebuah budget sudah terlampaui setelah mencatat pengeluaran, tampilkan peringatan di respons yang sama.`) with:

```text
4. INSIGHT PASCA-TULIS: Setelah create_expense/create_income/create_transfer/update_transaction berhasil, hasil tool membawa `insightContext` (saldo akun setelah tulis; untuk pengeluaran juga frekuensi & nominal kategori hari ini / minggu ini, serta status budget). WAJIB: kalau transaksi punya budget, sebut status budget di kalimat penutup (lihat aturan 12). OPSIONAL (maks 1 kalimat tambahan, hanya kalau menonjol): nominal jauh di atas kebiasaan kategori, streak/frekuensi hari ini (mis. "kopi ke-3 hari ini"), saldo yang menipis / limit hampir penuh, atau reaksi pemasukan. Kalau tidak ada yang menonjol atau `insightContext` tidak ada, jangan tambahkan apa-apa. Tetap ringkas.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/system-prompt.test.ts`
Expected: PASS (all assertions, including the existing rule-12/account-block tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/system-prompt.ts tests/agent/system-prompt.test.ts
git commit -m "feat(agent): generalize rule 4 into a post-write insight palette"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: all green. (Per project memory: the 4 `reconcile` timeouts are pre-existing Neon latency, not a regression — if only those are slow/flaky, re-run with a higher timeout or `npx vitest run --testTimeout 30000`.)

- [ ] **Step 4: Sanity-grep for leftover references**

Run: `git grep -n "fireRecurringPayments\|CRON_SCHEDULE" -- src tests`
Expected: no output.

- [ ] **Step 5: Final commit (if any verification fixups)**

Only if Steps 1–4 required edits. Otherwise this step is a no-op.

```bash
git add -A
git commit -m "chore: verification fixups for proactive-triggers slice 1"
```

---

## Notes for the executor

- **Layering:** `pg`/`@neondatabase/serverless` imports stay inside `src/adapters/neon/` only. This slice adds no DB-driver imports. `@grammyjs/types` (`InlineKeyboardMarkup`) is already imported in `src/telegram/formatter.ts`; extending it to `src/proactive/types.ts` is consistent with the existing proactive→Telegram boundary.
- **Staleness invariant preserved:** `insightContext.balanceAfter` is computed live via `accounts.findById` at write time — never read from the prepopulated `AKUN USER` block.
- **Callback handler unchanged:** morning-glance buttons emit `rec:<id>:confirm|defer|skip`, exactly matching `recurringPrompt`. No edits to `callback-query.ts` or `defer-sweep.ts`.
- **Per-CLAUDE.md verification:** always run `npx tsc --noEmit` alongside `npx vitest run` — vitest strips types and can pass while tsc fails.
