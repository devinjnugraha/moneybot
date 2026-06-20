import { pool } from './pool.js';
import { mapRecurringPayment } from './mappers.js';
import type { IRecurringPaymentRepository, CreateRecurringPaymentInput } from '../../repositories/interfaces.js';
import type { RecurringPayment } from '../../domain/entities.js';

/** Loose UUID v4 shape check — catches non-UUID strings before they hit a UUID-typed column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NeonRecurringPaymentRepository implements IRecurringPaymentRepository {
  async findAllByUserId(userId: string): Promise<RecurringPayment[]> {
    const { rows } = await pool.query(
      'SELECT * FROM recurring_payments WHERE user_id = $1 AND is_active = true ORDER BY day_of_month',
      [userId],
    );
    return rows.map((r) => mapRecurringPayment(r as Record<string, unknown>));
  }

  async findByDayOfMonth(dayOfMonth: number): Promise<RecurringPayment[]> {
    const { rows } = await pool.query(
      'SELECT * FROM recurring_payments WHERE day_of_month = $1 AND is_active = true',
      [dayOfMonth],
    );
    return rows.map((r) => mapRecurringPayment(r as Record<string, unknown>));
  }

  async findDueToday(wibYear: number, wibMonth: number, wibDay: number): Promise<RecurringPayment[]> {
    const daysInMonth = new Date(wibYear, wibMonth, 0).getDate();
    const { rows } = await pool.query(
      `SELECT * FROM recurring_payments
       WHERE is_active = true
       AND (
         day_of_month = $1
         OR (day_of_month > $2 AND $1 = $2)
       )
       AND (
         last_fired_at IS NULL
         OR EXTRACT(MONTH FROM last_fired_at) != $3
         OR EXTRACT(YEAR FROM last_fired_at) != $4
       )`,
      [wibDay, daysInMonth, wibMonth, wibYear],
    );
    return rows.map((r) => mapRecurringPayment(r as Record<string, unknown>));
  }

  async findById(userId: string, recurringId: string): Promise<RecurringPayment | null> {
    // Defensive: reject non-UUID strings before they reach Postgres.
    // JSONB columns (session_contexts.pending_recurring_confirmation) accept
    // arbitrary strings, but recurring_id is UUID-typed.  A malformed $2
    // would throw 22P02 and break the caller's control flow.
    if (!UUID_RE.test(recurringId)) return null;

    const { rows } = await pool.query(
      'SELECT * FROM recurring_payments WHERE user_id = $1 AND recurring_id = $2',
      [userId, recurringId],
    );
    return rows[0] ? mapRecurringPayment(rows[0] as Record<string, unknown>) : null;
  }

  async findByName(userId: string, name: string): Promise<RecurringPayment | null> {
    const { rows } = await pool.query(
      'SELECT * FROM recurring_payments WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND is_active = true',
      [userId, name],
    );
    return rows[0] ? mapRecurringPayment(rows[0] as Record<string, unknown>) : null;
  }

  async create(input: CreateRecurringPaymentInput): Promise<RecurringPayment> {
    const { rows } = await pool.query(
      `INSERT INTO recurring_payments
        (user_id, name, amount, account_id, category_id, budget_code_id, day_of_month, next_fire_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.userId, input.name, input.amount, input.accountId,
        input.categoryId, input.budgetCodeId ?? null, input.dayOfMonth, input.nextFireAt,
      ],
    );
    return mapRecurringPayment(rows[0] as Record<string, unknown>);
  }

  async update(userId: string, recurringId: string, patch: Partial<RecurringPayment>): Promise<RecurringPayment> {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [userId, recurringId];
    let i = 3;
    if (patch.name !== undefined) { sets.push(`name = $${i++}`); values.push(patch.name); }
    if (patch.amount !== undefined) { sets.push(`amount = $${i++}`); values.push(patch.amount); }
    if (patch.accountId !== undefined) { sets.push(`account_id = $${i++}`); values.push(patch.accountId); }
    if (patch.categoryId !== undefined) { sets.push(`category_id = $${i++}`); values.push(patch.categoryId); }
    if (patch.dayOfMonth !== undefined) { sets.push(`day_of_month = $${i++}`); values.push(patch.dayOfMonth); }
    if (patch.nextFireAt !== undefined) { sets.push(`next_fire_at = $${i++}`); values.push(patch.nextFireAt); }
    const { rows } = await pool.query(
      `UPDATE recurring_payments SET ${sets.join(', ')} WHERE user_id = $1 AND recurring_id = $2 RETURNING *`,
      values,
    );
    return mapRecurringPayment(rows[0] as Record<string, unknown>);
  }

  async deactivate(userId: string, recurringId: string): Promise<void> {
    await pool.query(
      'UPDATE recurring_payments SET is_active = false, updated_at = NOW() WHERE user_id = $1 AND recurring_id = $2',
      [userId, recurringId],
    );
  }
}
