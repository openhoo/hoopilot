import { describe, expect, it } from "bun:test";
import { CopilotAuth, splitCommand } from "../src/auth";
import type { FetchLike } from "../src/types";

describe("CopilotAuth", () => {
  it("exchanges a GitHub token for a Copilot token", async () => {
    const requests: Request[] = [];
    const fetcher: FetchLike = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        endpoints: {
          api: "https://api.githubcopilot.example",
        },
        expires_at: Math.floor(Date.now() / 1000) + 600,
        token: "copilot-token",
      });
    };

    const auth = new CopilotAuth({
      env: {},
      fetch: fetcher,
      githubToken: "github-token",
      githubTokenCommand: false,
    });

    const access = await auth.getAccess();
    expect(access).toMatchObject({
      apiBaseUrl: "https://api.githubcopilot.example",
      source: "github-token",
      token: "copilot-token",
    });
    expect(requests[0]!.headers.get("authorization")).toBe("token github-token");
  });

  it("falls back to direct GitHub token mode in auto auth mode", async () => {
    const auth = new CopilotAuth({
      env: {},
      fetch: async () => new Response("no exchange", { status: 404 }),
      githubToken: "github-token",
      githubTokenCommand: false,
    });

    const access = await auth.getAccess();
    expect(access.source).toBe("direct-github-token");
    expect(access.token).toBe("github-token");
  });

  it("supports direct GitHub token mode from a token command", async () => {
    const auth = new CopilotAuth({
      authMode: "direct-github-token",
      env: { COPILOT_API_BASE_URL: "https://copilot.example/" },
      githubTokenCommand: "printf command-token",
    });

    const access = await auth.getAccess();
    expect(access).toMatchObject({
      apiBaseUrl: "https://copilot.example",
      source: "direct-github-token",
      token: "command-token",
    });
  });

  it("uses a direct Copilot API token without exchange", async () => {
    const auth = new CopilotAuth({
      copilotToken: "direct-token",
      env: {},
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
      githubTokenCommand: false,
    });

    const access = await auth.getAccess();
    expect(access.source).toBe("copilot-token");
    expect(access.token).toBe("direct-token");
  });

  it("requires a direct token in copilot-token mode", async () => {
    const auth = new CopilotAuth({
      authMode: "copilot-token",
      env: {},
      githubTokenCommand: false,
    });

    await expect(auth.getAccess()).rejects.toThrow("COPILOT_API_TOKEN");
  });

  it("fails fast on exchange errors in github-token mode", async () => {
    const auth = new CopilotAuth({
      authMode: "github-token",
      env: {},
      fetch: async () => new Response("denied", { status: 403 }),
      githubToken: "github-token",
      githubTokenCommand: false,
    });

    await expect(auth.getAccess()).rejects.toThrow("403");
  });

  it("rejects exchange responses without a token", async () => {
    const auth = new CopilotAuth({
      authMode: "github-token",
      env: {},
      fetch: async () =>
        Response.json({ expires_at: new Date(Date.now() + 600_000).toISOString() }),
      githubToken: "github-token",
      githubTokenCommand: false,
    });

    await expect(auth.getAccess()).rejects.toThrow("did not include a token");
  });

  it("reports missing credentials", async () => {
    const auth = new CopilotAuth({
      env: {},
      githubTokenCommand: false,
    });

    await expect(auth.getAccess()).rejects.toThrow("No Copilot credential found");
  });
});

describe("splitCommand", () => {
  it("splits quoted commands", () => {
    expect(splitCommand('gh auth token --hostname "github.com"')).toEqual([
      "gh",
      "auth",
      "token",
      "--hostname",
      "github.com",
    ]);
  });

  it("handles escaped whitespace", () => {
    expect(splitCommand("printf hello\\ world")).toEqual(["printf", "hello world"]);
  });
});
