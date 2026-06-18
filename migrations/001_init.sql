-- Users
CREATE TABLE users (
  user_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id VARCHAR     UNIQUE NOT NULL,
  name             VARCHAR     NOT NULL,
  language         VARCHAR(2)  NOT NULL DEFAULT 'id',
  timezone         VARCHAR     NOT NULL DEFAULT 'Asia/Jakarta',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_users_telegram ON users(telegram_chat_id);

-- Accounts
CREATE TABLE accounts (
  account_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(user_id),
  name         VARCHAR     NOT NULL,
  type         VARCHAR     NOT NULL CHECK (type IN ('cash', 'bank', 'card')),
  balance      NUMERIC     NOT NULL DEFAULT 0,
  credit_limit NUMERIC,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_accounts_user ON accounts(user_id);

-- Categories (system-seeded)
CREATE TABLE categories (
  category_id        VARCHAR PRIMARY KEY,
  name               VARCHAR NOT NULL,
  name_en            VARCHAR NOT NULL,
  parent_category_id VARCHAR REFERENCES categories(category_id),
  icon               VARCHAR NOT NULL,
  type               VARCHAR NOT NULL CHECK (type IN ('expense', 'income', 'both'))
);

-- Transactions
CREATE TABLE transactions (
  transaction_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES users(user_id),
  type                  VARCHAR     NOT NULL CHECK (type IN ('expense', 'income', 'transfer')),
  amount                NUMERIC     NOT NULL,
  description           VARCHAR     NOT NULL,
  category_id           VARCHAR     REFERENCES categories(category_id),
  account_id            UUID        NOT NULL REFERENCES accounts(account_id),
  to_account_id         UUID        REFERENCES accounts(account_id),
  budget_code_id        UUID,
  date                  DATE        NOT NULL,
  notes                 TEXT,
  is_recurring_instance BOOLEAN     NOT NULL DEFAULT false,
  recurring_id          UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ
);
CREATE INDEX idx_txn_user_date    ON transactions(user_id, date);
CREATE INDEX idx_txn_account_date ON transactions(account_id, date);

-- Budget Codes
CREATE TABLE budget_codes (
  budget_code_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(user_id),
  name           VARCHAR     NOT NULL,
  monthly_budget NUMERIC     NOT NULL,
  month          SMALLINT    NOT NULL CHECK (month BETWEEN 1 AND 12),
  year           SMALLINT    NOT NULL,
  spent          NUMERIC     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name, year, month)
);
CREATE INDEX idx_budget_user_month ON budget_codes(user_id, year, month);

-- Recurring Payments
CREATE TABLE recurring_payments (
  recurring_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(user_id),
  name           VARCHAR     NOT NULL,
  amount         NUMERIC     NOT NULL,
  account_id     UUID        NOT NULL REFERENCES accounts(account_id),
  category_id    VARCHAR     NOT NULL REFERENCES categories(category_id),
  budget_code_id UUID,
  day_of_month   SMALLINT    NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  last_fired_at  DATE,
  next_fire_at   DATE        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_recurring_day_active ON recurring_payments(day_of_month) WHERE is_active = true;

-- Session Contexts (turns stores CoreMessage[] as JSONB)
CREATE TABLE session_contexts (
  chat_id                        VARCHAR     PRIMARY KEY,
  user_id                        UUID        NOT NULL REFERENCES users(user_id),
  turns                          JSONB       NOT NULL DEFAULT '[]',
  last_transaction_id            UUID,
  pending_recurring_confirmation JSONB,
  last_activity_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
