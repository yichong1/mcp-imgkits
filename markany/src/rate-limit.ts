/**
 * In-memory sliding window for remove_watermark.
 * The bucket key must already be a hash of the caller credential. This module
 * never stores or logs the raw key. State is per Worker isolate.
 */

const hits = new Map<string, number[]>();

export function resetRemoveWatermarkRateLimits(): void {
  hits.clear();
}

export async function hashCallerKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function consumeRemoveWatermarkRateLimit(
  bucketKey: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): { allowed: true; remaining: number } | { allowed: false; retryAfterMs: number } {
  const cutoff = now - windowMs;
  const recent = (hits.get(bucketKey) ?? []).filter((timestamp) => timestamp > cutoff);
  if (recent.length >= limit) {
    hits.set(bucketKey, recent);
    return { allowed: false, retryAfterMs: Math.max(0, recent[0] + windowMs - now) };
  }
  recent.push(now);
  hits.set(bucketKey, recent);
  return { allowed: true, remaining: limit - recent.length };
}
