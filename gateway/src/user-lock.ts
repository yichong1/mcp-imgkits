import { DurableObject } from "cloudflare:workers";
import { cacheKey, DAILY_DEBIT_CAP, MAX_ACTIVE_KEYS, RATE_LIMIT_PER_MINUTE, readTimeoutMs, utcDate } from "./constants";
import { decryptTicket, maskId } from "./crypto";
import { dailyUsed, findLedger, getKeyById, userDailyUsed, type ApiKeyRow, type LedgerRow } from "./db";
import { logEvent } from "./http";
import { UsaClient, UsaError } from "./usa";

export type ResultBody = {
  ok: boolean;
  error?: string;
  user?: { id_masked: string; app: string };
  free_cnt?: number;
  subscribed?: boolean;
  charged?: number;
  balance_after?: number;
  charge_id?: string;
  retry_after?: number;
  daily_used?: number;
  daily_cap?: number;
  cost?: number;
};

export type GatewayResult = {
  status: number;
  body: ResultBody;
};

export type PublicCall =
  | { op: "me" }
  | { op: "balance" }
  | {
      op: "charge";
      cost: number;
      tool: string | null;
      ref: string | null;
      idempotencyKey: string;
    };

export type MintInput = {
  id: string;
  keyHash: string;
  keyPrefix: string;
  usaUserId: string;
  fromApp: string;
  ticketCiphertext: string;
  ticketIv: string;
  emailMasked: string | null;
};

export type MintOutput = {
  id: string;
  keyPrefix: string;
  revokedIds: string[];
};

type RateRow = { hits: number; window_start: number };

function done(status: number, body: ResultBody): GatewayResult {
  return { status, body };
}

function isConfigError(error: unknown): boolean {
  return error instanceof Error && (error.message === "usa_base_url" || error.message === "ticket_key_length");
}

export class UserLock extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rate_buckets (
          key_id TEXT PRIMARY KEY,
          window_start INTEGER NOT NULL,
          hits INTEGER NOT NULL
        )
      `);
    });
  }

  async handle(keyId: string, call: PublicCall): Promise<GatewayResult> {
    return this.enqueue(() => this.run(keyId, call));
  }

  async mint(input: MintInput): Promise<MintOutput> {
    return this.enqueue(() => this.runMint(input));
  }

  async revoke(keyId: string): Promise<{ revokedAt: string | null }> {
    return this.enqueue(() => this.runRevoke(keyId));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(
      () => gate,
      () => gate,
    );
    return previous.then(fn, fn).finally(() => {
      release();
    });
  }

  private async run(keyId: string, call: PublicCall): Promise<GatewayResult> {
    const key = await getKeyById(this.env.DB, keyId);
    if (!key || (this.ctx.id.name && this.ctx.id.name !== key.usa_user_id)) {
      return done(401, { ok: false, error: "invalid_api_key" });
    }
    if (key.revoked_at) return done(401, { ok: false, error: "revoked" });

    const rate = this.takeRateToken(key.id);
    if (!rate.ok) {
      return done(429, { ok: false, error: "rate_limited", retry_after: rate.retryAfter });
    }

    if (call.op === "me") {
      return done(200, { ok: true, user: { id_masked: maskId(key.usa_user_id), app: key.from_app } });
    }
    if (call.op === "balance") return this.runBalance(key);
    return this.runCharge(key, call);
  }

  private takeRateToken(keyId: string): { ok: true } | { ok: false; retryAfter: number } {
    const nowMs = Date.now();
    const windowMs = 60_000;
    const windowStart = Math.floor(nowMs / windowMs);
    const rows = this.ctx.storage.sql
      .exec<RateRow>("SELECT hits, window_start FROM rate_buckets WHERE key_id = ?", keyId)
      .toArray();
    const row = rows[0];
    if (!row || row.window_start !== windowStart) {
      this.ctx.storage.sql.exec(
        `INSERT INTO rate_buckets (key_id, window_start, hits) VALUES (?, ?, 1)
         ON CONFLICT(key_id) DO UPDATE SET window_start = excluded.window_start, hits = 1`,
        keyId,
        windowStart,
      );
      return { ok: true };
    }
    if (row.hits >= RATE_LIMIT_PER_MINUTE) {
      const retryAfter = Math.max(1, Math.ceil(((windowStart + 1) * windowMs - nowMs) / 1000));
      return { ok: false, retryAfter };
    }
    this.ctx.storage.sql.exec(
      "UPDATE rate_buckets SET hits = hits + 1 WHERE key_id = ? AND window_start = ?",
      keyId,
      windowStart,
    );
    return { ok: true };
  }

  private async runBalance(key: ApiKeyRow): Promise<GatewayResult> {
    const ticket = await this.decrypt(key);
    if (typeof ticket !== "string") return ticket;
    try {
      const balance = await this.client().balance(ticket, key.from_app);
      return done(200, { ok: true, free_cnt: balance.freeCnt, subscribed: balance.subscribed });
    } catch (error) {
      if (isConfigError(error)) return done(500, { ok: false, error: "misconfigured" });
      return done(503, { ok: false, error: "usa_unavailable" });
    }
  }

  private async runCharge(
    key: ApiKeyRow,
    call: Extract<PublicCall, { op: "charge" }>,
  ): Promise<GatewayResult> {
    const existing = await findLedger(this.env.DB, key.usa_user_id, call.idempotencyKey);
    if (existing) return this.replay(existing, call);

    const today = utcDate();
    const keyUsed = dailyUsed(key, today);
    const userUsed = await userDailyUsed(this.env.DB, key.usa_user_id, today);
    const used = Math.max(keyUsed, userUsed);
    if (keyUsed + call.cost > DAILY_DEBIT_CAP || userUsed + call.cost > DAILY_DEBIT_CAP) {
      return done(429, {
        ok: false,
        error: "daily_cap",
        daily_used: used,
        daily_cap: DAILY_DEBIT_CAP,
      });
    }

    const ticket = await this.decrypt(key);
    if (typeof ticket !== "string") return ticket;

    let client: UsaClient;
    try {
      client = this.client();
    } catch (error) {
      if (isConfigError(error)) return done(500, { ok: false, error: "misconfigured" });
      throw error;
    }

    let balanceBefore: number;
    try {
      const balance = await client.balance(ticket, key.from_app);
      balanceBefore = balance.freeCnt;
    } catch (error) {
      if (isConfigError(error)) return done(500, { ok: false, error: "misconfigured" });
      return this.recordTerminal(key, call, {
        status: "failed_usa",
        httpStatus: 503,
        error: this.usaErrorCode("usa_balance", error),
        balanceBefore: null,
        balanceAfter: null,
        body: { ok: false, error: "usa_unavailable" },
      });
    }

    if (balanceBefore < call.cost) {
      return this.recordTerminal(key, call, {
        status: "rejected_insufficient",
        httpStatus: 402,
        error: "insufficient_credits",
        balanceBefore,
        balanceAfter: balanceBefore,
        body: { ok: false, error: "insufficient_credits", free_cnt: balanceBefore, cost: call.cost },
      });
    }

    const fresh = await getKeyById(this.env.DB, key.id);
    if (!fresh || fresh.revoked_at) return done(401, { ok: false, error: "revoked" });

    const chargeId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    try {
      await this.insertLedger({
        id: chargeId,
        key,
        call,
        status: "in_flight",
        balanceBefore,
        balanceAfter: null,
        createdAt,
        error: null,
        httpStatus: null,
        responseJson: null,
      });
    } catch (error) {
      const raced = await findLedger(this.env.DB, key.usa_user_id, call.idempotencyKey);
      if (raced) return this.replay(raced, call);
      throw error;
    }

    try {
      await client.debit(ticket, key.from_app, call.cost);
    } catch (error) {
      const ambiguous = this.debitAmbiguous(error);
      return this.finish(chargeId, {
        status: ambiguous ? "pending_manual_refund" : "failed_usa",
        httpStatus: 503,
        error: this.usaErrorCode("usa_debit", error),
        balanceBefore,
        balanceAfter: null,
        body: { ok: false, error: "usa_unavailable", charge_id: chargeId },
      });
    }

    let balanceAfter = balanceBefore - call.cost;
    try {
      const again = await client.balance(ticket, key.from_app);
      balanceAfter = again.freeCnt;
    } catch {
      balanceAfter = balanceBefore - call.cost;
    }
    if (balanceAfter > balanceBefore - call.cost) {
      logEvent("warn", {
        message: "balance_did_not_drop",
        key_prefix: key.key_prefix,
        charge_id: chargeId,
        before: balanceBefore,
        after: balanceAfter,
      });
    }

    const nextSum = keyUsed + call.cost;
    const body: ResultBody = {
      ok: true,
      charged: call.cost,
      balance_after: balanceAfter,
      charge_id: chargeId,
    };
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE ledger
         SET status = 'charged', usa_balance_before = ?, usa_balance_after = ?, error = NULL,
             http_status = 200, response_json = ?
         WHERE id = ?`,
      ).bind(balanceBefore, balanceAfter, JSON.stringify(body), chargeId),
      this.env.DB.prepare(
        `UPDATE api_keys SET daily_debit_date = ?, daily_debit_sum = ? WHERE id = ?`,
      ).bind(today, nextSum, key.id),
    ]);
    return done(200, body);
  }

  private async replay(row: LedgerRow, call: Extract<PublicCall, { op: "charge" }>): Promise<GatewayResult> {
    if (row.cost !== call.cost || (row.tool ?? null) !== call.tool || (row.ref ?? null) !== call.ref) {
      return done(409, { ok: false, error: "idempotency_conflict" });
    }
    if (row.status === "in_flight") {
      const body: ResultBody = { ok: false, error: "usa_unavailable", charge_id: row.id };
      await this.env.DB.prepare(
        `UPDATE ledger
         SET status = 'pending_manual_refund', error = 'idempotent_replay_inflight',
             http_status = 503, response_json = ?
         WHERE id = ? AND status = 'in_flight'`,
      )
        .bind(JSON.stringify(body), row.id)
        .run();
      return done(503, body);
    }
    if (row.http_status && row.response_json) {
      try {
        const body = JSON.parse(row.response_json) as ResultBody;
        if (body && typeof body.ok === "boolean") return done(row.http_status, body);
      } catch {
        return done(503, { ok: false, error: "usa_unavailable", charge_id: row.id });
      }
    }
    if (row.status === "charged") {
      return done(200, {
        ok: true,
        charged: row.cost,
        balance_after: row.usa_balance_after ?? Math.max(0, (row.usa_balance_before ?? row.cost) - row.cost),
        charge_id: row.id,
      });
    }
    if (row.status === "rejected_insufficient") {
      return done(402, {
        ok: false,
        error: "insufficient_credits",
        free_cnt: row.usa_balance_before ?? 0,
        cost: row.cost,
        charge_id: row.id,
      });
    }
    return done(503, { ok: false, error: "usa_unavailable", charge_id: row.id });
  }

  private async recordTerminal(
    key: ApiKeyRow,
    call: Extract<PublicCall, { op: "charge" }>,
    input: {
      status: "failed_usa" | "rejected_insufficient";
      httpStatus: number;
      error: string;
      balanceBefore: number | null;
      balanceAfter: number | null;
      body: ResultBody;
    },
  ): Promise<GatewayResult> {
    const chargeId = crypto.randomUUID();
    const body = { ...input.body, charge_id: chargeId };
    try {
      await this.insertLedger({
        id: chargeId,
        key,
        call,
        status: input.status,
        balanceBefore: input.balanceBefore,
        balanceAfter: input.balanceAfter,
        createdAt: new Date().toISOString(),
        error: input.error,
        httpStatus: input.httpStatus,
        responseJson: JSON.stringify(body),
      });
    } catch (error) {
      const raced = await findLedger(this.env.DB, key.usa_user_id, call.idempotencyKey);
      if (raced) return this.replay(raced, call);
      throw error;
    }
    return done(input.httpStatus, body);
  }

  private async finish(
    chargeId: string,
    input: {
      status: "failed_usa" | "pending_manual_refund";
      httpStatus: number;
      error: string;
      balanceBefore: number | null;
      balanceAfter: number | null;
      body: ResultBody;
    },
  ): Promise<GatewayResult> {
    await this.env.DB.prepare(
      `UPDATE ledger
       SET status = ?, usa_balance_before = ?, usa_balance_after = ?, error = ?,
           http_status = ?, response_json = ?
       WHERE id = ?`,
    )
      .bind(
        input.status,
        input.balanceBefore,
        input.balanceAfter,
        input.error,
        input.httpStatus,
        JSON.stringify(input.body),
        chargeId,
      )
      .run();
    return done(input.httpStatus, input.body);
  }

  private async insertLedger(input: {
    id: string;
    key: ApiKeyRow;
    call: Extract<PublicCall, { op: "charge" }>;
    status: string;
    balanceBefore: number | null;
    balanceAfter: number | null;
    createdAt: string;
    error: string | null;
    httpStatus: number | null;
    responseJson: string | null;
  }): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO ledger (
         id, key_id, usa_user_id, idempotency_key, cost, tool, ref, status,
         usa_balance_before, usa_balance_after, created_at, error, http_status, response_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        input.id,
        input.key.id,
        input.key.usa_user_id,
        input.call.idempotencyKey,
        input.call.cost,
        input.call.tool,
        input.call.ref,
        input.status,
        input.balanceBefore,
        input.balanceAfter,
        input.createdAt,
        input.error,
        input.httpStatus,
        input.responseJson,
      )
      .run();
  }

  private async decrypt(key: ApiKeyRow): Promise<string | GatewayResult> {
    try {
      return await decryptTicket(this.env.TICKET_ENCRYPTION_KEY, key.ticket_ciphertext, key.ticket_iv);
    } catch (error) {
      if (isConfigError(error)) return done(500, { ok: false, error: "misconfigured" });
      logEvent("error", { message: "ticket_decrypt_failed", key_prefix: key.key_prefix });
      return done(500, { ok: false, error: "internal_error" });
    }
  }

  private client(): UsaClient {
    return new UsaClient(this.env.USA_BASE_URL, readTimeoutMs(this.env.USA_TIMEOUT_MS));
  }

  private usaErrorCode(prefix: "usa_balance" | "usa_debit", error: unknown): string {
    if (error instanceof UsaError) return `${prefix}_${error.code}`;
    return `${prefix}_unknown`;
  }

  private debitAmbiguous(error: unknown): boolean {
    if (!(error instanceof UsaError)) return true;
    return (
      error.code === "timeout" ||
      error.code === "network" ||
      error.code === "redirect" ||
      error.code === "invalid"
    );
  }

  private async runMint(input: MintInput): Promise<MintOutput> {
    const active = await this.env.DB.prepare(
      `SELECT id, key_hash FROM api_keys
       WHERE usa_user_id = ? AND revoked_at IS NULL
       ORDER BY created_at ASC, rowid ASC`,
    )
      .bind(input.usaUserId)
      .all<{ id: string; key_hash: string }>();
    const rows = active.results ?? [];
    const overflow = rows.length - (MAX_ACTIVE_KEYS - 1);
    const revokeRows = overflow > 0 ? rows.slice(0, overflow) : [];
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = revokeRows.map((row) =>
      this.env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(now, row.id),
    );
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO api_keys (
           id, key_hash, key_prefix, usa_user_id, from_app, ticket_ciphertext, ticket_iv,
           email_masked, created_at, revoked_at, daily_debit_date, daily_debit_sum
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
      ).bind(
        input.id,
        input.keyHash,
        input.keyPrefix,
        input.usaUserId,
        input.fromApp,
        input.ticketCiphertext,
        input.ticketIv,
        input.emailMasked,
        now,
      ),
    );
    await this.env.DB.batch(statements);
    for (const row of revokeRows) {
      await this.env.KEY_CACHE.delete(cacheKey(row.key_hash));
    }
    return { id: input.id, keyPrefix: input.keyPrefix, revokedIds: revokeRows.map((row) => row.id) };
  }

  private async runRevoke(keyId: string): Promise<{ revokedAt: string | null }> {
    const key = await getKeyById(this.env.DB, keyId);
    if (!key || (this.ctx.id.name && this.ctx.id.name !== key.usa_user_id)) return { revokedAt: null };
    if (key.revoked_at) return { revokedAt: key.revoked_at };
    const revokedAt = new Date().toISOString();
    await this.env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .bind(revokedAt, key.id)
      .run();
    await this.env.KEY_CACHE.delete(cacheKey(key.key_hash));
    return { revokedAt };
  }
}
