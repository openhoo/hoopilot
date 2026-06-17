// Self-update and update-notification orchestration. The pure decision logic
// lives in update-core.ts; this module performs the network and filesystem I/O.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errorDetails } from "./logger";
import type { HoopilotLogger } from "./types";
import {
  assetNameFor,
  assetSuffixFor,
  checksumFor,
  codexxShimFiles,
  formatUpdateNotice,
  type InstallKind,
  isOutdated,
  isUpdateCheckDisabled,
  type LatestRelease,
  latestReleaseApiUrl,
  parseLatestRelease,
  parseState,
  resolveCacheDir,
  shouldCleanupOldBinary,
  shouldRefresh,
  type UpdateState,
  upgradeCommandFor,
} from "./update-core";
import { BAKED_TARGET, IS_STANDALONE_BINARY } from "./version";

const REQUEST_TIMEOUT_MS = 8_000;
const SHA256SUMS = "SHA256SUMS";

function userAgent(version: string): string {
  return `hoopilot/${version}`;
}

function cacheDir(): string {
  return resolveCacheDir(process.env, process.platform, homedir(), join);
}

function stateFilePath(): string {
  return join(cacheDir(), "update-check.json");
}

async function readStateSafe(): Promise<UpdateState> {
  try {
    return parseState(await readFile(stateFilePath(), "utf8"));
  } catch {
    return { lastCheck: 0, latestVersion: null, etag: null };
  }
}

async function writeStateSafe(state: UpdateState): Promise<void> {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    await writeFile(stateFilePath(), JSON.stringify(state), "utf8");
  } catch {
    // best effort: a read-only cache dir must never break the CLI
  }
}

interface FetchResult {
  status: number;
  etag: string | null;
  release: LatestRelease | null;
}

async function fetchLatest(version: string, etag?: string | null): Promise<FetchResult | null> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": userAgent(version),
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (etag) {
      headers["If-None-Match"] = etag;
    }
    const response = await fetch(latestReleaseApiUrl(), {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 304) {
      return { status: 304, etag: etag ?? null, release: null };
    }
    if (!response.ok) {
      return { status: response.status, etag: null, release: null };
    }
    return {
      status: response.status,
      etag: response.headers.get("etag"),
      release: parseLatestRelease(await response.json()),
    };
  } catch {
    return null; // offline / timeout: caller leaves state untouched
  }
}

/**
 * Print a notice if a previously-cached check found a newer release, then kick
 * off a throttled background refresh. Never blocks on the network and never
 * throws. Intended to be called (unawaited is fine) from the serve path.
 */
export async function maybeNotifyUpdate(
  currentVersion: string,
  kind: InstallKind,
  logger?: HoopilotLogger,
): Promise<void> {
  if (isUpdateCheckDisabled(process.env, Boolean(process.stderr.isTTY))) {
    logger?.debug({ event: "update.check.skipped" }, "update check skipped");
    return;
  }
  const state = await readStateSafe();
  if (state.latestVersion && isOutdated(currentVersion, state.latestVersion)) {
    logger?.debug(
      {
        currentVersion,
        event: "update.notice.cached",
        installKind: kind,
        latestVersion: state.latestVersion,
      },
      "showing cached update notice",
    );
    process.stderr.write(formatUpdateNotice(currentVersion, state.latestVersion, kind));
  }
  if (shouldRefresh(state.lastCheck, Date.now())) {
    logger?.debug({ event: "update.check.refresh_queued" }, "queued update check refresh");
    void refreshState(currentVersion, state.etag ?? null, logger).catch((error: unknown) => {
      logger?.debug(
        { err: errorDetails(error), event: "update.check.refresh_failed" },
        "update check refresh failed",
      );
    });
  }
}

async function refreshState(
  currentVersion: string,
  etag: string | null,
  logger?: HoopilotLogger,
): Promise<void> {
  const result = await fetchLatest(currentVersion, etag);
  if (!result) {
    logger?.debug({ event: "update.check.unavailable" }, "update check unavailable");
    return; // network error: keep prior state
  }
  if (result.status === 304) {
    const prev = await readStateSafe();
    await writeStateSafe({ ...prev, lastCheck: Date.now() });
    logger?.debug({ event: "update.check.not_modified" }, "latest release unchanged");
    return;
  }
  if (result.release) {
    await writeStateSafe({
      lastCheck: Date.now(),
      latestVersion: result.release.version,
      etag: result.etag,
    });
    logger?.debug(
      { event: "update.check.updated", latestVersion: result.release.version },
      "updated cached latest release state",
    );
  }
}

function detectInstallKind(): InstallKind {
  return IS_STANDALONE_BINARY ? "binary" : "npm";
}

function detectMusl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const report = process.report?.getReport?.() as
      | { header?: Record<string, unknown> }
      | undefined;
    if (report?.header && "glibcVersionRuntime" in report.header) {
      return !report.header.glibcVersionRuntime;
    }
  } catch {
    // fall through to file-based detection
  }
  try {
    if (existsSync("/etc/alpine-release")) {
      return true;
    }
    const ldd = execFileSync("ldd", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2_000,
    });
    return /musl/i.test(ldd);
  } catch {
    return false;
  }
}

async function downloadToFile(url: string, dest: string, version: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent(version) },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 10),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  await writeFile(dest, new Uint8Array(await response.arrayBuffer()));
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function verifyChecksum(
  release: LatestRelease,
  assetName: string,
  file: string,
  version: string,
): Promise<void> {
  const sums = release.assets.find((asset) => asset.name === SHA256SUMS);
  if (!sums) {
    // Fail closed: never overwrite the running binary with an unverified download.
    throw new Error(
      `Release ${release.tag} has no ${SHA256SUMS}; refusing to install an unverified binary.`,
    );
  }
  const response = await fetch(sums.url, {
    headers: { "User-Agent": userAgent(version) },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Could not download ${SHA256SUMS} (${response.status}).`);
  }
  const expected = checksumFor(await response.text(), assetName);
  if (!expected) {
    throw new Error(`No checksum for ${assetName} in ${SHA256SUMS}.`);
  }
  const actual = await sha256File(file);
  if (actual.toLowerCase() !== expected) {
    throw new Error(`Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}.`);
  }
}

function swapBinary(tmpFile: string, exePath: string): void {
  if (process.platform === "win32") {
    // A running .exe cannot be overwritten, but it can be renamed aside.
    const oldExe = `${exePath}.old`;
    try {
      rmSync(oldExe, { force: true });
    } catch {
      // a previous .old may still be locked; the new name still wins below
    }
    renameSync(exePath, oldExe);
    const restore = () => {
      try {
        renameSync(oldExe, exePath); // put the working binary back
      } catch {
        // nothing more we can do
      }
    };
    try {
      renameSync(tmpFile, exePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        try {
          copyFileSync(tmpFile, exePath);
        } catch (copyError) {
          restore();
          throw copyError;
        }
      } else {
        restore();
        throw error;
      }
    }
    return;
  }
  // Unix: atomic rename over the running file; the old inode stays mapped until exit.
  try {
    renameSync(tmpFile, exePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EXDEV") {
      copyFileSync(tmpFile, exePath);
      chmodSync(exePath, 0o755);
    } else if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `No permission to update ${exePath}. Re-run with sudo, or reinstall to a writable directory.`,
      );
    } else {
      throw error;
    }
  }
}

function refreshCodexxShim(dir: string, logger?: HoopilotLogger): void {
  try {
    for (const file of codexxShimFiles(process.platform)) {
      const path = join(dir, file.name);
      writeFileSync(path, file.content, "utf8");
      if (file.executable) {
        chmodSync(path, 0o755);
      }
    }
  } catch (error) {
    logger?.warn(
      { err: errorDetails(error), event: "update.codexx_shim_failed" },
      "could not refresh codexx shim",
    );
    console.warn(`Updated hoopilot, but could not refresh the codexx shim: ${errorMessage(error)}`);
  }
}

/** Remove the leftover ".old" binary from a prior Windows self-update. */
export function cleanupOldBinary(): void {
  if (!shouldCleanupOldBinary(process.platform, IS_STANDALONE_BINARY)) {
    return;
  }
  try {
    rmSync(`${realpathSync(process.execPath)}.old`, { force: true });
  } catch {
    // still locked or already gone
  }
}

/** Implements the `hoopilot update` command. */
export async function runUpdate(currentVersion: string, logger?: HoopilotLogger): Promise<void> {
  cleanupOldBinary();
  const kind = detectInstallKind();
  logger?.debug({ currentVersion, event: "update.started", installKind: kind }, "update started");

  if (kind !== "binary") {
    console.log(`hoopilot ${currentVersion} was installed via npm.`);
    console.log(`Update with: ${upgradeCommandFor("npm")}`);
    return;
  }

  console.log(`hoopilot ${currentVersion} — checking for updates...`);
  const result = await fetchLatest(currentVersion);
  const release = result?.release ?? null;
  if (!release) {
    throw new Error("Could not reach GitHub to check for the latest release.");
  }
  if (!isOutdated(currentVersion, release.version)) {
    logger?.debug(
      { currentVersion, event: "update.already_current", latestVersion: release.version },
      "hoopilot is already up to date",
    );
    console.log(`Already up to date (latest: ${release.version}).`);
    return;
  }

  const suffix = BAKED_TARGET ?? assetSuffixFor(process.platform, process.arch, detectMusl());
  const assetName = assetNameFor(suffix);
  const asset = release.assets.find((entry) => entry.name === assetName);
  if (!asset) {
    const available = release.assets.map((entry) => entry.name).join(", ") || "none";
    throw new Error(`Release ${release.tag} has no asset "${assetName}". Available: ${available}.`);
  }

  console.log(`Updating ${currentVersion} → ${release.version} (${assetName})...`);
  logger?.debug(
    {
      assetName,
      currentVersion,
      event: "update.installing",
      latestVersion: release.version,
    },
    "installing update",
  );
  const exePath = realpathSync(process.execPath);
  const tmpFile = join(dirname(exePath), `.hoopilot-update-${process.pid}.tmp`);
  try {
    await downloadToFile(asset.url, tmpFile, currentVersion);
    await verifyChecksum(release, assetName, tmpFile, currentVersion);
    if (process.platform !== "win32") {
      chmodSync(tmpFile, 0o755);
    }
    swapBinary(tmpFile, exePath);
    refreshCodexxShim(dirname(exePath), logger);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `No permission to update ${exePath}. Re-run with sudo, or reinstall to a writable directory (e.g. set HOOPILOT_INSTALL_DIR).`,
      );
    }
    throw error;
  } finally {
    try {
      rmSync(tmpFile, { force: true });
    } catch {
      // already moved into place or never created
    }
  }

  console.log(`Updated hoopilot to ${release.version}.`);
  logger?.debug(
    { currentVersion, event: "update.completed", latestVersion: release.version },
    "update completed",
  );
  if (process.platform === "win32") {
    console.log("Restart hoopilot to run the new version.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
