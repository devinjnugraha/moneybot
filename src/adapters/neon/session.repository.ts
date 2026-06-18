import { pool } from './pool.js';
import { mapSession } from './mappers.js';
import type { ISessionRepository } from '../../repositories/interfaces.js';
import type { SessionContext } from '../../domain/entities.js';

export class NeonSessionRepository implements ISessionRepository {
  async get(chatId: string): Promise<SessionContext | null> {
    const { rows } = await pool.query('SELECT * FROM session_contexts WHERE chat_id = $1', [chatId]);
    return rows[0] ? mapSession(rows[0] as Record<string, unknown>) : null;
  }

  async set(context: SessionContext): Promise<void> {
    await pool.query(
      `INSERT INTO session_contexts
        (chat_id, user_id, turns, last_transaction_id, pending_recurring_confirmation, last_activity_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (chat_id) DO UPDATE SET
         turns = EXCLUDED.turns,
         last_transaction_id = EXCLUDED.last_transaction_id,
         pending_recurring_confirmation = EXCLUDED.pending_recurring_confirmation,
         last_activity_at = EXCLUDED.last_activity_at`,
      [
        context.chatId,
        context.userId,
        JSON.stringify(context.turns),
        context.lastTransactionId ?? null,
        context.pendingRecurringConfirmation ?? null,
        context.lastActivityAt,
      ],
    );
  }

  async delete(chatId: string): Promise<void> {
    await pool.query('DELETE FROM session_contexts WHERE chat_id = $1', [chatId]);
  }
}
