import { pool } from './pool.js';
import type { IOutreachLogRepository } from '../../repositories/interfaces.js';
import type { ProactiveTriggerType } from '../../domain/entities.js';

export class NeonOutreachLogRepository implements IOutreachLogRepository {
  async record(i: {
    userId: string;
    triggerType: ProactiveTriggerType;
    dedupKey: string;
    payload: unknown;
    sentAt: Date;
  }): Promise<{ inserted: boolean }> {
    const { rows } = await pool.query(
      `INSERT INTO outreach_log (user_id, trigger_type, dedup_key, payload, sent_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, dedup_key) DO NOTHING
       RETURNING outreach_id`,
      [i.userId, i.triggerType, i.dedupKey, JSON.stringify(i.payload ?? {}), i.sentAt],
    );
    return { inserted: rows.length > 0 };
  }

  async existsKey(userId: string, dedupKey: string): Promise<boolean> {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM outreach_log WHERE user_id = $1 AND dedup_key = $2',
      [userId, dedupKey],
    );
    return (rowCount ?? 0) > 0;
  }

  async countSince(userId: string, since: Date): Promise<number> {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM outreach_log WHERE user_id = $1 AND sent_at >= $2',
      [userId, since],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
