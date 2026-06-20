-- User Preferences Memory (per-user key/value, injected into system prompt)
CREATE TABLE user_preferences (
  user_id    UUID        NOT NULL REFERENCES users(user_id),
  key        VARCHAR(96) NOT NULL,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);
