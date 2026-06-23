import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStoredCopilotAuth } from "../src/auth-store";
import { CopilotClient } from "../src/copilot";
import { MetricsRegistry } from "../src/metrics";
import { createHoopilotHandler, createUsageReader, startHoopilotServer } from "../src/server";
import type { FetchLike, HoopilotLogger, HoopilotServerOptions, LogFields } from "../src/types";

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

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
    await expect(upstreamRequests[0]!.json()).resolves.toMatchObject({ model: "gpt-4.1" });
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
    expect(options.headers.get("access-control-allow-headers")).toContain("x-request-id");
    expect(options.headers.get("access-control-allow-origin")).toBe("*");
    expect(options.headers.get("access-control-expose-headers")).toBe("x-request-id");

    const missing = await handler(new Request("http://localhost/missing"));
    expect(missing.status).toBe(404);
  });

  it("blocks unauthenticated cross-site browser requests before upstream auth is used", async () => {
    let calls = 0;
    const handler = createHoopilotHandler({
      ...oauthOptions(async () => {
        calls += 1;
        return Response.json({ data: [{ id: "gpt-4.1" }] });
      }),
    });

    for (const headers of [
      new Headers({ origin: "https://evil.example" }),
      new Headers({ "sec-fetch-site": "cross-site" }),
    ]) {
      const response = await handler(
        new Request("http://localhost/v1/models", {
          headers,
        }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "forbidden_origin" },
      });
    }
    expect(calls).toBe(0);
  });

  it("allows unauthenticated loopback browser origins", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () => Response.json({ data: [{ id: "gpt-4.1" }] })),
    );

    const response = await handler(
      new Request("http://localhost/v1/models", {
        headers: { origin: "http://localhost:3000" },
      }),
    );

    expect(response.status).toBe(200);
  });

  it("blocks cross-origin browser requests even when an API key is configured", async () => {
    let calls = 0;
    const handler = createHoopilotHandler({
      ...oauthOptions(async () => {
        calls += 1;
        return Response.json({ data: [{ id: "gpt-4.1" }] });
      }),
      apiKey: "local-key",
    });

    // A malicious page's preflight is refused and exposes no readable CORS grant.
    const preflight = await handler(
      new Request("http://localhost/v1/models", {
        headers: {
          "access-control-request-headers": "authorization",
          "access-control-request-method": "GET",
          origin: "https://evil.example",
        },
        method: "OPTIONS",
      }),
    );
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    // Even knowing the key, the actual cross-origin request is refused before upstream.
    const actual = await handler(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer local-key", origin: "https://evil.example" },
      }),
    );
    expect(actual.status).toBe(403);
    expect(actual.headers.get("access-control-allow-origin")).toBeNull();
    await expect(actual.json()).resolves.toMatchObject({ error: { code: "forbidden_origin" } });
    expect(calls).toBe(0);
  });

  it("reflects an allowed origin instead of advertising a wildcard", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () => Response.json({ data: [{ id: "gpt-4.1" }] })),
    );

    const response = await handler(
      new Request("http://localhost/v1/models", {
        headers: { origin: "http://localhost:3000" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("answers a loopback CORS preflight with the reflected origin", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () => Response.json({ data: [{ id: "gpt-4.1" }] })),
    );

    const preflight = await handler(
      new Request("http://localhost/v1/models", {
        headers: {
          "access-control-request-headers": "authorization",
          "access-control-request-method": "GET",
          origin: "http://localhost:3000",
        },
        method: "OPTIONS",
      }),
    );

    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(preflight.headers.get("vary")).toContain("Origin");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("permits cross-origin requests only from explicitly allowlisted origins", async () => {
    const handler = createHoopilotHandler({
      ...oauthOptions(async () => Response.json({ data: [{ id: "gpt-4.1" }] })),
      env: { HOOPILOT_ALLOWED_ORIGINS: "https://app.example, https://other.example" },
    });

    const allowed = await handler(
      new Request("http://localhost/v1/models", {
        headers: { origin: "https://app.example" },
      }),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example");

    const blocked = await handler(
      new Request("http://localhost/v1/models", {
        headers: { origin: "https://not-allowed.example" },
      }),
    );
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("adds request ids and emits structured request completion logs", async () => {
    const logs = captureLogger();
    const handler = createHoopilotHandler({
      env: {},
      fetch: unusedFetch,
      logger: logs.logger,
    });

    const response = await handler(
      new Request("http://localhost/healthz", {
        headers: { "x-request-id": "req-test" },
      }),
    );

    expect(response.headers.get("x-request-id")).toBe("req-test");
    expect(response.headers.get("access-control-expose-headers")).toBe("x-request-id");
    expect(logs.entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          event: "http.request.completed",
          method: "GET",
          path: "/healthz",
          requestId: "req-test",
          route: "health",
          status: 200,
          stream: false,
        }),
        level: "info",
        message: "request completed",
      }),
    );
  });

  it("bounds client-supplied request ids before echoing or logging them", async () => {
    const logs = captureLogger();
    const handler = createHoopilotHandler({
      env: {},
      fetch: unusedFetch,
      logger: logs.logger,
    });

    for (const supplied of ["has spaces", "x".repeat(129)]) {
      const response = await handler(
        new Request("http://localhost/healthz", {
          headers: { "x-request-id": supplied },
        }),
      );

      const echoed = response.headers.get("x-request-id") ?? "";
      expect(echoed).not.toBe(supplied);
      expect(echoed).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    expect(logs.entries.map((entry) => entry.fields.requestId)).not.toContain("has spaces");
  });

  it("creates a logger from server logging options", async () => {
    const handler = createHoopilotHandler({
      env: {},
      fetch: unusedFetch,
      logLevel: "silent",
    });

    const response = await handler(new Request("http://localhost/healthz"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("proxies Responses API requests to Copilot Responses without changing model or effort", async () => {
    const upstreamRequests: Request[] = [];
    const handler = createHoopilotHandler(
      oauthOptions(async (input, init) => {
        upstreamRequests.push(new Request(input, init));
        return Response.json({
          model: "gpt-5.5-2026-04-23",
          object: "response",
          output: [{ content: [{ text: "translated", type: "output_text" }], type: "message" }],
          output_text: "translated",
          status: "completed",
        });
      }),
    );

    const response = await handler(
      new Request("http://localhost/v1/responses", {
        body: JSON.stringify({ input: "hello", model: "gpt-5.5", reasoning: { effort: "xhigh" } }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(upstreamRequests[0]!.url).toBe("https://api.githubcopilot.com/responses");
    await expect(upstreamRequests[0]!.json()).resolves.toMatchObject({
      model: "gpt-5.5",
      reasoning: { effort: "xhigh" },
    });
    await expect(response.json()).resolves.toMatchObject({
      object: "response",
      output_text: "translated",
      status: "completed",
    });
  });

  it("maps Responses API upstream errors without retrying a different model", async () => {
    const upstreamRequests: Request[] = [];
    const handler = createHoopilotHandler(
      oauthOptions(async (input, init) => {
        upstreamRequests.push(new Request(input, init));
        return new Response("rate limited", { status: 429 });
      }),
    );

    const response = await handler(
      new Request("http://localhost/v1/responses", {
        body: JSON.stringify({ input: "hello", model: "gpt-5.5" }),
        method: "POST",
      }),
    );

    expect(upstreamRequests).toHaveLength(1);
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "copilot_error", message: "rate limited" },
    });
  });

  it("accepts Responses API path aliases", async () => {
    const upstreamRequests: Request[] = [];
    const handler = createHoopilotHandler(
      oauthOptions(async (input, init) => {
        upstreamRequests.push(new Request(input, init));
        return Response.json({
          model: "gpt-5.5-2026-04-23",
          object: "response",
          output_text: "translated",
          status: "completed",
        });
      }),
    );

    for (const path of ["/responses", "/v1/responses/"]) {
      const response = await handler(
        new Request(`http://localhost${path}`, {
          body: JSON.stringify({ input: "hello", model: "gpt-4.1" }),
          method: "POST",
        }),
      );

      expect(response.status).toBe(200);
      expect(upstreamRequests.at(-1)!.url).toBe("https://api.githubcopilot.com/responses");
      await expect(response.json()).resolves.toMatchObject({
        object: "response",
        output_text: "translated",
      });
    }
  });

  it("serves Codex remote compaction through a unary Responses call", async () => {
    const upstreamRequests: Request[] = [];
    const compactedOutput = [
      {
        content: [{ annotations: [], text: "compacted", type: "output_text" }],
        role: "assistant",
        type: "message",
      },
    ];
    const handler = createHoopilotHandler(
      oauthOptions(async (input, init) => {
        upstreamRequests.push(new Request(input, init));
        return Response.json({ object: "response", output: compactedOutput, status: "completed" });
      }),
    );

    for (const path of ["/v1/responses/compact", "/responses/compact", "/v1/responses/compact/"]) {
      const response = await handler(
        new Request(`http://localhost${path}`, {
          body: JSON.stringify({
            input: [
              { content: [{ text: "hi", type: "input_text" }], role: "user", type: "message" },
            ],
            instructions: "Summarize the conversation so far.",
            model: "gpt-5.5",
          }),
          method: "POST",
        }),
      );

      expect(response.status).toBe(200);
      const last = upstreamRequests.at(-1)!;
      expect(last.url).toBe("https://api.githubcopilot.com/responses");
      // Compaction is a unary request even though Codex normally streams.
      await expect(last.json()).resolves.toMatchObject({ model: "gpt-5.5", stream: false });
      await expect(response.json()).resolves.toEqual({ output: compactedOutput });
    }
  });

  it("maps Responses compaction upstream errors instead of returning 404", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () => new Response("rate limited", { status: 429 })),
    );

    const response = await handler(
      new Request("http://localhost/v1/responses/compact", {
        body: JSON.stringify({ input: "hi", model: "gpt-5.5" }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "copilot_error", message: "rate limited" },
    });
  });

  it("tells Codex to fall back when Responses WebSocket is probed", async () => {
    const handler = createHoopilotHandler({
      env: {},
      fetch: unusedFetch,
    });

    for (const path of ["/responses", "/v1/responses", "/v1/responses/"]) {
      const response = await handler(new Request(`http://localhost${path}`));

      expect(response.status).toBe(426);
      expect(response.headers.get("upgrade")).toBe("websocket");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "websocket_not_supported" },
      });
    }
  });

  it("streams Responses API requests", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(
        async () =>
          new Response('event: response.output_text.delta\ndata: {"delta":"ok"}\n\n', {
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

  it("serves Claude Code Messages requests through Copilot Responses", async () => {
    const upstreamRequests: Request[] = [];
    const handler = createHoopilotHandler(
      oauthOptions(async (input, init) => {
        upstreamRequests.push(new Request(input, init));
        return Response.json({
          id: "resp_1",
          model: "claude-sonnet-4.5",
          object: "response",
          output: [
            {
              content: [{ text: "hello from claude", type: "output_text" }],
              role: "assistant",
              type: "message",
            },
          ],
          status: "completed",
          usage: { input_tokens: 12, output_tokens: 4 },
        });
      }),
    );

    const response = await handler(
      new Request("http://localhost/v1/messages", {
        body: JSON.stringify({
          max_tokens: 64,
          messages: [{ content: "hi", role: "user" }],
          model: "claude-sonnet-4.5",
          system: "Be terse",
        }),
        headers: { "anthropic-version": "2023-06-01" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(upstreamRequests[0]!.url).toBe("https://api.githubcopilot.com/responses");
    await expect(upstreamRequests[0]!.json()).resolves.toMatchObject({
      input: [
        {
          content: [{ text: "hi", type: "input_text" }],
          role: "user",
          type: "message",
        },
      ],
      instructions: "Be terse",
      max_output_tokens: 64,
      model: "claude-sonnet-4.5",
    });
    await expect(response.json()).resolves.toMatchObject({
      content: [{ text: "hello from claude", type: "text" }],
      model: "claude-sonnet-4.5",
      role: "assistant",
      stop_reason: "end_turn",
      type: "message",
      usage: { input_tokens: 12, output_tokens: 4 },
    });
  });

  it("streams Claude Code Messages responses as Anthropic SSE", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(
        async () =>
          new Response(
            [
              'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"claude-sonnet-4.5"}}\n\n',
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"ok"}\n\n',
              'event: response.completed\ndata: {"type":"response.completed","response":{"model":"claude-sonnet-4.5","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
            ].join(""),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
      ),
    );

    const response = await handler(
      new Request("http://localhost/v1/messages", {
        body: JSON.stringify({
          max_tokens: 64,
          messages: [{ content: "hi", role: "user" }],
          model: "claude-sonnet-4.5",
          stream: true,
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text":"ok"');
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain("event: message_stop");
  });

  it("buffers streaming Claude Code responses when stream mode is buffer", async () => {
    const metrics = new MetricsRegistry();
    const handler = createHoopilotHandler({
      ...oauthOptions(
        async () =>
          new Response(
            [
              'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"claude-sonnet-4.5"}}\n\n',
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"ok"}\n\n',
              'event: response.completed\ndata: {"type":"response.completed","response":{"model":"claude-sonnet-4.5","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
            ].join(""),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
      ),
      metrics,
      streamingProxyMode: "buffer",
    });

    const response = await handler(
      new Request("http://localhost/v1/messages", {
        body: JSON.stringify({
          max_tokens: 64,
          messages: [{ content: "hi", role: "user" }],
          model: "claude-sonnet-4.5",
          stream: true,
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("connection")).toBe("close");
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text":"ok"');
    expect(text).toContain("event: message_stop");
    expect(metrics.snapshot().tokens.byModel["claude-sonnet-4.5"]).toMatchObject({
      completion: 1,
      prompt: 3,
      total: 4,
    });
  });

  it("serves Claude Code token-count preflights without an upstream request", async () => {
    let calls = 0;
    const handler = createHoopilotHandler(
      oauthOptions(async () => {
        calls += 1;
        return Response.json({});
      }),
    );

    const response = await handler(
      new Request("http://localhost/v1/messages/count_tokens", {
        body: JSON.stringify({
          messages: [{ content: "count this", role: "user" }],
          model: "claude-sonnet-4.5",
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { input_tokens: number; total_tokens: number };
    expect(body.input_tokens).toBeGreaterThan(0);
    expect(body.total_tokens).toBe(body.input_tokens);
    expect(calls).toBe(0);
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

  it("streams legacy completions instead of failing on the SSE body", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(
        async () =>
          new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );

    const response = await handler(
      new Request("http://localhost/v1/completions", {
        body: JSON.stringify({ model: "gpt-4.1", prompt: "hello", stream: true }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"text":"hi"');
    expect(text).not.toContain('"delta"');
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

  it("preserves upstream OpenAI-style JSON error objects", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () =>
        Response.json(
          {
            error: {
              code: "model_not_found",
              message: "bad model",
              param: "model",
              type: "invalid_request_error",
            },
          },
          { status: 400 },
        ),
      ),
    );

    const response = await handler(
      new Request("http://localhost/v1/responses", {
        body: JSON.stringify({ input: "hello" }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "model_not_found",
        message: "bad model",
        param: "model",
        type: "invalid_request_error",
      },
    });
  });

  it("maps legacy completions upstream errors", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () => new Response("legacy failed", { status: 502 })),
    );

    const response = await handler(
      new Request("http://localhost/v1/completions", {
        body: JSON.stringify({ model: "gpt-4.1", prompt: "hello" }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "copilot_error", message: "legacy failed" },
    });
  });

  it("rejects unsupported legacy completions fields before proxying upstream", async () => {
    let calls = 0;
    const handler = createHoopilotHandler(
      oauthOptions(async () => {
        calls += 1;
        return Response.json({});
      }),
    );

    const response = await handler(
      new Request("http://localhost/v1/completions", {
        body: JSON.stringify({ model: "gpt-4.1", prompt: ["one", "two"] }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    expect(calls).toBe(0);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request_error",
        message: expect.stringContaining("exactly one string prompt"),
      },
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

  it("does not send stored OAuth tokens to untrusted Copilot API URLs", async () => {
    for (const apiBaseUrl of ["http://copilot.internal", "https://evil.example"]) {
      const path = tempAuthPath();
      writeStoredCopilotAuth({ apiBaseUrl, token: "oauth-token" }, path);
      let calls = 0;
      const handler = createHoopilotHandler({
        authStorePath: path,
        env: {},
        fetch: async () => {
          calls += 1;
          return Response.json({});
        },
      });

      const response = await handler(
        new Request("http://localhost/v1/chat/completions", {
          body: JSON.stringify({ messages: [{ content: "hi", role: "user" }], model: "gpt-4.1" }),
          method: "POST",
        }),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "internal_error",
          message: expect.stringContaining("Refusing to send the GitHub OAuth token"),
        },
      });
      expect(calls).toBe(0);
    }
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

  it("logs upstream model fallback without logging the upstream body", async () => {
    const logs = captureLogger();
    const handler = createHoopilotHandler({
      ...oauthOptions(async () => new Response("secret upstream body", { status: 500 })),
      logger: logs.logger,
    });

    const response = await handler(new Request("http://localhost/v1/models"));

    expect(response.status).toBe(200);
    expect(logs.entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          event: "copilot.models.fallback",
          upstreamPath: "/models",
          upstreamStatus: 500,
        }),
        level: "warn",
        message: "falling back to built-in model list",
      }),
    );
    expect(JSON.stringify(logs.entries)).not.toContain("secret upstream body");
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

  it("reports missing OAuth credentials and logs the auth failure", async () => {
    const logs = captureLogger();
    const handler = createHoopilotHandler({
      authStorePath: join(mkdtempSync(join(tmpdir(), "hoopilot-missing-auth-test-")), "auth.json"),
      env: {},
      fetch: unusedFetch,
      logger: logs.logger,
    });

    const response = await handler(new Request("http://localhost/v1/models"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "copilot_auth_error" },
    });
    expect(logs.entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          event: "copilot.auth.missing",
          route: "models",
        }),
        level: "warn",
        message: "copilot auth failed",
      }),
    );
  });

  it("reports invalid JSON bodies", async () => {
    const logs = captureLogger();
    const handler = createHoopilotHandler({
      env: {},
      fetch: unusedFetch,
      logger: logs.logger,
    });

    const response = await handler(
      new Request("http://localhost/v1/responses", {
        body: "{secret prompt text",
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request_error", message: "Request body must be valid JSON." },
    });
    expect(JSON.stringify(logs.entries)).not.toContain("secret prompt text");
  });

  it("rejects non-object JSON bodies before proxying upstream", async () => {
    let calls = 0;
    const handler = createHoopilotHandler(
      oauthOptions(async () => {
        calls += 1;
        return Response.json({});
      }),
    );

    for (const [path, body] of [
      ["/v1/chat/completions", "[]"],
      ["/v1/responses", JSON.stringify("hello")],
    ]) {
      const response = await handler(
        new Request(`http://localhost${path}`, {
          body,
          method: "POST",
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "invalid_request_error",
          message: "Request body must be a JSON object.",
        },
      });
    }
    expect(calls).toBe(0);
  });

  it("rejects oversized JSON bodies before proxying upstream", async () => {
    let calls = 0;
    const handler = createHoopilotHandler(
      oauthOptions(async () => {
        calls += 1;
        return Response.json({});
      }),
    );

    const declared = await handler(
      new Request("http://localhost/v1/chat/completions", {
        body: "{}",
        headers: { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
        method: "POST",
      }),
    );
    expect(declared.status).toBe(413);

    const chunked = await handler(
      new Request("http://localhost/v1/chat/completions", {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(MAX_REQUEST_BODY_BYTES + 1)));
            controller.close();
          },
        }),
        method: "POST",
      }),
    );
    expect(chunked.status).toBe(413);
    expect(calls).toBe(0);
  });

  it("does not log local API keys or request bodies", async () => {
    const logs = captureLogger();
    const handler = createHoopilotHandler({
      apiKey: "local-key",
      env: {},
      fetch: unusedFetch,
      logger: logs.logger,
    });

    await handler(
      new Request("http://localhost/v1/responses", {
        body: "{not-json secret prompt text",
        headers: { authorization: "Bearer wrong-key" },
        method: "POST",
      }),
    );

    const serialized = JSON.stringify(logs.entries);
    expect(serialized).not.toContain("local-key");
    expect(serialized).not.toContain("wrong-key");
    expect(serialized).not.toContain("secret prompt text");
  });

  it("logs unexpected non-error failures without crashing", async () => {
    const logs = captureLogger();
    const handler = createHoopilotHandler({
      ...oauthOptions(async () => {
        throw "string failure";
      }),
      logger: logs.logger,
    });

    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        body: JSON.stringify({ messages: [{ content: "hi", role: "user" }], model: "gpt-4.1" }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "internal_error", message: "string failure" },
    });
    expect(logs.entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          err: { message: "string failure" },
          event: "http.request.failed",
        }),
        level: "error",
        message: "request failed",
      }),
    );
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

  it("refuses to start with the Docker image's default environment and no API key", () => {
    // Mirrors the shipped Dockerfile ENV (HOST=0.0.0.0, no HOOPILOT_API_KEY, no
    // HOOPILOT_ALLOW_UNAUTHENTICATED), which must now fail closed.
    expect(() =>
      startHoopilotServer({
        env: {
          HOOPILOT_AUTH_FILE: "/data/auth.json",
          HOOPILOT_LOG_FORMAT: "json",
          HOOPILOT_LOG_LEVEL: "info",
          HOST: "0.0.0.0",
          PORT: "0",
        },
        fetch: unusedFetch,
      }),
    ).toThrow("non-loopback");
  });

  it("refuses a non-loopback start when HOOPILOT_API_KEY is an empty string", () => {
    // docker-compose passes `${HOOPILOT_API_KEY:-}`, which substitutes to "" when
    // the operator has not exported a key. That blank value must still fail closed.
    expect(() =>
      startHoopilotServer({
        env: { HOOPILOT_API_KEY: "", HOST: "0.0.0.0", PORT: "0" },
        fetch: unusedFetch,
      }),
    ).toThrow("non-loopback");
  });

  it("refuses a non-loopback start that uses a well-known demo API key", () => {
    expect(() =>
      startHoopilotServer({
        apiKey: "local-key",
        env: {},
        fetch: unusedFetch,
        host: "0.0.0.0",
        port: 0,
      }),
    ).toThrow("well-known demo");
  });

  it("starts on a non-loopback host with a strong API key", () => {
    const started = startHoopilotServer({
      apiKey: "s3cret-strong-and-unique-key",
      env: {},
      fetch: unusedFetch,
      host: "0.0.0.0",
      port: 0,
    });

    expect(started.url).toContain(":");
    started.server.stop(true);
  });

  it("allows an explicit non-loopback unauthenticated opt-in", () => {
    const started = startHoopilotServer({
      allowUnauthenticated: true,
      env: {},
      fetch: unusedFetch,
      host: "0.0.0.0",
      port: 0,
    });

    started.server.stop(true);
  });

  it("rejects invalid server ports from the environment", () => {
    expect(() =>
      startHoopilotServer({
        env: { PORT: "65536" },
        fetch: unusedFetch,
      }),
    ).toThrow("Invalid port");
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

  it("formats IPv6 loopback server URLs with brackets", () => {
    const started = startHoopilotServer({
      env: {},
      fetch: unusedFetch,
      host: "::1",
      port: 0,
    });

    expect(started.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    expect(new URL(started.url).hostname).toBe("[::1]");
    started.server.stop(true);
  });
});

describe("metrics and usage endpoints", () => {
  it("exposes Prometheus metrics at /metrics", async () => {
    const handler = createHoopilotHandler({ env: {}, fetch: unusedFetch });

    const response = await handler(new Request("http://localhost/metrics"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("version=0.0.4");
    const body = await response.text();
    expect(body).toContain("hoopilot_process_start_time_seconds");
    expect(body).toContain("# TYPE hoopilot_requests_total counter");
  });

  it("gates /metrics behind the configured API key", async () => {
    const handler = createHoopilotHandler({ apiKey: "local-key", env: {}, fetch: unusedFetch });

    expect((await handler(new Request("http://localhost/metrics"))).status).toBe(401);
  });

  it("records token usage and request counts from chat completions", async () => {
    const metrics = new MetricsRegistry();
    const handler = createHoopilotHandler({
      ...oauthOptions(async () =>
        Response.json({
          choices: [{ message: { content: "hi", role: "assistant" } }],
          model: "gpt-4.1",
          usage: { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 },
        }),
      ),
      metrics,
    });

    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        body: JSON.stringify({ messages: [{ content: "hi", role: "user" }], model: "gpt-4.1" }),
        method: "POST",
      }),
    );
    await response.json();
    await tick();

    const snapshot = metrics.snapshot();
    expect(snapshot.requests.total).toBe(1);
    expect(snapshot.requests.byRoute.chat_completions).toBe(1);
    expect(snapshot.upstream).toEqual({ errors: 0, total: 1 });
    expect(snapshot.tokens.byModel["gpt-4.1"]).toMatchObject({
      completion: 3,
      prompt: 7,
      requests: 1,
      total: 10,
    });
  });

  it("serves proxy metrics plus live Copilot quota at /v1/usage", async () => {
    const metrics = new MetricsRegistry();
    const requests: Request[] = [];
    const handler = createHoopilotHandler({
      ...oauthOptions(async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.includes("/copilot_internal/user")) {
          return Response.json({
            copilot_plan: "individual_pro",
            quota_reset_date: "2026-07-01",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 300,
                percent_remaining: 96.7,
                remaining: 290,
                unlimited: false,
              },
            },
          });
        }
        return new Response("unexpected", { status: 500 });
      }),
      metrics,
    });

    const response = await handler(new Request("http://localhost/v1/usage"));

    expect(response.status).toBe(200);
    expect(requests[0]!.url).toBe("https://api.github.com/copilot_internal/user");
    expect(requests[0]!.headers.get("authorization")).toBe("token oauth-token");
    expect(requests[0]!.headers.get("x-github-api-version")).toBe("2025-04-01");
    const body = (await response.json()) as {
      copilot: { plan: string; quotas: Record<string, { used: number }> };
      object: string;
      proxy: { upstream: { errors: number; total: number }; uptimeSeconds: number };
    };
    expect(body.object).toBe("usage");
    expect(body.copilot.plan).toBe("individual_pro");
    expect(body.copilot.quotas.premium_interactions!.used).toBe(10);
    expect(typeof body.proxy.uptimeSeconds).toBe("number");
    expect(body.proxy.upstream).toEqual({ errors: 0, total: 1 });
    // The quota call is recorded as an upstream request and cached for /metrics gauges.
    expect(metrics.snapshot().upstream).toEqual({ errors: 0, total: 1 });
    expect(metrics.renderPrometheus()).toContain(
      'hoopilot_copilot_quota_remaining{category="premium_interactions"} 290',
    );
  });

  it("records token usage from legacy completions using the response model", async () => {
    const metrics = new MetricsRegistry();
    const handler = createHoopilotHandler({
      ...oauthOptions(async () =>
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: "legacy", role: "assistant" } }],
          model: "gpt-4.1-2025",
          usage: { completion_tokens: 4, prompt_tokens: 6, total_tokens: 10 },
        }),
      ),
      metrics,
    });

    const response = await handler(
      new Request("http://localhost/v1/completions", {
        body: JSON.stringify({ model: "gpt-4.1", prompt: "hello" }),
        method: "POST",
      }),
    );
    await response.json();
    await tick();

    // The response model overrides the requested model in the token label.
    expect(metrics.snapshot().tokens.byModel["gpt-4.1-2025"]).toMatchObject({
      completion: 4,
      prompt: 6,
      total: 10,
    });
  });

  it("records token usage from a non-streaming Responses body", async () => {
    const metrics = new MetricsRegistry();
    const handler = createHoopilotHandler({
      ...oauthOptions(async () =>
        Response.json({
          model: "gpt-5.5",
          object: "response",
          output_text: "hi",
          status: "completed",
          usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
        }),
      ),
      metrics,
    });

    const response = await handler(
      new Request("http://localhost/v1/responses", {
        body: JSON.stringify({ input: "hello", model: "gpt-5.5" }),
        method: "POST",
      }),
    );
    await response.json();
    await tick();

    expect(metrics.snapshot().tokens.byModel["gpt-5.5"]).toMatchObject({
      completion: 5,
      prompt: 12,
      total: 17,
    });
  });

  it("caches the Copilot quota within the TTL and refetches after it expires", async () => {
    let calls = 0;
    let nowMs = 1_000;
    const client = new CopilotClient({
      authStorePath: tempAuthPath(),
      env: {},
      fetch: async () => {
        calls += 1;
        return Response.json({
          copilot_plan: "individual_pro",
          quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 290 } },
        });
      },
    });
    const metrics = new MetricsRegistry();
    const read = createUsageReader(client, metrics, () => nowMs, 60_000);

    await read();
    await read();
    expect(calls).toBe(1);

    nowMs += 60_001;
    await read();
    expect(calls).toBe(2);
    expect(metrics.snapshot().upstream.total).toBe(2);
  });

  it("reports Copilot quota errors without failing /v1/usage", async () => {
    const handler = createHoopilotHandler(
      oauthOptions(async () => new Response("forbidden", { status: 403 })),
    );

    const response = await handler(new Request("http://localhost/v1/usage"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { copilot: unknown; copilot_error: string };
    expect(body.copilot).toBeNull();
    expect(body.copilot_error).toContain("403");
  });

  it("reports missing credentials at /v1/usage without a 401", async () => {
    const metrics = new MetricsRegistry();
    const handler = createHoopilotHandler({
      authStorePath: join(mkdtempSync(join(tmpdir(), "hoopilot-usage-noauth-")), "auth.json"),
      env: {},
      fetch: unusedFetch,
      metrics,
    });

    const response = await handler(new Request("http://localhost/v1/usage"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { copilot: unknown; copilot_error: string };
    expect(body.copilot).toBeNull();
    expect(body.copilot_error).toContain("hoopilot login");
    expect(metrics.snapshot().upstream).toEqual({ errors: 0, total: 0 });
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

interface CapturedLog {
  fields: LogFields;
  level: string;
  message: string;
}

function captureLogger(bindings: LogFields = {}, entries: CapturedLog[] = []) {
  const logger: HoopilotLogger = {
    child: (childBindings) => captureLogger({ ...bindings, ...childBindings }, entries).logger,
    debug: record("debug"),
    error: record("error"),
    fatal: record("fatal"),
    info: record("info"),
    trace: record("trace"),
    warn: record("warn"),
  };

  function record(level: string) {
    return (fieldsOrMessage: LogFields | string, message?: string) => {
      if (typeof fieldsOrMessage === "string") {
        entries.push({ fields: bindings, level, message: fieldsOrMessage });
        return;
      }
      entries.push({
        fields: { ...bindings, ...fieldsOrMessage },
        level,
        message: message ?? "",
      });
    };
  }

  return { entries, logger };
}
