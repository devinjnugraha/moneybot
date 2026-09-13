import { pool } from './pool.js';
import { mapAccount } from './mappers.js';
import type { IAccountRepository, CreateAccountInput } from '../../repositories/interfaces.js';
import type { Account } from '../../domain/entities.js';

export class NeonAccountRepository implements IAccountRepository {
  async findAllByUserId(userId: string): Promise<Account[]> {
    const { rows } = await pool.query(
      'SELECT * FROM accounts WHERE user_id = $1 AND is_active = true ORDER BY created_at',
      [userId],
    );
    return rows.map((r) => mapAccount(r as Record<string, unknown>));
  }

  async findById(userId: string, accountId: string): Promise<Account | null> {
    const { rows } = await pool.query(
      'SELECT * FROM accounts WHERE user_id = $1 AND account_id = $2',
      [userId, accountId],
    );
    return rows[0] ? mapAccount(rows[0] as Record<string, unknown>) : null;
  }

  async findByName(userId: string, name: string): Promise<Account | null> {
    const { rows } = await pool.query(
      'SELECT * FROM accounts WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND is_active = true',
      [userId, name],
    );
    return rows[0] ? mapAccount(rows[0] as Record<string, unknown>) : null;
  }

  async create(input: CreateAccountInput): Promise<Account> {
    const { rows } = await pool.query(
      `INSERT INTO accounts (user_id, name, type, balance, credit_limit, billing_day, due_in_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.userId,
        input.name,
        input.type,
        input.openingBalance ?? 0,
        input.creditLimit ?? null,
        input.billingDay ?? null,
        input.dueInDays ?? 15,
      ],
    );
    return mapAccount(rows[0] as Record<string, unknown>);
  }

  async updateBalance(userId: string, accountId: string, delta: number): Promise<void> {
    await pool.query(
      `UPDATE accounts
       SET balance = balance + $3, updated_at = NOW()
       WHERE user_id = $1 AND account_id = $2`,
      [userId, accountId, delta],
    );
  }

  async update(userId: string, accountId: string, patch: Partial<Account>): Promise<Account> {
    const { rows } = await pool.query(
      `UPDATE accounts
       SET name = COALESCE($3, name),
           is_active = COALESCE($4, is_active),
           billing_day = COALESCE($5, billing_day),
           due_in_days = COALESCE($6, due_in_days),
           updated_at = NOW()
       WHERE user_id = $1 AND account_id = $2
       RETURNING *`,
      [
        userId, accountId,
        patch.name ?? null, patch.isActive ?? null,
        patch.billingDay ?? null, patch.dueInDays ?? null,
      ],
    );
    return mapAccount(rows[0] as Record<string, unknown>);
  }

  async ensureDefaultAccount(userId: string): Promise<Account> {
    // ON CONFLICT against the partial unique index (user_id WHERE is_default):
    // creates "Dompet" on first call, reactivates it if a prior accounts-mode
    // stretch deactivated it. Never renames or rebalances an existing default.
    const { rows } = await pool.query(
      `INSERT INTO accounts (user_id, name, type, is_default)
       VALUES ($1, 'Dompet', 'cash', true)
       ON CONFLICT (user_id) WHERE is_default
       DO UPDATE SET is_active = true, updated_at = NOW()
       RETURNING *`,
      [userId],
    );
    return mapAccount(rows[0] as Record<string, unknown>);
  }

  async findDefault(userId: string): Promise<Account | null> {
    const { rows } = await pool.query(
      'SELECT * FROM accounts WHERE user_id = $1 AND is_default = true',
      [userId],
    );
    return rows[0] ? mapAccount(rows[0] as Record<string, unknown>) : null;
  }
}
