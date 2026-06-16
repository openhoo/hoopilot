import { describe, expect, it } from "bun:test";
import { DEFAULT_GITHUB_COPILOT_CLIENT_ID, githubCopilotDeviceLogin } from "../src/github-device";
import type { FetchLike } from "../src/types";

describe("githubCopilotDeviceLogin", () => {
  it("uses GitHub OAuth device login and returns the access token", async () => {
    const requests: Request[] = [];
    const responses = [
      Response.json({
        device_code: "device-code",
        expires_in: 900,
        interval: 1,
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
      }),
      Response.json({ error: "authorization_pending" }),
      Response.json({ access_token: "oauth-token" }),
    ];
    const fetcher: FetchLike = async (input, init) => {
      requests.push(new Request(input, init));
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected request");
      }
      return response;
    };
    const logs: string[] = [];
    const openedUrls: string[] = [];
    const sleeps: number[] = [];

    const result = await githubCopilotDeviceLogin({
      fetch: fetcher,
      logger: {
        error: (message) => logs.push(message),
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
      },
      openBrowser: (url) => {
        openedUrls.push(url);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result).toEqual({ domain: "github.com", token: "oauth-token" });
    expect(openedUrls).toEqual(["https://github.com/login/device"]);
    expect(logs).toContain("First copy your one-time code: ABCD-1234");
    expect(sleeps).toEqual([4_000, 4_000]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://github.com/login/device/code",
      "https://github.com/login/oauth/access_token",
      "https://github.com/login/oauth/access_token",
    ]);
    await expect(requests[0]!.json()).resolves.toMatchObject({
      client_id: DEFAULT_GITHUB_COPILOT_CLIENT_ID,
      scope: "read:user",
    });
    await expect(requests[1]!.json()).resolves.toMatchObject({
      client_id: DEFAULT_GITHUB_COPILOT_CLIENT_ID,
      device_code: "device-code",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });

  it("supports alternate GitHub domains", async () => {
    const requests: Request[] = [];
    const fetcher: FetchLike = async (input, init) => {
      requests.push(new Request(input, init));
      if (requests.length === 1) {
        return Response.json({
          device_code: "device-code",
          expires_in: 900,
          interval: 1,
          user_code: "ABCD-1234",
          verification_uri: "https://github.example/login/device",
        });
      }
      return Response.json({ access_token: "oauth-token" });
    };

    const result = await githubCopilotDeviceLogin({
      env: { HOOPILOT_GITHUB_DOMAIN: "https://github.example/" },
      fetch: fetcher,
      sleep: async () => {},
    });

    expect(result.domain).toBe("github.example");
    expect(requests[0]!.url).toBe("https://github.example/login/device/code");
  });

  it("handles slow_down polling responses", async () => {
    const responses = [
      Response.json({
        device_code: "device-code",
        expires_in: 900,
        interval: 1,
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
      }),
      Response.json({ error: "slow_down", interval: 7 }),
      Response.json({ access_token: "oauth-token" }),
    ];
    const sleeps: number[] = [];

    const result = await githubCopilotDeviceLogin({
      fetch: async () => responses.shift() ?? Response.json({ access_token: "late-token" }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.token).toBe("oauth-token");
    expect(sleeps).toEqual([4_000, 10_000]);
  });

  it("reports malformed and rejected device authorization responses", async () => {
    await expect(
      githubCopilotDeviceLogin({
        fetch: async () => Response.json({ user_code: "ABCD-1234" }),
      }),
    ).rejects.toThrow("missing required fields");

    await expect(
      githubCopilotDeviceLogin({
        fetch: async () => new Response("bad app", { status: 400 }),
      }),
    ).rejects.toThrow("GitHub device authorization failed with 400: bad app");
  });

  it("reports rejected token polling responses", async () => {
    await expect(
      githubCopilotDeviceLogin({
        fetch: pollFetch(new Response("rate limited", { status: 429 })),
        sleep: async () => {},
      }),
    ).rejects.toThrow("GitHub device token exchange failed with 429: rate limited");
  });

  it("reports terminal GitHub device-login errors", async () => {
    await expect(
      githubCopilotDeviceLogin({
        fetch: pollFetch(Response.json({ error: "expired_token" })),
        sleep: async () => {},
      }),
    ).rejects.toThrow("GitHub device login expired");

    await expect(
      githubCopilotDeviceLogin({
        fetch: pollFetch(Response.json({ error: "access_denied" })),
        sleep: async () => {},
      }),
    ).rejects.toThrow("GitHub device login was cancelled");

    await expect(
      githubCopilotDeviceLogin({
        fetch: pollFetch(
          Response.json({
            error: "bad_verification_code",
            error_description: "verification code was not accepted",
          }),
        ),
        sleep: async () => {},
      }),
    ).rejects.toThrow("verification code was not accepted");
  });

  it("reports a clear error when device authorization returns non-JSON", async () => {
    await expect(
      githubCopilotDeviceLogin({
        fetch: async () => new Response("<html>not json</html>", { status: 200 }),
        sleep: async () => {},
      }),
    ).rejects.toThrow("GitHub device authorization response was not valid JSON");
  });

  it("reports a clear error when token polling returns non-JSON", async () => {
    await expect(
      githubCopilotDeviceLogin({
        fetch: pollFetch(new Response("<html>not json</html>", { status: 200 })),
        sleep: async () => {},
      }),
    ).rejects.toThrow("GitHub device token response was not valid JSON");
  });

  it("times out while waiting for GitHub device authorization", async () => {
    await expect(
      githubCopilotDeviceLogin({
        fetch: pollFetch(Response.json({ error: "authorization_pending" }), {
          expiresIn: 0.001,
        }),
        sleep: async () => {
          await Bun.sleep(2);
        },
      }),
    ).rejects.toThrow("GitHub device login timed out");
  });
});

function pollFetch(tokenResponse: Response, options: { expiresIn?: number } = {}): FetchLike {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json({
        device_code: "device-code",
        expires_in: options.expiresIn ?? 900,
        interval: 1,
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
      });
    }
    return tokenResponse;
  };
}
