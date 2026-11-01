CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  usa_user_id TEXT NOT NULL,
  from_app TEXT NOT NULL,
  ticket_ciphertext TEXT NOT NULL,
  ticket_iv TEXT NOT NULL,
  email_masked TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  daily_debit_date TEXT,
  daily_debit_sum INTEGER NOT NULL DEFAULT 0 CHECK (daily_debit_sum >= 0)
);

CREATE INDEX idx_api_keys_user ON api_keys (usa_user_id, revoked_at);

CREATE TABLE ledger (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  usa_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  cost INTEGER NOT NULL CHECK (cost > 0),
  tool TEXT,
  ref TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'in_flight',
      'charged',
      'failed_usa',
      'pending_manual_refund',
      'rejected_insufficient'
    )
  ),
  usa_balance_before INTEGER,
  usa_balance_after INTEGER,
  created_at TEXT NOT NULL,
  error TEXT,
  http_status INTEGER,
  response_json TEXT,
  UNIQUE (usa_user_id, idempotency_key)
);

CREATE INDEX idx_ledger_status ON ledger (status, created_at);
CREATE INDEX idx_ledger_key ON ledger (key_id);
