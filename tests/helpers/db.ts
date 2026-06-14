import { pool } from '../../src/adapters/neon/pool.js';

const USER_TABLES = [
  'session_contexts',
  'transactions',
  'budget_codes',
  'recurring_payments',
  'accounts',
  'users',
];

/** Truncate all user-data tables. Categories and _migrations are preserved. */
export async function resetDb(): Promise<void> {
  // CASCADE handles FK ordering
  await pool.query(`TRUNCATE ${USER_TABLES.join(', ')} CASCADE`);
}

export { pool };
