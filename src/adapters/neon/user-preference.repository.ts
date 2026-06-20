import { pool } from './pool.js';
import { mapUserPreference } from './mappers.js';
import type { IUserPreferenceRepository } from '../../repositories/interfaces.js';
import type { UserPreference } from '../../domain/entities.js';

export class NeonUserPreferenceRepository implements IUserPreferenceRepository {
  async findAllByUserId(userId: string): Promise<UserPreference[]> {
    const { rows } = await pool.query(
      'SELECT * FROM user_preferences WHERE user_id = $1 ORDER BY key',
      [userId],
    );
    return rows.map((r) => mapUserPreference(r as Record<string, unknown>));
  }

  async upsert(userId: string, key: string, value: string): Promise<UserPreference> {
    const { rows } = await pool.query(
      `INSERT INTO user_preferences (user_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       RETURNING *`,
      [userId, key, value],
    );
    return mapUserPreference(rows[0] as Record<string, unknown>);
  }

  async delete(userId: string, key: string): Promise<void> {
    await pool.query(
      'DELETE FROM user_preferences WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
  }
}
