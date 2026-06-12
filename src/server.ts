import { CopilotAuthError } from "./auth";
import { CopilotClient } from "./copilot";
import {
  chatCompletionToCompletion,
  chatCompletionToResponse,
  completionsRequestToChatCompletion,
  fallbackModels,
  normalizeModelsResponse,
  responsesRequestToChatCompletion,
  responsesStreamFromChatStream,
} from "./openai";
import type { HoopilotServerOptions, JsonObject, StartedHoopilotServer } from "./types";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4141;

export function createHoopilotHandler(options: HoopilotServerOptions = {}) {
  const client = new CopilotClient(options);
  const apiKey = options.apiKey ?? options.env?.HOOPILOT_API_KEY;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (!isAuthorized(request, apiKey)) {
      return jsonError(401, "invalid_api_key", "Invalid or missing Hoopilot API key.");
    }

    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
        return jsonResponse({
          name: "hoopilot",
          object: "health",
          status: "ok",
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return await handleModels(client, request.signal);
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        return await handleChatCompletions(client, request);
      }
      if (request.method === "POST" && url.pathname === "/v1/completions") {
        return await handleCompletions(client, request);
      }
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        return await handleResponses(client, request);
      }
      return jsonError(404, "not_found", `No route for ${request.method} ${url.pathname}.`);
    } catch (error) {
      if (error instanceof CopilotAuthError) {
        return jsonError(401, "copilot_auth_error", error.message);
      }
      return jsonError(500, "internal_error", errorMessage(error));
    }
  };
}

export function startHoopilotServer(options: HoopilotServerOptions = {}): StartedHoopilotServer {
  const host = options.host ?? options.env?.HOST ?? DEFAULT_HOST;
  const port = Number(options.port ?? options.env?.PORT ?? DEFAULT_PORT);
  const apiKey = options.apiKey ?? options.env?.HOOPILOT_API_KEY;
  const allowUnauthenticated =
    options.allowUnauthenticated ?? options.env?.HOOPILOT_ALLOW_UNAUTHENTICATED === "1";

  if (!isLoopbackHost(host) && !apiKey && !allowUnauthenticated) {
    throw new Error(
      "Refusing to listen on a non-loopback host without HOOPILOT_API_KEY. Set an API key or pass --allow-unauthenticated.",
    );
  }

  const server = Bun.serve({
    fetch: createHoopilotHandler({
      ...options,
      apiKey,
      host,
      port,
    }),
    hostname: host,
    port,
  });

  return {
    server,
    url: `http://${host}:${server.port}`,
  };
}

async function handleModels(client: CopilotClient, signal: AbortSignal): Promise<Response> {
  const upstream = await client.models(signal);
  if (!upstream.ok) {
    return jsonResponse({ data: fallbackModels(), object: "list" });
  }
  return jsonResponse(normalizeModelsResponse(await upstream.json()));
}

async function handleChatCompletions(client: CopilotClient, request: Request): Promise<Response> {
  const upstream = await client.forwardChatCompletions(await request.text(), request.signal);
  return proxyResponse(upstream);
}

async function handleCompletions(client: CopilotClient, request: Request): Promise<Response> {
  const body = await readJson(request);
  const upstream = await client.chatCompletions(
    completionsRequestToChatCompletion(body),
    request.signal,
  );
  if (!upstream.ok) {
    return proxyError(upstream);
  }
  return jsonResponse(chatCompletionToCompletion(await upstream.json()));
}

async function handleResponses(client: CopilotClient, request: Request): Promise<Response> {
  const body = await readJson(request);
  const chatRequest = responsesRequestToChatCompletion(body);
  const upstream = await client.chatCompletions(chatRequest, request.signal);
  if (!upstream.ok) {
    return proxyError(upstream);
  }

  if (body.stream === true && upstream.body) {
    return new Response(
      responsesStreamFromChatStream(upstream.body, {
        model: typeof chatRequest.model === "string" ? chatRequest.model : "gpt-4.1",
      }),
      {
        headers: {
          ...corsHeaders(),
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
        },
      },
    );
  }

  return jsonResponse(chatCompletionToResponse(await upstream.json()));
}

async function proxyError(upstream: Response): Promise<Response> {
  const text = await upstream.text();
  return jsonError(upstream.status, "copilot_error", text || upstream.statusText);
}

function proxyResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(upstream.body, {
    headers,
    status: upstream.status,
    statusText: upstream.statusText,
  });
}

async function readJson(request: Request): Promise<JsonObject> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function jsonResponse(body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });
}

function jsonError(status: number, code: string, message: string): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        type: code,
      },
    },
    status,
  );
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-headers": "authorization, content-type, x-api-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": "*",
  };
}

function isAuthorized(request: Request, apiKey: string | undefined): boolean {
  if (!apiKey) {
    return true;
  }
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer === apiKey || request.headers.get("x-api-key") === apiKey;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
