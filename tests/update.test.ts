import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  assetNameFor,
  assetSuffixFor,
  checksumFor,
  compareSemver,
  formatUpdateNotice,
  isOutdated,
  isUpdateCheckDisabled,
  latestDownloadUrl,
  latestReleaseApiUrl,
  parseLatestRelease,
  parseState,
  resolveCacheDir,
  shouldCleanupOldBinary,
  shouldRefresh,
  upgradeCommandFor,
  versionFromTag,
} from "../src/update-core";
import { getVersion } from "../src/version";

describe("compareSemver", () => {
  it("orders major, minor, and patch numerically (not lexically)", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.0.0")).toBe(1);
    expect(compareSemver("1.2.0", "1.10.0")).toBe(-1);
    expect(compareSemver("1.0.9", "1.0.10")).toBe(-1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("ignores a leading v or = and build metadata", () => {
    expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("=1.0.0", "v1.0.0")).toBe(0);
    expect(compareSemver("1.0.0+build.9", "1.0.0+build.1")).toBe(0);
  });

  it("treats a prerelease as lower than the matching release", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("orders the prerelease precedence chain from the semver spec", () => {
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      // Assert both directions so a sign flip in the comparator is caught.
      expect(compareSemver(chain[i] as string, chain[i + 1] as string)).toBe(-1);
      expect(compareSemver(chain[i + 1] as string, chain[i] as string)).toBe(1);
    }
  });

  it("orders asymmetric prerelease fields in the greater-than direction", () => {
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1); // more fields wins
    expect(compareSemver("1.0.0-beta.11", "1.0.0-beta.2")).toBe(1); // numeric, not lexical
    expect(compareSemver("1.0.0-alpha", "1.0.0-1")).toBe(1); // alphanumeric > numeric
  });

  it("continues past equal prerelease fields to the first difference", () => {
    expect(compareSemver("1.0.0-alpha.1.1", "1.0.0-alpha.1.2")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.1.2", "1.0.0-alpha.1.1")).toBe(1);
  });

  it("sorts unparseable versions low and equal-when-both-bad", () => {
    expect(compareSemver("not-a-version", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "garbage")).toBe(1);
    expect(compareSemver("x", "y")).toBe(0);
  });
});

describe("isOutdated", () => {
  it("is true only when latest is strictly newer", () => {
    expect(isOutdated("0.2.4", "0.2.5")).toBe(true);
    expect(isOutdated("0.2.5", "0.2.5")).toBe(false);
    expect(isOutdated("0.3.0", "0.2.5")).toBe(false);
  });
});

describe("versionFromTag", () => {
  it("strips a leading v", () => {
    expect(versionFromTag("v0.2.5")).toBe("0.2.5");
    expect(versionFromTag("0.2.5")).toBe("0.2.5");
    expect(versionFromTag("  v1.0.0  ")).toBe("1.0.0");
  });
});

describe("assetSuffixFor / assetNameFor", () => {
  it("maps platform and arch to a release suffix", () => {
    expect(assetSuffixFor("linux", "x64", false)).toBe("linux-x64");
    expect(assetSuffixFor("linux", "arm64", false)).toBe("linux-arm64");
    expect(assetSuffixFor("linux", "x64", true)).toBe("linux-x64-musl");
    expect(assetSuffixFor("linux", "aarch64", true)).toBe("linux-arm64-musl");
    expect(assetSuffixFor("darwin", "arm64", false)).toBe("darwin-arm64");
    expect(assetSuffixFor("darwin", "x64", true)).toBe("darwin-x64");
    expect(assetSuffixFor("win32", "x64", false)).toBe("windows-x64");
    expect(assetSuffixFor("win32", "arm64", false)).toBe("windows-arm64");
  });

  it("adds .exe only for Windows asset names", () => {
    expect(assetNameFor("linux-x64")).toBe("hoopilot-linux-x64");
    expect(assetNameFor("darwin-arm64")).toBe("hoopilot-darwin-arm64");
    expect(assetNameFor("windows-x64")).toBe("hoopilot-windows-x64.exe");
    expect(assetNameFor("windows-arm64")).toBe("hoopilot-windows-arm64.exe");
  });
});

describe("isUpdateCheckDisabled", () => {
  const tty = true;

  it("is disabled by opt-out env vars", () => {
    expect(isUpdateCheckDisabled({ HOOPILOT_NO_UPDATE_CHECK: "1" }, tty)).toBe(true);
    expect(isUpdateCheckDisabled({ NO_UPDATE_NOTIFIER: "1" }, tty)).toBe(true);
    expect(isUpdateCheckDisabled({ NODE_ENV: "test" }, tty)).toBe(true);
  });

  it("is disabled in CI environments", () => {
    expect(isUpdateCheckDisabled({ CI: "true" }, tty)).toBe(true);
    expect(isUpdateCheckDisabled({ GITHUB_ACTIONS: "true" }, tty)).toBe(true);
    expect(isUpdateCheckDisabled({ CONTINUOUS_INTEGRATION: "1" }, tty)).toBe(true);
    expect(isUpdateCheckDisabled({ BUILD_NUMBER: "42" }, tty)).toBe(true);
    expect(isUpdateCheckDisabled({ RUN_ID: "x" }, tty)).toBe(true);
  });

  it("treats CI=false as not CI", () => {
    expect(isUpdateCheckDisabled({ CI: "false" }, tty)).toBe(false);
  });

  it("is disabled when output is not a TTY", () => {
    expect(isUpdateCheckDisabled({}, false)).toBe(true);
  });

  it("is enabled for an interactive, non-CI environment", () => {
    expect(isUpdateCheckDisabled({}, true)).toBe(false);
  });
});

describe("shouldRefresh", () => {
  it("refreshes only after the interval has elapsed", () => {
    expect(shouldRefresh(1000, 1000 + 5000, 10_000)).toBe(false);
    expect(shouldRefresh(1000, 1000 + 10_000, 10_000)).toBe(true);
    expect(shouldRefresh(0, 999_999_999, 10_000)).toBe(true);
  });
});

describe("upgradeCommandFor / formatUpdateNotice", () => {
  it("returns the right upgrade command per install kind", () => {
    expect(upgradeCommandFor("binary")).toBe("hoopilot update");
    expect(upgradeCommandFor("npm")).toContain("npm install -g @openhoo/hoopilot@latest");
  });

  it("renders a notice with both versions and the command", () => {
    const notice = formatUpdateNotice("0.2.4", "0.2.5", "binary");
    expect(notice).toContain("0.2.4 → 0.2.5");
    expect(notice).toContain("hoopilot update");
  });
});

describe("shouldCleanupOldBinary", () => {
  it("only allows cleanup for standalone Windows binaries", () => {
    expect(shouldCleanupOldBinary("win32", true)).toBe(true);
    expect(shouldCleanupOldBinary("win32", false)).toBe(false);
    expect(shouldCleanupOldBinary("linux", true)).toBe(false);
    expect(shouldCleanupOldBinary("darwin", true)).toBe(false);
  });
});

describe("parseState", () => {
  it("parses a valid state file", () => {
    const state = parseState(JSON.stringify({ lastCheck: 5, latestVersion: "1.0.0", etag: "W/x" }));
    expect(state).toEqual({ lastCheck: 5, latestVersion: "1.0.0", etag: "W/x" });
  });

  it("returns defaults for malformed or partial input", () => {
    expect(parseState("not json")).toEqual({ lastCheck: 0, latestVersion: null, etag: null });
    expect(parseState("{}")).toEqual({ lastCheck: 0, latestVersion: null, etag: null });
    expect(parseState(JSON.stringify({ lastCheck: "x", latestVersion: 5 }))).toEqual({
      lastCheck: 0,
      latestVersion: null,
      etag: null,
    });
  });
});

describe("parseLatestRelease", () => {
  it("extracts version, tag, and well-formed assets", () => {
    const release = parseLatestRelease({
      tag_name: "v0.2.5",
      assets: [
        { name: "hoopilot-linux-x64", browser_download_url: "https://x/linux" },
        { name: "SHA256SUMS", browser_download_url: "https://x/sums" },
        { name: "bad" }, // missing url -> skipped
        null,
      ],
    });
    expect(release?.version).toBe("0.2.5");
    expect(release?.tag).toBe("v0.2.5");
    expect(release?.assets).toEqual([
      { name: "hoopilot-linux-x64", url: "https://x/linux" },
      { name: "SHA256SUMS", url: "https://x/sums" },
    ]);
  });

  it("returns null for invalid input", () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease("string")).toBeNull();
    expect(parseLatestRelease({ assets: [] })).toBeNull();
  });

  it("tolerates a missing assets array", () => {
    const release = parseLatestRelease({ tag_name: "v1.2.3" });
    expect(release?.version).toBe("1.2.3");
    expect(release?.assets).toEqual([]);
  });
});

describe("checksumFor", () => {
  const sums = [
    "abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd  hoopilot-linux-x64",
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef *hoopilot-windows-x64.exe",
  ].join("\n");

  it("finds the hash for a file name (with and without the binary marker)", () => {
    expect(checksumFor(sums, "hoopilot-linux-x64")).toBe(
      "abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd",
    );
    expect(checksumFor(sums, "hoopilot-windows-x64.exe")).toBe(
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
  });

  it("returns undefined when the file is absent", () => {
    expect(checksumFor(sums, "hoopilot-darwin-arm64")).toBeUndefined();
  });
});

describe("resolveCacheDir", () => {
  it("uses platform-appropriate locations", () => {
    expect(resolveCacheDir({ LOCALAPPDATA: "C:\\Local" }, "win32", "C:\\Users\\me", join)).toBe(
      join("C:\\Local", "hoopilot"),
    );
    expect(resolveCacheDir({}, "darwin", "/Users/me", join)).toBe(
      join("/Users/me", "Library", "Caches", "hoopilot"),
    );
    expect(resolveCacheDir({ XDG_CACHE_HOME: "/xdg" }, "linux", "/home/me", join)).toBe(
      join("/xdg", "hoopilot"),
    );
    expect(resolveCacheDir({}, "linux", "/home/me", join)).toBe(
      join("/home/me", ".cache", "hoopilot"),
    );
    expect(resolveCacheDir({}, "win32", "C:\\Users\\me", join)).toBe(
      join("C:\\Users\\me", "AppData", "Local", "hoopilot"),
    );
  });
});

describe("release URLs", () => {
  it("builds the API and latest-download URLs for the repo", () => {
    expect(latestReleaseApiUrl()).toBe(
      "https://api.github.com/repos/openhoo/hoopilot/releases/latest",
    );
    expect(latestDownloadUrl("hoopilot-linux-x64")).toBe(
      "https://github.com/openhoo/hoopilot/releases/latest/download/hoopilot-linux-x64",
    );
  });
});

describe("getVersion", () => {
  it("resolves the package version in dev/npm mode", async () => {
    const version = await getVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
