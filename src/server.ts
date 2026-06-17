import { CopilotAuthError } from "./auth";
import { CopilotClient, normalizeCopilotUsage } from "./copilot";
import { createHoopilotLogger, errorDetails, noopLogger, shouldCreateLogger } from "./logger";
import { MetricsRegistry, observeResponseUsage, PROMETHEUS_CONTENT_TYPE } from "./metrics";
import {
  chatCompletionToCompletion,
  completionStreamFromChatStream,
  completionsRequestToChatCompletion,
  extractTokenUsage,
  fallbackModels,
  normalizeChatCompletionRequest,
  normalizeModelsResponse,
  normalizeRequestedModel,
} from "./openai";
import type {
  CopilotUsage,
  HoopilotLogger,
  HoopilotServerOptions,
  JsonObject,
  LogFields,
  StartedHoopilotServer,
  TokenUsage,
} from "./types";
import { asRecord } from "./util";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4141;
const FORBIDDEN_BROWSER_ORIGIN_MESSAGE =
  "Browser-origin requests require HOOPILOT_API_KEY unless the Origin is loopback.";
const INVALID_JSON_MESSAGE = "Request body must be valid JSON.";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const USAGE_CACHE_TTL_MS = 60_000;

interface UsageReadResult {
  copilot?: CopilotUsage;
  error?: string;
}

type UsageReader = (signal?: AbortSignal) => Promise<UsageReadResult>;
type TokenRecorder = (model: string, usage: TokenUsage) => void;

export function createHoopilotHandler(
  options: HoopilotServerOptions = {},
): (request: Request) => Promise<Response> {
  const client = new CopilotClient(options);
  const apiKey = options.apiKey ?? options.env?.HOOPILOT_API_KEY;
  const logger = serverLogger(options);
  const metrics = options.metrics ?? new MetricsRegistry();
  const readUsage = createUsageReader(client, metrics);
  const recordTokens: TokenRecorder = (model, usage) => metrics.recordTokens(model, usage);

  return async (request: Request): Promise<Response> => {
    const startedAt = performance.now();
    const url = new URL(request.url);
    const apiPath = canonicalApiPath(url.pathname);
    const requestId = requestIdFor(request);
    const route = routeFor(request.method, apiPath);
    const requestLogger = logger.child({
      method: request.method,
      path: url.pathname,
      requestId,
      route,
    });
    metrics.startRequest();
    const finish = (response: Response): Response =>
      finishResponse(response, {
        logger: requestLogger,
        method: request.method,
        metrics,
        requestId,
        route,
        startedAt,
      });

    const browserOrigin = forbiddenBrowserOrigin(request, apiKey);
    if (browserOrigin) {
      requestLogger.warn(
        { event: "http.request.forbidden_origin", origin: browserOrigin },
        "blocked unauthenticated browser-origin request",
      );
      return finish(jsonError(403, "forbidden_origin", FORBIDDEN_BROWSER_ORIGIN_MESSAGE));
    }

    if (request.method === "OPTIONS") {
      return finish(new Response(null, { headers: corsHeaders() }));
    }

    if (!isAuthorized(request, apiKey)) {
      requestLogger.warn({ event: "http.request.unauthorized" }, "invalid hoopilot api key");
      return finish(jsonError(401, "invalid_api_key", "Invalid or missing Hoopilot API key."));
    }

    try {
      if (request.method === "GET" && (apiPath === "/" || apiPath === "/healthz")) {
        return finish(jsonResponse({ name: "hoopilot", object: "health", status: "ok" }));
      }
      if (request.method === "GET" && apiPath === "/metrics") {
        return finish(metricsResponse(metrics));
      }
      if (request.method === "GET" && apiPath === "/v1/usage") {
        return finish(await handleUsage(metrics, readUsage, request.signal));
      }
      if (request.method === "GET" && apiPath === "/v1/responses") {
        return finish(websocketUnsupportedResponse());
      }
      if (request.method === "GET" && apiPath === "/v1/models") {
        return finish(await handleModels(client, metrics, request.signal, requestLogger));
      }
      if (request.method === "POST" && apiPath === "/v1/chat/completions") {
        return finish(
          await handleChatCompletions(client, metrics, recordTokens, request, requestLogger),
        );
      }
      if (request.method === "POST" && apiPath === "/v1/completions") {
        return finish(
          await handleCompletions(client, metrics, recordTokens, request, requestLogger),
        );
      }
      if (request.method === "POST" && apiPath === "/v1/responses") {
        return finish(await handleResponses(client, metrics, recordTokens, request, requestLogger));
      }
      return finish(jsonError(404, "not_found", `No route for ${request.method} ${url.pathname}.`));
    } catch (error) {
      if (error instanceof CopilotAuthError) {
        requestLogger.warn(
          { err: errorDetails(error), event: "copilot.auth.missing" },
          "copilot auth failed",
        );
        return finish(jsonError(401, "copilot_auth_error", error.message));
      }
      const message = errorMessage(error);
      if (message === INVALID_JSON_MESSAGE) {
        requestLogger.warn(
          { err: errorDetails(error), event: "http.request.failed" },
          "request body was invalid json",
        );
        return finish(jsonError(400, "invalid_request_error", message));
      } else {
        requestLogger.error(
          { err: errorDetails(error), event: "http.request.failed" },
          "request failed",
        );
      }
      return finish(jsonError(500, "internal_error", message));
    }
  };
}

export function startHoopilotServer(options: HoopilotServerOptions = {}): StartedHoopilotServer {
  const host = options.host ?? options.env?.HOST ?? DEFAULT_HOST;
  const port = normalizeServerPort(options.port ?? options.env?.PORT ?? DEFAULT_PORT);
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
  metrics: MetricsRegistry,
  signal: AbortSignal,
  logger: HoopilotLogger,
): Promise<Response> {
  const upstream = await client.models(signal);
  metrics.recordUpstream("/models", upstream.ok);
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
  metrics: MetricsRegistry,
  recordTokens: TokenRecorder,
  request: Request,
  logger: HoopilotLogger,
): Promise<Response> {
  const chatRequest = normalizeChatCompletionRequest(await readJson(request));
  const upstream = await client.chatCompletions(chatRequest, request.signal);
  metrics.recordUpstream("/chat/completions", upstream.ok);
  if (!upstream.ok) {
    return proxyError(upstream, logger);
  }
  logUpstreamSuccess(logger, "/chat/completions", upstream.status);
  const model = normalizeRequestedModel(chatRequest.model);
  return proxyResponse(observeResponseUsage(upstream, model, recordTokens, request.signal));
}

async function handleCompletions(
  client: CopilotClient,
  metrics: MetricsRegistry,
  recordTokens: TokenRecorder,
  request: Request,
  logger: HoopilotLogger,
): Promise<Response> {
  const body = await readJson(request);
  const upstream = await client.chatCompletions(
    completionsRequestToChatCompletion(body),
    request.signal,
  );
  metrics.recordUpstream("/chat/completions", upstream.ok);
  if (!upstream.ok) {
    return proxyError(upstream, logger);
  }
  logUpstreamSuccess(logger, "/chat/completions", upstream.status);
  const model = normalizeRequestedModel(body.model);
  // A streaming request yields chat-completion SSE; convert each chunk to the
  // legacy completions stream shape instead of calling .json() on the body.
  if (isStreamingResponse(upstream) && upstream.body) {
    return proxyResponse(
      observeResponseUsage(
        new Response(completionStreamFromChatStream(upstream.body), {
          headers: upstream.headers,
          status: upstream.status,
          statusText: upstream.statusText,
        }),
        model,
        recordTokens,
        request.signal,
      ),
    );
  }
  const completion = asRecord(await upstream.json());
  const usage = extractTokenUsage(completion.usage);
  if (usage) {
    const responseModel = typeof completion.model === "string" ? completion.model.trim() : "";
    recordTokens(responseModel || model, usage);
  }
  return jsonResponse(chatCompletionToCompletion(completion));
}

async function handleResponses(
  client: CopilotClient,
  metrics: MetricsRegistry,
  recordTokens: TokenRecorder,
  request: Request,
  logger: HoopilotLogger,
): Promise<Response> {
  const body = await readJsonText(request);
  const upstream = await client.responses(body, request.signal);
  metrics.recordUpstream("/responses", upstream.ok);
  if (!upstream.ok) {
    return proxyError(upstream, logger);
  }
  logUpstreamSuccess(logger, "/responses", upstream.status);
  const model = normalizeRequestedModel(asRecord(safeParseJson(body)).model);
  return proxyResponse(observeResponseUsage(upstream, model, recordTokens, request.signal));
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
  return upstreamErrorResponse(upstream.status, text || upstream.statusText);
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
    return asRecord(await request.json());
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

function upstreamErrorResponse(status: number, text: string): Response {
  const parsedError = asRecord(asRecord(safeParseJson(text)).error);
  if (Object.keys(parsedError).length > 0) {
    return jsonResponse({ error: parsedError }, status);
  }
  return jsonError(status, "copilot_error", text);
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

function forbiddenBrowserOrigin(request: Request, apiKey: string | undefined): string | undefined {
  if (apiKey) {
    return undefined;
  }

  const origin = request.headers.get("origin")?.trim();
  if (origin) {
    return isLoopbackOrigin(origin) ? undefined : origin;
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  return fetchSite === "cross-site" ? "cross-site" : undefined;
}

function isUpstreamAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function upstreamAuthMessage(message: string): string {
  return `GitHub Copilot rejected the credential or account access: ${message}`;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function normalizeServerPort(value: number | string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${value}.`);
  }
  return port;
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
  options: {
    logger: HoopilotLogger;
    method: string;
    metrics: MetricsRegistry;
    requestId: string;
    route: string;
    startedAt: number;
  },
): Response {
  const withRequestId = responseWithRequestId(response, options.requestId);
  const stream = isStreamingResponse(withRequestId);
  const status = withRequestId.status;
  // Record metrics and log when the response is truly done. For a streamed body
  // that is when the client finishes receiving (or aborts) — so the in-flight
  // gauge and duration histogram reflect the full serving lifetime, not just the
  // time to upstream headers.
  const complete = (): void => {
    const durationMs = Math.round((performance.now() - options.startedAt) * 100) / 100;
    options.metrics.observe({ durationMs, method: options.method, route: options.route, status });
    logRequestCompleted(options.logger, status, stream, durationMs);
  };

  if (stream && withRequestId.body) {
    return new Response(trackStreamCompletion(withRequestId.body, complete), {
      headers: withRequestId.headers,
      status,
      statusText: withRequestId.statusText,
    });
  }
  complete();
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

// Re-stream `body`, invoking `onComplete` exactly once when the stream finishes,
// is cancelled (client disconnect), or errors — so callers can measure the true
// end of a streamed response.
function trackStreamCompletion(
  body: ReadableStream<Uint8Array>,
  onComplete: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let fired = false;
  const fire = (): void => {
    if (!fired) {
      fired = true;
      onComplete();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          fire();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        fire();
        controller.error(error);
      }
    },
    cancel(reason) {
      fire();
      return reader.cancel(reason);
    },
  });
}

function logRequestCompleted(
  logger: HoopilotLogger,
  status: number,
  stream: boolean,
  durationMs: number,
): void {
  const fields: LogFields = {
    durationMs,
    event: "http.request.completed",
    status,
    stream,
  };
  if (status >= 500) {
    logger.error(fields, "request completed with server error");
    return;
  }
  if (status >= 400) {
    logger.warn(fields, "request completed with client error");
    return;
  }
  logger.info(fields, "request completed");
}

function requestIdFor(request: Request): string {
  const existing = request.headers.get("x-request-id")?.trim();
  return existing && REQUEST_ID_PATTERN.test(existing) ? existing : crypto.randomUUID();
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
    case "/usage":
      return "/v1/usage";
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
  if (method === "GET" && path === "/metrics") {
    return "metrics";
  }
  if (method === "GET" && path === "/v1/usage") {
    return "usage";
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

function metricsResponse(metrics: MetricsRegistry): Response {
  return new Response(metrics.renderPrometheus(), {
    headers: {
      ...corsHeaders(),
      "content-type": PROMETHEUS_CONTENT_TYPE,
    },
    status: 200,
  });
}

async function handleUsage(
  metrics: MetricsRegistry,
  readUsage: UsageReader,
  signal: AbortSignal,
): Promise<Response> {
  const proxy = metrics.snapshot();
  const { copilot, error } = await readUsage(signal);
  const body: JsonObject = { copilot: copilot ?? null, object: "usage", proxy };
  if (error) {
    body.copilot_error = error;
  }
  return jsonResponse(body);
}

/**
 * Build a memoizing reader for the Copilot quota. The result is cached for
 * {@link USAGE_CACHE_TTL_MS} so repeated `/v1/usage` scrapes do not hammer
 * GitHub's REST rate limit, and missing credentials or upstream errors surface
 * as an `error` string rather than failing the whole response.
 */
export function createUsageReader(
  client: CopilotClient,
  metrics: MetricsRegistry,
  now: () => number = Date.now,
  ttlMs = USAGE_CACHE_TTL_MS,
): UsageReader {
  const usagePath = "/copilot_internal/user";
  let cache: { atMs: number; value: CopilotUsage } | undefined;
  return async (signal) => {
    if (cache && now() - cache.atMs < ttlMs) {
      return { copilot: cache.value };
    }
    try {
      const upstream = await client.usage(signal);
      metrics.recordUpstream(usagePath, upstream.ok);
      if (!upstream.ok) {
        return { error: `GitHub Copilot usage request failed with ${upstream.status}.` };
      }
      const value = normalizeCopilotUsage(await upstream.json().catch(() => ({})));
      cache = { atMs: now(), value };
      metrics.recordCopilotQuota(value);
      return { copilot: value };
    } catch (error) {
      metrics.recordUpstream(usagePath, false);
      if (error instanceof CopilotAuthError) {
        return { error: error.message };
      }
      return { error: errorMessage(error) };
    }
  };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
