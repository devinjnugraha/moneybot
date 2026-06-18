import type {
  User,
  Account,
  Transaction,
  BudgetCode,
  RecurringPayment,
  SessionContext,
  AccountType,
  TransactionType,
} from '../domain/entities.js';

// ---- Input types ----

export interface CreateUserInput {
  telegramChatId: string;
  name: string;
  language?: 'id' | 'en';
  timezone?: string;
}

export interface CreateAccountInput {
  userId: string;
  name: string;
  type: AccountType;
  creditLimit?: number;
  openingBalance?: number;
}

export interface CreateTransactionInput {
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
  isRecurringInstance?: boolean;
  recurringId?: string;
}

export interface CreateBudgetCodeInput {
  userId: string;
  name: string;
  monthlyBudget: number;
  month: number;
  year: number;
}

export interface CreateRecurringPaymentInput {
  userId: string;
  name: string;
  amount: number;
  accountId: string;
  categoryId: string;
  budgetCodeId?: string;
  dayOfMonth: number;
  nextFireAt: string;
}

export interface CreateTransferInput {
  userId: string;
  amount: number;
  fromAccountId: string;
  toAccountId: string;
  description: string;
  date: string;
  notes?: string;
}

// ---- Repository interfaces (SRS §7) ----

export interface IUserRepository {
  findByTelegramChatId(chatId: string): Promise<User | null>;
  findById(userId: string): Promise<User | null>;
  create(input: CreateUserInput): Promise<User>;
  update(userId: string, patch: Partial<User>): Promise<User>;
}

export interface IAccountRepository {
  findAllByUserId(userId: string): Promise<Account[]>;
  findById(userId: string, accountId: string): Promise<Account | null>;
  findByName(userId: string, name: string): Promise<Account | null>;
  create(input: CreateAccountInput): Promise<Account>;
  updateBalance(userId: string, accountId: string, delta: number): Promise<void>;
  update(userId: string, accountId: string, patch: Partial<Account>): Promise<Account>;
}

export interface ITransactionRepository {
  create(input: CreateTransactionInput): Promise<Transaction>;
  createTransfer(input: CreateTransferInput): Promise<Transaction>;
  findByDateRange(userId: string, from: string, to: string): Promise<Transaction[]>;
  findByAccountAndDateRange(
    userId: string,
    accountId: string,
    from: string,
    to: string,
  ): Promise<Transaction[]>;
  findLatestByUserId(userId: string, limit?: number): Promise<Transaction[]>;
  findById(userId: string, transactionId: string): Promise<Transaction | null>;
  update(userId: string, transactionId: string, patch: Partial<Transaction>): Promise<Transaction>;
  softDelete(userId: string, transactionId: string): Promise<void>;
}

export interface IBudgetCodeRepository {
  findByUserAndMonth(userId: string, year: number, month: number): Promise<BudgetCode[]>;
  findByName(userId: string, name: string, year: number, month: number): Promise<BudgetCode | null>;
  create(input: CreateBudgetCodeInput): Promise<BudgetCode>;
  incrementSpent(userId: string, budgetCodeId: string, delta: number): Promise<void>;
  update(userId: string, budgetCodeId: string, patch: Partial<BudgetCode>): Promise<BudgetCode>;
}

export interface IRecurringPaymentRepository {
  findAllByUserId(userId: string): Promise<RecurringPayment[]>;
  findByDayOfMonth(dayOfMonth: number): Promise<RecurringPayment[]>;
  findById(userId: string, recurringId: string): Promise<RecurringPayment | null>;
  findByName(userId: string, name: string): Promise<RecurringPayment | null>;
  create(input: CreateRecurringPaymentInput): Promise<RecurringPayment>;
  update(userId: string, recurringId: string, patch: Partial<RecurringPayment>): Promise<RecurringPayment>;
  deactivate(userId: string, recurringId: string): Promise<void>;
}

export interface ISessionRepository {
  get(chatId: string): Promise<SessionContext | null>;
  set(context: SessionContext): Promise<void>;
  delete(chatId: string): Promise<void>;
}

/** Slice-1 repos — what's implemented so far. */
export interface Slice1Repos {
  users: IUserRepository;
  accounts: IAccountRepository;
  transactions: ITransactionRepository;
  sessions: ISessionRepository;
}

export interface Repos {
  users: IUserRepository;
  accounts: IAccountRepository;
  transactions: ITransactionRepository;
  sessions: ISessionRepository;
  budgets: IBudgetCodeRepository;
  recurrings: IRecurringPaymentRepository;
}
