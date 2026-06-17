import type { JsonObject } from "./types";

/** Remove any trailing slashes from a URL or path string. */
export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** True for HTTPS URLs, or HTTP only on loopback hosts used by local tests/dev. */
export function isHttpsOrLoopbackUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
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
