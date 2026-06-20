-- Rename life.terea → life.tobacco (SRS §10 category taxonomy update)
-- Safe: no FK references to life.terea exist in dev; idempotent for prod.
DELETE FROM categories WHERE category_id = 'life.terea';
INSERT INTO categories (category_id, name, name_en, icon, type)
VALUES ('life.tobacco', 'Tembakau', 'Tobacco', '🚬', 'expense')
ON CONFLICT (category_id) DO NOTHING;
