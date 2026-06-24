import { asRecord } from "./util";

// Build-time constants. For standalone binaries these identifiers are replaced
// at compile time via `bun build --compile --define 'HOOPILOT_VERSION="x.y.z"'`
// (see scripts/build-binaries.sh). In dev runs and the npm package they are not
// defined, so `typeof` is "undefined" and we fall back to reading package.json.
declare const HOOPILOT_VERSION: string;
declare const HOOPILOT_TARGET: string;

/** Version baked into a standalone binary, or undefined for npm/dev installs. */
export const BAKED_VERSION: string | undefined =
  typeof HOOPILOT_VERSION !== "undefined" ? HOOPILOT_VERSION : undefined;

/**
 * Release asset suffix baked into a standalone binary (e.g. "linux-x64-musl",
 * "windows-x64", "darwin-arm64"), or undefined for npm/dev installs. Lets the
 * self-updater fetch the exact asset variant it was built from.
 */
export const BAKED_TARGET: string | undefined =
  typeof HOOPILOT_TARGET !== "undefined" ? HOOPILOT_TARGET : undefined;

/** True when running as a `bun build --compile` standalone executable. */
export const IS_STANDALONE_BINARY: boolean = BAKED_VERSION !== undefined;

let cachedVersion: string | undefined;

/** Resolve the running version, preferring the baked value for binaries. */
export async function getVersion(): Promise<string> {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  let resolved: string;
  if (BAKED_VERSION) {
    resolved = BAKED_VERSION;
  } else {
    try {
      const manifest = asRecord(await Bun.file(new URL("../package.json", import.meta.url)).json());
      const version = manifest.version;
      resolved = typeof version === "string" ? version : "0.0.0";
    } catch {
      resolved = "0.0.0";
    }
  }
  cachedVersion = resolved;
  return resolved;
}
