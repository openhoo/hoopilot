import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStoredCopilotAuth } from "../src/auth-store";
import { createHoopilotHandler, startHoopilotServer } from "../src/server";
import type { FetchLike, HoopilotServerOptions } from "../src/types";

describe("createHoopilotHandler", () => {
  it("proxies chat completions to Copilot", async () => {
    const upstreamRequests: Request[] = [];
    const handler = createHoopilotHandler(
      oauthOptions(async (input, init) => {
        upstreamRequests.push(new Request(input, init));
        return Response.json({
          choices: [{ message: { content: "hello", role: "assistant" } }],
          model: "gpt-4.1",
        });
      }),
    );

    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        body: JSON.stringify({ messages: [{ content: "hi", role: "user" }], model: "gpt-4.1" }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(upstreamRequests[0]!.url).toBe("https://api.githubcopilot.com/chat/completions");
    expect(upstreamRequests[0]!.headers.get("authorization")).toBe("Bearer oauth-token");
    expect(upstreamRequests[0]!.headers.get("x-github-api-version")).toBe("2026-06-01");
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "hello" } }],
    });
  });

  it("requires the configured local API key", async () => {
    const handler = createHoopilotHandler({
      apiKey: "local-key",
      env: {},
      fetch: unusedFetch,
    });

    const unauthorized = await handler(new Request("http://localhost/v1/models"));
    expect(unauthorized.status).toBe(401);

    const authorized = await handler(
      new Request("http://localhost/healthz", {
        headers: { authorization: "Bearer local-key" },
      }),
    );
    expect(authorized.status).toBe(200);
  });

  it("handles options and unknown routes", async () => {
    const handler = createHoopilotHandler({
      env: {},
      fetch: unusedFetch,
    });

    const options = await handler(
      new Request("http://localhost/v1/models", {
        method: "OPTIONS",
      }),
    );
    expect(options.status).toBe(200);
    expect(options.headers.get("access-control-allow-origin")).toBe("*");

    const missing = await handler(new Request("http://localhost/missing"));
    expect(missing.status).toBe(404);
  });

  it("serves Responses API requests by translating to chat completions", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () =>
        Response.json({
          choices: [{ message: { content: "translated", role: "assistant" } }],
          model: "gpt-4.1",
        }),
      ),
    );

    const response = await handler(
      new Request("http://localhost/v1/responses", {
        body: JSON.stringify({ input: "hello", model: "gpt-4.1" }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      object: "response",
      output_text: "translated",
      status: "completed",
    });
  });

  it("streams Responses API requests", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(
        async () =>
          new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );

    const response = await handler(
      new Request("http://localhost/v1/responses", {
        body: JSON.stringify({ input: "hello", model: "gpt-4.1", stream: true }),
        method: "POST",
      }),
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await expect(response.text()).resolves.toContain('"delta":"ok"');
  });

  it("serves legacy completions", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () =>
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: "legacy", role: "assistant" } }],
          model: "gpt-4.1",
        }),
      ),
    );

    const response = await handler(
      new Request("http://localhost/v1/completions", {
        body: JSON.stringify({ model: "gpt-4.1", prompt: "hello" }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ text: "legacy" }],
      object: "text_completion",
    });
  });

  it("maps upstream non-auth errors to OpenAI-style errors", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () => new Response("rate limited", { status: 429 })),
    );

    const response = await handler(
      new Request("http://localhost/v1/responses", {
        body: JSON.stringify({ input: "hello" }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "copilot_error", message: "rate limited" },
    });
  });

  it("maps upstream auth failures to copilot auth errors", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () => new Response("forbidden", { status: 403 })),
    );

    const response = await handler(
      new Request("http://localhost/v1/responses", {
        body: JSON.stringify({ input: "hello" }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "copilot_auth_error",
        message: "GitHub Copilot rejected the credential or account access: forbidden",
      },
    });
  });

  it("maps chat completion auth failures before proxying to Codex", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () => new Response("bad token", { status: 401 })),
    );

    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        body: JSON.stringify({ messages: [{ content: "hi", role: "user" }], model: "gpt-4.1" }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "copilot_auth_error",
        message: "GitHub Copilot rejected the credential or account access: bad token",
      },
    });
  });

  it("normalizes model responses", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () => Response.json({ data: [{ id: "gpt-4.1" }] })),
    );

    const response = await handler(new Request("http://localhost/v1/models"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [{ created: 0, id: "gpt-4.1", object: "model", owned_by: "github-copilot" }],
      object: "list",
    });
  });

  it("falls back to a default model list when upstream model fetch fails", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () => new Response("nope", { status: 500 })),
    );

    const response = await handler(new Request("http://localhost/v1/models"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "gpt-4.1" })],
      object: "list",
    });
  });

  it("does not hide upstream model auth failures behind fallback models", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () => new Response("forbidden", { status: 403 })),
    );

    const response = await handler(new Request("http://localhost/v1/models"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "copilot_auth_error" },
    });
  });

  it("reports invalid JSON bodies", async () => {
    const handler = createHoopilotHandler({
      env: {},
      fetch: unusedFetch,
    });

    const response = await handler(
      new Request("http://localhost/v1/responses", {
        body: "{",
        method: "POST",
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "internal_error", message: "Request body must be valid JSON." },
    });
  });

  it("refuses non-loopback starts without an API key", () => {
    expect(() =>
      startHoopilotServer({
        env: {},
        fetch: unusedFetch,
        host: "0.0.0.0",
        port: 0,
      }),
    ).toThrow("non-loopback");
  });

  it("can start and stop a loopback Bun server", () => {
    const started = startHoopilotServer({
      env: {},
      fetch: unusedFetch,
      port: 0,
    });

    expect(started.url).toStartWith("http://127.0.0.1:");
    started.server.stop(true);
  });
});

const unusedFetch: FetchLike = async () => {
  throw new Error("fetch should not be called");
};

function oauthOptions(fetcher: FetchLike): HoopilotServerOptions {
  return {
    authStorePath: tempAuthPath(),
    env: {},
    fetch: fetcher,
  };
}

function tempAuthPath(): string {
  const path = join(mkdtempSync(join(tmpdir(), "hoopilot-server-test-")), "auth.json");
  writeStoredCopilotAuth({ token: "oauth-token" }, path);
  return path;
}
