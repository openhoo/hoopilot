import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStoredCopilotAuth } from "../src/auth-store";
import { main, parseArgs, runModels, runUsage, verifyCopilotOAuthToken } from "../src/cli";
import type { FetchLike } from "../src/types";

describe("parseArgs", () => {
  it("accepts OAuth credential store and server options", () => {
    expect(
      parseArgs([
        "serve",
        "--auth-file",
        "/tmp/hoopilot-auth.json",
        "--copilot-api-base-url=https://api.githubcopilot.example",
        "--log-format",
        "pretty",
        "--log-level=debug",
        "--port",
        "4242",
      ]),
    ).toMatchObject({
      authStorePath: "/tmp/hoopilot-auth.json",
      copilotApiBaseUrl: "https://api.githubcopilot.example",
      logFormat: "pretty",
      logLevel: "debug",
      port: 4242,
    });
  });

  it("keeps equals signs inside inline option values", () => {
    expect(
      parseArgs([
        "--api-key=abc=def",
        "--copilot-api-base-url=https://api.githubcopilot.example/models?token=a=b",
      ]),
    ).toMatchObject({
      apiKey: "abc=def",
      copilotApiBaseUrl: "https://api.githubcopilot.example/models?token=a=b",
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
});

describe("verifyCopilotOAuthToken", () => {
  it("verifies that the OAuth token can reach the Copilot API", async () => {
    const requests: Request[] = [];
    const fetcher: FetchLike = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ data: [{ id: "gpt-5.5" }] });
    };

    const access = await verifyCopilotOAuthToken("oauth-token", {
      copilotApiBaseUrl: "https://api.githubcopilot.example/",
      fetch: fetcher,
    });

    expect(access).toMatchObject({
      apiBaseUrl: "https://api.githubcopilot.example",
      source: "github-copilot-oauth",
      token: "oauth-token",
    });
    expect(requests[0]!.url).toBe("https://api.githubcopilot.example/models");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer oauth-token");
    expect(requests[0]!.headers.get("x-github-api-version")).toBe("2026-06-01");
  });

  it("reports Copilot auth failures as auth errors", async () => {
    const fetcher: FetchLike = async () => new Response("forbidden", { status: 403 });

    await expect(
      verifyCopilotOAuthToken("bad-token", {
        fetch: fetcher,
      }),
    ).rejects.toThrow("GitHub Copilot API verification failed with 403");
  });

  it("does not send OAuth tokens to plaintext non-loopback Copilot API URLs", async () => {
    let calls = 0;

    await expect(
      verifyCopilotOAuthToken("oauth-token", {
        copilotApiBaseUrl: "http://copilot.internal",
        fetch: async () => {
          calls += 1;
          return Response.json({});
        },
      }),
    ).rejects.toThrow("Refusing to send the GitHub OAuth token to a non-HTTPS host");
    expect(calls).toBe(0);
  });
});

describe("runModels", () => {
  it("prints the available Copilot model IDs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hoopilot-cli-test-"));
    try {
      const authPath = join(dir, "auth.json");
      writeStoredCopilotAuth(
        {
          apiBaseUrl: "https://api.githubcopilot.example",
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
      expect(requests[0]!.url).toBe("https://api.githubcopilot.example/models");
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
});
