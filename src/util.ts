import type { JsonObject, StreamingProxyMode } from "./types";

/** Remove any trailing slashes from a URL or path string. */
export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Treat blank environment variables as unset while preserving nonblank values. */
export function envValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** True for HTTPS URLs, or HTTP only on loopback hosts used by local tests/dev. */
export function isHttpsOrLoopbackUrl(rawUrl: string): boolean {
  const url = parseUrl(rawUrl);
  if (!url) {
    return false;
  }
  return url.protocol === "https:" || isLoopbackHttpUrl(url);
}

/** Validate a base URL before sending a bearer/OAuth token to it. */
export function isTrustedTokenBaseUrl(
  rawUrl: string,
  allowedHttpsHosts: readonly string[],
  allowUnsafeHttps = false,
): boolean {
  const url = parseUrl(rawUrl);
  if (!url) {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) {
    return false;
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    return false;
  }
  if (isLoopbackHttpUrl(url)) {
    return true;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return allowedHttpsHosts.includes(host) || allowUnsafeHttps;
}

function parseUrl(rawUrl: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  return url;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True for hostnames that always resolve to the local machine. */
export function isLoopbackHostname(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(host);
}

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && isLoopbackHostname(url.hostname);
}

/** Read a response body as text, truncated to keep error messages bounded. */
export async function truncatedResponseText(response: Response, max = 500): Promise<string> {
  const text = await response.text();
  return text.slice(0, max);
}

/** Narrow an unknown value to a plain object, returning {} for arrays/primitives/null. */
export function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Return the first finite number among the candidates, else undefined. */
export function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/** Generate a dash-free random identifier for synthesized response/message ids. */
export function randomId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** Drop keys whose value is undefined so they are omitted from JSON output. */
export function removeUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Parse JSON, returning undefined instead of throwing on malformed input. */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parse JSON into a plain object, returning undefined on malformed or non-object input. */
export function parseJsonObject(text: string): JsonObject | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Extract de-duplicated model IDs from an OpenAI-style `/models` response (an
 * object carrying a `data` array, or a bare array of model objects).
 */
export function modelIdsFromResponse(body: unknown): string[] {
  const record = asRecord(body);
  const data = Array.isArray(record.data) ? record.data : Array.isArray(body) ? body : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const model of data) {
    const id = asRecord(model).id;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Canonical set of accepted streaming-proxy modes, kept in sync with {@link StreamingProxyMode}. */
export const STREAMING_PROXY_MODES = [
  "auto",
  "buffer",
  "live",
] as const satisfies readonly StreamingProxyMode[];

/** Validate a stream-mode string against the allowed {@link StreamingProxyMode} values. */
export function parseStreamingProxyMode(value: string): StreamingProxyMode {
  if ((STREAMING_PROXY_MODES as readonly string[]).includes(value)) {
    return value as StreamingProxyMode;
  }
  throw new Error(`Invalid stream mode: ${value}. Expected ${STREAMING_PROXY_MODES.join(", ")}.`);
}
