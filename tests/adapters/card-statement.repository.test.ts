import { describe, it, expect } from 'vitest';
import { NeonUserRepository } from '../../src/adapters/neon/user.repository.js';
import { NeonAccountRepository } from '../../src/adapters/neon/account.repository.js';
import { NeonCardStatementRepository } from '../../src/adapters/neon/card-statement.repository.js';
import { uniqueChatId, pool } from '../helpers/db.js';
import type { Account } from '../../src/domain/entities.js';

async function seedUser() {
  return new NeonUserRepository().create({ telegramChatId: uniqueChatId(), name: 'U' });
}

/** Create a card and pin its created_at so cycle math is deterministic (the card's
 *  live created_at is ~now, which would otherwise make lastCut < created → 0 inserts). */
async function createCard(userId: string, opts: { billingDay: number; createdAt: string }): Promise<Account> {
  const accounts = new NeonAccountRepository();
  const card = await accounts.create({
    userId, name: 'CC', type: 'card', creditLimit: 5_000_000, billingDay: opts.billingDay,
  });
  await pool.query('UPDATE accounts SET created_at = $1 WHERE account_id = $2', [opts.createdAt, card.accountId]);
  return card;
}

describe('NeonCardStatementRepository.ensureEndedCycles', () => {
  it('creates a row for the cycle ending on the most recent cut, with cycle_start = previous cut', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 5, createdAt: '2026-06-10' });
    const repo = new NeonCardStatementRepository();
    // asOf 2026-07-20 → last cut 2026-07-05; cycle_start 2026-06-05
    const created = await repo.ensureEndedCycles(
      user.userId, card.accountId, 5, '2026-06-10', new Date('2026-07-20T03:00:00Z'),
    );
    expect(created).toBe(1);
    const { rows } = await pool.query(
      'SELECT cycle_start, cycle_end FROM card_statements WHERE account_id = $1', [card.accountId],
    );
    expect(rows[0]!.cycle_start).toBe('2026-06-05');
    expect(rows[0]!.cycle_end).toBe('2026-07-05');
  });

  it('is idempotent (second call inserts nothing)', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 5, createdAt: '2026-06-10' });
    const repo = new NeonCardStatementRepository();
    const asOf = new Date('2026-07-20T03:00:00Z');
    await repo.ensureEndedCycles(user.userId, card.accountId, 5, '2026-06-10', asOf);
    const second = await repo.ensureEndedCycles(user.userId, card.accountId, 5, '2026-06-10', asOf);
    expect(second).toBe(0);
  });

  it('returns 0 when the most recent cut predates the card creation', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 5, createdAt: '2026-07-10' });
    const repo = new NeonCardStatementRepository();
    // asOf 2026-07-20 → last cut 2026-07-05 < created 2026-07-10 → nothing to freeze yet.
    const created = await repo.ensureEndedCycles(
      user.userId, card.accountId, 5, '2026-07-10', new Date('2026-07-20T03:00:00Z'),
    );
    expect(created).toBe(0);
    const { rows } = await pool.query(
      'SELECT cycle_end FROM card_statements WHERE account_id = $1', [card.accountId],
    );
    expect(rows).toHaveLength(0);
  });

  it('self-heals multi-month gaps (inserts each missed cycle up to the last cut)', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 5, createdAt: '2026-04-10' });
    const repo = new NeonCardStatementRepository();
    // First run to 2026-05-20 → last cut 2026-05-05 (one row: cycle 2026-04-05..2026-05-05).
    await repo.ensureEndedCycles(user.userId, card.accountId, 5, '2026-04-10', new Date('2026-05-20T03:00:00Z'));
    // Second run to 2026-07-20 → must backfill cuts 2026-06-05 and 2026-07-05.
    const created = await repo.ensureEndedCycles(user.userId, card.accountId, 5, '2026-04-10', new Date('2026-07-20T03:00:00Z'));
    expect(created).toBe(2);
    const { rows } = await pool.query(
      'SELECT cycle_end FROM card_statements WHERE account_id = $1 ORDER BY cycle_end', [card.accountId],
    );
    expect(rows.map((r) => String(r.cycle_end))).toEqual(['2026-05-05', '2026-06-05', '2026-07-05']);
  });

  it('clamps a day-31 billing day to month length', async () => {
    const user = await seedUser();
    const card = await createCard(user.userId, { billingDay: 31, createdAt: '2026-01-10' });
    const repo = new NeonCardStatementRepository();
    await repo.ensureEndedCycles(user.userId, card.accountId, 31, '2026-01-10', new Date('2026-03-15T03:00:00Z'));
    const { rows } = await pool.query(
      'SELECT cycle_end FROM card_statements WHERE account_id = $1', [card.accountId],
    );
    expect(rows.map((r) => String(r.cycle_end))).toContain('2026-02-28');
  });
});
