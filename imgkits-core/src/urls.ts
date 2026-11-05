import { ToolError } from "./errors";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

const BLOCKED_SUFFIXES = [
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

/**
 * Reject obvious SSRF targets before any upstream or image fetch. The upstream
 * still fetches the URL, so it must also enforce egress controls; this is a
 * cheap first gate, not a DNS-rebinding-proof sandbox.
 */
export function assertPublicUrl(raw: string, field: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError(`${field} is not a valid absolute URL.`, "invalid_url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError(`${field} must use http or https.`, "invalid_url");
  }
  if (url.username || url.password) {
    throw new ToolError(`${field} must not contain embedded credentials.`, "invalid_url");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host) throw new ToolError(`${field} has no hostname.`, "invalid_url");

  if (host.includes(":")) {
    assertPublicIpv6(host, field);
    return url.toString();
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    assertPublicIpv4(host, field);
    return url.toString();
  }

  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new ToolError(`${field} points to a private, local, or metadata host.`, "blocked_url");
  }
  if (!host.includes(".")) {
    throw new ToolError(`${field} must use a public multi-label hostname.`, "blocked_url");
  }
  // Reject non-canonical numeric hosts such as 0x7f000001 or 2130706433.
  if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(host)) {
    throw new ToolError(`${field} must not use a numeric host literal.`, "blocked_url");
  }

  return url.toString();
}

function assertPublicIpv4(host: string, field: string): void {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new ToolError(`${field} has an invalid IPv4 address.`, "invalid_url");
  }
  const [a, b] = parts;
  const blocked =
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
  if (blocked) {
    throw new ToolError(`${field} points to a private or reserved IPv4 address.`, "blocked_url");
  }
}

function assertPublicIpv6(host: string, field: string): void {
  const normalized = host.toLowerCase();
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("::ffff:")
  ) {
    throw new ToolError(`${field} points to a private or reserved IPv6 address.`, "blocked_url");
  }
}
