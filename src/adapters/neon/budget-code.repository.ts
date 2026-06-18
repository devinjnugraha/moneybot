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
      `INSERT INTO budget_codes (user_id, name, monthly_budget, month, year)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.userId, input.name, input.monthlyBudget, input.month, input.year],
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
           updated_at = NOW()
       WHERE user_id = $1 AND budget_code_id = $2
       RETURNING *`,
      [userId, budgetCodeId, patch.name ?? null, patch.monthlyBudget ?? null],
    );
    return mapBudgetCode(rows[0] as Record<string, unknown>);
  }
}
