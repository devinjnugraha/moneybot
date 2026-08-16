import { describe, it, expect } from 'vitest';
import { periodCompare } from '../../src/domain/analytics/compare.js';
import type { Transaction } from '../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

describe('periodCompare — category breakdown', () => {
  const current = [
    mkTxn({ categoryId: 'food.coffee', amount: 150_000 }),
    mkTxn({ categoryId: 'food.coffee', amount: 50_000 }),
    mkTxn({ categoryId: 'transport.fuel', amount: 100_000 }),
    mkTxn({ type: 'transfer', amount: 500_000 }), // excluded everywhere
    mkTxn({ type: 'income', amount: 5_000_000 }), // excluded from expense totals
  ];
  const previous = [
    mkTxn({ categoryId: 'food.coffee', amount: 100_000 }),
    mkTxn({ categoryId: 'transport.fuel', amount: 100_000 }),
  ];

  it('totals only expenses; overall delta is rounded integer %', () => {
    const r = periodCompare(current, previous, { breakdown: 'category' });
    expect(r.currentTotal).toBe(300_000);
    expect(r.previousTotal).toBe(200_000);
    expect(r.deltaPct).toBe(50);
  });

  it('per-group deltas: coffee +100%, fuel 0%; sorted by |delta| desc', () => {
    const r = periodCompare(current, previous, { breakdown: 'category' });
    expect(r.groups[0]).toMatchObject({ key: 'food.coffee', current: 200_000, previous: 100_000, deltaPct: 100, pctOfTotal: 67 });
    expect(r.groups[1]).toMatchObject({ key: 'transport.fuel', current: 100_000, previous: 100_000, deltaPct: 0 });
  });

  it('deltaPct undefined when previous is 0 (new group)', () => {
    const r = periodCompare([mkTxn({ categoryId: 'other.misc', amount: 10_000 })], [], { breakdown: 'category' });
    expect(r.groups[0]!.deltaPct).toBeUndefined();
    expect(r.currentTotal).toBe(10_000);
  });

  it('current-only call (no previous) sorts by current desc, no delta fields', () => {
    const r = periodCompare(current, undefined, { breakdown: 'category' });
    expect(r.previousTotal).toBeUndefined();
    expect(r.deltaPct).toBeUndefined();
    expect(r.groups.map((g) => g.key)).toEqual(['food.coffee', 'transport.fuel']);
  });

  it('topN caps the group list', () => {
    const many = Array.from({ length: 5 }, (_, i) => mkTxn({ categoryId: `c${i}`, amount: (i + 1) * 1000 }));
    const r = periodCompare(many, undefined, { breakdown: 'category', topN: 3 });
    expect(r.groups).toHaveLength(3);
  });

  it('uncategorized expenses group under __uncategorized__', () => {
    const r = periodCompare([mkTxn({ amount: 5_000 })], undefined, { breakdown: 'category' });
    expect(r.groups[0]!.key).toBe('__uncategorized__');
  });
});

describe('periodCompare — description breakdown uses normalizeDescription', () => {
  it('groups variants of the same merchant-ish string', () => {
    const current = [
      mkTxn({ description: 'Kopi Kenangan', amount: 100_000 }),
      mkTxn({ description: 'kopi kenangan (diskon)', amount: 50_000 }),
      mkTxn({ description: 'kopi kenangan 2x', amount: 50_000 }),
    ];
    const previous = [mkTxn({ description: 'Kopi Kenangan', amount: 100_000 })];
    const r = periodCompare(current, previous, { breakdown: 'description' });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.key).toBe('kopi kenangan');
    expect(r.groups[0]!.current).toBe(200_000);
  });

  it('empty normalized keys are skipped', () => {
    const r = periodCompare([mkTxn({ description: '123', amount: 5_000 })], undefined, { breakdown: 'description' });
    expect(r.groups).toHaveLength(0);
    expect(r.currentTotal).toBe(5_000); // total still counted
  });
});
