import { pool } from '../../src/adapters/neon/pool.js';
import { randomUUID } from 'node:crypto';

/** Return a unique telegram chat ID for test isolation (no more hard-coded IDs). */
export function uniqueChatId(): string {
  return `test-${randomUUID()}`;
}

const USER_TABLES = [
  'session_contexts',
  'transactions',
  'budget_codes',
  'recurring_payments',
  'user_preferences',
  'accounts',
  'users',
];

/** Truncate all user-data tables. Categories and _migrations are preserved. */
export async function resetDb(): Promise<void> {
  // CASCADE handles FK ordering
  await pool.query(`TRUNCATE ${USER_TABLES.join(', ')} CASCADE`);
}

export { pool };
