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
    expect(options.headers.get("access-control-allow-origin")).toBe("*");

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

  it("does not send stored OAuth tokens to plaintext non-loopback Copilot API URLs", async () => {
    const path = tempAuthPath();
    writeStoredCopilotAuth({ apiBaseUrl: "http://copilot.internal", token: "oauth-token" }, path);
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
      proxy: { uptimeSeconds: number };
    };
    expect(body.object).toBe("usage");
    expect(body.copilot.plan).toBe("individual_pro");
    expect(body.copilot.quotas.premium_interactions!.used).toBe(10);
    expect(typeof body.proxy.uptimeSeconds).toBe("number");
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
    const handler = createHoopilotHandler({
      authStorePath: join(mkdtempSync(join(tmpdir(), "hoopilot-usage-noauth-")), "auth.json"),
      env: {},
      fetch: unusedFetch,
    });

    const response = await handler(new Request("http://localhost/v1/usage"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { copilot: unknown; copilot_error: string };
    expect(body.copilot).toBeNull();
    expect(body.copilot_error).toContain("hoopilot login");
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
