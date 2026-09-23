// Throwaway: replicates every assertion from tests/agent/system-prompt.test.ts
// and system-prompt-advisory.test.ts without vitest's DB-backed global setup.
// Run: npx tsx scripts/check-prompt-assertions.ts
import { buildSystemPrompt, enrichSystemPrompt } from '../src/agent/system-prompt.js';
import type { Account, BudgetCode, UserPreference } from '../src/domain/entities.js';

let failures = 0;
function check(label: string, actual: boolean) {
  if (!actual) {
    failures++;
    console.error(`FAIL: ${label}`);
  }
}
const has = (s: string, sub: string) => s.includes(sub);
const re = (s: string, r: RegExp) => r.test(s);

const prompt = buildSystemPrompt('2026-06-22');

// --- standardized transaction confirmation ---
check('FORMAT KONFIRMASI EXPENSE/INCOME', re(prompt, /FORMAT KONFIRMASI EXPENSE\/INCOME/));
check('FORMAT KONFIRMASI TRANSFER', re(prompt, /FORMAT KONFIRMASI TRANSFER/));
for (const s of ['cash 💵', 'bank 🏦', 'card 💳', 'expense 💸', 'income 💰', 'transfer 🔁']) check(`icon ${s}`, has(prompt, s));
check('8 karakter pertama', has(prompt, '8 karakter pertama'));
check('<transactionId8>', has(prompt, '<transactionId8>'));
check('- food.dining 🍜', has(prompt, '- food.dining 🍜'));
check('- income.salary 💰', has(prompt, '- income.salary 💰'));
check('NOT "🍜 food.dining"', !has(prompt, '🍜 food.dining'));
check('NOT "💰 income.salary"', !has(prompt, '💰 income.salary'));

// --- enrichment ---
const base = 'BASE';
const pref: UserPreference = { userId: 'u1', key: 'default_account', value: 'BCA', updatedAt: '' };
const account: Account = { accountId: 'acct-1', userId: 'u1', name: 'BCA', type: 'bank', balance: 1234567, isDefault: false, isActive: true, createdAt: '', updatedAt: '' };
const budget: BudgetCode = { budgetCodeId: 'bc-1', userId: 'u1', name: 'Raissa', monthlyBudget: 800000, month: 6, year: 2026, spent: 999999, isRecurring: false, createdAt: '', updatedAt: '' };

const outPref = enrichSystemPrompt(base, { preferences: [pref] });
check('PREFERENSI USER block', has(outPref, 'PREFERENSI USER') && has(outPref, '- default_account: BCA'));
const outAcct = enrichSystemPrompt(base, { accounts: [account] });
check('AKUN block', has(outAcct, 'AKUN USER') && has(outAcct, 'acct-1') && has(outAcct, '🏦'));
check('AKUN balance omitted', !has(outAcct, '1234567'));
const outBud = enrichSystemPrompt(base, { budgets: [budget] });
check('BUDGET block', has(outBud, 'BUDGET CODE BULAN INI') && has(outBud, 'batas 800.000'));
check('BUDGET spent omitted', !has(outBud, '999999'));
check('empty → base unchanged', enrichSystemPrompt(base, { preferences: [], accounts: [], budgets: [] }) === base && enrichSystemPrompt(base, {}) === base);
const outAll = enrichSystemPrompt(base, { preferences: [pref], accounts: [account], budgets: [budget] });
check('all sections', has(outAll, 'PREFERENSI USER') && has(outAll, 'AKUN USER') && has(outAll, 'BUDGET CODE BULAN INI'));

// --- base rules ---
check('get_account_balance in base', has(prompt, 'get_account_balance'));
check('onboarding', re(prompt, /Jika AKUN USER kosong\/tidak ada/));
check('SETELAH TOOL TULIS BERHASIL', re(prompt, /SETELAH TOOL TULIS BERHASIL/));
check('insight cap', re(prompt, /insight maksimal satu kalimat hanya jika menonjol/));
check('no tables', has(prompt, 'Jangan pakai tabel Markdown') && re(prompt, /satu baris per item/) && re(prompt, /SATU BARIS PER ITEM/i));
check('bulanan/isRecurring', re(prompt, /bulanan/i) && has(prompt, 'isRecurring'));
check('pref stores NAME not id', has(prompt, 'Jangan pernah') && has(prompt, 'budgetCodeId'));
check('rules routed to budget code', has(prompt, 'update_budget_code') && re(prompt, /BUKAN di remember_preference/));
check('auto-tag mandate', re(prompt, /otomatis tag transaksi/i));
check('delete confirmation', has(prompt, 'delete_budget_code') && re(prompt, /Ya\/Tidak/));
check('transactions survive', re(prompt, /TIDAK menghapus transaksi/i));
check('card tools', has(prompt, 'pay_card_bill') && has(prompt, 'get_card_statements') && re(prompt, /billingDay/i) && has(prompt, 'BUKAN create_transfer'));
check('mode toggle', has(prompt, 'set_accounts_mode') && re(prompt, /WAJIB konfirmasi/i));
check('re-enable gate', re(prompt, /saldo "Dompet" 0/i));
check('onboarding mode', re(prompt, /mode sederhana/i) && has(prompt, 'set_accounts_mode(useAccounts=false)'));

// --- recurring marker & rules ---
const recurring: BudgetCode = { budgetCodeId: 'bc-r', userId: 'u1', name: 'Terea', monthlyBudget: 300000, month: 7, year: 2026, spent: 0, isRecurring: true, createdAt: '', updatedAt: '' };
const oneTime: BudgetCode = { budgetCodeId: 'bc-o', userId: 'u1', name: 'Trip', monthlyBudget: 1000000, month: 7, year: 2026, spent: 0, isRecurring: false, createdAt: '', updatedAt: '' };
const withRules: BudgetCode = { ...recurring, rules: 'semua expense yang menyebut terea masuk ke budget ini' };
check('(bulanan) marker', has(enrichSystemPrompt(base, { budgets: [recurring] }), '(bulanan)'));
check('one-time unmarked', !has(enrichSystemPrompt(base, { budgets: [oneTime] }), '(bulanan)'));
check('rules rendered', has(enrichSystemPrompt(base, { budgets: [withRules] }), 'aturan: semua expense yang menyebut terea masuk ke budget ini'));
const noRules = enrichSystemPrompt(base, { budgets: [oneTime] });
check('no rules suffix', has(noRules, 'Trip') && !has(noRules, 'aturan:'));

// --- advisory ---
check('ANALISIS & SARAN', has(prompt, 'ANALISIS & SARAN') && has(prompt, 'get_analytics'));
check('grounding', has(prompt, 'Jangan mengarang') && has(prompt, 'insufficient_data'));
check('interpretasi', has(prompt, 'interpretasi'));

// --- MODE SEDERHANA block ---
const outSimple = enrichSystemPrompt(base, { accounts: [account], accountsEnabled: false });
check('block last', outSimple.indexOf('AKUN USER (') < outSimple.indexOf('MODE SEDERHANA'));
check('block strings', has(outSimple, 'JANGAN pernah menanya akun') && has(outSimple, 'HAPUS baris akun') && has(outSimple, 'get_account_balance TANPA accountId'));
check('accounts listed in simple mode', has(outSimple, 'acct-1 BCA'));
check('no block in accounts mode', !has(enrichSystemPrompt(base, { accounts: [account], accountsEnabled: true }), 'MODE SEDERHANA') && !has(enrichSystemPrompt(base, { accounts: [account] }), 'MODE SEDERHANA'));

console.log(failures === 0 ? `\nALL ASSERTIONS PASS (${new Date().toISOString().slice(0, 10)} diet)` : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
