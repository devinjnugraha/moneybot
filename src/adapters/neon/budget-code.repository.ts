import { pool } from './pool.js';
import { mapBudgetCode } from './mappers.js';
import type { IBudgetCodeRepository, CreateBudgetCodeInput } from '../../repositories/interfaces.js';
import type { BudgetCode } from '../../domain/entities.js';

export class NeonBudgetCodeRepository implements IBudgetCodeRepository {
  async findByUserAndMonth(userId: string, year: number, month: number): Promise<BudgetCode[]> {
    const { rows } = await pool.query(
      'SELECT * FROM budget_codes WHERE user_id = $1 AND year = $2 AND month = $3 ORDER BY name',
      [userId, year, month],
    );
    return rows.map((r) => mapBudgetCode(r as Record<string, unknown>));
  }

  async findByName(userId: string, name: string, year: number, month: number): Promise<BudgetCode | null> {
    const { rows } = await pool.query(
      `SELECT * FROM budget_codes
       WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND year = $3 AND month = $4`,
      [userId, name, year, month],
    );
    return rows[0] ? mapBudgetCode(rows[0] as Record<string, unknown>) : null;
  }

  async create(input: CreateBudgetCodeInput): Promise<BudgetCode> {
    const { rows } = await pool.query(
      `INSERT INTO budget_codes (user_id, name, monthly_budget, month, year, is_recurring, old_budget_id, rules)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [input.userId, input.name, input.monthlyBudget, input.month, input.year,
       input.isRecurring ?? false, input.oldBudgetId ?? null, input.rules ?? null],
    );
    return mapBudgetCode(rows[0] as Record<string, unknown>);
  }

  async incrementSpent(userId: string, budgetCodeId: string, delta: number): Promise<void> {
    await pool.query(
      `UPDATE budget_codes
       SET spent = spent + $3, updated_at = NOW()
       WHERE user_id = $1 AND budget_code_id = $2`,
      [userId, budgetCodeId, delta],
    );
  }

  async update(userId: string, budgetCodeId: string, patch: Partial<BudgetCode>): Promise<BudgetCode> {
    const { rows } = await pool.query(
      `UPDATE budget_codes
       SET name = COALESCE($3, name),
           monthly_budget = COALESCE($4, monthly_budget),
           -- rules: undefined (NULL param) keeps the value; '' clears it to NULL.
           rules = CASE WHEN $5::text = '' THEN NULL ELSE COALESCE($5, rules) END,
           updated_at = NOW()
       WHERE user_id = $1 AND budget_code_id = $2
       RETURNING *`,
      [userId, budgetCodeId, patch.name ?? null, patch.monthlyBudget ?? null, patch.rules ?? null],
    );
    return mapBudgetCode(rows[0] as Record<string, unknown>);
  }

  async delete(userId: string, budgetCodeId: string, name: string): Promise<{ stoppedRecurring: boolean }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Flip FIRST, inside the same tx as the DELETE: once no same-name row has
      // is_recurring=true, the daily sweep cannot recreate the budget. LOWER()
      // is a deliberate superset of the sweep's exact-name match —
      // UNIQUE(user_id, name, year, month) is case-sensitive, so differently
      // cased rows of the "same" budget can coexist across months.
      const flip = await client.query(
        `UPDATE budget_codes
         SET is_recurring = false, updated_at = NOW()
         WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND is_recurring = true`,
        [userId, name],
      );
      const del = await client.query(
        'DELETE FROM budget_codes WHERE user_id = $1 AND budget_code_id = $2',
        [userId, budgetCodeId],
      );
      if ((del.rowCount ?? 0) === 0) throw new Error(`budget_code ${budgetCodeId} not found for user`);
      await client.query('COMMIT');
      return { stoppedRecurring: (flip.rowCount ?? 0) > 0 };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async rollRecurringIntoMonth(userId: string, year: number, month: number): Promise<number> {
    const result = await pool.query(
      `INSERT INTO budget_codes (user_id, name, monthly_budget, month, year, is_recurring, spent, old_budget_id, rules)
       SELECT user_id, name, monthly_budget, $3, $2, true, 0, budget_code_id, rules
       FROM (
         SELECT DISTINCT ON (name) name, monthly_budget, budget_code_id, user_id, rules
         FROM budget_codes
         WHERE user_id = $1
           AND is_recurring = true
           AND (year < $2 OR (year = $2 AND month < $3))
         ORDER BY name, year DESC, month DESC
       ) AS src
       WHERE NOT EXISTS (
         SELECT 1 FROM budget_codes c
         WHERE c.user_id = $1 AND c.name = src.name AND c.year = $2 AND c.month = $3
       )`,
      [userId, year, month],
    );
    return result.rowCount ?? 0;
  }
}
