import { pool } from './pool.js';
import { mapUser } from './mappers.js';
import type { IUserRepository, CreateUserInput } from '../../repositories/interfaces.js';
import type { User } from '../../domain/entities.js';

export class NeonUserRepository implements IUserRepository {
  async findByTelegramChatId(chatId: string): Promise<User | null> {
    const { rows } = await pool.query('SELECT * FROM users WHERE telegram_chat_id = $1', [chatId]);
    return rows[0] ? mapUser(rows[0] as Record<string, unknown>) : null;
  }

  async findById(userId: string): Promise<User | null> {
    const { rows } = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    return rows[0] ? mapUser(rows[0] as Record<string, unknown>) : null;
  }

  async findAll(): Promise<User[]> {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at');
    return rows.map((r) => mapUser(r as Record<string, unknown>));
  }

  async create(input: CreateUserInput): Promise<User> {
    const { rows } = await pool.query(
      `INSERT INTO users (telegram_chat_id, name, language, timezone)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.telegramChatId, input.name, input.language ?? 'id', input.timezone ?? 'Asia/Jakarta'],
    );
    return mapUser(rows[0] as Record<string, unknown>);
  }

  async update(userId: string, patch: Partial<User>): Promise<User> {
    const { rows } = await pool.query(
      `UPDATE users
       SET name = COALESCE($2, name),
           language = COALESCE($3, language),
           timezone = COALESCE($4, timezone),
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [userId, patch.name ?? null, patch.language ?? null, patch.timezone ?? null],
    );
    return mapUser(rows[0] as Record<string, unknown>);
  }
}
