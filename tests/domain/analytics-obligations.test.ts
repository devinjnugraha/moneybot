import { describe, it, expect } from 'vitest';
import { obligations } from '../../src/domain/analytics/obligations.js';
import type { Account, RecurringPayment } from '../../src/domain/entities.js';

function mkAccount(over: Partial<Account>): Account {
  return { accountId: 'a', userId: 'u', name: 'acc', type: 'cash', balance: 0, isActive: true, createdAt: '', updatedAt: '', ...over };
}
function mkRecurring(over: Partial<RecurringPayment>): RecurringPayment {
  return { recurringId: 'r', userId: 'u', name: 'netflix', amount: 100_000, accountId: 'a', categoryId: 'other.misc', dayOfMonth: 20, isActive: true, nextFireAt: '2026-08-20', createdAt: '', updatedAt: '', ...over };
}

const TODAY = '2026-08-16'; // horizonEnd default 2026-09-15
const BANK = mkAccount({ type: 'bank', balance: 1_000_000 });

describe('obligations', () => {
  it('collects recurring fires + card dues in (today, horizonEnd], sorted by dueDate', () => {
    const r = obligations({
      recurrings: [
        mkRecurring({ name: 'netflix', amount: 100_000, nextFireAt: '2026-08-20' }),
        mkRecurring({ name: 'listrik', amount: 300_000, nextFireAt: '2026-09-01' }),
        mkRecurring({ name: 'sudah lewat', nextFireAt: '2026-08-10' }), // outside horizon
        mkRecurring({ name: 'mati', isActive: false, nextFireAt: '2026-08-20' }), // inactive
      ],
      accounts: [BANK],
      cardDues: [{ name: 'bca card', amount: 500_000, dueDate: '2026-08-25' }, { name: 'paid card', amount: 0, dueDate: '2026-08-25' }],
      today: TODAY,
    });
    expect(r.items.map((i) => i.name)).toEqual(['netflix', 'bca card', 'listrik']);
    expect(r.items[0]).toMatchObject({ kind: 'recurring', dueDate: '2026-08-20' });
    expect(r.items[1]).toMatchObject({ kind: 'card' });
    expect(r.totalDue).toBe(900_000);
    expect(r.horizonEnd).toBe('2026-09-15');
  });

  it('liquidBalance sums active cash+bank only', () => {
    const r = obligations({
      recurrings: [], accounts: [
        BANK,
        mkAccount({ type: 'cash', balance: 200_000 }),
        mkAccount({ type: 'card', balance: -500_000 }),     // never liquid
        mkAccount({ type: 'bank', balance: 999_999, isActive: false }), // inactive
      ],
      cardDues: [], today: TODAY,
    });
    expect(r.liquidBalance).toBe(1_200_000);
  });

  it('covered when liquid >= totalDue; nothing due → covered', () => {
    const covered = obligations({ recurrings: [mkRecurring({ amount: 500_000 })], accounts: [BANK], cardDues: [], today: TODAY });
    expect(covered.verdict).toBe('covered');
    const none = obligations({ recurrings: [], accounts: [BANK], cardDues: [], today: TODAY });
    expect(none.verdict).toBe('covered');
    expect(none.totalDue).toBe(0);
  });

  it('tight at >= 50% coverage; short below with shortfall', () => {
    const tight = obligations({ recurrings: [mkRecurring({ amount: 1_800_000 })], accounts: [BANK], cardDues: [], today: TODAY });
    expect(tight.verdict).toBe('tight');
    expect(tight.shortfall).toBe(800_000);
    const short = obligations({ recurrings: [mkRecurring({ amount: 4_000_000 })], accounts: [BANK], cardDues: [], today: TODAY });
    expect(short.verdict).toBe('short');
    expect(short.shortfall).toBe(3_000_000);
  });
});
