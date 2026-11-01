export const RATE_LIMIT_PER_MINUTE = 60;
export const DAILY_DEBIT_CAP = 500;
export const MAX_ACTIVE_KEYS = 2;
export const KEY_CACHE_TTL_SECONDS = 60;
export const DEFAULT_USA_TIMEOUT_MS = 5_000;
export const KEY_RANDOM_BYTES = 32;
export const KEY_PREFIX_HEX_CHARS = 4;

export const USA_STATUS_PATH = "/api/user/status";
export const USA_DOWNLOAD_PATH = "/api/order/download";

export function cacheKey(keyHash: string): string {
  return `key:${keyHash}`;
}

export function utcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function readTimeoutMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_USA_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 15_000) {
    return DEFAULT_USA_TIMEOUT_MS;
  }
  return parsed;
}
