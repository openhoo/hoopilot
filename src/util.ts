import type { JsonObject } from "./types";

/** Remove any trailing slashes from a URL or path string. */
export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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
