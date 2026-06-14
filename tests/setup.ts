import { beforeEach } from 'vitest';
import { resetDb } from './helpers/db.js';

beforeEach(async () => {
  await resetDb();
});
