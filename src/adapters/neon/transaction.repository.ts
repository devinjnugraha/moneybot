import { pool } from './pool.js';
import { mapTransaction } from './mappers.js';
import type { ITransactionRepository, CreateTransactionInput } from '../../repositories/interfaces.js';
import type { Transaction } from '../../domain/entities.js';

export class NeonTransactionRepository implements ITransactionRepository {
  async create(input: CreateTransactionInput): Promise<Transaction> {
    const { rows } = await pool.query(
      `INSERT INTO transactions
        (user_id, type, amount, description, category_id, account_id,
         to_account_id, budget_code_id, date, notes,
         is_recurring_instance, recurring_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        input.userId,
        input.type,
        input.amount,
        input.description,
        input.categoryId ?? null,
        input.accountId,
        input.toAccountId ?? null,
        input.budgetCodeId ?? null,
        input.date,
        input.notes ?? null,
        input.isRecurringInstance ?? false,
        input.recurringId ?? null,
      ],
    );
    return mapTransaction(rows[0] as Record<string, unknown>);
  }

  async findByDateRange(userId: string, from: string, to: string): Promise<Transaction[]> {
    const { rows } = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id = $1 AND date BETWEEN $2 AND $3 AND deleted_at IS NULL
       ORDER BY date DESC, created_at DESC`,
      [userId, from, to],
    );
    return rows.map((r) => mapTransaction(r as Record<string, unknown>));
  }

  async findByAccountAndDateRange(
    userId: string,
    accountId: string,
    from: string,
    to: string,
  ): Promise<Transaction[]> {
    const { rows } = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id = $1 AND account_id = $2 AND date BETWEEN $3 AND $4 AND deleted_at IS NULL
       ORDER BY date DESC, created_at DESC`,
      [userId, accountId, from, to],
    );
    return rows.map((r) => mapTransaction(r as Record<string, unknown>));
  }

  async findLatestByUserId(userId: string, limit = 10): Promise<Transaction[]> {
    const { rows } = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY date DESC, created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => mapTransaction(r as Record<string, unknown>));
  }

  async findById(userId: string, transactionId: string): Promise<Transaction | null> {
    const { rows } = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 AND transaction_id = $2',
      [userId, transactionId],
    );
    return rows[0] ? mapTransaction(rows[0] as Record<string, unknown>) : null;
  }

  async update(
    userId: string,
    transactionId: string,
    patch: Partial<Transaction>,
  ): Promise<Transaction> {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [userId, transactionId];
    let i = 3;
    if (patch.amount !== undefined) { sets.push(`amount = $${i++}`); values.push(patch.amount); }
    if (patch.description !== undefined) { sets.push(`description = $${i++}`); values.push(patch.description); }
    if (patch.categoryId !== undefined) { sets.push(`category_id = $${i++}`); values.push(patch.categoryId); }
    if (patch.accountId !== undefined) { sets.push(`account_id = $${i++}`); values.push(patch.accountId); }
    if (patch.notes !== undefined) { sets.push(`notes = $${i++}`); values.push(patch.notes); }
    const { rows } = await pool.query(
      `UPDATE transactions SET ${sets.join(', ')} WHERE user_id = $1 AND transaction_id = $2 RETURNING *`,
      values,
    );
    return mapTransaction(rows[0] as Record<string, unknown>);
  }

  async softDelete(userId: string, transactionId: string): Promise<void> {
    await pool.query(
      'UPDATE transactions SET deleted_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND transaction_id = $2',
      [userId, transactionId],
    );
  }
}
