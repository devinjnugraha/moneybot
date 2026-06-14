import { migrate } from '../src/adapters/neon/migrate.js';
import { seed } from '../src/adapters/neon/seed.js';

export default async function globalSetup() {
  await migrate();
  await seed();
}
