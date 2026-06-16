import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStoredCopilotAuth } from "../src/auth-store";
import { createHoopilotHandler, startHoopilotServer } from "../src/server";
import type { FetchLike, HoopilotLogger, HoopilotServerOptions, LogFields } from "../src/types";

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
    await expect(response.text()).resolves.toContain('"content":"hi"');
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

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "internal_error", message: "Request body must be valid JSON." },
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
