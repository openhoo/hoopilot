import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStoredCopilotAuth } from "../src/auth-store";
import { parseArgs, runModels, verifyCopilotOAuthToken } from "../src/cli";
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

  it("rejects invalid logging options", () => {
    expect(() => parseArgs(["--log-level", "verbose"])).toThrow("Invalid log level");
    expect(() => parseArgs(["--log-format", "text"])).toThrow("Invalid log format");
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
