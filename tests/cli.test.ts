import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStoredCopilotAuth, writeStoredCopilotAuth } from "../src/auth-store";
import {
  main,
  openBrowserBestEffort,
  parseArgs,
  runLogin,
  runModels,
  runUsage,
  verifyCopilotOAuthToken,
} from "../src/cli";
import type { FetchLike } from "../src/types";

describe("parseArgs", () => {
  it("accepts OAuth credential store and server options", () => {
    expect(
      parseArgs([
        "serve",
        "--auth-file",
        "/tmp/hoopilot-auth.json",
        "--copilot-api-base-url=https://api.githubcopilot.com",
        "--log-format",
        "pretty",
        "--log-level=debug",
        "--stream-mode",
        "buffer",
        "--port",
        "4242",
      ]),
    ).toMatchObject({
      authStorePath: "/tmp/hoopilot-auth.json",
      copilotApiBaseUrl: "https://api.githubcopilot.com",
      logFormat: "pretty",
      logLevel: "debug",
      port: 4242,
      streamingProxyMode: "buffer",
    });
  });

  it("keeps equals signs inside inline option values", () => {
    expect(
      parseArgs([
        "--api-key=abc=def",
        "--copilot-api-base-url=https://api.githubcopilot.com/models?token=a=b",
      ]),
    ).toMatchObject({
      apiKey: "abc=def",
      copilotApiBaseUrl: "https://api.githubcopilot.com/models?token=a=b",
    });
  });

  it("reads local API keys from files", () => {
    const dir = mkdtempSync(join(tmpdir(), "hoopilot-api-key-test-"));
    try {
      const keyPath = join(dir, "key");
      writeFileSync(keyPath, "abc=def\n", "utf8");

      expect(parseArgs(["--api-key-file", keyPath])).toMatchObject({
        apiKey: "abc=def",
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("accepts the login token printing flag", () => {
    expect(parseArgs(["--print-key"])).toMatchObject({ printToken: true });
    expect(parseArgs(["--print-token"])).toMatchObject({ printToken: true });
  });

  it("rejects removed token and auth mode options", () => {
    for (const option of [
      "--auth-mode",
      "--copilot-token",
      "--github-token",
      "--github-token-command",
      "--no-gh",
    ]) {
      expect(() => parseArgs([option, "value"])).toThrow("Unknown option");
    }
  });

  it("rejects stray arguments and unknown flags without consuming following tokens", () => {
    expect(() => parseArgs(["serve", "prompt"])).toThrow("Unknown argument: prompt");
    expect(() => parseArgs(["unknown-command"])).toThrow("Unknown argument: unknown-command");
    expect(() => parseArgs(["--bogus"])).toThrow("Unknown option: --bogus");
    expect(() => parseArgs(["--bogus", "value"])).toThrow("Unknown option: --bogus");
  });

  it("rejects invalid logging options", () => {
    expect(() => parseArgs(["--log-level", "verbose"])).toThrow("Invalid log level");
    expect(() => parseArgs(["--log-format", "text"])).toThrow("Invalid log format");
  });

  it("rejects invalid stream modes", () => {
    expect(() => parseArgs(["--stream-mode", "fast"])).toThrow("Invalid stream mode");
  });

  it("rejects ports outside the TCP range", () => {
    expect(() => parseArgs(["--port", "0"])).toThrow("Invalid port");
    expect(() => parseArgs(["--port", "65536"])).toThrow("Invalid port");
  });
});

describe("main", () => {
  it("routes hoopilot codexx to the codexx entrypoint", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => {
      lines.push(values.join(" "));
    };
    try {
      await main(["codexx", "--help"]);
    } finally {
      console.log = originalLog;
    }

    expect(lines.join("\n")).toContain("codexx");
    expect(lines.join("\n")).toContain(
      "Run Codex against an already-running local Hoopilot server",
    );
  });

  it("honors version flags on subcommands before running them", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => {
      lines.push(values.join(" "));
    };
    try {
      await main(["login", "--version"]);
      await main(["update", "--version"]);
    } finally {
      console.log = originalLog;
    }

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d+\.\d+\.\d+/);
    expect(lines[1]).toBe(lines[0]);
  });
});

describe("runLogin", () => {
  it("prints only the received OAuth token to stdout when requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hoopilot-login-test-"));
    try {
      const authPath = join(dir, "auth.json");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const requests: Request[] = [];
      const originalLog = console.log;
      const originalError = console.error;
      console.log = (...values: unknown[]) => {
        stdout.push(values.join(" "));
      };
      console.error = (...values: unknown[]) => {
        stderr.push(values.join(" "));
      };
      try {
        await runLogin({
          authStorePath: authPath,
          deviceLogin: async (options) => {
            options.logger?.info("First copy your one-time code: ABCD-1234");
            return { domain: "github.com", token: "oauth-token" };
          },
          fetch: async (input, init) => {
            requests.push(new Request(input, init));
            return Response.json({ data: [{ id: "gpt-5.5" }] });
          },
          printToken: true,
        });
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }

      expect(stdout).toEqual(["oauth-token"]);
      expect(stderr).toContain("Starting GitHub Copilot browser login...");
      expect(stderr).toContain("First copy your one-time code: ABCD-1234");
      expect(stderr).toContain("Checking GitHub Copilot access...");
      expect(stderr).toContain(`Copilot OAuth credential stored at ${authPath}`);
      expect(stderr).toContain("Copilot authentication ready.");
      expect(readStoredCopilotAuth(authPath)).toMatchObject({
        apiBaseUrl: "https://api.githubcopilot.com",
        githubDomain: "github.com",
        source: "github-device-oauth",
        token: "oauth-token",
      });
      expect(requests[0]!.url).toBe("https://api.githubcopilot.com/models");
      expect(requests[0]!.headers.get("authorization")).toBe("Bearer oauth-token");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("openBrowserBestEffort", () => {
  it("ignores missing browser opener executables", async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    let unrefCalled = false;
    child.unref = () => {
      unrefCalled = true;
    };

    openBrowserBestEffort("https://github.com/login/device", () => child);
    child.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));
    await Promise.resolve();

    expect(unrefCalled).toBe(true);
  });
});

describe("verifyCopilotOAuthToken", () => {
  it("verifies that the OAuth token can reach the Copilot API", async () => {
    const requests: Request[] = [];
    const fetcher: FetchLike = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ data: [{ id: "gpt-5.5" }] });
    };

    const access = await verifyCopilotOAuthToken("oauth-token", {
      copilotApiBaseUrl: "https://api.githubcopilot.com/",
      fetch: fetcher,
    });

    expect(access).toMatchObject({
      apiBaseUrl: "https://api.githubcopilot.com",
      source: "github-copilot-oauth",
      token: "oauth-token",
    });
    expect(requests[0]!.url).toBe("https://api.githubcopilot.com/models");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer oauth-token");
    expect(requests[0]!.headers.get("x-github-api-version")).toBe("2026-06-01");
  });

  it("allows custom HTTPS Copilot hosts only with the unsafe upstream opt-in", async () => {
    const requests: Request[] = [];

    const access = await verifyCopilotOAuthToken("oauth-token", {
      copilotApiBaseUrl: "https://api.githubcopilot.example/",
      env: { HOOPILOT_ALLOW_UNSAFE_UPSTREAM: "1" },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ data: [{ id: "gpt-5.5" }] });
      },
    });

    expect(access.apiBaseUrl).toBe("https://api.githubcopilot.example");
    expect(requests[0]!.url).toBe("https://api.githubcopilot.example/models");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer oauth-token");
  });

  it("reports Copilot auth failures as auth errors", async () => {
    const fetcher: FetchLike = async () => new Response("forbidden", { status: 403 });

    await expect(
      verifyCopilotOAuthToken("bad-token", {
        fetch: fetcher,
      }),
    ).rejects.toThrow("GitHub Copilot API verification failed with 403");
  });

  it("does not send OAuth tokens to untrusted Copilot API URLs", async () => {
    for (const copilotApiBaseUrl of ["http://copilot.internal", "https://evil.example"]) {
      let calls = 0;

      await expect(
        verifyCopilotOAuthToken("oauth-token", {
          copilotApiBaseUrl,
          fetch: async () => {
            calls += 1;
            return Response.json({});
          },
        }),
      ).rejects.toThrow("Refusing to send the GitHub OAuth token to an untrusted Copilot API host");
      expect(calls).toBe(0);
    }
  });
});

describe("runModels", () => {
  it("prints the available Copilot model IDs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hoopilot-cli-test-"));
    try {
      const authPath = join(dir, "auth.json");
      writeStoredCopilotAuth(
        {
          apiBaseUrl: "https://api.githubcopilot.com",
          token: "oauth-token",
        },
        authPath,
      );

      const requests: Request[] = [];
      const fetcher: FetchLike = async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          data: [{ id: "gpt-4.1" }, { id: "gpt-5.5" }, { id: "gpt-5.5" }],
        });
      };
      const lines: string[] = [];
      const originalLog = console.log;
      console.log = (...values: unknown[]) => {
        lines.push(values.join(" "));
      };
      try {
        const ids = await runModels({ authStorePath: authPath, fetch: fetcher });
        expect(ids).toEqual(["gpt-4.1", "gpt-5.5"]);
      } finally {
        console.log = originalLog;
      }

      expect(lines).toEqual(["gpt-4.1", "gpt-5.5"]);
      expect(requests[0]!.url).toBe("https://api.githubcopilot.com/models");
      expect(requests[0]!.headers.get("authorization")).toBe("Bearer oauth-token");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("runUsage", () => {
  it("prints the Copilot plan and quota", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hoopilot-usage-test-"));
    try {
      const authPath = join(dir, "auth.json");
      writeStoredCopilotAuth({ token: "oauth-token" }, authPath);

      const requests: Request[] = [];
      const fetcher: FetchLike = async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          access_type_sku: "copilot_pro",
          copilot_plan: "individual_pro",
          quota_reset_date: "2026-07-01",
          quota_snapshots: {
            chat: { unlimited: true },
            premium_interactions: {
              entitlement: 300,
              percent_remaining: 88.5,
              remaining: 265.5,
              unlimited: false,
            },
          },
        });
      };
      const lines: string[] = [];
      const originalLog = console.log;
      console.log = (...values: unknown[]) => {
        lines.push(values.join(" "));
      };
      try {
        const usage = await runUsage({ authStorePath: authPath, fetch: fetcher });
        expect(usage.plan).toBe("individual_pro");
      } finally {
        console.log = originalLog;
      }

      expect(requests[0]!.url).toBe("https://api.github.com/copilot_internal/user");
      expect(requests[0]!.headers.get("authorization")).toBe("token oauth-token");
      expect(requests[0]!.headers.get("x-github-api-version")).toBe("2025-04-01");
      expect(lines).toContain("Plan: individual_pro");
      expect(lines).toContain("Quota resets: 2026-07-01");
      expect(lines).toContain("Premium requests: 34.5/300 used, 88.5% remaining");
      expect(lines).toContain("Chat: unlimited");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("reports Copilot usage auth failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hoopilot-usage-fail-"));
    try {
      const authPath = join(dir, "auth.json");
      writeStoredCopilotAuth({ token: "oauth-token" }, authPath);
      const fetcher: FetchLike = async () => new Response("forbidden", { status: 403 });

      await expect(runUsage({ authStorePath: authPath, fetch: fetcher })).rejects.toThrow(
        "GitHub Copilot usage request failed with 403",
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("does not send OAuth tokens to untrusted GitHub usage API URLs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hoopilot-usage-host-fail-"));
    try {
      const authPath = join(dir, "auth.json");
      writeStoredCopilotAuth({ token: "oauth-token" }, authPath);
      let calls = 0;

      await expect(
        runUsage({
          authStorePath: authPath,
          fetch: async () => {
            calls += 1;
            return Response.json({});
          },
          githubApiBaseUrl: "https://evil.example",
        }),
      ).rejects.toThrow("Refusing to send the GitHub OAuth token to an untrusted GitHub API host");
      expect(calls).toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
