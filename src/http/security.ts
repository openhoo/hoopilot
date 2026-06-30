import { createHash, timingSafeEqual } from "node:crypto";
import { envValue, isLoopbackHostname } from "../util";

export const FORBIDDEN_BROWSER_ORIGIN_MESSAGE =
  "Cross-origin browser requests are blocked unless the Origin is loopback or listed in HOOPILOT_ALLOWED_ORIGINS.";

const MIN_NON_LOOPBACK_API_KEY_LENGTH = 24;
const WELL_KNOWN_DEMO_API_KEYS = new Set([
  "changeme",
  "demo",
  "example",
  "hoopilot",
  "local-key",
  "password",
  "password123",
  "secret",
  "test",
]);

// CORS headers shared by every response. The `access-control-allow-origin` value
// is intentionally omitted here and set per request by the outer HTTP bookend.
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-headers":
      "anthropic-beta, anthropic-dangerous-direct-browser-access, anthropic-version, authorization, content-type, x-api-key, x-request-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-expose-headers": "x-request-id",
  };
}

export function isAuthorized(request: Request, apiKey: string | undefined): boolean {
  if (!apiKey) {
    return true;
  }
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return (
    (bearer !== undefined && secretEquals(bearer, apiKey)) ||
    secretEquals(request.headers.get("x-api-key") ?? "", apiKey)
  );
}

export function forbiddenBrowserOrigin(
  origin: string | undefined,
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): string | undefined {
  if (origin) {
    return isAllowedOrigin(origin, allowedOrigins) ? undefined : origin;
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  return fetchSite === "cross-site" ? "cross-site" : undefined;
}

export function parseAllowedOrigins(env: NodeJS.ProcessEnv | undefined): ReadonlySet<string> {
  const raw = envValue(env?.HOOPILOT_ALLOWED_ORIGINS);
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
}

export function resolveCorsAllowOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): string | undefined {
  if (!origin) {
    return "*";
  }
  return isAllowedOrigin(origin, allowedOrigins) ? origin : undefined;
}

export function apiKeyRejectionReason(apiKey: string): string | undefined {
  const normalized = apiKey.trim();
  if (WELL_KNOWN_DEMO_API_KEYS.has(normalized.toLowerCase())) {
    return "HOOPILOT_API_KEY is a well-known demo value. Set a strong, unique API key.";
  }
  if (normalized.length < MIN_NON_LOOPBACK_API_KEY_LENGTH) {
    return `HOOPILOT_API_KEY must be at least ${MIN_NON_LOOPBACK_API_KEY_LENGTH} characters when listening on a non-loopback host.`;
  }
  if (/^(.)\1+$/.test(normalized)) {
    return "HOOPILOT_API_KEY must not be a repeated single character. Set a strong, unique API key.";
  }
  return undefined;
}

export function isLoopbackHost(host: string): boolean {
  return isLoopbackHostname(host);
}

export function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

// Compare two secrets in constant time. Both sides are hashed to a fixed-width
// digest first so neither the key length nor a prefix match leaks via timing.
function secretEquals(candidate: string, secret: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

function isAllowedOrigin(origin: string, allowedOrigins: ReadonlySet<string>): boolean {
  return isLoopbackOrigin(origin) || allowedOrigins.has(origin.toLowerCase());
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}
