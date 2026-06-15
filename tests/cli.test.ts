import { describe, expect, it } from "bun:test";
import { parseArgs, verifyCopilotOAuthToken } from "../src/cli";
import type { FetchLike } from "../src/types";

describe("parseArgs", () => {
  it("accepts OAuth credential store and server options", () => {
    expect(
      parseArgs([
        "serve",
        "--auth-file",
        "/tmp/hoopilot-auth.json",
        "--copilot-api-base-url=https://api.githubcopilot.example",
        "--port",
        "4242",
      ]),
    ).toMatchObject({
      authStorePath: "/tmp/hoopilot-auth.json",
      copilotApiBaseUrl: "https://api.githubcopilot.example",
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
