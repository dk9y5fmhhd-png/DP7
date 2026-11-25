-- ============================================================
-- DP7 v3.9 — admin-approved login + 10-hour session + no downloads
--
-- Har login par admin ki permission chahiye. Session 10 ghante chalega,
-- uske baad dobara permission leni padegi. Non-admin koi CSV/export
-- download nahi kar sakta.
--
-- Safe to run repeatedly.
-- ============================================================

-- Kaun-kaun login approval bypass kare (Super Admin hamesha bypass karta hai)
ALTER TABLE users ADD COLUMN IF NOT EXISTS require_approval BOOLEAN NOT NULL DEFAULT TRUE;

-- Login requests — admin approve/reject karega
CREATE TABLE IF NOT EXISTS login_requests (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login_id     TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  ip           TEXT NOT NULL DEFAULT '',
  user_agent   TEXT NOT NULL DEFAULT '',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at   TIMESTAMPTZ,
  decided_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note         TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS login_requests_status_idx
  ON login_requests (status, requested_at DESC);

CREATE INDEX IF NOT EXISTS login_requests_user_idx
  ON login_requests (user_id, requested_at DESC);

-- Purane pending requests ko upgrade par band kar do
UPDATE login_requests SET status = 'expired'
 WHERE status = 'pending' AND requested_at < NOW() - INTERVAL '5 minutes';

