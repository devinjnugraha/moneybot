import { describe, it, expect } from 'vitest';
import { normalizeDescription } from '../../src/domain/analytics/normalize.js';

describe('normalizeDescription', () => {
  it('trims, lowercases, collapses whitespace', () => {
    expect(normalizeDescription('  Kopi   Kenangan  ')).toBe('kopi kenangan');
  });

  it('truncates at punctuation (parenthetical notes dropped)', () => {
    expect(normalizeDescription('Kopi Kenangan (diskon gofood)')).toBe('kopi kenangan');
    expect(normalizeDescription('makan siang - warteg')).toBe('makan siang');
  });

  it('strips digits and qty markers', () => {
    expect(normalizeDescription('kopi 2 x')).toBe('kopi');
    expect(normalizeDescription('kopi x2')).toBe('kopi');
    expect(normalizeDescription('susu 3pcs')).toBe('susu');
    expect(normalizeDescription('bakso 2 porsi')).toBe('bakso');
  });

  it('returns empty string for digit-only or empty input', () => {
    expect(normalizeDescription('123')).toBe('');
    expect(normalizeDescription('   ')).toBe('');
  });
});
