// Throwaway measurement: build the real system prompt (base + enrichment) and
// break down where the characters/tokens go. Run: npx tsx scripts/measure-prompt.ts
import { buildSystemPrompt, enrichSystemPrompt } from '../src/agent/system-prompt.js';
import { CATEGORIES } from '../src/domain/categories.js';

// Rough token estimate for Indonesian + emoji content on modern tokenizers:
// prose ≈ 3.2 chars/token, emoji-heavy taxonomy lines ≈ 2.6 chars/token.
const estTokens = (s: string, ratio = 3.2) => Math.round(s.length / ratio);

const base = buildSystemPrompt('Senin, 22 September 2026');

// Realistic enrichment payload: 2 prefs, 3 accounts, 3 budgets (one with rules),
// simple mode ON (worst case — appends the MODE SEDERHANA block).
const enriched = enrichSystemPrompt(base, {
	preferences: [
		{ userId: 'u1', key: 'salim_pref', value: 'nama panggilan: Sal', updatedAt: '' },
		{ userId: 'u1', key: 'report_style', value: 'ringkas tanpa tabel', updatedAt: '' },
	],
	accounts: [
		{ accountId: '01H9AAAAAA', userId: 'u1', name: 'Dompet', type: 'cash', balance: 250000, isDefault: true, isActive: true, createdAt: '', updatedAt: '' },
		{ accountId: '01H9BBBBBB', userId: 'u1', name: 'BCA', type: 'bank', balance: 5000000, isDefault: false, isActive: true, createdAt: '', updatedAt: '' },
		{ accountId: '01H9CCCCCC', userId: 'u1', name: 'Kartu Kredit', type: 'card', balance: -300000, isDefault: false, isActive: true, billingDay: 5, createdAt: '', updatedAt: '' },
	] as never[],
	budgets: [
		{ budgetCodeId: '01H9DDDDDD', userId: 'u1', name: 'Terea', monthlyBudget: 300000, month: 9, year: 2026, spent: 0, isRecurring: true, rules: 'semua expense yang menyebut terea', createdAt: '', updatedAt: '' },
		{ budgetCodeId: '01H9EEEEEE', userId: 'u1', name: 'Makan di luar', monthlyBudget: 500000, month: 9, year: 2026, spent: 0, isRecurring: false, createdAt: '', updatedAt: '' },
		{ budgetCodeId: '01H9FFFFFF', userId: 'u1', name: 'Bensin', monthlyBudget: 200000, month: 9, year: 2026, spent: 0, isRecurring: true, createdAt: '', updatedAt: '' },
	] as never[],
	accountsEnabled: false,
});

const report = (label: string, s: string, ratio?: number) =>
	console.log(`${label.padEnd(34)} ${String(s.length).padStart(7)} chars  ~${String(estTokens(s, ratio ?? 3.2)).padStart(5)} tok`);

console.log('=== BASE PROMPT sections ===');
const headerRe = /^[A-Z][A-Z &]+:$/gm;
const headers = [...base.matchAll(headerRe)].map((m) => m.index ?? 0);
for (let i = 0; i < headers.length; i++) {
	const start = headers[i]!;
	const end = i + 1 < headers.length ? headers[i + 1]! : base.length;
	// section = header line + body until the next header line
	const chunk = base.slice(start, end).trimEnd();
	report(chunk.split('\n', 1)[0]!, chunk);
}
report('BASE TOTAL', base);

console.log('\n=== ENRICHMENT (realistic worst case) ===');
report('enriched TOTAL', enriched);
report('=> enrichment delta', enriched.slice(base.length), 3.0);

console.log('\n=== CATEGORY TAXONOMY detail ===');
const taxonomyBlock = CATEGORIES.map((c) => `- ${c.categoryId} ${c.icon} — ${c.name} (${c.nameEn})`).join('\n');
const withoutEn = CATEGORIES.map((c) => `- ${c.categoryId} ${c.icon} ${c.name}`).join('\n');
const idOnly = CATEGORIES.map((c) => `- ${c.categoryId}`).join('\n');
report('current (id icon — name (nameEn))', taxonomyBlock, 2.6);
report('slim (id icon name)', withoutEn, 2.6);
report('ids only (for comparison)', idOnly, 2.6);
console.log(`categories: ${CATEGORIES.length}, emoji count: ${[...taxonomyBlock].filter((ch) => /\p{Extended_Pictographic}/u.test(ch)).length}`);

console.log(`\nGRAND TOTAL (enriched): ${enriched.length} chars ≈ ${estTokens(enriched, 3.0)} tokens (estimate)`);
