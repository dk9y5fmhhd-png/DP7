-- DP7 database schema (PostgreSQL)
-- Safe to run repeatedly: everything is IF NOT EXISTS / CREATE OR REPLACE.

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  login_id        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'super_admin')),
  page_access     TEXT[] NOT NULL DEFAULT '{}',
  totp_secret     TEXT,
  totp_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS levels (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  min_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  max_amount NUMERIC(14,2),
  sort       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS deposits (
  id         BIGSERIAL PRIMARY KEY,
  play_date  DATE NOT NULL,
  username   TEXT NOT NULL,
  mobile     TEXT NOT NULL DEFAULT '',
  amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-day uniqueness sirf manual entry ke liye hai — dekho schema-v3.sql (deposits_manual_day_uniq).

CREATE INDEX IF NOT EXISTS deposits_play_date_idx ON deposits (play_date);
CREATE INDEX IF NOT EXISTS deposits_username_idx  ON deposits (LOWER(username));
CREATE INDEX IF NOT EXISTS deposits_mobile_idx    ON deposits (mobile);

CREATE TABLE IF NOT EXISTS followups (
  id          BIGSERIAL PRIMARY KEY,
  username    TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_date DATE NOT NULL,
  response    TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS followups_username_idx ON followups (LOWER(username));

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER,
  login_id   TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

-- client_stats view ab schema-v3.2.sql me hai (txn_count + successful filter ke saath).

-- Which level does a given lifetime total fall into? NULL = no band matched.
CREATE OR REPLACE FUNCTION client_level(p_total NUMERIC)
RETURNS INTEGER AS $$
  SELECT l.id
  FROM levels l
  WHERE p_total >= l.min_amount
    AND (l.max_amount IS NULL OR p_total <= l.max_amount)
  ORDER BY l.sort, l.id
  LIMIT 1;
$$ LANGUAGE sql STABLE;

