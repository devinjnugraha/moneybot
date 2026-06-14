import { pool } from './pool.js';
import { CATEGORIES } from '../../domain/categories.js';
import { pathToFileURL } from 'node:url';

export async function seed(): Promise<void> {
  for (const c of CATEGORIES) {
    await pool.query(
      `INSERT INTO categories (category_id, name, name_en, parent_category_id, icon, type)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (category_id) DO NOTHING`,
      [c.categoryId, c.name, c.nameEn, c.parentCategoryId ?? null, c.icon, c.type],
    );
  }
  console.log(`[seed] ensured ${CATEGORIES.length} categories`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  seed()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
