import { cacheKey, KEY_CACHE_TTL_SECONDS } from "./constants";
import { isWellFormedKey, keyPrefixFromPlaintext, sha256Hex } from "./crypto";
import { getKeyByHash } from "./db";
import { isRecord } from "./http";

type CachedKey = {
  id: string;
  key_prefix: string;
  usa_user_id: string;
  from_app: string;
  revoked_at: string | null;
};

export type ResolvedKey =
  | {
      kind: "active";
      id: string;
      key_prefix: string;
      usa_user_id: string;
      from_app: string;
      key_hash: string;
    }
  | { kind: "revoked"; key_prefix: string }
  | { kind: "missing"; key_prefix: string };

function isCachedKey(value: unknown): value is CachedKey {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.key_prefix === "string" &&
    typeof value.usa_user_id === "string" &&
    typeof value.from_app === "string" &&
    (value.revoked_at === null || typeof value.revoked_at === "string")
  );
}

export function parseBearer(request: Request): { token: string } | { prefix: string | null } {
  const header = (request.headers.get("authorization") ?? "").trim();
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1] ?? "";
  if (!isWellFormedKey(token)) {
    return { prefix: token.startsWith("sk_live_") ? token.slice(0, 12) : null };
  }
  return { token };
}

export async function resolveKey(env: Env, token: string): Promise<ResolvedKey> {
  const keyHash = await sha256Hex(token);
  const prefix = keyPrefixFromPlaintext(token);
  const storedKey = cacheKey(keyHash);
  try {
    const cached = await env.KEY_CACHE.get(storedKey, "json");
    if (isCachedKey(cached)) {
      if (cached.revoked_at) return { kind: "revoked", key_prefix: cached.key_prefix };
      return { kind: "active", ...cached, key_hash: keyHash };
    }
  } catch {
    // A cache failure falls through to D1.
  }
  const row = await getKeyByHash(env.DB, keyHash);
  if (!row) return { kind: "missing", key_prefix: prefix };
  const payload: CachedKey = {
    id: row.id,
    key_prefix: row.key_prefix,
    usa_user_id: row.usa_user_id,
    from_app: row.from_app,
    revoked_at: row.revoked_at,
  };
  try {
    await env.KEY_CACHE.put(storedKey, JSON.stringify(payload), { expirationTtl: KEY_CACHE_TTL_SECONDS });
  } catch {
    // D1 remains authoritative inside the per-user Durable Object.
  }
  if (row.revoked_at) return { kind: "revoked", key_prefix: row.key_prefix };
  return {
    kind: "active",
    id: payload.id,
    key_prefix: payload.key_prefix,
    usa_user_id: payload.usa_user_id,
    from_app: payload.from_app,
    key_hash: keyHash,
  };
}
