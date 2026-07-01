import type {
  User,
  UserStatus,
  Account,
  Transaction,
  BudgetCode,
  RecurringPayment,
  SessionContext,
  UserPreference,
} from '../../domain/entities.js';
import type { CoreMessage } from 'ai';

type Row = Record<string, unknown>;

function str(r: Row, k: string): string {
  return String(r[k]);
}
function num(r: Row, k: string): number {
  return Number(r[k]);
}
function bool(r: Row, k: string): boolean {
  return Boolean(r[k]);
}
function maybeStr(r: Row, k: string): string | undefined {
  const v = r[k];
  return v == null ? undefined : String(v);
}
function maybeNum(r: Row, k: string): number | undefined {
  const v = r[k];
  return v == null ? undefined : Number(v);
}

export function mapUser(r: Row): User {
  return {
    userId: str(r, 'user_id'),
    telegramChatId: str(r, 'telegram_chat_id'),
    name: str(r, 'name'),
    language: str(r, 'language') === 'en' ? 'en' : 'id',
    timezone: str(r, 'timezone'),
    status: str(r, 'status') as UserStatus,
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  };
}

export function mapAccount(r: Row): Account {
  return {
    accountId: str(r, 'account_id'),
    userId: str(r, 'user_id'),
    name: str(r, 'name'),
    type: str(r, 'type') as Account['type'],
    balance: num(r, 'balance'),
    creditLimit: maybeNum(r, 'credit_limit'),
    isActive: bool(r, 'is_active'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  };
}

export function mapTransaction(r: Row): Transaction {
  return {
    transactionId: str(r, 'transaction_id'),
    userId: str(r, 'user_id'),
    type: str(r, 'type') as Transaction['type'],
    amount: num(r, 'amount'),
    description: str(r, 'description'),
    categoryId: maybeStr(r, 'category_id'),
    accountId: str(r, 'account_id'),
    toAccountId: maybeStr(r, 'to_account_id'),
    budgetCodeId: maybeStr(r, 'budget_code_id'),
    date: str(r, 'date'),
    notes: maybeStr(r, 'notes'),
    isRecurringInstance: bool(r, 'is_recurring_instance'),
    recurringId: maybeStr(r, 'recurring_id'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
    deletedAt: maybeStr(r, 'deleted_at'),
  };
}

export function mapBudgetCode(r: Row): BudgetCode {
  return {
    budgetCodeId: str(r, 'budget_code_id'),
    userId: str(r, 'user_id'),
    name: str(r, 'name'),
    monthlyBudget: num(r, 'monthly_budget'),
    month: num(r, 'month'),
    year: num(r, 'year'),
    spent: num(r, 'spent'),
    isRecurring: bool(r, 'is_recurring'),
    oldBudgetId: maybeStr(r, 'old_budget_id'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  };
}

export function mapRecurringPayment(r: Row): RecurringPayment {
  return {
    recurringId: str(r, 'recurring_id'),
    userId: str(r, 'user_id'),
    name: str(r, 'name'),
    amount: num(r, 'amount'),
    accountId: str(r, 'account_id'),
    categoryId: str(r, 'category_id'),
    budgetCodeId: maybeStr(r, 'budget_code_id'),
    dayOfMonth: num(r, 'day_of_month'),
    isActive: bool(r, 'is_active'),
    lastFiredAt: maybeStr(r, 'last_fired_at'),
    nextFireAt: str(r, 'next_fire_at'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  };
}

export function mapSession(r: Row): SessionContext {
  const turns = (r['turns'] as CoreMessage[] | null) ?? [];
  const pending = r['pending_recurring_confirmation'] as
    | { recurringId: string; expiresAt: string }
    | null
    | undefined;
  return {
    chatId: str(r, 'chat_id'),
    userId: str(r, 'user_id'),
    turns,
    lastTransactionId: maybeStr(r, 'last_transaction_id'),
    pendingRecurringConfirmation: pending ?? undefined,
    lastActivityAt: str(r, 'last_activity_at'),
  };
}

export function mapUserPreference(r: Row): UserPreference {
  return {
    userId: str(r, 'user_id'),
    key: str(r, 'key'),
    value: str(r, 'value'),
    updatedAt: str(r, 'updated_at'),
  };
}
