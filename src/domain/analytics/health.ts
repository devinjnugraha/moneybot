import type { CashflowSummary } from './cashflow.js';
import type { PacingResult } from './pacing.js';
import type { ObligationsResult } from './obligations.js';

export type HealthStatus = 'good' | 'warn' | 'bad' | 'insufficient_data' | 'not_applicable';

export type HealthComponentKey =
  | 'savings_rate' | 'budget_adherence' | 'bill_coverage' | 'runway' | 'leak_flags' | 'trend';

export interface HealthComponent {
  key: HealthComponentKey;
  label: string;
  value: number | null;
  display: string;
  status: HealthStatus;
  note?: string;
}

export interface HealthVerdict {
  month: string;
  asOf: string;
  score?: number;
  components: HealthComponent[];
}

export interface HealthInput {
  month: string;              // 'YYYY-MM' being judged
  asOf: string;               // 'YYYY-MM-DD' — today for the current month, month-end for past months
  trailingCashflow: CashflowSummary[]; // up to 3 FULL months BEFORE `month` (oldest→newest)
  pacing: PacingResult;       // for `month` (as-of `asOf`)
  obligations?: ObligationsResult;     // current month only; absent → not_applicable
  liquidBalance: number;
  currentExpense: number;     // `month`'s expense total (month-to-date when current)
  previousExpense: number;    // month-before-`month`'s expense total
  leakCount: number;          // spikes + recurring findings
}

/** Component thresholds (spec §2.2). */
const SAVINGS_GOOD_PCT = 20;
const ADHERENCE_GOOD_PCT = 80;
const ADHERENCE_WARN_PCT = 50;
const RUNWAY_GOOD_MONTHS = 3;
const RUNWAY_WARN_MONTHS = 1;
const TREND_WARN_PCT = 25;

/** Weights sum to 1.0 (spec §2.2). */
const WEIGHTS: Record<HealthComponentKey, number> = {
  savings_rate: 0.25, budget_adherence: 0.15, bill_coverage: 0.25,
  runway: 0.2, leak_flags: 0.05, trend: 0.1,
};
const POINTS: Record<'good' | 'warn' | 'bad', number> = { good: 100, warn: 50, bad: 0 };

/** Holistic verdict (spec §2.2): components degrade individually, never globally. */
export function healthVerdict(input: HealthInput): HealthVerdict {
  const components: HealthComponent[] = [];

  // savings_rate — mean savingsRate over trailing months that have income.
  const savingsMonths = input.trailingCashflow.filter((c) => c.income > 0 && c.savingsRate != null);
  if (savingsMonths.length === 0) {
    components.push({ key: 'savings_rate', label: 'Rasio tabungan', value: null, display: '—', status: 'insufficient_data', note: 'Belum ada bulan dengan pemasukan tercatat' });
  } else {
    const avg = Math.round(savingsMonths.reduce((s, c) => s + (c.savingsRate ?? 0), 0) / savingsMonths.length);
    const status: HealthStatus = avg >= SAVINGS_GOOD_PCT ? 'good' : avg >= 0 ? 'warn' : 'bad';
    components.push({ key: 'savings_rate', label: 'Rasio tabungan', value: avg, display: `${avg}%`, status, note: `rata-rata ${savingsMonths.length} bulan` });
  }

  // budget_adherence — % of budgets on track this month.
  const total = input.pacing.items.length;
  if (total === 0) {
    components.push({ key: 'budget_adherence', label: 'Kedisiplinan budget', value: null, display: '—', status: 'insufficient_data', note: 'Belum ada budget bulan ini' });
  } else {
    const onTrack = input.pacing.items.filter((p) => p.verdict === 'on_track').length;
    const pct = Math.round((onTrack / total) * 100);
    const status: HealthStatus = pct >= ADHERENCE_GOOD_PCT ? 'good' : pct >= ADHERENCE_WARN_PCT ? 'warn' : 'bad';
    components.push({ key: 'budget_adherence', label: 'Kedisiplinan budget', value: pct, display: `${onTrack}/${total} on track`, status });
  }

  // bill_coverage — forward-looking; only meaningful for the current month (spec §3.2).
  if (!input.obligations) {
    components.push({ key: 'bill_coverage', label: 'Cakupan tagihan 30 hari', value: null, display: '—', status: 'not_applicable', note: 'Hanya untuk bulan berjalan' });
  } else {
    const map = { covered: 'good', tight: 'warn', short: 'bad' } as const;
    components.push({
      key: 'bill_coverage', label: 'Cakupan tagihan 30 hari',
      value: input.obligations.totalDue,
      display: `${input.obligations.verdict} (${input.obligations.totalDue} vs ${input.obligations.liquidBalance})`,
      status: map[input.obligations.verdict],
    });
  }

  // runway — liquid balance ÷ avg monthly expense over trailing months with expense.
  const expenseMonths = input.trailingCashflow.filter((c) => c.expense > 0);
  if (expenseMonths.length === 0) {
    components.push({ key: 'runway', label: 'Dana darurat', value: null, display: '—', status: 'insufficient_data', note: 'Belum ada bulan penuh dengan pengeluaran' });
  } else {
    const avgExpense = expenseMonths.reduce((s, c) => s + c.expense, 0) / expenseMonths.length;
    const months = input.liquidBalance / avgExpense;
    const status: HealthStatus = months >= RUNWAY_GOOD_MONTHS ? 'good' : months >= RUNWAY_WARN_MONTHS ? 'warn' : 'bad';
    components.push({ key: 'runway', label: 'Dana darurat', value: Math.round(months * 10) / 10, display: `${months.toFixed(1)} bulan`, status });
  }

  // leak_flags — always scorable: 0 findings is itself a (good) verdict.
  const leakStatus: HealthStatus = input.leakCount >= 2 ? 'bad' : input.leakCount === 1 ? 'warn' : 'good';
  components.push({ key: 'leak_flags', label: 'Indikasi bocoran', value: input.leakCount, display: `${input.leakCount} temuan`, status: leakStatus });

  // trend — expense Δ% vs previous month.
  if (input.previousExpense <= 0 || input.currentExpense <= 0) {
    components.push({ key: 'trend', label: 'Tren pengeluaran', value: null, display: '—', status: 'insufficient_data', note: 'Butuh dua bulan dengan pengeluaran' });
  } else {
    const delta = Math.round(((input.currentExpense - input.previousExpense) / input.previousExpense) * 100);
    const status: HealthStatus = delta <= 0 ? 'good' : delta <= TREND_WARN_PCT ? 'warn' : 'bad';
    components.push({ key: 'trend', label: 'Tren pengeluaran', value: delta, display: `${delta >= 0 ? '+' : ''}${delta}% vs bulan lalu`, status });
  }

  // Weighted score over scorable components (guard: if none, no score).
  let weightSum = 0;
  let pointSum = 0;
  for (const c of components) {
    if (c.status !== 'good' && c.status !== 'warn' && c.status !== 'bad') continue;
    weightSum += WEIGHTS[c.key];
    pointSum += WEIGHTS[c.key] * POINTS[c.status];
  }
  const verdict: HealthVerdict = { month: input.month, asOf: input.asOf, components };
  if (weightSum > 0) verdict.score = Math.round(pointSum / weightSum);
  return verdict;
}
