# Standardized Transaction Confirmation Format

- **Date:** 2026-06-22
- **Status:** Approved
- **Supersedes / refines:** system-prompt rule 3 (vague "ringkasan konfirmasi yang rapi")

## Problem

After a successful transaction write, the agent's confirmation is unstructured — rule 3 only
says "jawab dengan ringkasan konfirmasi yang rapi", so the output shape varies randomly between
turns. We want a consistent, scannable block for every transaction write, while **keeping** the
natural short follow-up sentence the user already likes (budget status line, exceeded warning,
"beri tahu saya", etc.).

## Decision: prompt-only standardization (Approach A)

Add a precise block template + worked example to the system prompt; hardcode the icon mappings in
the prompt text; expose category icons in the rendered taxonomy. **No tool-result or agent-loop
changes** — all data (id, amount, date, account, category) is already in the model's context from
the write tool's result plus the prior `get_accounts` call.

Rejected alternatives:

- **B — tool returns a code-built `confirmationBlock`, LLM emits it verbatim + writes its own tail.**
  Only half-determinant (the tail is still LLM-generated), adds a tool-result shape change + tests,
  and works against the minimal-infra lean. Kept as the upgrade path if drift is observed.
- **C — orchestrator post-processor appends a code-formatted block.** Most invasive; changes the
  agent loop and risks the block landing disjoint from the LLM's tail sentence.

## Format templates

### Expense / income

```
✅ <transactionId — first 8 chars, e.g. 550e8400>
📋 <description>
📅 <DD Mon YYYY>
<amountIcon> <amount — IDR locale, no symbol>
<accountIcon> <accountName>
<categoryIcon> <categoryName> (<categoryId>)

<short follow-up sentence — or budget status / exceeded warning when a budget is attached>
```

Worked example (expense):

```
✅ 550e8400
📋 Top up flazz
📅 22 Jun 2026
💸 100.000
🏦 BCA
💳 Flazz (transport.flazz)

Transaksi berhasil dicatat. Jika ada yang ingin diubah atau ditambahkan, beri tahu saya!
```

### Transfer

No category line (transfers have none); the account line shows source → destination with each
account's own icon.

```
✅ <transactionId — first 8 chars, e.g. 550e8400>
📋 <description>
📅 <DD Mon YYYY>
🔁 <amount — IDR locale, no symbol>
<fromIcon> <fromName> → <toIcon> <toName>

<short follow-up sentence>
```

## Icon mappings (hardcoded in the prompt)

| Slot | Rule |
|---|---|
| Account line | by account `type`: `cash 💵`, `bank 🏦`, `card 💳` |
| Amount line | by transaction type: `expense 💸`, `income 💰`, `transfer 🔁` |
| Description line | fixed `📋` |
| Category line | the category's own `icon` from the taxonomy |
| transactionId | **first 8 chars** of the UUID (e.g. `550e8400`) — truncate only, never hash |

## Existing rules leveraged (unchanged)

- Rule 9 (IDR locale, no "Rp"/"IDR") → amount line.
- Rule 10 (DD Mon YYYY) → date line.
- Rule 4 (budget warning in the same response) → tail line when a budget is exceeded.
- Rule 5 (category visible so the user can correct it) → category line.

## Scope

**Gets the standardized block:** `create_expense`, `create_income`, `create_transfer`,
`update_transaction`.

**No block** (rule 3 "neat summary" still applies, but free-form): `create_account`,
`create_budget_code`, `create_recurring_payment`, `update_profile`, `remember_preference`,
`forget_preference`, `soft_delete_transaction` (brief "✅ Transaksi dihapus." + short message).

## Code changes

1. `src/agent/system-prompt.ts`
   - `formatCategories()` — include `c.icon` so the rendered taxonomy shows category icons
     (currently stripped). Required so the model can emit the `{category icon}` line.
   - Add **rule 12** with the two templates, the worked example, and the account/amount
     icon-mapping lines. Tighten rule 3 to cover only non-transaction writes.
2. `tests/agent/system-prompt.test.ts` (new) — assert: rule 12 text present; both icon-mapping
   lines (account by type, amount by transaction type) present; rendered taxonomy contains a
   category icon (e.g. `transport.flazz` → 💳).

## Verification

```bash
npx tsc --noEmit
npm run lint
npx vitest run tests/agent/system-prompt.test.ts
```

(Vitest strips types, so `tsc` is run separately per project convention.)

## Out of scope / future

- If format drift shows up in real runs, upgrade to Approach B (tool returns a code-built
  `confirmationBlock` emitted verbatim by the model).
- Formatting rules 9 and 10 are unchanged.
