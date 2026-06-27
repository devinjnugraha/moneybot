-- Approval gate: per-user access status. Default 'pending' for new signups.
ALTER TABLE users
  ADD COLUMN status VARCHAR NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected'));

-- Backfill: users already present are trusted and keep working.
UPDATE users SET status = 'approved';
