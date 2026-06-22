import type { CoreMessage } from 'ai';

export type AccountType = 'cash' | 'bank' | 'card';
export type TransactionType = 'expense' | 'income' | 'transfer';

export interface User {
  userId: string;
  telegramChatId: string;
  name: string;
  language: 'id' | 'en';
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  accountId: string;
  userId: string;
  name: string;
  type: AccountType;
  balance: number;
  creditLimit?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  categoryId: string; // slug, e.g. 'food.dining'
  name: string;
  nameEn: string;
  parentCategoryId?: string;
  icon: string;
  type: 'expense' | 'income' | 'both';
}

export interface BudgetCode {
  budgetCodeId: string;
  userId: string;
  name: string;
  monthlyBudget: number;
  month: number; // 1–12
  year: number;
  spent: number;
  createdAt: string;
  updatedAt: string;
}

export interface Transaction {
  transactionId: string;
  userId: string;
  type: TransactionType;
  amount: number;
  description: string;
  categoryId?: string;
  accountId: string;
  toAccountId?: string;
  budgetCodeId?: string;
  date: string; // 'YYYY-MM-DD' (WIB)
  notes?: string;
  isRecurringInstance: boolean;
  recurringId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface RecurringPayment {
  recurringId: string;
  userId: string;
  name: string;
  amount: number;
  accountId: string;
  categoryId: string;
  budgetCodeId?: string;
  dayOfMonth: number;
  isActive: boolean;
  lastFiredAt?: string;
  nextFireAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserPreference {
  userId: string;
  key: string;
  value: string;
  updatedAt: string;
}

export interface SessionContext {
  chatId: string;
  userId: string;
  turns: CoreMessage[];
  lastTransactionId?: string;
  pendingRecurringConfirmation?: {
    recurringId: string;
    expiresAt: string;
  };
  lastActivityAt: string;
}

/**
 * Discriminated result returned by every write tool. Tools NEVER throw across
 * this boundary — the ReAct loop reads the status and continues. See design §5.
 */
export type WriteResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'missing_fields'; missing: string[]; options?: Record<string, unknown> }
  | { status: 'ambiguous'; field: string; matches: { id: string; label: string }[] }
  | { status: 'error'; message: string };

export type AccountResult = WriteResult<Account>;
export type TransactionResult = WriteResult<{
  transaction: Transaction;
  budget?: { spent: number; limit: number; exceeded: boolean };
}>;

// ---- Proactive outreach ----

export type ProactiveTriggerType =
  | 'scheduled_summary'
  | 'budget_threshold'
  | 'logging_gap'
  | 'anomaly';

export interface OutreachLogEntry {
  outreachId: string;
  userId: string;
  triggerType: ProactiveTriggerType;
  dedupKey: string;
  payload: unknown;
  sentAt: string; // ISO 8601
}

export interface ProactiveSettings {
  userId: string;
  muted: boolean;
  resumeAt?: string; // ISO 8601; undefined => mute until explicitly turned back on
}
