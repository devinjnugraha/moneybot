/**
 * Normalize a free-text transaction description into a stable grouping key
 * (spec §2.3): trim → lowercase → truncate at the first punctuation → strip
 * digits & qty markers (2x, x2, 3pcs, 2 porsi …) → collapse whitespace.
 * Returns '' when nothing survives (digit-only / empty) — callers skip it.
 */
export function normalizeDescription(raw: string): string {
  let s = raw.trim().toLowerCase();
  const punct = s.search(/[.,;:!?)(-]/);
  if (punct > 0) s = s.slice(0, punct);
  s = s
    .replace(/\b\d+\s*(x|pcs|buah|cup|porsi|bks)\b/g, ' ')
    .replace(/\bx\s*\d+\b/g, ' ')
    .replace(/\d+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
