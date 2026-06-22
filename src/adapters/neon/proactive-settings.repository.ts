import { pool } from './pool.js';
import type { IProactiveSettingsRepository } from '../../repositories/interfaces.js';
import type { ProactiveSettings } from '../../domain/entities.js';

export class NeonProactiveSettingsRepository implements IProactiveSettingsRepository {
  async get(userId: string): Promise<ProactiveSettings> {
    const { rows } = await pool.query(
      'SELECT muted, resume_at FROM proactive_settings WHERE user_id = $1',
      [userId],
    );
    if (rows.length === 0) return { userId, muted: false };
    const row = rows[0] as { muted: boolean; resume_at: string | null };
    return {
      userId,
      muted: row.muted,
      resumeAt: row.resume_at ?? undefined,
    };
  }

  async setMuted(userId: string, muted: boolean, resumeAt?: Date): Promise<void> {
    await pool.query(
      `INSERT INTO proactive_settings (user_id, muted, resume_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         muted = EXCLUDED.muted,
         resume_at = EXCLUDED.resume_at,
         updated_at = NOW()`,
      [userId, muted, resumeAt ?? null],
    );
  }
}
