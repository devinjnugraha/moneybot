import { pool } from './pool.js';
import { todayWIB, billingCut, lastBillingCutOnOrBefore, previousBillingCut } from '../../domain/time.js';
import type { ICardStatementRepository } from '../../repositories/interfaces.js';

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

}
