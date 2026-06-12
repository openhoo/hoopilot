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
      githubToken: "gho_oauth-token",
      githubTokenCommand: false,
    });

    const access = await auth.getAccess();
    expect(access.source).toBe("direct-github-token");
    expect(access.token).toBe("gho_oauth-token");
  });

  it("rejects personal access tokens", async () => {
    for (const token of ["ghp_classic-token", "github_pat_fine-grained-token"]) {
      const auth = new CopilotAuth({
        env: {},
        fetch: async () => {
          throw new Error("fetch should not be called");
        },
        githubToken: token,
        githubTokenCommand: false,
      });

      await expect(auth.getAccess()).rejects.toThrow("personal access tokens");
    }
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

  it("rejects exchange responses without a token", async () => {
    const auth = new CopilotAuth({
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
