import type { JsonObject } from "./types";

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

function isLoopbackHttpUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]")
  );
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
