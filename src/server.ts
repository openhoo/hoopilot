import { CopilotAuthError } from "./auth";
import { CopilotClient } from "./copilot";
import { createHoopilotLogger, noopLogger, shouldCreateLogger } from "./logger";
import {
  chatCompletionToCompletion,
  completionsRequestToChatCompletion,
  fallbackModels,
  normalizeChatCompletionRequest,
  normalizeModelsResponse,
} from "./openai";
import type {
  HoopilotLogger,
  HoopilotServerOptions,
  JsonObject,
  LogFields,
  StartedHoopilotServer,
} from "./types";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4141;
const INVALID_JSON_MESSAGE = "Request body must be valid JSON.";

export function createHoopilotHandler(options: HoopilotServerOptions = {}) {
  const client = new CopilotClient(options);
  const apiKey = options.apiKey ?? options.env?.HOOPILOT_API_KEY;
  const logger = serverLogger(options);

  return async (request: Request): Promise<Response> => {
    const startedAt = performance.now();
    const url = new URL(request.url);
    const apiPath = canonicalApiPath(url.pathname);
    const requestId = requestIdFor(request);
    const requestLogger = logger.child({
      method: request.method,
      path: url.pathname,
      requestId,
      route: routeFor(request.method, apiPath),
    });

    if (request.method === "OPTIONS") {
      return finishResponse(new Response(null, { headers: corsHeaders() }), {
        logger: requestLogger,
        requestId,
        startedAt,
      });
    }

    if (!isAuthorized(request, apiKey)) {
      requestLogger.warn({ event: "http.request.unauthorized" }, "invalid hoopilot api key");
      return finishResponse(
        jsonError(401, "invalid_api_key", "Invalid or missing Hoopilot API key."),
        {
          logger: requestLogger,
          requestId,
          startedAt,
        },
      );
    }

    try {
      if (request.method === "GET" && (apiPath === "/" || apiPath === "/healthz")) {
        return finishResponse(
          jsonResponse({
            name: "hoopilot",
            object: "health",
            status: "ok",
          }),
          { logger: requestLogger, requestId, startedAt },
        );
      }
      if (request.method === "GET" && apiPath === "/v1/responses") {
        return finishResponse(websocketUnsupportedResponse(), {
          logger: requestLogger,
          requestId,
          startedAt,
        });
      }
      if (request.method === "GET" && apiPath === "/v1/models") {
        return finishResponse(await handleModels(client, request.signal, requestLogger), {
          logger: requestLogger,
          requestId,
          startedAt,
        });
      }
      if (request.method === "POST" && apiPath === "/v1/chat/completions") {
        return finishResponse(await handleChatCompletions(client, request, requestLogger), {
          logger: requestLogger,
          requestId,
          startedAt,
        });
      }
      if (request.method === "POST" && apiPath === "/v1/completions") {
        return finishResponse(await handleCompletions(client, request, requestLogger), {
          logger: requestLogger,
          requestId,
          startedAt,
        });
      }
      if (request.method === "POST" && apiPath === "/v1/responses") {
        return finishResponse(await handleResponses(client, request, requestLogger), {
          logger: requestLogger,
          requestId,
          startedAt,
        });
      }
      return finishResponse(
        jsonError(404, "not_found", `No route for ${request.method} ${url.pathname}.`),
        { logger: requestLogger, requestId, startedAt },
      );
    } catch (error) {
      if (error instanceof CopilotAuthError) {
        requestLogger.warn(
          { err: errorDetails(error), event: "copilot.auth.missing" },
          "copilot auth failed",
        );
        return finishResponse(jsonError(401, "copilot_auth_error", error.message), {
          logger: requestLogger,
          requestId,
          startedAt,
        });
      }
      const message = errorMessage(error);
      if (message === INVALID_JSON_MESSAGE) {
        requestLogger.warn(
          { err: errorDetails(error), event: "http.request.failed" },
          "request body was invalid json",
        );
      } else {
        requestLogger.error(
          { err: errorDetails(error), event: "http.request.failed" },
          "request failed",
        );
      }
      return finishResponse(jsonError(500, "internal_error", message), {
        logger: requestLogger,
        requestId,
        startedAt,
      });
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

async function handleModels(
  client: CopilotClient,
  signal: AbortSignal,
  logger: HoopilotLogger,
): Promise<Response> {
  const upstream = await client.models(signal);
  if (!upstream.ok) {
    if (isUpstreamAuthStatus(upstream.status)) {
      return proxyError(upstream, logger);
    }
    logger.warn(
      {
        event: "copilot.models.fallback",
        upstreamPath: "/models",
        upstreamStatus: upstream.status,
      },
      "falling back to built-in model list",
    );
    return jsonResponse({ data: fallbackModels(), object: "list" });
  }
  logUpstreamSuccess(logger, "/models", upstream.status);
  return jsonResponse(normalizeModelsResponse(await upstream.json()));
}

async function handleChatCompletions(
  client: CopilotClient,
  request: Request,
  logger: HoopilotLogger,
): Promise<Response> {
  const chatRequest = normalizeChatCompletionRequest(await readJson(request));
  const upstream = await client.chatCompletions(chatRequest, request.signal);
  if (!upstream.ok) {
    return proxyError(upstream, logger);
  }
  logUpstreamSuccess(logger, "/chat/completions", upstream.status);
  return proxyResponse(upstream);
}

async function handleCompletions(
  client: CopilotClient,
  request: Request,
  logger: HoopilotLogger,
): Promise<Response> {
  const body = await readJson(request);
  const upstream = await client.chatCompletions(
    completionsRequestToChatCompletion(body),
    request.signal,
  );
  if (!upstream.ok) {
    return proxyError(upstream, logger);
  }
  logUpstreamSuccess(logger, "/chat/completions", upstream.status);
  return jsonResponse(chatCompletionToCompletion(await upstream.json()));
}

async function handleResponses(
  client: CopilotClient,
  request: Request,
  logger: HoopilotLogger,
): Promise<Response> {
  const body = await readJsonText(request);
  const upstream = await client.responses(body, request.signal);
  if (!upstream.ok) {
    return proxyError(upstream, logger);
  }
  logUpstreamSuccess(logger, "/responses", upstream.status);
  return proxyResponse(upstream);
}

async function proxyError(upstream: Response, logger: HoopilotLogger): Promise<Response> {
  const text = await upstream.text();
  if (isUpstreamAuthStatus(upstream.status)) {
    logger.warn(
      { event: "copilot.auth.rejected", upstreamStatus: upstream.status },
      "copilot rejected credential or account access",
    );
    return jsonError(401, "copilot_auth_error", upstreamAuthMessage(text || upstream.statusText));
  }
  logger.warn(
    { event: "copilot.request.failed", upstreamStatus: upstream.status },
    "copilot upstream request failed",
  );
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
    throw new Error(INVALID_JSON_MESSAGE);
  }
}

async function readJsonText(request: Request): Promise<string> {
  const text = await request.text();
  try {
    JSON.parse(text);
    return text;
  } catch {
    throw new Error(INVALID_JSON_MESSAGE);
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

function websocketUnsupportedResponse(): Response {
  const response = jsonError(
    426,
    "websocket_not_supported",
    "Hoopilot does not support Responses WebSocket transport; retry with HTTP Responses API.",
  );
  response.headers.set("upgrade", "websocket");
  return response;
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

function isUpstreamAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function upstreamAuthMessage(message: string): string {
  return `GitHub Copilot rejected the credential or account access: ${message}`;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serverLogger(options: HoopilotServerOptions): HoopilotLogger {
  if (options.logger) {
    return options.logger.child({ component: "server" });
  }
  if (shouldCreateLogger(options)) {
    return createHoopilotLogger({
      env: options.env,
      format: options.logFormat,
      level: options.logLevel,
    }).child({ component: "server" });
  }
  return noopLogger;
}

function finishResponse(
  response: Response,
  options: { logger: HoopilotLogger; requestId: string; startedAt: number },
): Response {
  const withRequestId = responseWithRequestId(response, options.requestId);
  logRequestCompleted(options.logger, withRequestId, options.startedAt);
  return withRequestId;
}

function responseWithRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function logRequestCompleted(logger: HoopilotLogger, response: Response, startedAt: number): void {
  const fields: LogFields = {
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    event: "http.request.completed",
    status: response.status,
    stream: isStreamingResponse(response),
  };
  if (response.status >= 500) {
    logger.error(fields, "request completed with server error");
    return;
  }
  if (response.status >= 400) {
    logger.warn(fields, "request completed with client error");
    return;
  }
  logger.info(fields, "request completed");
}

function requestIdFor(request: Request): string {
  const existing = request.headers.get("x-request-id")?.trim();
  return existing || crypto.randomUUID();
}

function canonicalApiPath(path: string): string {
  const withoutTrailingSlash = path.length > 1 ? path.replace(/\/+$/, "") : path;
  switch (withoutTrailingSlash) {
    case "/models":
      return "/v1/models";
    case "/chat/completions":
      return "/v1/chat/completions";
    case "/completions":
      return "/v1/completions";
    case "/responses":
      return "/v1/responses";
    default:
      return withoutTrailingSlash;
  }
}

function routeFor(method: string, path: string): string {
  if (method === "OPTIONS") {
    return "cors.preflight";
  }
  if (method === "GET" && (path === "/" || path === "/healthz")) {
    return "health";
  }
  if (method === "GET" && path === "/v1/models") {
    return "models";
  }
  if (method === "POST" && path === "/v1/chat/completions") {
    return "chat_completions";
  }
  if (method === "POST" && path === "/v1/completions") {
    return "completions";
  }
  if (method === "POST" && path === "/v1/responses") {
    return "responses";
  }
  if (method === "GET" && path === "/v1/responses") {
    return "responses_websocket";
  }
  return "not_found";
}

function isStreamingResponse(response: Response): boolean {
  return response.headers.get("content-type")?.includes("text/event-stream") ?? false;
}

function logUpstreamSuccess(logger: HoopilotLogger, upstreamPath: string, status: number): void {
  logger.debug(
    {
      event: "copilot.request.completed",
      upstreamPath,
      upstreamStatus: status,
    },
    "copilot upstream request completed",
  );
}

function errorDetails(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}
