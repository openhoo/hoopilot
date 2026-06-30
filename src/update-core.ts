// Pure, dependency-free logic for version checks and self-update decisions.
// Everything here is side-effect free so it can be unit tested without network
// or filesystem access; the I/O orchestration lives in update.ts.

const REPO_OWNER = "openhoo";
const REPO_NAME = "hoopilot";
export const REPO = `${REPO_OWNER}/${REPO_NAME}`;
export const NPM_PACKAGE = "@openhoo/hoopilot";

/** How a copy of hoopilot was installed. */
export type InstallKind = "binary" | "npm";

/** How often the background update check is allowed to hit GitHub. */
export const UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 24; // 24h

/** Persisted state for the throttled update check. */
export interface UpdateState {
  lastCheck: number;
  latestVersion: string | null;
  etag: string | null;
}

export interface CodexxShimFile {
  content: string;
  executable: boolean;
  name: string;
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(input: string): SemVer | null {
  const value = String(input)
    .trim()
    .replace(/^[v=]+/, "");
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    // Build metadata (everything after "+") is intentionally dropped.
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  // A release outranks an otherwise-equal prerelease.
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    // The version with more prerelease fields has higher precedence.
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
    }
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) {
        return diff < 0 ? -1 : 1;
      }
    } else if (xNumeric) {
      return -1; // numeric identifiers sort lower than alphanumeric
    } else if (yNumeric) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1; // ASCII lexical
    }
  }
  return 0;
}

/**
 * Compare two semantic versions. Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Tolerates a leading "v"/"=", ignores build metadata, honors prerelease
 * precedence, and sorts unparseable input low so a bad value never throws.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    if (!pa && !pb) {
      return 0;
    }
    return pa ? 1 : -1;
  }
  if (pa.major !== pb.major) {
    return pa.major < pb.major ? -1 : 1;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor < pb.minor ? -1 : 1;
  }
  if (pa.patch !== pb.patch) {
    return pa.patch < pb.patch ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** True when `latest` is a strictly newer release than `current`. */
export function isOutdated(current: string, latest: string): boolean {
  return compareSemver(current, latest) < 0;
}

/** Strip a leading "v" from a git tag to get a bare version string. */
export function versionFromTag(tag: string): string {
  return tag.trim().replace(/^v/, "");
}

/**
 * Compute the release asset suffix for a platform/arch, e.g. "linux-x64-musl",
 * "darwin-arm64", "windows-x64". `platform`/`arch` use Node's process values.
 */
export function assetSuffixFor(platform: string, arch: string, isMusl: boolean): string {
  const os =
    platform === "linux"
      ? "linux"
      : platform === "win32"
        ? "windows"
        : platform === "darwin"
          ? "darwin"
          : undefined;
  if (!os) {
    throw new Error(`Unsupported platform for standalone updates: ${platform}.`);
  }

  const cpu =
    arch === "x64" || arch === "amd64"
      ? "x64"
      : arch === "arm64" || arch === "aarch64"
        ? "arm64"
        : undefined;
  if (!cpu) {
    throw new Error(`Unsupported architecture for standalone updates: ${arch}.`);
  }

  const libc = os === "linux" && isMusl ? "-musl" : "";
  return `${os}-${cpu}${libc}`;
}

/** Full release asset file name for a suffix (adds .exe for Windows). */
export function assetNameFor(suffix: string): string {
  const name = `hoopilot-${suffix}`;
  return suffix.startsWith("windows-") ? `${name}.exe` : name;
}

/** Whether automatic update checks should be skipped, per env + TTY. */
export function isUpdateCheckDisabled(
  env: Record<string, string | undefined>,
  isTty: boolean,
): boolean {
  if (env.HOOPILOT_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER) {
    return true;
  }
  if (env.NODE_ENV === "test") {
    return true;
  }
  if (!isTty) {
    return true; // piped / non-interactive output
  }
  if (
    (env.CI && env.CI !== "false") ||
    env.CONTINUOUS_INTEGRATION ||
    env.GITHUB_ACTIONS ||
    env.BUILD_NUMBER ||
    env.RUN_ID
  ) {
    return true;
  }
  return false;
}

/** Whether the background check is due again given the last check time. */
export function shouldRefresh(
  lastCheck: number,
  now: number,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
): boolean {
  return now - lastCheck >= intervalMs;
}

/** The command a user runs to upgrade, depending on how they installed. */
export function upgradeCommandFor(kind: InstallKind): string {
  return kind === "binary"
    ? "hoopilot update"
    : `npm install -g ${NPM_PACKAGE}@latest  (or: bun add -g ${NPM_PACKAGE})`;
}

/** Whether it is safe to remove a leftover Windows self-update backup. */
export function shouldCleanupOldBinary(platform: string, isStandaloneBinary: boolean): boolean {
  return platform === "win32" && isStandaloneBinary;
}

/** Files that expose the standalone `codexx` command next to the `hoopilot` binary. */
export function codexxShimFiles(platform: string): CodexxShimFile[] {
  if (platform === "win32") {
    return [
      {
        content: `$ErrorActionPreference = 'Stop'
$hoopilot = Join-Path $PSScriptRoot 'hoopilot.exe'
& $hoopilot codexx @args
exit $LASTEXITCODE
`,
        executable: false,
        name: "codexx.ps1",
      },
      {
        content: `@echo off
setlocal
where pwsh >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0codexx.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0codexx.ps1" %*
)
exit /b %ERRORLEVEL%
`,
        executable: false,
        name: "codexx.cmd",
      },
    ];
  }
  return [
    {
      content: `#!/bin/sh
set -eu
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec "$script_dir/hoopilot" codexx "$@"
`,
      executable: true,
      name: "codexx",
    },
  ];
}

/** Render the "update available" notice printed to stderr. */
export function formatUpdateNotice(current: string, latest: string, kind: InstallKind): string {
  return (
    `\nUpdate available for hoopilot: ${current} → ${latest}\n` +
    `Run: ${upgradeCommandFor(kind)}\n\n`
  );
}

/** Parse the persisted update-check state, tolerating any malformed input. */
export function parseState(text: string): UpdateState {
  try {
    const data: unknown = JSON.parse(text);
    const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    return {
      lastCheck: typeof record.lastCheck === "number" ? record.lastCheck : 0,
      latestVersion: typeof record.latestVersion === "string" ? record.latestVersion : null,
      etag: typeof record.etag === "string" ? record.etag : null,
    };
  } catch {
    return { lastCheck: 0, latestVersion: null, etag: null };
  }
}

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface LatestRelease {
  version: string;
  tag: string;
  assets: Array<ReleaseAsset>;
}

/** Parse the GitHub `releases/latest` response into the fields we need. */
export function parseLatestRelease(json: unknown): LatestRelease | null {
  if (!json || typeof json !== "object") {
    return null;
  }
  const record = json as Record<string, unknown>;
  const tag = typeof record.tag_name === "string" ? record.tag_name : undefined;
  if (!tag) {
    return null;
  }
  const assets: Array<ReleaseAsset> = [];
  if (Array.isArray(record.assets)) {
    for (const item of record.assets) {
      if (item && typeof item === "object") {
        const asset = item as Record<string, unknown>;
        if (typeof asset.name === "string" && typeof asset.browser_download_url === "string") {
          assets.push({ name: asset.name, url: asset.browser_download_url });
        }
      }
    }
  }
  return { version: versionFromTag(tag), tag, assets };
}

/** Find a checksum line for `fileName` in a `sha256sum`-style SHA256SUMS file. */
export function checksumFor(sumsText: string, fileName: string): string | undefined {
  for (const line of sumsText.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match?.[1] && match[2]?.trim() === fileName) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
}

/**
 * Resolve the per-OS cache directory (no deps). Mirrors env-paths conventions:
 * Windows -> %LOCALAPPDATA%, macOS -> ~/Library/Caches, else $XDG_CACHE_HOME||~/.cache.
 */
export function resolveCacheDir(
  env: Record<string, string | undefined>,
  platform: string,
  homedir: string,
  join: (...parts: string[]) => string,
): string {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || join(homedir, "AppData", "Local");
    return join(base, "hoopilot");
  }
  if (platform === "darwin") {
    return join(homedir, "Library", "Caches", "hoopilot");
  }
  const base = env.XDG_CACHE_HOME || join(homedir, ".cache");
  return join(base, "hoopilot");
}

/** Stable redirect URL that downloads an asset from the latest release. */
export function latestDownloadUrl(asset: string): string {
  return `https://github.com/${REPO}/releases/latest/download/${asset}`;
}

/** GitHub REST endpoint for the latest release. */
export function latestReleaseApiUrl(): string {
  return `https://api.github.com/repos/${REPO}/releases/latest`;
}
