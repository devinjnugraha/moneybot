import { tool, type CoreTool } from 'ai';
import { z } from 'zod';
import type { Repos } from '../repositories/interfaces.js';
import type { AccountResult, TransactionResult, Transaction } from '../domain/entities.js';
import { CATEGORIES } from '../domain/categories.js';
import { todayWIB, wibMonth, wibYear, nextFireDate } from '../domain/time.js';
import { logEvent } from '../utils/logger.js';

export interface BuildToolsArgs {
  userId: string;
  repos: Repos;
  hasAccount: boolean;
  lastTransactionId?: string;
}

/** Core expense-creation logic shared by T06 create_expense and the
 *  Slice 4 callback handler (confirm). All IDs must be pre-resolved. */
export async function createExpenseCore(params: {
  userId: string;
  amount: number;
  description: string;
  categoryId: string;
  accountId: string;
  budgetCodeId?: string;
  date: string;
  isRecurringInstance?: boolean;
  recurringId?: string;
  repos: Repos;
}): Promise<TransactionResult> {
  try {
    const transaction = await params.repos.transactions.create({
      userId: params.userId,
      type: 'expense',
      amount: params.amount,
      description: params.description,
      categoryId: params.categoryId,
      accountId: params.accountId,
      budgetCodeId: params.budgetCodeId,
      date: params.date,
      isRecurringInstance: params.isRecurringInstance,
      recurringId: params.recurringId,
    });

    await params.repos.accounts.updateBalance(params.userId, params.accountId, -params.amount);

    let budget: { spent: number; limit: number; exceeded: boolean } | undefined;
    if (params.budgetCodeId) {
      await params.repos.budgets.incrementSpent(params.userId, params.budgetCodeId, params.amount);
      const allBudgets = await params.repos.budgets.findByUserAndMonth(
        params.userId,
        wibYear(),
        wibMonth(),
      );
      const bc = allBudgets.find((b) => b.budgetCodeId === params.budgetCodeId);
      if (bc) {
        budget = { spent: bc.spent, limit: bc.monthlyBudget, exceeded: bc.spent > bc.monthlyBudget };
      }
    }

    return { status: 'ok', data: { transaction, budget } };
  } catch (e) {
    logEvent('error', 'createExpenseCore failed', { userId: params.userId, error: (e as Error).message });
    return { status: 'error', message: 'Gagal mencatat pengeluaran. Coba lagi.' } as TransactionResult;
  }
}

export function buildTools({ userId, repos, hasAccount, lastTransactionId }: BuildToolsArgs) {
  // CoreTool is the AI SDK's broad tool type; tool() returns a compatible object.
  // We type the container once so the orchestrator's RunAgentArgs.tools matches.
  const tools = {} as Record<string, CoreTool>;

  tools.create_account = tool({
    description: 'Buat akun baru (cash/bank/card). Wajib untuk card: creditLimit.',
    parameters: z.object({
      name: z.string().describe('Nama akun, mis. "BCA", "BCA CC", "Cash"'),
      type: z.enum(['cash', 'bank', 'card']),
      creditLimit: z.number().positive().optional(),
      openingBalance: z.number().optional(),
    }),
    execute: async ({ name, type, creditLimit, openingBalance }) => {
      if (type === 'card' && (creditLimit === undefined || creditLimit <= 0)) {
        const res: AccountResult = { status: 'missing_fields', missing: ['creditLimit'] };
        return res;
      }
      try {
        const account = await repos.accounts.create({
          userId,
          name,
          type,
          creditLimit,
          openingBalance,
        });
        const res: AccountResult = { status: 'ok', data: account };
        return res;
      } catch (e) {
        logEvent('error', 'create_account failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal membuat akun. Coba lagi.' } as AccountResult;
      }
    },
  });

  // Read tools are ALWAYS available: SRS SP-02 makes get_accounts an
  // unconditional rule ("Always verify via get_accounts…"), so it must be
  // registered even during onboarding — otherwise the model obeys SP-02 and
  // calls an unregistered tool → AI SDK NoSuchToolError. Returns [] for a user
  // with no accounts, which the model uses to prompt account creation (FR-01).
  tools.get_accounts = tool({
    description: 'Daftar semua akun user beserta saldo saat ini.',
    parameters: z.object({}),
    execute: async () => {
      const accounts = await repos.accounts.findAllByUserId(userId);
      return accounts.map((a) => ({
        accountId: a.accountId,
        name: a.name,
        type: a.type,
        balance: a.balance,
        creditLimit: a.creditLimit,
      }));
    },
  });

  tools.get_categories = tool({
    description: 'Daftar semua kategori sistem (pengeluaran & pemasukan).',
    parameters: z.object({}),
    execute: async () => {
      return CATEGORIES.map((c) => ({
        categoryId: c.categoryId,
        name: c.name,
        nameEn: c.nameEn,
        icon: c.icon,
        type: c.type,
      }));
    },
  });

  tools.get_budget_codes = tool({
    description: 'Daftar budget codes user untuk bulan/tahun tertentu. Default: bulan ini (WIB).',
    parameters: z.object({
      month: z.number().int().min(1).max(12).optional(),
      year: z.number().int().positive().optional(),
    }),
    execute: async ({ month, year }) => {
      const m = month ?? wibMonth();
      const y = year ?? wibYear();
      const codes = await repos.budgets.findByUserAndMonth(userId, y, m);
      return codes.map((c) => ({
        budgetCodeId: c.budgetCodeId,
        name: c.name,
        monthlyBudget: c.monthlyBudget,
        spent: c.spent,
      }));
    },
  });

  tools.get_transactions = tool({
    description: 'Cari transaksi berdasarkan rentang tanggal. Bisa filter opsional: accountId, categoryId, type, limit.',
    parameters: z.object({
      fromDate: z.string().describe('YYYY-MM-DD'),
      toDate: z.string().describe('YYYY-MM-DD'),
      accountId: z.string().optional(),
      categoryId: z.string().optional(),
      type: z.enum(['expense', 'income', 'transfer']).optional(),
      limit: z.number().int().positive().optional(),
    }),
    execute: async ({ fromDate, toDate, accountId, categoryId, type, limit }) => {
      let rows;
      if (accountId) {
        rows = await repos.transactions.findByAccountAndDateRange(userId, accountId, fromDate, toDate);
      } else {
        rows = await repos.transactions.findByDateRange(userId, fromDate, toDate);
      }
      if (categoryId) rows = rows.filter((t) => t.categoryId === categoryId);
      if (type) rows = rows.filter((t) => t.type === type);
      if (limit) rows = rows.slice(0, limit);
      return rows.map((t) => ({
        transactionId: t.transactionId,
        type: t.type,
        amount: t.amount,
        description: t.description,
        categoryId: t.categoryId,
        accountId: t.accountId,
        date: t.date,
        notes: t.notes,
      }));
    },
  });

  tools.get_recurring_payments = tool({
    description: 'Daftar semua recurring payment yang masih aktif.',
    parameters: z.object({}),
    execute: async () => {
      const recurrings = await repos.recurrings.findAllByUserId(userId);
      return recurrings.map((r) => ({
        recurringId: r.recurringId,
        name: r.name,
        amount: r.amount,
        accountId: r.accountId,
        categoryId: r.categoryId,
        dayOfMonth: r.dayOfMonth,
        nextFireAt: r.nextFireAt,
      }));
    },
  });

  tools.get_account_balance = tool({
    description: 'Cek saldo satu akun (via accountId) atau semua akun.',
    parameters: z.object({
      accountId: z.string().optional(),
    }),
    execute: async ({ accountId }) => {
      if (accountId) {
        const acc = await repos.accounts.findById(userId, accountId);
        if (!acc) return [];
        return { accountId: acc.accountId, name: acc.name, balance: acc.balance };
      }
      const all = await repos.accounts.findAllByUserId(userId);
      return all.map((a) => ({ accountId: a.accountId, name: a.name, balance: a.balance }));
    },
  });

  tools.get_report = tool({
    description:
      'Laporan agregat pengeluaran/pemasukan untuk rentang tanggal. ' +
      'Bisa dikelompokkan per kategori atau budget code, atau difilter ke budget code tertentu. ' +
      'Transfer SELALU dikecualikan dari laporan (FR-10e).',
    parameters: z.object({
      from: z.string().describe('YYYY-MM-DD (WIB), inklusif.'),
      to: z.string().describe('YYYY-MM-DD (WIB), inklusif.'),
      type: z.enum(['expense', 'income']).optional().default('expense'),
      groupBy: z.enum(['category', 'budget']).optional(),
      budgetCodeId: z.string().optional().describe('Filter ke satu budget code (untuk drill-down).'),
    }),
    execute: async ({ from, to, type, groupBy, budgetCodeId }) => {
      const rows = await repos.transactions.findByDateRange(userId, from, to);

      // Filter: exclude transfers + soft-deleted (findByDateRange already
      // filters deleted_at IS NULL), match type, optionally by budgetCodeId.
      const filtered = rows.filter((t) => {
        if (t.type !== type) return false;
        if (budgetCodeId && t.budgetCodeId !== budgetCodeId) return false;
        return true;
      });

      const total = filtered.reduce((sum, t) => sum + t.amount, 0);
      const count = filtered.length;

      // When filtering by budgetCodeId, default to category grouping so the
      // response includes a per-category breakdown of that budget.
      const effectiveGroupBy = groupBy ?? (budgetCodeId ? 'category' : undefined);

      if (!effectiveGroupBy) {
        return { total, count, groups: undefined };
      }

      // Aggregate by groupKey
      const groups = new Map<string, { total: number; count: number }>();
      for (const t of filtered) {
        const key = effectiveGroupBy === 'category'
          ? (t.categoryId ?? '__uncategorized__')
          : (t.budgetCodeId ?? '__none__');
        const g = groups.get(key) ?? { total: 0, count: 0 };
        g.total += t.amount;
        g.count += 1;
        groups.set(key, g);
      }

      // Build result array sorted by total descending
      const categoryMap = new Map(CATEGORIES.map((c) => [c.categoryId, c]));
      const budgetMap = effectiveGroupBy === 'budget'
        ? new Map(
            (await repos.budgets.findByUserAndMonth(
              userId,
              Number(from.slice(0, 4)),
              Number(from.slice(5, 7)),
            )).map((b) => [b.budgetCodeId, b]),
          )
        : new Map();

      const result = Array.from(groups.entries())
        .map(([groupKey, g]) => {
          let label: string;
          let icon: string | undefined;
          if (effectiveGroupBy === 'category') {
            const cat = groupKey !== '__uncategorized__' ? categoryMap.get(groupKey) : undefined;
            label = cat?.name ?? 'Tanpa Kategori';
            icon = cat?.icon;
          } else {
            const bc = groupKey !== '__none__' ? budgetMap.get(groupKey) : undefined;
            label = bc?.name ?? 'Tanpa Budget';
            icon = undefined;
          }
          return {
            groupKey,
            label,
            icon,
            total: g.total,
            percentage: total > 0 ? Math.round((g.total / total) * 100) : 0,
            count: g.count,
          };
        })
        .sort((a, b) => b.total - a.total);

      return { total, count, groups: result };
    },
  });

  // Gate only WRITE tools behind onboarding: no account yet → create_account +
  // get_accounts only.
  if (!hasAccount) return tools;

  const expenseSchema = z.object({
    description: z.string(),
    amount: z.number().positive(),
    accountId: z.string().describe('Bisa nama akun (mis. "bca") atau accountId. Resolve via get_accounts.'),
    categoryId: z.string(),
    budgetCodeId: z.string().optional(),
    date: z.string().optional().describe('YYYY-MM-DD (WIB). Default: hari ini.'),
  });

  tools.create_expense = tool({
    description: 'Catat pengeluaran. Resolve accountId via get_accounts bila ragu.',
    parameters: expenseSchema,
    execute: async ({ description, amount, accountId, categoryId, budgetCodeId, date }) => {
      // Resolve account: accept accountId or account name
      let account = await repos.accounts.findById(userId, accountId);
      if (!account) account = await repos.accounts.findByName(userId, accountId);
      if (!account) {
        const all = await repos.accounts.findAllByUserId(userId);
        return { status: 'ambiguous', field: 'accountId', matches: all.map((a) => ({ id: a.accountId, label: a.name })) } as TransactionResult;
      }

      // FR-03c: if budgetCodeId is a name (not UUID), resolve it
      let resolvedBudgetCodeId = budgetCodeId;
      if (budgetCodeId && !/^[0-9a-f-]{36}$/.test(budgetCodeId)) {
        const existing = await repos.budgets.findByName(userId, budgetCodeId, wibYear(), wibMonth());
        if (existing) {
          resolvedBudgetCodeId = existing.budgetCodeId;
        } else {
          return { status: 'missing_fields', missing: ['budgetCodeId'], options: { monthlyBudget: null } } as TransactionResult;
        }
      }

      return createExpenseCore({
        userId, amount, description, categoryId,
        accountId: account.accountId,
        budgetCodeId: resolvedBudgetCodeId,
        date: date ?? todayWIB(),
        repos,
      });
    },
  });

  tools.create_income = tool({
    description: 'Catat pemasukan. Mirip create_expense tapi saldo bertambah.',
    parameters: z.object({
      description: z.string(),
      amount: z.number().positive(),
      accountId: z.string().describe('Bisa nama akun atau accountId.'),
      categoryId: z.string(),
      budgetCodeId: z.string().optional(),
      date: z.string().optional().describe('YYYY-MM-DD (WIB). Default: hari ini.'),
    }),
    execute: async ({ description, amount, accountId, categoryId, budgetCodeId, date }) => {
      try {
        let account = await repos.accounts.findById(userId, accountId);
        if (!account) account = await repos.accounts.findByName(userId, accountId);
        if (!account) {
          const all = await repos.accounts.findAllByUserId(userId);
          const res: TransactionResult = {
            status: 'ambiguous',
            field: 'accountId',
            matches: all.map((a) => ({ id: a.accountId, label: a.name })),
          };
          return res;
        }

        const transaction = await repos.transactions.create({
          userId,
          type: 'income',
          amount,
          description,
          categoryId,
          accountId: account.accountId,
          budgetCodeId,
          date: date ?? todayWIB(),
        });

        await repos.accounts.updateBalance(userId, account.accountId, amount);

        const res: TransactionResult = { status: 'ok', data: { transaction } };
        return res;
      } catch (e) {
        logEvent('error', 'create_income failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal mencatat pemasukan. Coba lagi.' } as TransactionResult;
      }
    },
  });

  tools.create_transfer = tool({
    description: 'Pindahkan saldo antar dua akun. Bukan pemasukan atau pengeluaran — hanya perpindahan. Tidak pakai categoryId.',
    parameters: z.object({
      fromAccountId: z.string().describe('Akun sumber (nama atau accountId).'),
      toAccountId: z.string().describe('Akun tujuan (nama atau accountId).'),
      amount: z.number().positive(),
      description: z.string(),
      date: z.string().optional().describe('YYYY-MM-DD (WIB). Default: hari ini.'),
      notes: z.string().optional(),
    }),
    execute: async ({ fromAccountId, toAccountId, amount, description, date, notes }) => {
      try {
        let fromAccount = await repos.accounts.findById(userId, fromAccountId);
        if (!fromAccount) fromAccount = await repos.accounts.findByName(userId, fromAccountId);
        if (!fromAccount) {
          const all = await repos.accounts.findAllByUserId(userId);
          const res: TransactionResult = {
            status: 'ambiguous',
            field: 'fromAccountId',
            matches: all.map((a) => ({ id: a.accountId, label: a.name })),
          };
          return res;
        }

        let toAccount = await repos.accounts.findById(userId, toAccountId);
        if (!toAccount) toAccount = await repos.accounts.findByName(userId, toAccountId);
        if (!toAccount) {
          const all = await repos.accounts.findAllByUserId(userId);
          const res: TransactionResult = {
            status: 'ambiguous',
            field: 'toAccountId',
            matches: all.map((a) => ({ id: a.accountId, label: a.name })),
          };
          return res;
        }

        if (fromAccount.accountId === toAccount.accountId) {
          return { status: 'error', message: 'Akun sumber dan tujuan sama.' } as TransactionResult;
        }

        const transaction = await repos.transactions.createTransfer({
          userId,
          amount,
          fromAccountId: fromAccount.accountId,
          toAccountId: toAccount.accountId,
          description,
          date: date ?? todayWIB(),
          notes,
        });

        const res: TransactionResult = { status: 'ok', data: { transaction } };
        return res;
      } catch (e) {
        logEvent('error', 'create_transfer failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal mencatat transfer. Coba lagi.' } as TransactionResult;
      }
    },
  });

  tools.update_transaction = tool({
    description:
      'Koreksi transaksi: ubah amount, description, categoryId, accountId, atau notes. ' +
      'Kalau user bilang "koreksi tadi", pakai lastTransactionId dari konteks — tidak perlu minta transactionId.',
    parameters: z.object({
      transactionId: z.string().optional(),
      amount: z.number().positive().optional(),
      description: z.string().optional(),
      categoryId: z.string().optional(),
      accountId: z.string().optional(),
      notes: z.string().optional(),
    }),
    execute: async (args) => {
      try {
        // FR-08: transactionId from model arg > lastTransactionId (from closure) > missing
        const a = args as { transactionId?: string; amount?: number; description?: string; categoryId?: string; accountId?: string; notes?: string };
        const transactionId = a.transactionId ?? lastTransactionId;
        if (!transactionId) {
          return { status: 'missing_fields', missing: ['transactionId'] } as TransactionResult;
        }

        // Fetch the current record (findById filters deleted_at IS NULL, so a
        // soft-deleted txn is treated as not found).
        const existing = await repos.transactions.findById(userId, transactionId);
        if (!existing) {
          return { status: 'error', message: 'Transaksi tidak ditemukan.' } as TransactionResult;
        }

        const patch: Record<string, unknown> = {};
        if (a.amount !== undefined) patch.amount = a.amount;
        if (a.description !== undefined) patch.description = a.description;
        if (a.categoryId !== undefined) patch.categoryId = a.categoryId;
        if (a.accountId !== undefined) patch.accountId = a.accountId;
        if (a.notes !== undefined) patch.notes = a.notes;

        // FR-08 step 6: reconcile account balance when amount or accountId changes.
        // Only expense/income affect a single account's balance (transfers move
        // between two accounts and are not correctable through this tool).
        const newAmount = a.amount ?? existing.amount;
        const newAccountId = a.accountId ?? existing.accountId;
        const amountChanged = a.amount !== undefined && a.amount !== existing.amount;
        const accountChanged = a.accountId !== undefined && a.accountId !== existing.accountId;
        const balanceRelevant = existing.type === 'expense' || existing.type === 'income';
        if (balanceRelevant && (amountChanged || accountChanged)) {
          // signed effect of recording: expense → -amount, income → +amount
          const signed = (type: string, amount: number) =>
            type === 'expense' ? -amount : type === 'income' ? amount : 0;
          // reverse the original effect on the original account, then apply the
          // new effect on the (possibly different) account.
          await repos.accounts.updateBalance(userId, existing.accountId, -signed(existing.type, existing.amount));
          await repos.accounts.updateBalance(userId, newAccountId, signed(existing.type, newAmount));
        }

        // FR-08 step 7: reconcile budget spent when a budgeted expense's amount changes.
        if (existing.budgetCodeId && amountChanged && a.amount !== undefined) {
          await repos.budgets.incrementSpent(userId, existing.budgetCodeId, a.amount - existing.amount);
        }

        const updated = await repos.transactions.update(userId, transactionId, patch as Partial<Transaction>);
        const res: TransactionResult = { status: 'ok', data: { transaction: updated } };
        return res;
      } catch (e) {
        logEvent('error', 'update_transaction failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal memperbarui transaksi. Coba lagi.' } as TransactionResult;
      }
    },
  });

  tools.soft_delete_transaction = tool({
    description:
      'Hapus transaksi (soft delete). Kalau user bilang "hapus tadi", pakai lastTransactionId.',
    parameters: z.object({
      transactionId: z.string().optional(),
    }),
    execute: async (args) => {
      try {
        const a = args as { transactionId?: string };
        const transactionId = a.transactionId ?? lastTransactionId;
        if (!transactionId) {
          return { status: 'missing_fields', missing: ['transactionId'] } as TransactionResult;
        }
        const txn = await repos.transactions.findById(userId, transactionId);
        if (!txn) {
          return { status: 'error', message: 'Transaksi tidak ditemukan.' } as TransactionResult;
        }
        if (txn.deletedAt) {
          return { status: 'error', message: 'Transaksi sudah dihapus.' } as TransactionResult;
        }
        // Reverse balance delta: expense → add back (+), income → subtract (-)
        const delta = txn.type === 'expense' ? txn.amount : txn.type === 'income' ? -txn.amount : 0;
        if (delta !== 0) {
          await repos.accounts.updateBalance(userId, txn.accountId, delta);
        }
        await repos.transactions.softDelete(userId, transactionId);
        return { status: 'ok' } as TransactionResult;
      } catch (e) {
        logEvent('error', 'soft_delete_transaction failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal menghapus transaksi. Coba lagi.' } as TransactionResult;
      }
    },
  });

  tools.create_budget_code = tool({
    description: 'Buat budget code baru dengan alokasi bulanan. Default month/year dari WIB.',
    parameters: z.object({
      name: z.string(),
      monthlyBudget: z.number().positive(),
      month: z.number().int().min(1).max(12).optional(),
      year: z.number().int().positive().optional(),
    }),
    execute: async ({ name, monthlyBudget, month, year }) => {
      try {
        const bc = await repos.budgets.create({
          userId,
          name,
          monthlyBudget,
          month: month ?? wibMonth(),
          year: year ?? wibYear(),
        });
        return { status: 'ok', data: bc };
      } catch (e) {
        logEvent('error', 'create_budget_code failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal membuat budget code. Coba lagi.' };
      }
    },
  });

  tools.create_recurring_payment = tool({
    description: 'Buat jadwal pembayaran berulang bulanan. nextFireAt dihitung otomatis dari dayOfMonth.',
    parameters: z.object({
      name: z.string(),
      amount: z.number().positive(),
      accountId: z.string(),
      categoryId: z.string(),
      dayOfMonth: z.number().int().min(1).max(31),
      budgetCodeId: z.string().optional(),
    }),
    execute: async ({ name, amount, accountId, categoryId, dayOfMonth, budgetCodeId }) => {
      try {
        let account = await repos.accounts.findById(userId, accountId);
        if (!account) account = await repos.accounts.findByName(userId, accountId);
        if (!account) {
          const all = await repos.accounts.findAllByUserId(userId);
          return {
            status: 'ambiguous',
            field: 'accountId',
            matches: all.map((a) => ({ id: a.accountId, label: a.name })),
          };
        }

        const nextFireAt = nextFireDate(dayOfMonth);

        const rp = await repos.recurrings.create({
          userId,
          name,
          amount,
          accountId: account.accountId,
          categoryId,
          budgetCodeId,
          dayOfMonth,
          nextFireAt,
        });

        return { status: 'ok', data: rp };
      } catch (e) {
        logEvent('error', 'create_recurring_payment failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal membuat pembayaran rutin. Coba lagi.' };
      }
    },
  });

  tools.deactivate_recurring_payment = tool({
    description: 'Nonaktifkan (hapus) jadwal recurring payment.',
    parameters: z.object({
      recurringId: z.string(),
    }),
    execute: async ({ recurringId }) => {
      try {
        await repos.recurrings.deactivate(userId, recurringId);
        return { status: 'ok' };
      } catch (e) {
        logEvent('error', 'deactivate_recurring_payment failed', { userId, error: (e as Error).message });
        return { status: 'error', message: 'Gagal menonaktifkan pembayaran rutin. Coba lagi.' };
      }
    },
  });

  return tools;
}
