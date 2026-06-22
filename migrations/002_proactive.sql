-- Proactive outreach log: dedup + rate-limit source of truth (design §6).
-- The (user_id, dedup_key) UNIQUE index is the atomic dedup invariant.
CREATE TABLE outreach_log (
  outreach_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(user_id),
  trigger_type VARCHAR     NOT NULL CHECK (trigger_type IN
                ('scheduled_summary','budget_threshold','logging_gap','anomaly')),
  dedup_key    VARCHAR     NOT NULL,
  payload      JSONB       NOT NULL DEFAULT '{}',
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_outreach_dedup     ON outreach_log(user_id, dedup_key);
CREATE INDEX        idx_outreach_user_sent ON outreach_log(user_id, sent_at);

-- Per-user proactive control. No row == defaults (not muted).
CREATE TABLE proactive_settings (
  user_id    UUID        PRIMARY KEY REFERENCES users(user_id),
  muted      BOOLEAN     NOT NULL DEFAULT false,
  resume_at  TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
