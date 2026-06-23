import {
  AnthropicCompatibilityError,
  anthropicMessagesToResponsesRequest,
  estimateAnthropicMessageTokens,
  responsesResponseToAnthropicMessage,
  responsesSseTextToAnthropicSseText,
  responsesStreamToAnthropicStream,
} from "./anthropic";
import { CopilotAuthError } from "./auth";
import { CopilotClient, normalizeCopilotUsage } from "./copilot";
import { createHoopilotLogger, errorDetails, noopLogger, shouldCreateLogger } from "./logger";
import {
  MetricsRegistry,
  observeResponseUsage,
  PROMETHEUS_CONTENT_TYPE,
  recordResponseTextUsage,
} from "./metrics";
import {
  chatCompletionToCompletion,
  completionSseTextFromChatSseText,
  completionStreamFromChatStream,
  completionsRequestToChatCompletion,
  extractTokenUsage,
  fallbackModels,
  normalizeChatCompletionRequest,
  normalizeModelsResponse,
  normalizeRequestedModel,
  OpenAICompatibilityError,
  responsesCompactionResult,
} from "./openai";
import type {
  CopilotUsage,
  HoopilotLogger,
  HoopilotServerOptions,
  JsonObject,
  LogFields,
  StartedHoopilotServer,
  StreamingProxyMode,
  TokenUsage,
} from "./types";
import { asRecord, envValue } from "./util";
import { IS_STANDALONE_BINARY } from "./version";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4141;
const FORBIDDEN_BROWSER_ORIGIN_MESSAGE =
  "Cross-origin browser requests are blocked unless the Origin is loopback or listed in HOOPILOT_ALLOWED_ORIGINS.";
// API keys we ship in docs/examples as placeholders. They are effectively public,
// so refusing them on non-loopback binds keeps a credential-backed proxy from being
// reachable on a network with a guessable key.
const WELL_KNOWN_DEMO_API_KEYS = new Set(["local-key"]);
const INVALID_JSON_MESSAGE = "Request body must be valid JSON.";
const JSON_OBJECT_MESSAGE = "Request body must be a JSON object.";
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_TOO_LARGE_MESSAGE = `Request body must be ${MAX_REQUEST_BODY_BYTES} bytes or smaller.`;
const USAGE_CACHE_TTL_MS = 60_000;

interface UsageReadResult {
  copilot?: CopilotUsage;
  error?: string;
}

type UsageReader = (signal?: AbortSignal) => Promise<UsageReadResult>;
type TokenRecorder = (model: string, usage: TokenUsage) => void;

class RequestBodyTooLargeError extends Error {
  constructor() {
    super(REQUEST_TOO_LARGE_MESSAGE);
    this.name = "RequestBodyTooLargeError";
  }
}

export function createHoopilotHandler(
  options: HoopilotServerOptions = {},
): (request: Request) => Promise<Response> {
  const client = new CopilotClient(options);
  const apiKey = options.apiKey ?? envValue(options.env?.HOOPILOT_API_KEY);
  const allowedOrigins = parseAllowedOrigins(options.env);
  const logger = serverLogger(options);
  const metrics = options.metrics ?? new MetricsRegistry();
  const readUsage = createUsageReader(client, metrics);
  const recordTokens: TokenRecorder = (model, usage) => metrics.recordTokens(model, usage);
  const streamingProxyMode = resolveStreamingProxyMode(options);
  const bufferProxyBodies = shouldBufferProxyBodies(streamingProxyMode);

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
    const origin = request.headers.get("origin")?.trim() || undefined;
    const corsOrigin = resolveCorsAllowOrigin(origin, allowedOrigins);
    const finish = (response: Response): Response =>
      finishResponse(response, {
        corsOrigin,
        logger: requestLogger,
        method: request.method,
        metrics,
        requestId,
        route,
        startedAt,
        closeConnection: bufferProxyBodies,
        trackStreamingBody: !bufferProxyBodies,
      });

    const browserOrigin = forbiddenBrowserOrigin(origin, request, allowedOrigins);
    if (browserOrigin) {
      requestLogger.warn(
        { event: "http.request.forbidden_origin", origin: browserOrigin },
        "blocked cross-origin browser request",
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
      if (request.method === "POST" && apiPath === "/v1/messages") {
        return finish(
          await handleAnthropicMessages(
            client,
            metrics,
            recordTokens,
            request,
            requestLogger,
            bufferProxyBodies,
          ),
        );
      }
      if (request.method === "POST" && apiPath === "/v1/messages/count_tokens") {
        return finish(handleAnthropicCountTokens(await readJson(request)));
      }
      if (request.method === "POST" && apiPath === "/v1/chat/completions") {
        return finish(
          await handleChatCompletions(
            client,
            metrics,
            recordTokens,
            request,
            requestLogger,
            bufferProxyBodies,
          ),
        );
      }
      if (request.method === "POST" && apiPath === "/v1/completions") {
        return finish(
          await handleCompletions(
            client,
            metrics,
            recordTokens,
            request,
            requestLogger,
            bufferProxyBodies,
          ),
        );
      }
      if (request.method === "POST" && apiPath === "/v1/responses/compact") {
        return finish(
          await handleResponsesCompact(client, metrics, recordTokens, request, requestLogger),
        );
      }
      if (request.method === "POST" && apiPath === "/v1/responses") {
        return finish(
          await handleResponses(
            client,
            metrics,
            recordTokens,
            request,
            requestLogger,
            bufferProxyBodies,
          ),
        );
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
      if (message === INVALID_JSON_MESSAGE || message === JSON_OBJECT_MESSAGE) {
        requestLogger.warn(
          { err: errorDetails(error), event: "http.request.failed" },
          "request body was not usable json",
        );
        return finish(jsonError(400, "invalid_request_error", message));
      } else if (
        error instanceof OpenAICompatibilityError ||
        error instanceof AnthropicCompatibilityError
      ) {
        requestLogger.warn(
          { err: errorDetails(error), event: "http.request.failed" },
          "request body used unsupported compatibility fields",
        );
        return finish(jsonError(400, "invalid_request_error", message));
      } else if (error instanceof RequestBodyTooLargeError) {
        requestLogger.warn(
          { err: errorDetails(error), event: "http.request.failed" },
          "request body exceeded size limit",
        );
        return finish(jsonError(413, "request_too_large", message));
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
  const host = options.host ?? envValue(options.env?.HOST) ?? DEFAULT_HOST;
  const port = normalizeServerPort(options.port ?? envValue(options.env?.PORT) ?? DEFAULT_PORT);
  const apiKey = options.apiKey ?? envValue(options.env?.HOOPILOT_API_KEY);
  const allowUnauthenticated =
    options.allowUnauthenticated ?? envValue(options.env?.HOOPILOT_ALLOW_UNAUTHENTICATED) === "1";

  if (!isLoopbackHost(host)) {
    if (!apiKey && !allowUnauthenticated) {
      throw new Error(
        "Refusing to listen on a non-loopback host without HOOPILOT_API_KEY. Set an API key or pass --allow-unauthenticated.",
      );
    }
    if (apiKey && isWellKnownDemoApiKey(apiKey)) {
      throw new Error(
        "Refusing to listen on a non-loopback host with a well-known demo HOOPILOT_API_KEY. Set a strong, unique API key.",
      );
    }
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
    url: `http://${urlHost(host)}:${server.port}`,
  };
}

async function handleAnthropicMessages(
  client: CopilotClient,
  metrics: MetricsRegistry,
  recordTokens: TokenRecorder,
  request: Request,
  logger: HoopilotLogger,
  bufferProxyBodies: boolean,
): Promise<Response> {
  const anthropicRequest = await readJson(request);
  const responsesRequest = anthropicMessagesToResponsesRequest(anthropicRequest);
  const upstream = await client.responses(JSON.stringify(responsesRequest), request.signal);
  metrics.recordUpstream("/responses", upstream.ok);
  if (!upstream.ok) {
    return proxyError(upstream, logger);
  }
  logUpstreamSuccess(logger, "/responses", upstream.status);
  const model = normalizeRequestedModel(responsesRequest.model);

  if (isStreamingResponse(upstream) && upstream.body) {
    if (bufferProxyBodies) {
      const text = await upstream.text();
      recordResponseTextUsage(text, true, model, recordTokens);
      return proxyResponse(
        responseFromText(upstream, responsesSseTextToAnthropicSseText(text, { model })),
      );
    }
    const observed = observeResponseUsage(upstream, model, recordTokens, request.signal);
    if (!observed.body) {
      return proxyResponse(observed);
    }
    return proxyResponse(
      new Response(responsesStreamToAnthropicStream(observed.body, { model }), {
        headers: observed.headers,
        status: observed.status,
        statusText: observed.statusText,
      }),
    );
  }

  const body = asRecord(await upstream.json());
  const usage = extractTokenUsage(body.usage);
  if (usage) {
    const responseModel = typeof body.model === "string" ? body.model.trim() : "";
    recordTokens(responseModel || model, usage);
  }
  return jsonResponse(responsesResponseToAnthropicMessage(body, model));
}

function handleAnthropicCountTokens(body: JsonObject): Response {
  return jsonResponse(estimateAnthropicMessageTokens(body));
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
  bufferProxyBodies: boolean,
): Promise<Response> {
  const chatRequest = normalizeChatCompletionRequest(await readJson(request));
  const upstream = await client.chatCompletions(chatRequest, request.signal);
  metrics.recordUpstream("/chat/completions", upstream.ok);
  if (!upstream.ok) {
    return proxyError(upstream, logger);
  }
  logUpstreamSuccess(logger, "/chat/completions", upstream.status);
  const model = normalizeRequestedModel(chatRequest.model);
  return proxyResponse(
    await responseWithObservedUsage(
      upstream,
      model,
      recordTokens,
      request.signal,
      bufferProxyBodies,
    ),
  );
}

async function handleCompletions(
  client: CopilotClient,
  metrics: MetricsRegistry,
  recordTokens: TokenRecorder,
  request: Request,
  logger: HoopilotLogger,
  bufferProxyBodies: boolean,
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
    if (bufferProxyBodies) {
      const upstreamText = await upstream.text();
      recordResponseTextUsage(upstreamText, true, model, recordTokens);
      const text = completionSseTextFromChatSseText(upstreamText);
      return proxyResponse(responseFromText(upstream, text));
    }
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
  bufferProxyBodies: boolean,
): Promise<Response> {
  const body = await readJsonText(request);
  const upstream = await client.responses(body, request.signal);
  metrics.recordUpstream("/responses", upstream.ok);
  if (!upstream.ok) {
    return proxyError(upstream, logger);
  }
  logUpstreamSuccess(logger, "/responses", upstream.status);
  const model = normalizeRequestedModel(asRecord(safeParseJson(body)).model);
  return proxyResponse(
    await responseWithObservedUsage(
      upstream,
      model,
      recordTokens,
      request.signal,
      bufferProxyBodies,
    ),
  );
}

/**
 * Codex's remote context compaction (`POST /responses/compact`, used when the
 * model provider is named "OpenAI" or is Azure) is a proprietary OpenAI surface
 * that Copilot does not expose, and Codex has no client-side fallback — a 404
 * there hard-fails compaction. Satisfy it by running the supplied Responses-API
 * payload through Copilot's `/responses` as a unary request and returning the
 * `{ output }` document Codex expects, so the conversation history is replaced
 * with a real model-produced summary instead of erroring out.
 */
async function handleResponsesCompact(
  client: CopilotClient,
  metrics: MetricsRegistry,
  recordTokens: TokenRecorder,
  request: Request,
  logger: HoopilotLogger,
): Promise<Response> {
  const body = await readJson(request);
  const upstream = await client.responses(
    JSON.stringify({ ...body, stream: false }),
    request.signal,
  );
  metrics.recordUpstream("/responses", upstream.ok);
  if (!upstream.ok) {
    return proxyError(upstream, logger);
  }
  logUpstreamSuccess(logger, "/responses", upstream.status);
  const isSse = isStreamingResponse(upstream);
  const text = await upstream.text();
  recordResponseTextUsage(text, isSse, normalizeRequestedModel(body.model), recordTokens);
  return jsonResponse(responsesCompactionResult(text, isSse));
}

async function responseWithObservedUsage(
  response: Response,
  fallbackModel: string,
  recordTokens: TokenRecorder,
  signal: AbortSignal,
  bufferBody: boolean,
): Promise<Response> {
  const isSse = isStreamingResponse(response);
  if (bufferBody && response.body) {
    const text = await response.text();
    recordResponseTextUsage(text, isSse, fallbackModel, recordTokens);
    return responseFromText(response, text);
  }
  return observeResponseUsage(response, fallbackModel, recordTokens, signal);
}

function responseFromText(source: Response, text: string): Response {
  return new Response(text, {
    headers: source.headers,
    status: source.status,
    statusText: source.statusText,
  });
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
  const text = await readRequestText(request);
  return parseJsonObject(text);
}

function parseJsonObject(text: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(INVALID_JSON_MESSAGE);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(JSON_OBJECT_MESSAGE);
  }
  return parsed as JsonObject;
}

async function readJsonText(request: Request): Promise<string> {
  const text = await readRequestText(request);
  parseJsonObject(text);
  return text;
}

async function readRequestText(request: Request): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
  }

  const body = request.body;
  if (!body) {
    return "";
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return `${text}${decoder.decode()}`;
      }
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
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

// CORS headers shared by every response. The `access-control-allow-origin` value
// is intentionally omitted here and set per-request by `finishResponse`, so the
// proxy only advertises access to origins it actually allows (loopback or
// HOOPILOT_ALLOWED_ORIGINS) instead of a blanket wildcard.
function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-headers":
      "anthropic-beta, anthropic-dangerous-direct-browser-access, anthropic-version, authorization, content-type, x-api-key, x-request-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-expose-headers": "x-request-id",
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

// Block cross-origin browser requests regardless of whether an API key is set.
// The proxy holds a GitHub OAuth credential and is meant for local CLI/tool
// clients, never for arbitrary web pages: a malicious site must not be able to
// drive it even if it knows (or guesses) the local API key. Loopback origins and
// any origin in HOOPILOT_ALLOWED_ORIGINS are allowed through to the key check.
function forbiddenBrowserOrigin(
  origin: string | undefined,
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): string | undefined {
  if (origin) {
    return isAllowedOrigin(origin, allowedOrigins) ? undefined : origin;
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  return fetchSite === "cross-site" ? "cross-site" : undefined;
}

// Parse the comma-separated HOOPILOT_ALLOWED_ORIGINS allowlist into a normalized
// set of exact origins (scheme + host + optional port), lower-cased for matching.
function parseAllowedOrigins(env: NodeJS.ProcessEnv | undefined): ReadonlySet<string> {
  const raw = envValue(env?.HOOPILOT_ALLOWED_ORIGINS);
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
}

function isAllowedOrigin(origin: string, allowedOrigins: ReadonlySet<string>): boolean {
  return isLoopbackOrigin(origin) || allowedOrigins.has(origin.toLowerCase());
}

// Resolve the `access-control-allow-origin` value for a response. Allowed browser
// origins are echoed back (so the page can read the response); a request with no
// Origin is a non-browser client where the value is inert, so we keep `*`;
// disallowed origins get no header (they are also blocked with a 403), so a
// malicious page cannot read even an error body.
function resolveCorsAllowOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): string | undefined {
  if (!origin) {
    return "*";
  }
  return isAllowedOrigin(origin, allowedOrigins) ? origin : undefined;
}

function isWellKnownDemoApiKey(apiKey: string): boolean {
  return WELL_KNOWN_DEMO_API_KEYS.has(apiKey.trim().toLowerCase());
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

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
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

function resolveStreamingProxyMode(options: HoopilotServerOptions): StreamingProxyMode {
  const value =
    options.streamingProxyMode ??
    envValue(options.env?.HOOPILOT_STREAM_MODE) ??
    envValue(options.env?.HOOPILOT_STREAMING_PROXY_MODE) ??
    "auto";
  if (value === "auto" || value === "buffer" || value === "live") {
    return value;
  }
  throw new Error(`Invalid stream mode: ${value}. Expected auto, live, or buffer.`);
}

function shouldBufferProxyBodies(mode: StreamingProxyMode): boolean {
  if (mode === "buffer") {
    return true;
  }
  if (mode === "live") {
    return false;
  }
  return process.platform === "win32" && IS_STANDALONE_BINARY;
}

function finishResponse(
  response: Response,
  options: {
    closeConnection: boolean;
    corsOrigin: string | undefined;
    logger: HoopilotLogger;
    method: string;
    metrics: MetricsRegistry;
    requestId: string;
    route: string;
    startedAt: number;
    trackStreamingBody: boolean;
  },
): Response {
  const withRequestId = responseWithRequestId(
    response,
    options.requestId,
    options.closeConnection,
    options.corsOrigin,
  );
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

  if (stream && withRequestId.body && options.trackStreamingBody) {
    return new Response(trackStreamCompletion(withRequestId.body, complete), {
      headers: withRequestId.headers,
      status,
      statusText: withRequestId.statusText,
    });
  }
  complete();
  return withRequestId;
}

function responseWithRequestId(
  response: Response,
  requestId: string,
  closeConnection: boolean,
  corsOrigin: string | undefined,
): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  if (corsOrigin) {
    headers.set("access-control-allow-origin", corsOrigin);
    // A specific (non-wildcard) origin makes the response origin-dependent, so
    // mark it Vary: Origin to keep shared caches from serving it to others.
    if (corsOrigin !== "*") {
      headers.append("vary", "Origin");
    }
  } else {
    headers.delete("access-control-allow-origin");
  }
  if (closeConnection) {
    headers.set("connection", "close");
  }
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
    case "/messages":
      return "/v1/messages";
    case "/messages/count_tokens":
      return "/v1/messages/count_tokens";
    case "/responses":
      return "/v1/responses";
    case "/responses/compact":
      return "/v1/responses/compact";
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
  if (method === "POST" && path === "/v1/messages") {
    return "anthropic_messages";
  }
  if (method === "POST" && path === "/v1/messages/count_tokens") {
    return "anthropic_count_tokens";
  }
  if (method === "POST" && path === "/v1/chat/completions") {
    return "chat_completions";
  }
  if (method === "POST" && path === "/v1/completions") {
    return "completions";
  }
  if (method === "POST" && path === "/v1/responses/compact") {
    return "responses_compact";
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
  const { copilot, error } = await readUsage(signal);
  const proxy = metrics.snapshot();
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
      if (error instanceof CopilotAuthError) {
        return { error: error.message };
      }
      metrics.recordUpstream(usagePath, false);
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
