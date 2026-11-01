export type ApiKeyRow = {
  id: string;
  key_hash: string;
  key_prefix: string;
  usa_user_id: string;
  from_app: string;
  ticket_ciphertext: string;
  ticket_iv: string;
  email_masked: string | null;
  created_at: string;
  revoked_at: string | null;
  daily_debit_date: string | null;
  daily_debit_sum: number;
};

export type PublicKeyRow = {
  id: string;
  key_hash: string;
  key_prefix: string;
  usa_user_id: string;
  from_app: string;
  revoked_at: string | null;
};

export type LedgerRow = {
  id: string;
  key_id: string;
  usa_user_id: string;
  idempotency_key: string;
  cost: number;
  tool: string | null;
  ref: string | null;
  status: string;
  usa_balance_before: number | null;
  usa_balance_after: number | null;
  created_at: string;
  error: string | null;
  http_status: number | null;
  response_json: string | null;
};

const KEY_COLUMNS = `id, key_hash, key_prefix, usa_user_id, from_app, ticket_ciphertext, ticket_iv,
  email_masked, created_at, revoked_at, daily_debit_date, daily_debit_sum`;

export async function getKeyByHash(db: D1Database, keyHash: string): Promise<PublicKeyRow | null> {
  return db
    .prepare(
      `SELECT id, key_hash, key_prefix, usa_user_id, from_app, revoked_at
       FROM api_keys WHERE key_hash = ?`,
    )
    .bind(keyHash)
    .first<PublicKeyRow>();
}

export async function getKeyById(db: D1Database, id: string): Promise<ApiKeyRow | null> {
  return db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ?`).bind(id).first<ApiKeyRow>();
}

export async function getPublicKeyById(db: D1Database, id: string): Promise<PublicKeyRow | null> {
  return db
    .prepare(
      `SELECT id, key_hash, key_prefix, usa_user_id, from_app, revoked_at
       FROM api_keys WHERE id = ?`,
    )
    .bind(id)
    .first<PublicKeyRow>();
}

export function dailyUsed(row: Pick<ApiKeyRow, "daily_debit_date" | "daily_debit_sum">, today: string): number {
  return row.daily_debit_date === today ? row.daily_debit_sum : 0;
}

export async function userDailyUsed(db: D1Database, usaUserId: string, today: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN daily_debit_date = ? THEN daily_debit_sum ELSE 0 END), 0) AS used
       FROM api_keys WHERE usa_user_id = ?`,
    )
    .bind(today, usaUserId)
    .first<{ used: number }>();
  return row?.used ?? 0;
}

export async function findLedger(
  db: D1Database,
  usaUserId: string,
  idempotencyKey: string,
): Promise<LedgerRow | null> {
  return db
    .prepare(`SELECT * FROM ledger WHERE usa_user_id = ? AND idempotency_key = ?`)
    .bind(usaUserId, idempotencyKey)
    .first<LedgerRow>();
}
