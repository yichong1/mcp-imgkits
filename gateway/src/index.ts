import { cacheKey, DAILY_DEBIT_CAP, utcDate } from "./constants";
import { encryptTicket, generateApiKey, sha256Hex, timingSafeEqual } from "./crypto";
import { getPublicKeyById } from "./db";
import { htmlResponse, renderHome, renderPrivacy } from "./html";
import { HttpError, isRecord, json, logEvent, readJson } from "./http";
import { parseBearer, resolveKey } from "./keys";
import { handleMcpRequest } from "./mcp/app";
import { README_MARKDOWN } from "./readme-text";
import { UserLock, type PublicCall } from "./user-lock";

export { UserLock };

const LEDGER_STATUSES = new Set([
  "in_flight",
  "charged",
  "failed_usa",
  "pending_manual_refund",
  "rejected_insufficient",
]);

function requestIdOf(): string {
  return crypto.randomUUID();
}

async function requireAdmin(request: Request, env: Env): Promise<void> {
  const configured = env.ADMIN_TOKEN.trim();
  if (configured.length < 16) throw new HttpError(500, "misconfigured");
  const presented = (request.headers.get("x-admin-token") ?? "").trim();
  if (!presented || presented.length > 512) throw new HttpError(401, "invalid_admin_token");
  if (!(await timingSafeEqual(presented, configured))) throw new HttpError(401, "invalid_admin_token");
}

function optionalText(value: unknown, max: number, code: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, code);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new HttpError(400, code);
  return trimmed;
}

function validateMintBody(body: unknown): {
  usaUserId: string;
  fromApp: string;
  ticket: string;
  emailMasked: string | null;
} {
  if (!isRecord(body)) throw new HttpError(400, "invalid_body");
  const usaUserId = body.usa_user_id;
  const fromApp = body.from_app;
  const ticket = body.ticket;
  if (typeof usaUserId !== "string" || !/^[A-Za-z0-9_.:@|-]{1,128}$/.test(usaUserId)) {
    throw new HttpError(400, "invalid_usa_user_id");
  }
  if (typeof fromApp !== "string" || !/^[a-z0-9_-]{1,32}$/.test(fromApp)) {
    throw new HttpError(400, "invalid_from_app");
  }
  if (typeof ticket !== "string" || ticket.length < 8 || ticket.length > 4096 || ticket.includes("\0")) {
    throw new HttpError(400, "invalid_ticket");
  }
  const emailMasked = optionalText(body.email_masked, 320, "invalid_email_masked");
  if (emailMasked && emailMasked.includes("@") && !emailMasked.includes("*")) {
    throw new HttpError(400, "email_must_be_masked");
  }
  return { usaUserId, fromApp, ticket, emailMasked };
}

function chargeCall(body: unknown, idempotencyKey: string): Extract<PublicCall, { op: "charge" }> {
  if (!isRecord(body)) throw new HttpError(400, "invalid_body");
  const cost = body.cost;
  if (typeof cost !== "number" || !Number.isInteger(cost) || cost < 1) throw new HttpError(400, "invalid_cost");
  return {
    op: "charge",
    cost,
    tool: optionalText(body.tool, 128, "invalid_tool"),
    ref: optionalText(body.ref, 256, "invalid_ref"),
    idempotencyKey,
  };
}

function readIdempotencyKey(request: Request): string {
  const raw = request.headers.get("idempotency-key");
  if (raw === null) throw new HttpError(400, "missing_idempotency_key");
  const key = raw.trim();
  if (!/^[\x21-\x7E]{1,200}$/.test(key)) throw new HttpError(400, "invalid_idempotency_key");
  return key;
}

function normalizeLedgerStatus(raw: string | null): string {
  if (!raw || raw === "pending_refund" || raw === "pending_manual_refund") return "pending_manual_refund";
  if (LEDGER_STATUSES.has(raw)) return raw;
  throw new HttpError(400, "invalid_status");
}

async function publicCall(request: Request, env: Env, call: PublicCall, path: string): Promise<Response> {
  const parsed = parseBearer(request);
  if (!("token" in parsed)) {
    logEvent("info", { message: "public", path, status: 401, key_prefix: parsed.prefix, error: "invalid_api_key" });
    return json({ ok: false, error: "invalid_api_key" }, 401);
  }
  const resolved = await resolveKey(env, parsed.token);
  if (resolved.kind !== "active") {
    const error = resolved.kind === "revoked" ? "revoked" : "invalid_api_key";
    logEvent("info", { message: "public", path, status: 401, key_prefix: resolved.key_prefix, error });
    return json({ ok: false, error }, 401);
  }
  const result = await env.USER_LOCK.getByName(resolved.usa_user_id).handle(resolved.id, call);
  if (result.status === 401) {
    try {
      await env.KEY_CACHE.delete(cacheKey(resolved.key_hash));
    } catch {
      // The next DO read still sees revoked_at.
    }
  }
  logEvent(result.status >= 500 ? "error" : "info", {
    message: "public",
    path,
    status: result.status,
    key_prefix: resolved.key_prefix,
    error: result.body.error ?? null,
    charge_id: result.body.charge_id ?? null,
  });
  const extra =
    result.status === 429 && typeof result.body.retry_after === "number"
      ? { "retry-after": String(result.body.retry_after) }
      : undefined;
  return json(result.body, result.status, extra);
}

async function adminMint(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const { usaUserId, fromApp, ticket, emailMasked } = validateMintBody(await readJson(request));
  const { plaintext, prefix } = generateApiKey();
  const keyHash = await sha256Hex(plaintext);
  let encrypted: { ciphertext: string; iv: string };
  try {
    encrypted = await encryptTicket(env.TICKET_ENCRYPTION_KEY, ticket);
  } catch {
    throw new HttpError(500, "misconfigured");
  }
  const id = crypto.randomUUID();
  const minted = await env.USER_LOCK.getByName(usaUserId).mint({
    id,
    keyHash,
    keyPrefix: prefix,
    usaUserId,
    fromApp,
    ticketCiphertext: encrypted.ciphertext,
    ticketIv: encrypted.iv,
    emailMasked,
  });
  logEvent("info", {
    message: "admin_mint",
    key_prefix: minted.keyPrefix,
    usa_user_id: usaUserId,
    from_app: fromApp,
    revoked: minted.revokedIds.length,
  });
  return json({
    ok: true,
    key: plaintext,
    id: minted.id,
    key_prefix: minted.keyPrefix,
    usa_user_id: usaUserId,
    from_app: fromApp,
    revoked_ids: minted.revokedIds,
  });
}

async function adminRevoke(request: Request, env: Env, keyId: string): Promise<Response> {
  await requireAdmin(request, env);
  if (!/^[0-9a-f-]{36}$/i.test(keyId)) throw new HttpError(404, "not_found");
  const row = await getPublicKeyById(env.DB, keyId);
  if (!row) throw new HttpError(404, "not_found");
  const revoked = await env.USER_LOCK.getByName(row.usa_user_id).revoke(row.id);
  try {
    await env.KEY_CACHE.delete(cacheKey(row.key_hash));
  } catch {
    // Revoke already deleted the cache from the Durable Object when it found the row.
  }
  if (!revoked.revokedAt) throw new HttpError(404, "not_found");
  logEvent("info", { message: "admin_revoke", key_prefix: row.key_prefix, key_id: row.id });
  return json({ ok: true, id: row.id, key_prefix: row.key_prefix, revoked_at: revoked.revokedAt });
}

async function adminList(request: Request, env: Env, url: URL): Promise<Response> {
  await requireAdmin(request, env);
  const usaUserId = url.searchParams.get("usa_user_id")?.trim() ?? "";
  if (!usaUserId || !/^[A-Za-z0-9_.:@|-]{1,128}$/.test(usaUserId)) {
    throw new HttpError(400, "invalid_usa_user_id");
  }
  const today = utcDate();
  const listed = await env.DB.prepare(
    `SELECT id, key_prefix, usa_user_id, from_app, email_masked, created_at, revoked_at,
            CASE WHEN daily_debit_date = ? THEN daily_debit_sum ELSE 0 END AS daily_used
     FROM api_keys
     WHERE usa_user_id = ?
     ORDER BY created_at DESC`,
  )
    .bind(today, usaUserId)
    .all<{
      id: string;
      key_prefix: string;
      usa_user_id: string;
      from_app: string;
      email_masked: string | null;
      created_at: string;
      revoked_at: string | null;
      daily_used: number;
    }>();
  logEvent("info", { message: "admin_list_keys", usa_user_id: usaUserId, count: listed.results?.length ?? 0 });
  return json({
    ok: true,
    daily_cap: DAILY_DEBIT_CAP,
    keys: (listed.results ?? []).map((row) => ({
      id: row.id,
      key_prefix: row.key_prefix,
      usa_user_id: row.usa_user_id,
      from_app: row.from_app,
      email_masked: row.email_masked,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
      daily_used: row.daily_used,
      daily_cap: DAILY_DEBIT_CAP,
    })),
  });
}

async function adminLedger(request: Request, env: Env, url: URL): Promise<Response> {
  await requireAdmin(request, env);
  const status = normalizeLedgerStatus(url.searchParams.get("status"));
  const order = status === "pending_manual_refund" ? "ASC" : "DESC";
  const listed = await env.DB.prepare(
    `SELECT l.id, l.key_id, k.key_prefix, l.usa_user_id, l.idempotency_key, l.cost, l.tool, l.ref,
            l.status, l.usa_balance_before, l.usa_balance_after, l.created_at, l.error
     FROM ledger l
     LEFT JOIN api_keys k ON k.id = l.key_id
     WHERE l.status = ?
     ORDER BY l.created_at ${order}
     LIMIT 100`,
  )
    .bind(status)
    .all();
  logEvent("info", { message: "admin_ledger", status, count: listed.results?.length ?? 0 });
  return json({ ok: true, status, entries: listed.results ?? [] });
}

function stamp(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = requestIdOf();
    try {
      const response = await route(request, env, url);
      return stamp(response, requestId);
    } catch (error) {
      if (error instanceof HttpError) {
        logEvent(error.status >= 500 ? "error" : "info", {
          message: "request",
          request_id: requestId,
          path: url.pathname,
          status: error.status,
          error: error.code,
        });
        return stamp(json({ ok: false, error: error.code }, error.status), requestId);
      }
      logEvent("error", {
        message: "unhandled",
        request_id: requestId,
        path: url.pathname,
        error: error instanceof Error ? error.name : "error",
      });
      return stamp(json({ ok: false, error: "internal_error" }, 500), requestId);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/") return htmlResponse(renderHome());
  if (request.method === "GET" && pathname === "/privacy") return htmlResponse(renderPrivacy());
  if (request.method === "GET" && pathname === "/readme") {
    return new Response(README_MARKDOWN, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (pathname === "/mcp" || pathname === "/mcp/") return handleMcpRequest(request, env);
  if (pathname === "/v1/refund") return json({ ok: false, error: "not_found" }, 404);

  if (pathname === "/v1/me" && request.method === "GET") {
    return publicCall(request, env, { op: "me" }, pathname);
  }
  if (pathname === "/v1/balance" && request.method === "GET") {
    return publicCall(request, env, { op: "balance" }, pathname);
  }
  if (pathname === "/v1/charge" && request.method === "POST") {
    const call = chargeCall(await readJson(request), readIdempotencyKey(request));
    return publicCall(request, env, call, pathname);
  }
  if (pathname === "/v1/admin/keys" && request.method === "POST") return adminMint(request, env);
  if (pathname === "/v1/admin/keys" && request.method === "GET") return adminList(request, env, url);
  const revoke = /^\/v1\/admin\/keys\/([^/]+)\/revoke$/.exec(pathname);
  if (revoke && request.method === "POST") return adminRevoke(request, env, decodeURIComponent(revoke[1] ?? ""));
  if (pathname === "/v1/admin/ledger" && request.method === "GET") return adminLedger(request, env, url);
  return json({ ok: false, error: "not_found" }, 404);
}
