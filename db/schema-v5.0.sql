-- DP7 v5.0 — TeleCMI click-to-call and WhatsApp (Baileys).
-- Safe to run repeatedly (applied on every start, like the earlier files).

-- Screen language chosen by the user; NULL follows the system default.
ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT CHECK (language IN ('en','hi'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS telecmi_agent_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telecmi_password_enc TEXT;

CREATE TABLE IF NOT EXISTS telecmi_accounts (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  app_id TEXT NOT NULL UNIQUE,
  secret_enc TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_webhook_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- One webhook address serves every account (as in Ringline).
ALTER TABLE telecmi_accounts DROP COLUMN IF EXISTS webhook_token_hash;

ALTER TABLE calls ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES telecmi_accounts(id) ON DELETE SET NULL;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outbound';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hangup_reason TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS calls_provider_ref_idx ON calls (provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS telecmi_webhook_logs (
  id BIGSERIAL PRIMARY KEY,
  account_id INTEGER REFERENCES telecmi_accounts(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS telecmi_webhook_logs_created_idx ON telecmi_webhook_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  phone_number TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected','qr','qr_expired','connecting','connected','reconnecting','replaced','logged_out')),
  daily_cap INTEGER NOT NULL DEFAULT 150 CHECK (daily_cap BETWEEN 1 AND 1000),
  connected_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_session_users (
  session_id INTEGER NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_auth_keys (
  session_id INTEGER NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (session_id, key)
);

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en','hi')),
  body TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (name, language)
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE RESTRICT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  remote_jid TEXT NOT NULL,
  number TEXT,
  conversation_key TEXT NOT NULL,
  body TEXT,
  media_type TEXT,
  provider_message_id TEXT NOT NULL,
  delivery_status SMALLINT NOT NULL DEFAULT 0,
  delivery_error TEXT,
  message_at TIMESTAMPTZ NOT NULL,
  sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (session_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_messages_chat_idx ON whatsapp_messages (session_id, conversation_key, message_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_messages_customer_idx ON whatsapp_messages (customer_id, message_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_messages_session_time_idx ON whatsapp_messages (session_id, message_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_opt_outs (
  id SERIAL PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('reply','manual')),
  trigger_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
