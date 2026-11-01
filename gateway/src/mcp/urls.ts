import { AppError } from "./http";

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_URL_LENGTH = 2048;

// PDF + raster images only. DOCX is deliberately excluded from this release.
const ALLOWED_EXTENSIONS = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "tif",
  "tiff",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".corp",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
];

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

export interface UrlOptions {
  maxFiles?: number;
}

/** Validate a user-provided file URL before any credit charge or upstream call. */
export function validateFileUrl(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new AppError(400, "invalid_file_url", "Each file must be a public https URL string.");
  }
  const value = raw.trim();
  if (!value) throw new AppError(400, "invalid_file_url", "File URL must not be empty.");
  if (value.length > MAX_FILE_URL_LENGTH) {
    throw new AppError(400, "invalid_file_url", `File URL must be at most ${MAX_FILE_URL_LENGTH} characters.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, "invalid_file_url", "File URL is not a valid absolute URL.");
  }

  if (url.protocol !== "https:") {
    throw new AppError(400, "invalid_file_url", "Only public https URLs are accepted.");
  }
  if (url.username || url.password) {
    throw new AppError(400, "invalid_file_url", "File URLs must not contain embedded credentials.");
  }
  if (url.port && url.port !== "443") {
    throw new AppError(400, "invalid_file_url", "File URLs must use the default https port.");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new AppError(400, "invalid_file_url", "File URL has no hostname.");

  if (host.startsWith("[") && host.endsWith("]")) {
    assertPublicIpv6(host.slice(1, -1));
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    assertPublicIpv4(host);
  } else {
    if (BLOCKED_HOSTS.has(host)) {
      throw new AppError(400, "blocked_file_url", "Private, local, or metadata hosts are not allowed.");
    }
    if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      throw new AppError(400, "blocked_file_url", "Private, local, or metadata hosts are not allowed.");
    }
    if (!host.includes(".")) {
      throw new AppError(400, "blocked_file_url", "Single-label hosts are not allowed.");
    }
    // Reject non-canonical numeric hosts (for example 0x7f000001 or 2130706433).
    if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(host)) {
      throw new AppError(400, "blocked_file_url", "Numeric host literals are not allowed.");
    }
  }

  const extension = extensionOf(url.pathname);
  if (!extension) {
    throw new AppError(
      400,
      "unsupported_file_type",
      "File URL must point directly to a file with a supported extension (pdf, png, jpeg, webp, bmp, tiff).",
    );
  }
  if (extension === "docx" || extension === "doc") {
    throw new AppError(
      400,
      "unsupported_file_type",
      "DOCX/DOC input is not supported in this release. Use PDF or an image.",
    );
  }
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new AppError(
      400,
      "unsupported_file_type",
      "Unsupported file type. Supported: pdf, png, jpeg, webp, bmp, tiff.",
    );
  }

  return url.toString();
}

export function validateFileUrls(raw: unknown, options: UrlOptions = {}): string[] {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(400, "invalid_files", `Provide between 1 and ${maxFiles} file URLs in "files".`);
  }
  if (raw.length > maxFiles) {
    throw new AppError(400, "too_many_files", `At most ${maxFiles} files are allowed per call.`);
  }
  const urls = raw.map((item) => validateFileUrl(item));
  if (new Set(urls).size !== urls.length) {
    throw new AppError(400, "duplicate_file_url", "Duplicate file URLs are not allowed.");
  }
  return urls;
}

function extensionOf(pathname: string): string {
  const last = pathname.split("/").pop() ?? "";
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // Keep the raw segment when percent-decoding fails.
  }
  const dot = decoded.lastIndexOf(".");
  if (dot < 0 || dot === decoded.length - 1) return "";
  return decoded.slice(dot + 1).toLowerCase();
}

function assertPublicIpv4(host: string): void {
  const parts = host.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    throw new AppError(400, "blocked_file_url", "Invalid IP address in file URL.");
  }
  const [a, b, c] = parts as [number, number, number, number];
  const blocked =
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
  if (blocked) {
    throw new AppError(400, "blocked_file_url", "Private, local, or metadata IP addresses are not allowed.");
  }
}

function assertPublicIpv6(rawHost: string): void {
  const host = rawHost.toLowerCase();
  const zone = host.indexOf("%");
  const withoutZone = zone >= 0 ? host.slice(0, zone) : host;
  const groups = expandIpv6(withoutZone);
  if (!groups) {
    throw new AppError(400, "blocked_file_url", "Invalid IPv6 address in file URL.");
  }

  const [g0, g1, g2, g3, g4, g5] = groups;
  const unspecifiedOrLoopback =
    groups.slice(0, 7).every((group) => group === 0) && (groups[7] ?? 0) <= 1;
  const uniqueLocal = (g0 & 0xfe00) === 0xfc00;
  const linkLocal = (g0 & 0xffc0) === 0xfe80;
  const multicast = (g0 & 0xff00) === 0xff00;
  const documentation = g0 === 0x2001 && g1 === 0x0db8;
  const teredo = g0 === 0x2001 && g1 === 0x0000;
  const sixToFour = g0 === 0x2002;
  const nat64 = g0 === 0x0064 && g1 === 0xff9b;
  const ipv4Mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;

  if (
    unspecifiedOrLoopback ||
    uniqueLocal ||
    linkLocal ||
    multicast ||
    documentation ||
    teredo ||
    sixToFour ||
    nat64 ||
    ipv4Mapped
  ) {
    throw new AppError(400, "blocked_file_url", "Private, local, or metadata IPv6 addresses are not allowed.");
  }
}

function expandIpv6(host: string): number[] | null {
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;

  const groups: string[] = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return parsed.some((group) => Number.isNaN(group)) ? null : parsed;
}

interface PreflightOptions {
  fetchImpl: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Best-effort size/content-type check before charging. A HEAD request is not
 * followed across redirects, so a public URL cannot redirect this Worker into
 * a private network. Non-2xx or failed HEAD requests are ignored; the upstream
 * gateway enforces its own hard size limit.
 */
export async function preflightFileUrls(urls: string[], options: PreflightOptions): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  const timeoutMs = options.timeoutMs ?? 4_000;
  await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await options.fetchImpl(url, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: "application/pdf,image/*;q=0.9,*/*;q=0.1" },
        });
        if (!response.ok) return;
        const htmlType = (response.headers.get("content-type") ?? "").toLowerCase();
        if (htmlType.startsWith("text/html")) {
          throw new AppError(415, "unsupported_file_type", "The URL returned an HTML page, not a PDF or image.");
        }
        const length = Number(response.headers.get("content-length") ?? "");
        if (Number.isFinite(length) && length > maxBytes) {
          throw new AppError(
            413,
            "file_too_large",
            `Each file must be at most ${Math.floor(maxBytes / (1024 * 1024))} MiB.`,
          );
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        // Network failure, timeout, or HEAD unsupported: let the upstream decide.
      }
    }),
  );
}
