-- Card billing cycle fields on accounts.
ALTER TABLE accounts
  ADD COLUMN billing_day SMALLINT,
  ADD COLUMN due_in_days  SMALLINT NOT NULL DEFAULT 15,
  ADD CONSTRAINT accounts_billing_day_range
    CHECK (billing_day IS NULL OR billing_day BETWEEN 1 AND 31);

-- Billing metadata: one row per card per ended billing cycle. All financial
-- figures and the due date are DERIVED on read (see getWithFigures), so this
-- table holds only cycle identity.
CREATE TABLE card_statements (
  statement_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(user_id),
  account_id    UUID        NOT NULL REFERENCES accounts(account_id),
  cycle_start   DATE        NOT NULL,
  cycle_end     DATE        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, cycle_end)
);
CREATE INDEX idx_card_statements_user_account ON card_statements(user_id, account_id, cycle_end);
