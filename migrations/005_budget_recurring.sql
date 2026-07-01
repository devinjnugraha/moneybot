-- Recurring vs one-time budgets + lineage for auto roll-over (design §3).
ALTER TABLE budget_codes
  ADD COLUMN is_recurring  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN old_budget_id UUID REFERENCES budget_codes(budget_code_id) ON DELETE SET NULL;

-- Speeds "most recent prior recurring instance per (user, name)" in roll-over.
CREATE INDEX IF NOT EXISTS idx_budget_recurring_prior
  ON budget_codes(user_id, name) WHERE is_recurring = true;
