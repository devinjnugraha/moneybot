import { tool, type CoreTool } from 'ai';
import { z } from 'zod';
import type { Slice1Repos } from '../repositories/interfaces.js';
import type { AccountResult, TransactionResult } from '../domain/entities.js';
import { todayWIB } from '../domain/time.js';

export interface BuildToolsArgs {
  userId: string;
  repos: Slice1Repos;
  hasAccount: boolean;
}

export function buildTools({ userId, repos, hasAccount }: BuildToolsArgs) {
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
        return { status: 'error', message: (e as Error).message } as AccountResult;
      }
    },
  });

  if (!hasAccount) return tools;

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
      try {
        // Resolve account: accept accountId or account name
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
          type: 'expense',
          amount,
          description,
          categoryId,
          accountId: account.accountId,
          budgetCodeId,
          date: date ?? todayWIB(),
        });

        await repos.accounts.updateBalance(userId, account.accountId, -amount);

        const res: TransactionResult = { status: 'ok', data: { transaction } };
        return res;
      } catch (e) {
        return { status: 'error', message: (e as Error).message } as TransactionResult;
      }
    },
  });

  return tools;
}
