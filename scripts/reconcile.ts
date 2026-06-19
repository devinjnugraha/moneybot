import { pool } from '../src/adapters/neon/pool.js';
import { pathToFileURL } from 'node:url';

export interface Correction {
  accountId: string;
  name: string;
  oldBalance: number;
  newBalance: number;
}

/**
 * Re-derive every active account's balance from the sum of non-deleted
 * transactions.  Corrects any drift and returns the list of corrections.
 *
 * Balance formula (per account):
 *   SUM(income) - SUM(expense) - SUM(transfer_out) + SUM(transfer_in)
 */
export async function reconcile(): Promise<Correction[]> {
  const client = await pool.connect();
  try {
    // 1. Fetch all active accounts
    const { rows: accounts } = await client.query(
      'SELECT account_id, user_id, name, balance FROM accounts WHERE is_active = true',
    );

    const corrections: Correction[] = [];

    for (const acc of accounts) {
      const accountId = String(acc['account_id']);
      const name = String(acc['name']);
      const oldBalance = Number(acc['balance']);

      // 2. Compute correct balance from non-deleted transactions
      const { rows: txnRows } = await client.query(
        `SELECT type, amount, to_account_id
         FROM transactions
         WHERE deleted_at IS NULL
         AND (account_id = $1 OR to_account_id = $1)`,
        [accountId],
      );

      let newBalance = 0;
      for (const t of txnRows) {
        const type = String(t['type']);
        const amount = Number(t['amount']);
        const toAccountId = t['to_account_id'] ? String(t['to_account_id']) : null;

        if (type === 'income') {
          newBalance += amount;
        } else if (type === 'expense') {
          newBalance -= amount;
        } else if (type === 'transfer') {
          if (toAccountId === accountId) {
            // Transfer to this account
            newBalance += amount;
          } else {
            // Transfer from this account
            newBalance -= amount;
          }
        }
      }

      // 3. Correct drift if any
      if (newBalance !== oldBalance) {
        await client.query(
          'UPDATE accounts SET balance = $1, updated_at = NOW() WHERE account_id = $2',
          [newBalance, accountId],
        );
        corrections.push({ accountId, name, oldBalance, newBalance });
      }
    }

    return corrections;
  } finally {
    client.release();
  }
}

// Run directly via `npm run reconcile` or `npx tsx scripts/reconcile.ts`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  reconcile()
    .then((corrections) => {
      if (corrections.length === 0) {
        console.log('✅ All balances are correct — no drift found.');
      } else {
        console.log(`🔧 Corrected ${corrections.length} account(s):`);
        for (const c of corrections) {
          console.log(`  ${c.name}: ${c.oldBalance} → ${c.newBalance} (delta: ${c.newBalance - c.oldBalance})`);
        }
      }
    })
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Reconcile failed:', err);
      process.exit(1);
    });
}
