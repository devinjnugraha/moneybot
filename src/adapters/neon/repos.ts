import { NeonUserRepository } from './user.repository.js';
import { NeonAccountRepository } from './account.repository.js';
import { NeonTransactionRepository } from './transaction.repository.js';
import { NeonSessionRepository } from './session.repository.js';
import { NeonBudgetCodeRepository } from './budget-code.repository.js';
import { NeonRecurringPaymentRepository } from './recurring-payment.repository.js';
import type { Repos } from '../../repositories/interfaces.js';

export function createRepos(): Repos {
  return {
    users: new NeonUserRepository(),
    accounts: new NeonAccountRepository(),
    transactions: new NeonTransactionRepository(),
    sessions: new NeonSessionRepository(),
    budgets: new NeonBudgetCodeRepository(),
    recurrings: new NeonRecurringPaymentRepository(),
  };
}
