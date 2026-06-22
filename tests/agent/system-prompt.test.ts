import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../src/agent/system-prompt.js';

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
