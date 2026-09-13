-- Accounts-mode toggle (FR-11): users may opt out of per-account tracking.
-- NOT NULL DEFAULT backfills every existing user to accounts mode — this
-- feature changes nothing for them until they explicitly toggle.
ALTER TABLE users
  ADD COLUMN accounts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Per-user default account ("Dompet") — the single container in simple mode.
ALTER TABLE accounts
  ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX idx_accounts_default ON accounts(user_id) WHERE is_default;
