import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, enrichSystemPrompt } from '../../src/agent/system-prompt.js';
import type { Account, BudgetCode, UserPreference } from '../../src/domain/entities.js';

describe('buildSystemPrompt — standardized transaction confirmation', () => {
  const prompt = buildSystemPrompt('2026-06-22');

  it('includes the per-type confirmation-format sections', () => {
    expect(prompt).toMatch(/FORMAT KONFIRMASI EXPENSE\/INCOME/);
    expect(prompt).toMatch(/FORMAT KONFIRMASI TRANSFER/);
  });

  it('hardcodes the account-icon mapping by account type', () => {
    expect(prompt).toContain('cash 💵');
    expect(prompt).toContain('bank 🏦');
    expect(prompt).toContain('card 💳');
  });

  it('hardcodes the amount-icon mapping by transaction type', () => {
    expect(prompt).toContain('expense 💸');
    expect(prompt).toContain('income 💰');
    expect(prompt).toContain('transfer 🔁');
  });

  it('instructs truncating transactionId to the first 8 chars', () => {
    expect(prompt).toContain('8 karakter pertama');
    expect(prompt).toContain('<transactionId8>');
  });

  it('renders the taxonomy id-first so the model copies a clean categoryId (icon kept, after the id)', () => {
    // Icon prefixing the id made the LLM emit "🍜 food.dining" as the categoryId,
    // causing prod FK violations on every expense. The id must lead the line
    // (like accounts/budgets); the icon stays for display, repositioned after.
    expect(prompt).toContain('- food.dining 🍜');
    expect(prompt).toContain('- income.salary 💰');
    expect(prompt).not.toContain('🍜 food.dining');
    expect(prompt).not.toContain('💰 income.salary');
  });
});

describe('enrichSystemPrompt', () => {
  const base = 'BASE';

  const pref: UserPreference = { userId: 'u1', key: 'default_account', value: 'BCA', updatedAt: '' };
  const account: Account = {
    accountId: 'acct-1', userId: 'u1', name: 'BCA', type: 'bank',
    balance: 1234567, isDefault: false, isActive: true, createdAt: '', updatedAt: '',
  };
  const budget: BudgetCode = {
    budgetCodeId: 'bc-1', userId: 'u1', name: 'Raissa', monthlyBudget: 800000,
    month: 6, year: 2026, spent: 999999, isRecurring: false, createdAt: '', updatedAt: '',
  };

  it('appends a PREFERENSI block when preferences are present', () => {
    const out = enrichSystemPrompt(base, { preferences: [pref] });
    expect(out.startsWith('BASE')).toBe(true);
    expect(out).toContain('PREFERENSI USER');
    expect(out).toContain('- default_account: BCA');
  });

  it('appends an AKUN block with id, name, and type icon — but NEVER the balance', () => {
    const out = enrichSystemPrompt(base, { accounts: [account] });
    expect(out).toContain('AKUN USER');
    expect(out).toContain('acct-1');
    expect(out).toContain('BCA');
    expect(out).toContain('🏦');
    // Staleness invariant: balance must NOT be rendered.
    expect(out).not.toContain('1234567');
  });

  it('appends a BUDGET block with id, name, and limit — but NEVER spent', () => {
    const out = enrichSystemPrompt(base, { budgets: [budget] });
    expect(out).toContain('BUDGET CODE BULAN INI');
    expect(out).toContain('bc-1');
    expect(out).toContain('Raissa');
    expect(out).toContain('batas 800.000');
    // Staleness invariant: spent must NOT be rendered.
    expect(out).not.toContain('999999');
  });

  it('returns the base unchanged when all arrays are empty or undefined', () => {
    expect(enrichSystemPrompt(base, { preferences: [], accounts: [], budgets: [] })).toBe(base);
    expect(enrichSystemPrompt(base, {})).toBe(base);
  });

  it('appends all present sections, separated by blank lines', () => {
    const out = enrichSystemPrompt(base, { preferences: [pref], accounts: [account], budgets: [budget] });
    expect(out).toContain('PREFERENSI USER');
    expect(out).toContain('AKUN USER');
    expect(out).toContain('BUDGET CODE BULAN INI');
  });
});

describe('buildSystemPrompt — account-block rules', () => {
  const prompt = buildSystemPrompt('2026-06-22');

  it('rule 1 points the model at the AKUN USER block and mandates get_account_balance for balances', () => {
    expect(prompt).toContain('AKUN USER');
    expect(prompt).toContain('get_account_balance');
  });

  it('onboards when the AKUN USER block is absent or empty', () => {
    expect(prompt).toMatch(/Jika AKUN USER kosong\/tidak ada/);
  });
});

describe('buildSystemPrompt — post-write insight', () => {
  const prompt = buildSystemPrompt('2026-06-22');

  it('caps the optional post-write insight at one line with a notability bar', () => {
    expect(prompt).toMatch(/SETELAH TOOL TULIS BERHASIL/);
    expect(prompt).toMatch(/insight maksimal satu kalimat hanya jika menonjol/);
  });

  it('keeps budget-status mandatory when a transaction is budgeted', () => {
    expect(prompt).toMatch(/budget/);
  });
});

describe('buildSystemPrompt — Telegram formatting (no markdown tables)', () => {
  const prompt = buildSystemPrompt('2026-06-22');

  it('forbids markdown tables because Telegram cannot render them', () => {
    expect(prompt).toContain('Jangan pakai tabel Markdown');
    expect(prompt).toMatch(/satu baris per item/);
  });

  it('mandates a one-line-per-item alternative for lists and reports', () => {
    expect(prompt).toMatch(/SATU BARIS PER ITEM/i);
  });
});

describe('buildSystemPrompt — budget auto-rolling rules', () => {
  const prompt = buildSystemPrompt('2026-07-01');

  it('tells the model to ask bulanan-vs-sekali at creation', () => {
    expect(prompt).toMatch(/bulanan/i);
    expect(prompt).toContain('isRecurring');
  });

  it('tells the model to store budget NAME (not budgetCodeId) in preferences', () => {
    expect(prompt).toContain('Jangan pernah');
    expect(prompt).toContain('budgetCodeId');
  });
});

describe('enrichSystemPrompt — recurring marker', () => {
  const base = 'BASE';
  const recurring: BudgetCode = {
    budgetCodeId: 'bc-r', userId: 'u1', name: 'Terea', monthlyBudget: 300_000,
    month: 7, year: 2026, spent: 0, isRecurring: true, createdAt: '', updatedAt: '',
  };
  const oneTime: BudgetCode = {
    budgetCodeId: 'bc-o', userId: 'u1', name: 'Trip', monthlyBudget: 1_000_000,
    month: 7, year: 2026, spent: 0, isRecurring: false, createdAt: '', updatedAt: '',
  };

  it('marks recurring budgets with (bulanan)', () => {
    const out = enrichSystemPrompt(base, { budgets: [recurring] });
    expect(out).toContain('(bulanan)');
  });

  it('does not mark one-time budgets', () => {
    const out = enrichSystemPrompt(base, { budgets: [oneTime] });
    expect(out).not.toContain('(bulanan)');
  });
});

describe('enrichSystemPrompt — budget rules', () => {
  const base = 'BASE';
  const withRules: BudgetCode = {
    budgetCodeId: 'bc-r', userId: 'u1', name: 'Terea', monthlyBudget: 300_000,
    month: 7, year: 2026, spent: 0, isRecurring: true, createdAt: '', updatedAt: '',
    rules: 'semua expense yang menyebut terea masuk ke budget ini',
  };
  const withoutRules: BudgetCode = {
    budgetCodeId: 'bc-n', userId: 'u1', name: 'Trip', monthlyBudget: 1_000_000,
    month: 7, year: 2026, spent: 0, isRecurring: false, createdAt: '', updatedAt: '',
  };

  it('appends the rules to the budget line when present', () => {
    const out = enrichSystemPrompt(base, { budgets: [withRules] });
    expect(out).toContain('aturan: semua expense yang menyebut terea masuk ke budget ini');
  });

  it('omits the rules suffix when the budget has none', () => {
    const out = enrichSystemPrompt(base, { budgets: [withoutRules] });
    expect(out).toContain('Trip');
    expect(out).not.toContain('aturan:');
  });
});

describe('buildSystemPrompt — budget rules guidance', () => {
  const prompt = buildSystemPrompt('2026-08-17');

  it('routes budget-tagging rules to the budget code, not preferences', () => {
    expect(prompt).toContain('update_budget_code');
    expect(prompt).toMatch(/BUKAN di remember_preference/);
  });

  it('mandates auto-tagging from the budget block rules', () => {
    expect(prompt).toMatch(/otomatis tag transaksi/i);
  });
});

describe('buildSystemPrompt — budget deletion rules', () => {
  const prompt = buildSystemPrompt('2026-08-18');

  it('mandates Ya/Tidak confirmation before delete_budget_code', () => {
    expect(prompt).toContain('delete_budget_code');
    expect(prompt).toMatch(/Ya\/Tidak/);
  });

  it('tells the model transactions survive budget deletion', () => {
    expect(prompt).toMatch(/TIDAK menghapus transaksi/i);
  });
});

describe('buildSystemPrompt — card billing rules', () => {
  const prompt = buildSystemPrompt('2026-07-26');

  it('documents pay_card_bill and get_card_statements', () => {
    expect(prompt).toContain('pay_card_bill');
    expect(prompt).toContain('get_card_statements');
  });

  it('tells the model to ask for billingDay at card creation', () => {
    expect(prompt).toMatch(/billingDay/i);
  });

  it('forbids create_transfer for card payments (use pay_card_bill)', () => {
    expect(prompt).toContain('pay_card_bill');
    expect(prompt).toContain('BUKAN create_transfer');
  });
});

describe('buildSystemPrompt — accounts mode (FR-11)', () => {
  const prompt = buildSystemPrompt('2026-09-13');

  it('documents the toggle tool and its confirm-first rule', () => {
    expect(prompt).toContain('set_accounts_mode');
    expect(prompt).toMatch(/WAJIB konfirmasi/i);
  });

  it('documents the re-enable gate (Dompet must be emptied)', () => {
    expect(prompt).toMatch(/saldo "Dompet" 0/i);
  });

  it('onboarding asks for the mode instead of assuming an account', () => {
    expect(prompt).toMatch(/mode sederhana/i);
    expect(prompt).toContain('set_accounts_mode(useAccounts=false)');
  });
});

describe('enrichSystemPrompt — MODE SEDERHANA block (FR-11)', () => {
  const base = 'BASE';
  const account: Account = {
    accountId: 'acct-1', userId: 'u1', name: 'BCA', type: 'bank',
    balance: 1234567, isDefault: false, isActive: true, createdAt: '', updatedAt: '',
  };

  it('appends the override block LAST when accountsEnabled is false', () => {
    const out = enrichSystemPrompt(base, { accounts: [account], accountsEnabled: false });
    expect(out).toContain('MODE SEDERHANA');
    // the real AKUN USER section header (with its parenthetical) precedes the
    // mode block — the block's own prose mentions "blok AKUN USER" too, so
    // match the header form, not the bare phrase
    expect(out.indexOf('AKUN USER (')).toBeLessThan(out.indexOf('MODE SEDERHANA'));
    expect(out).toContain('JANGAN pernah menanya akun');
    expect(out).toContain('HAPUS baris akun');
    expect(out).toContain('get_account_balance TANPA accountId');
  });

  it('keeps accounts listed in simple mode (explicit mentions + re-enable prep resolve them)', () => {
    const out = enrichSystemPrompt(base, { accounts: [account], accountsEnabled: false });
    expect(out).toContain('AKUN USER');
    expect(out).toContain('acct-1 BCA');
  });

  it('omits the block in accounts mode (true or undefined)', () => {
    expect(enrichSystemPrompt(base, { accounts: [account], accountsEnabled: true })).not.toContain('MODE SEDERHANA');
    expect(enrichSystemPrompt(base, { accounts: [account] })).not.toContain('MODE SEDERHANA');
  });
});
