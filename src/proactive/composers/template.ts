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

interface BudgetThresholdData {
  codeId: string;
  name: string;
  spent: number;
  alloc: number;
  pct: number; // actual fraction (e.g. 0.82)
  level: number; // threshold level crossed (e.g. 80 or 100)
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

/** Deterministic budget-crossed nudge (design §9.2). Escalates at level 100. */
export function budgetThresholdTemplate(payload: ProactivePayload): string {
  const d = payload.data as unknown as BudgetThresholdData;
  const pct = Math.round(d.pct * 100);
  const over = d.level >= 100;
  const icon = over ? '🚨' : '⚠️';
  const tail = over ? ' — over budget!' : '';
  return `${icon} Budget '${d.name}' udah ${pct}% (${idr(d.spent)} / ${idr(d.alloc)})${tail}`;
}

/** Dispatch a template-channel payload to its formatter. */
export function templateCompose(payload: ProactivePayload): string {
  switch (payload.triggerType) {
    case 'scheduled_summary':
      return scheduledSummaryTemplate(payload);
    case 'budget_threshold':
      return budgetThresholdTemplate(payload);
    default:
      return '(tidak ada pesan)';
  }
}
