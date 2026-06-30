import type { ProactivePayload } from '../types.js';

/** Format a number as IDR locale (dot thousands separator, no symbol). */
function idr(n: number): string {
  return n.toLocaleString('id-ID');
}

/**
 * Render a deterministic range bar for a budget fraction. Glyphs (|, em-dash,
 * bullet) are wrapped in backticks so Telegram renders the span monospace and
 * bars align across lines. `pct` is a fraction (0..N; values >1 clamp the
 * bullet at the right edge). `width` is the inner cell count (default 10).
 */
export function renderBudgetBar(pct: number, width = 10): string {
  const left = Math.min(width, Math.max(0, Math.round(pct * width)));
  const right = width - left;
  return '`|' + '—'.repeat(left) + '•' + '—'.repeat(right) + '|`';
}

interface MGAccount {
  name: string;
  balance: number;
}

/** Render active-account balances as a guaranteed bullet list. '' when empty. */
export function renderAccountList(balances: readonly MGAccount[]): string {
  if (balances.length === 0) return '';
  const lines = balances.map((b) => `• ${b.name} ${idr(b.balance)}`);
  return `🏦 Saldo\n${lines.join('\n')}`;
}

interface MGBudget {
  name: string;
  spent: number;
  alloc: number;
  remaining: number;
  pct: number; // fraction 0..N (may exceed 1)
}
const BUDGET_CAP = 3;

/** Render per-code budget lines (spent/alloc · remaining · pct + bar), capped. */
export function renderBudgetBlock(budgets: readonly MGBudget[]): string {
  if (budgets.length === 0) return '';
  const shown = budgets.slice(0, BUDGET_CAP);
  const lines = shown.map((b) => {
    const pct = Math.round(b.pct * 100);
    const prefix = b.pct > 1 ? '🚨 ' : '';
    return `${prefix}${b.name} ${idr(b.spent)}/${idr(b.alloc)} · sisa ${idr(b.remaining)} · ${pct}% ${renderBudgetBar(b.pct)}`;
  });
  if (budgets.length > BUDGET_CAP) lines.push(`+${budgets.length - BUDGET_CAP} lainnya`);
  return `📊 Budget\n${lines.join('\n')}`;
}

interface MGUpcoming {
  name: string;
  amount: number;
  account: string;
  dueDate: string;
}
interface MGDue {
  name: string;
  amount: number;
  account: string;
}
const UPCOMING_CAP = 3;

/** Render this week's upcoming bills as bullets, capped. '' when empty. */
export function renderUpcoming(upcoming: readonly MGUpcoming[]): string {
  if (upcoming.length === 0) return '';
  const shown = upcoming.slice(0, UPCOMING_CAP);
  const lines = shown.map((u) => `• ${u.name} — ${idr(u.amount)} via ${u.account} (${u.dueDate})`);
  if (upcoming.length > UPCOMING_CAP) lines.push(`+${upcoming.length - UPCOMING_CAP} lainnya`);
  return `📅 Tagihan minggu ini\n${lines.join('\n')}`;
}

/** Render today's due bills as bullets (name + amount + account). '' when empty. */
export function renderTodayDue(todayDueBills: readonly MGDue[]): string {
  if (todayDueBills.length === 0) return '';
  const lines = todayDueBills.map((b) => `• ${b.name} — ${idr(b.amount)} via ${b.account}`);
  return `Jatuh tempo hari ini\n${lines.join('\n')}`;
}

/** Fixed pointer to the inline due-bill keyboard; shared by the LLM path and fallback. */
export const MORNING_GLANCE_DUE_CTA = 'Tagihan hari ini tinggal dipencet di bawah ya 👇';

/**
 * Assemble the deterministic morning-glance block from a payload's data:
 * saldo → budget → upcoming → todayDue, empty sections omitted, joined by blank
 * lines. Returns '' when all sections are empty. Used by both the LLM composer
 * path and the template fallback so the structured block is identical.
 */
export function renderMorningGlanceBlock(payload: ProactivePayload): string {
  const d = payload.data as {
    balances?: MGAccount[];
    budgets?: MGBudget[];
    upcoming?: MGUpcoming[];
    todayDueBills?: MGDue[];
  };
  return [
    renderAccountList(d.balances ?? []),
    renderBudgetBlock(d.budgets ?? []),
    renderUpcoming(d.upcoming ?? []),
    renderTodayDue(d.todayDueBills ?? []),
  ]
    .filter(Boolean)
    .join('\n\n');
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

interface LoggingGapData {
  gapDays: number;
  lastDate: string; // 'YYYY-MM-DD'
}

interface AnomalyCategory {
  category: string;
  name: string;
  icon: string;
  thisWeek: number;
  avg: number;
}
interface AnomalyData {
  week: string;
  flagged: AnomalyCategory[];
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

/** Deterministic logging-gap nudge (design §9.3). */
export function loggingGapTemplate(payload: ProactivePayload): string {
  const d = payload.data as unknown as LoggingGapData;
  return `Halo, ${d.gapDays} hari ga ada catatan pengeluaran. Mau aku bantu catat sesuatu?`;
}

/** Deterministic LLM-fallback for the weekly anomaly insight (design §9.4). */
export function anomalyTemplate(payload: ProactivePayload): string {
  const d = payload.data as unknown as AnomalyData;
  const lines = ['🚨 Pengeluaran minggu ini lebih tinggi dari biasanya:'];
  for (const c of d.flagged) {
    lines.push(`${c.icon} ${c.name}: ${idr(c.thisWeek)} (rata-rata ${idr(c.avg)})`);
  }
  return lines.join('\n');
}

/**
 * Deterministic LLM-fallback for the morning glance. Renders the same structured
 * block the LLM path appends, plus a deterministic greeting, a yesterday line
 * (no LLM here), and the due-bill CTA when there are bills due today.
 */
export function morningGlanceTemplate(payload: ProactivePayload): string {
  const d = payload.data as {
    yesterday?: { count: number; totalSpend: number } | null;
    todayDueBills?: unknown[];
  };
  const parts: string[] = ['🌅 Pagi!'];
  parts.push(
    d.yesterday
      ? `Kemarin: ${d.yesterday.count} catatan, total ${idr(d.yesterday.totalSpend)}.`
      : 'Kemarin belum ada catatan — ada yang mau diinput?',
  );
  const block = renderMorningGlanceBlock(payload);
  if (block) parts.push(block);
  if ((d.todayDueBills ?? []).length > 0) parts.push(MORNING_GLANCE_DUE_CTA);
  return parts.join('\n\n');
}

/** Dispatch a template-channel payload to its formatter. */
export function templateCompose(payload: ProactivePayload): string {
  switch (payload.triggerType) {
    case 'scheduled_summary':
      return scheduledSummaryTemplate(payload);
    case 'budget_threshold':
      return budgetThresholdTemplate(payload);
    case 'logging_gap':
      return loggingGapTemplate(payload);
    case 'anomaly':
      return anomalyTemplate(payload);
    case 'morning_glance':
      return morningGlanceTemplate(payload);
    default:
      return '(tidak ada pesan)';
  }
}
