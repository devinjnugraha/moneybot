import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, enrichSystemPrompt } from '../../src/agent/system-prompt.js';
import type { Account, BudgetCode, UserPreference } from '../../src/domain/entities.js';

describe('buildSystemPrompt — standardized transaction confirmation (rule 12)', () => {
  const prompt = buildSystemPrompt('2026-06-22');

  it('includes the rule 12 confirmation-format section', () => {
    expect(prompt).toMatch(/KONFIRMASI TRANSAKSI/);
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
  });

  it('shows the worked example with a truncated id (550e8400)', () => {
    expect(prompt).toContain('550e8400');
  });

  it('renders category icons in the taxonomy (icon not stripped)', () => {
    // Each category's icon must appear immediately before its categoryId.
    expect(prompt).toContain('💰 income.salary');
    expect(prompt).toContain('💳 transport.flazz');
  });
});

describe('enrichSystemPrompt', () => {
  const base = 'BASE';

  const pref: UserPreference = { userId: 'u1', key: 'default_account', value: 'BCA', updatedAt: '' };
  const account: Account = {
    accountId: 'acct-1', userId: 'u1', name: 'BCA', type: 'bank',
    balance: 1234567, isActive: true, createdAt: '', updatedAt: '',
  };
  const budget: BudgetCode = {
    budgetCodeId: 'bc-1', userId: 'u1', name: 'Raissa', monthlyBudget: 800000,
    month: 6, year: 2026, spent: 999999, createdAt: '', updatedAt: '',
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

  it('rule 11 onboards when the AKUN USER block is absent or empty', () => {
    expect(prompt).toMatch(/blok AKUN USER (tidak ada|kosong)/);
  });
});
