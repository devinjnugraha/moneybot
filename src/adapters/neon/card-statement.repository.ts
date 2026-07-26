import { pool } from './pool.js';
import { mapCardStatement, mapTransaction } from './mappers.js';
import { todayWIB, addDays, billingCut, lastBillingCutOnOrBefore, previousBillingCut } from '../../domain/time.js';
import type { ICardStatementRepository } from '../../repositories/interfaces.js';
import type { CardStatementWithFigures } from '../../domain/entities.js';

export class NeonCardStatementRepository implements ICardStatementRepository {
  async ensureEndedCycles(
    userId: string,
    accountId: string,
    billingDay: number,
    cardCreatedAt: string,
    asOf: Date,
  ): Promise<number> {
    const today = todayWIB(asOf);
    const lastCut = lastBillingCutOnOrBefore(billingDay, today);
    const created = cardCreatedAt.slice(0, 10); // 'YYYY-MM-DD'
    if (lastCut < created) return 0;

    let inserted = 0;
    let y = Number(created.slice(0, 4));
    let m = Number(created.slice(5, 7));
    // Cap at 120 months as a safety valve against runaway loops.
    for (let i = 0; i < 120; i++) {
      const cut = billingCut(billingDay, y, m);
      if (cut > lastCut) break;
      if (cut >= created) {
        const prevCut = previousBillingCut(billingDay, cut);
        const result = await pool.query(
          `INSERT INTO card_statements (user_id, account_id, cycle_start, cycle_end)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (account_id, cycle_end) DO NOTHING`,
          [userId, accountId, prevCut, cut],
        );
        inserted += result.rowCount ?? 0;
      }
      if (m === 12) { m = 1; y++; } else m++;
    }
    return inserted;
  }

  async getWithFigures(userId: string, accountId: string, asOf: Date = new Date()): Promise<CardStatementWithFigures[]> {
    const accRes = await pool.query(
      'SELECT due_in_days FROM accounts WHERE user_id = $1 AND account_id = $2',
      [userId, accountId],
    );
    if ((accRes.rowCount ?? 0) === 0) return [];
    const dueInDays = Number((accRes.rows[0] as Record<string, unknown>).due_in_days) || 15;

    const stmtRes = await pool.query(
      'SELECT * FROM card_statements WHERE user_id = $1 AND account_id = $2 ORDER BY cycle_end',
      [userId, accountId],
    );
    const stmts = stmtRes.rows.map((r) => mapCardStatement(r as Record<string, unknown>));
    if (stmts.length === 0) return [];

    const txnRes = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id = $1 AND deleted_at IS NULL
         AND ((type = 'expense' AND account_id = $2)
              OR (type = 'transfer' AND to_account_id = $2))
       ORDER BY date, created_at`,
      [userId, accountId],
    );
    const txns = txnRes.rows.map((r) => mapTransaction(r as Record<string, unknown>));
    const expenses = txns.filter((t) => t.type === 'expense');
    // Local mutable copies so FIFO can consume remainders.
    const payments = txns
      .filter((t) => t.type === 'transfer')
      .map((t) => ({ amount: t.amount, createdAt: t.createdAt }));

    const today = todayWIB(asOf);
    const result: CardStatementWithFigures[] = stmts.map((s) => {
      const newCharges = expenses
        .filter((t) => t.date > s.cycleStart && t.date <= s.cycleEnd)
        .reduce((sum, t) => sum + t.amount, 0);
      return {
        ...s,
        newCharges,
        amountPaid: 0,
        remainingDue: newCharges,
        status: 'open',
        dueDate: addDays(s.cycleEnd, dueInDays),
        paidAt: undefined,
        overdue: false,
      };
    });

    let payIdx = 0;
    for (const s of result) {
      let need = s.newCharges;
      let settledAt: string | undefined;
      while (need > 0 && payIdx < payments.length) {
        const p = payments[payIdx]!;
        if (p.amount <= 0) { payIdx++; continue; }
        const applied = Math.min(need, p.amount);
        s.amountPaid += applied;
        need -= applied;
        p.amount -= applied;
        settledAt = p.createdAt;
        if (p.amount <= 0) payIdx++;
        if (need <= 0) break;
      }
      s.remainingDue = Math.max(0, s.newCharges - s.amountPaid);
      if (s.newCharges > 0 && s.remainingDue === 0) {
        s.status = 'paid';
        s.paidAt = settledAt;
      } else if (s.amountPaid > 0) {
        s.status = 'partially_paid';
      } else {
        s.status = 'open';
      }
      s.overdue = s.dueDate < today && s.remainingDue > 0;
    }
    return result;
  }

}
