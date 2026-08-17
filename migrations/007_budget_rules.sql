-- Free-text auto-tagging rules per budget code (e.g. "semua expense terea
-- masuk ke budget ini"). Interpreted by the LLM via the enriched system
-- prompt — deliberately NOT a structured rule engine. NULL = no rules.
-- Copied forward by the recurring roll-over (most recent instance wins).
ALTER TABLE budget_codes
  ADD COLUMN rules TEXT;
