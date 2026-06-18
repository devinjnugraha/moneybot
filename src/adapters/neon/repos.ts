import { NeonUserRepository } from './user.repository.js';
import { NeonAccountRepository } from './account.repository.js';
import { NeonTransactionRepository } from './transaction.repository.js';
import { NeonSessionRepository } from './session.repository.js';
import type { Slice1Repos } from '../../repositories/interfaces.js';

export function createRepos(): Slice1Repos {
  return {
    users: new NeonUserRepository(),
    accounts: new NeonAccountRepository(),
    transactions: new NeonTransactionRepository(),
    sessions: new NeonSessionRepository(),
  };
}
