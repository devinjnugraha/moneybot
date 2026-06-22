import type { ProactivePayload } from '../types.js';

/** Format a number as IDR locale (dot thousands separator, no symbol). */
function idr(n: number): string {
  return n.toLocaleString('id-ID');
}

interface SummaryCategory {
  id: string;
  name: string;
  icon: string;
  amount: number;
}
interface SummaryBudget {
  name: string;
  spent: number;
  alloc: number;
  pct: number;
}
interface SummaryData {
  date: string;
  totalSpend: number;
  topCategories: SummaryCategory[];
  budgets: SummaryBudget[];
}

/** Deterministic LLM-fallback for the daily summary. */
export function scheduledSummaryTemplate(payload: ProactivePayload): string {
  const d = payload.data as unknown as SummaryData;
  const lines: string[] = [];
  lines.push(`📊 Ringkasan pengeluaran ${d.date}:`);
  lines.push(`Total: ${idr(d.totalSpend)}`);
  if (d.topCategories.length > 0) {
    lines.push('Top kategori:');
    for (const c of d.topCategories) lines.push(`${c.icon} ${c.name}: ${idr(c.amount)}`);
  }
  if (d.budgets.length > 0) {
    lines.push('Budget:');
    for (const b of d.budgets) {
      lines.push(`${b.name}: ${idr(b.spent)} / ${idr(b.alloc)} (${Math.round(b.pct * 100)}%)`);
    }
  }
  return lines.join('\n');
}

/** Dispatch a template-channel payload to its formatter. */
export function templateCompose(payload: ProactivePayload): string {
  switch (payload.triggerType) {
    case 'scheduled_summary':
      return scheduledSummaryTemplate(payload);
    default:
      return '(tidak ada pesan)';
  }
}
