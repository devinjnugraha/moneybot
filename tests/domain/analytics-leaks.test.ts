import { describe, it, expect } from 'vitest';
import { leakCandidates } from '../../src/domain/analytics/leaks.js';
import type { RecurringPayment, Transaction } from '../../src/domain/entities.js';

function mkTxn(over: Partial<Transaction>): Transaction {
  return {
    transactionId: 't', userId: 'u', type: 'expense', amount: 0, description: '',
    accountId: 'a', date: '2026-08-01', isRecurringInstance: false, createdAt: '', updatedAt: '',
    ...over,
  };
}
function mkRecurring(over: Partial<RecurringPayment>): RecurringPayment {
  return { recurringId: 'r', userId: 'u', name: 'netflix', amount: 100_000, accountId: 'a', categoryId: 'other.misc', dayOfMonth: 5, isActive: true, nextFireAt: '2026-09-05', createdAt: '2025-01-01T00:00:00Z', updatedAt: '', ...over };
}

const TODAY = '2026-08-16';

describe('leakCandidates — spikes', () => {
  it('flags a description group that grew > 50% with >= 2 occurrences each side and >= 50k total', () => {
    const r = leakCandidates({
      currentTx: [
        mkTxn({ description: 'kopi kenangan', amount: 150_000 }),
        mkTxn({ description: 'Kopi Kenangan (diskon)', amount: 100_000 }),
      ],
      previousTx: [
        mkTxn({ description: 'kopi kenangan', amount: 100_000 }),
        mkTxn({ description: 'kopi kenangan', amount: 50_000 }),
      ],
      tx60d: [], recurrings: [], today: TODAY,
    });
    expect(r.spikes).toHaveLength(1);
    expect(r.spikes[0]).toMatchObject({ label: 'kopi kenangan', current: 250_000, previous: 150_000, deltaPct: 67, countCurrent: 2, countPrevious: 2 });
  });

  it('ignores small-total and single-occurrence groups', () => {
    const r = leakCandidates({
      currentTx: [
        mkTxn({ description: 'parkir', amount: 20_000 }),   // total 40k < 50k floor
        mkTxn({ description: 'parkir', amount: 20_000 }),
        mkTxn({ description: 'sekali ini', amount: 500_000 }), // count 1 < 2
      ],
      previousTx: [mkTxn({ description: 'parkir', amount: 10_000 }), mkTxn({ description: 'sekali ini', amount: 10_000 })],
      tx60d: [], recurrings: [], today: TODAY,
    });
    expect(r.spikes).toHaveLength(0);
  });

  it('steady groups (<= 50% growth) are not leaks', () => {
    const r = leakCandidates({
      currentTx: [mkTxn({ description: 'gonline', amount: 100_000 }), mkTxn({ description: 'gonline', amount: 50_000 })],
      previousTx: [mkTxn({ description: 'gonline', amount: 100_000 }), mkTxn({ description: 'gonline', amount: 50_000 })],
      tx60d: [], recurrings: [], today: TODAY,
    });
    expect(r.spikes).toHaveLength(0);
  });
});

describe('leakCandidates — recurring audit', () => {
  it('marks subscriptions created < 90d ago as new; older ones form baselineTotal', () => {
    const r = leakCandidates({
      currentTx: [], previousTx: [],
      // 'lama' has recent instances → NOT dormant; keeps this test about new-subscription detection.
      tx60d: [mkTxn({ description: 'netflix lama', amount: 1_000, isRecurringInstance: true, recurringId: 'lama' })],
      today: TODAY,
      recurrings: [
        mkRecurring({ name: 'lama', recurringId: 'lama', amount: 100_000, createdAt: '2026-01-01T00:00:00Z' }),
        mkRecurring({ name: 'baru', amount: 50_000, createdAt: '2026-07-01T00:00:00Z' }), // 46 days before TODAY
      ],
    });
    expect(r.recurring).toEqual([{ name: 'baru', amount: 50_000, kind: 'new' }]);
    expect(r.recurringTotal).toBe(150_000);
    expect(r.baselineTotal).toBe(100_000);
  });

  it('flags dormant: active recurring with no instance transaction in 60d', () => {
    const r = leakCandidates({
      currentTx: [], previousTx: [],
      tx60d: [mkTxn({ description: 'x', amount: 1_000, isRecurringInstance: true, recurringId: 'other' })],
      recurrings: [mkRecurring({ name: 'netflix', recurringId: 'dormant-one', createdAt: '2025-01-01T00:00:00Z' })],
      today: TODAY,
    });
    expect(r.recurring).toEqual([{ name: 'netflix', amount: 100_000, kind: 'dormant' }]);
  });

  it('inactive recurrings are excluded entirely', () => {
    const r = leakCandidates({
      currentTx: [], previousTx: [], tx60d: [],
      recurrings: [mkRecurring({ isActive: false })],
      today: TODAY,
    });
    expect(r.recurring).toEqual([]);
    expect(r.recurringTotal).toBe(0);
    expect(r.baselineTotal).toBeUndefined(); // no baseline ever formed → undefined, never a fake 0
  });
});
