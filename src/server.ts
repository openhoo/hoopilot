import { createHash, timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import {
  AnthropicCompatibilityError,
  anthropicMessagesToResponsesRequest,
  estimateAnthropicMessageTokens,
  responsesResponseToAnthropicMessage,
  responsesSseTextToAnthropicSseText,
  responsesStreamToAnthropicStream,
} from "./anthropic";
import { CopilotAuthError } from "./auth";
import { CopilotClient, normalizeCopilotUsage, parseRateLimitHeaders } from "./copilot";
import { DASHBOARD_HTML } from "./dashboard";
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
  UsageResponseBody,
} from "./types";
import {
  asRecord,
  envValue,
  errorMessage,
  isLoopbackHostname,
  parseStreamingProxyMode,
  safeJsonParse,
} from "./util";
import { getVersion, IS_STANDALONE_BINARY } from "./version";

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
type ExtractionRecorder = (extracted: boolean) => void;

class RequestBodyTooLargeError extends Error {
  constructor() {
    super(REQUEST_TOO_LARGE_MESSAGE);
    this.name = "RequestBodyTooLargeError";
  }
}

// Typed body-parse failures so onError discriminates them by `instanceof` like
// the other handler errors, instead of matching on the message string.
class InvalidJsonError extends Error {
  constructor() {
    super(INVALID_JSON_MESSAGE);
    this.name = "InvalidJsonError";
  }
}

class JsonNotObjectError extends Error {
  constructor() {
    super(JSON_OBJECT_MESSAGE);
    this.name = "JsonNotObjectError";
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
  const recordExtraction: ExtractionRecorder = (extracted) =>
    metrics.recordTokenExtraction(extracted);
  const bufferProxyBodies = shouldBufferProxyBodies(resolveStreamingProxyMode(options));

  // Per-request channel into the Elysia lifecycle. The bookend below builds the
  // child logger once (with the canonical request id and the original path) and
  // stashes it here keyed by the request object, which Elysia passes through by
  // identity to onRequest/handlers/onError — so the id in the response header and
  // every log line agree without recomputing (or regenerating) it inside Elysia.
  const requestContext = new WeakMap<Request, RequestContext>();
  const app = buildApp({
    apiKey,
    allowedOrigins,
    bufferProxyBodies,
    client,
    metrics,
    readUsage,
    recordExtraction,
    recordTokens,
    requestContext,
  });

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

    // Elysia owns routing, body-parse control, the pre-routing gates, and error
    // mapping. The cross-cutting bookend stays out here so it runs on EVERY
    // response — routed, gated, 404, or thrown — regardless of Elysia's
    // short-circuit semantics (an onRequest gate skips mapResponse/onAfterResponse):
    // metrics.startRequest() above pairs with the metrics.observe() that
    // finishResponse() schedules, and the per-request child logger reaches the
    // Elysia lifecycle through `requestContext`.
    const inner = normalizeInnerRequest(request, apiPath, url);
    requestContext.set(inner, {
      apiPath,
      logger: requestLogger,
      origin,
      originalPath: url.pathname,
    });

    let response: Response;
    try {
      response = await app.handle(inner);
    } catch (error) {
      // Elysia resolves handler and hook throws through onError, so this only
      // catches a failure inside onError itself — still finish so the in-flight
      // gauge opened by startRequest() above is always balanced.
      requestLogger.error(
        { err: errorDetails(error), event: "http.request.failed" },
        "request failed",
      );
      response = jsonError(500, "internal_error", errorMessage(error));
    }

    return finishResponse(response, {
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
  };
}

// Request-scoped data the bookend computes once and threads into the Elysia
// lifecycle, keyed by the request object (see the WeakMap note above). Carrying
// apiPath/origin here lets the onRequest gate reuse them instead of re-parsing
// the URL, and originalPath lets the 404 message report the caller's path rather
// than the canonicalized inner path the router matched against.
interface RequestContext {
  apiPath: string;
  logger: HoopilotLogger;
  origin: string | undefined;
  originalPath: string;
}

interface ServerDeps {
  apiKey: string | undefined;
  allowedOrigins: ReadonlySet<string>;
  bufferProxyBodies: boolean;
  client: CopilotClient;
  metrics: MetricsRegistry;
  readUsage: UsageReader;
  recordExtraction: ExtractionRecorder;
  recordTokens: TokenRecorder;
  requestContext: WeakMap<Request, RequestContext>;
}

// Build the Elysia application once per handler factory (closing over deps), then
// drive it per request with app.handle() from the bookend above. Route handlers
// return the raw Response objects the existing helpers build — Elysia passes a
// returned Response through untouched (no header injection, no re-serialization),
// so the wire format stays byte-identical. This passthrough holds only because the
// handlers never write to Elysia's `set` (headers/status/cookie) or `store`: doing so
// would route the response back through mapResponse and re-serialize it, drifting the
// bytes. Each handler reads its per-request
// child logger from `requestContext` rather than recomputing it, which keeps the
// request id and the original request path consistent between header and logs.
// POST routes set `parse: "none"` so Elysia never consumes the body: the handlers
// stream it themselves under the 16 MB cap (readRequestText) and forward the raw
// bytes upstream verbatim.
function buildApp(deps: ServerDeps) {
  const {
    apiKey,
    allowedOrigins,
    bufferProxyBodies,
    client,
    metrics,
    readUsage,
    recordExtraction,
    recordTokens,
    requestContext,
  } = deps;

  // Recover the request-scoped context the bookend stashed (keyed by request
  // identity — Elysia passes the same Request object through every hook/handler).
  // A miss should never happen: the bookend always populates it before
  // app.handle(). The fallback recomputes from the request purely as a crash
  // guard so an unexpected re-wrapped request degrades instead of throwing.
  const contextFor = (request: Request): RequestContext => {
    const stored = requestContext.get(request);
    if (stored) {
      return stored;
    }
    const originalPath = new URL(request.url).pathname;
    return {
      apiPath: canonicalApiPath(originalPath),
      logger: noopLogger,
      origin: request.headers.get("origin")?.trim() || undefined,
      originalPath,
    };
  };
  const loggerFor = (request: Request): HoopilotLogger => contextFor(request).logger;
  const noBody = { parse: "none" } as const;

  return (
    new Elysia()
      // Pre-routing gate, in the exact order the hand-rolled handler used: block
      // cross-origin browser requests, answer CORS preflight, serve the dashboard
      // before the API-key gate, then enforce the gate. Returning a Response
      // short-circuits routing; the bookend still decorates it via finishResponse.
      .onRequest(({ request }) => {
        const { apiPath, logger, origin } = contextFor(request);

        const browserOrigin = forbiddenBrowserOrigin(origin, request, allowedOrigins);
        if (browserOrigin) {
          logger.warn(
            { event: "http.request.forbidden_origin", origin: browserOrigin },
            "blocked cross-origin browser request",
          );
          return jsonError(403, "forbidden_origin", FORBIDDEN_BROWSER_ORIGIN_MESSAGE);
        }
        if (request.method === "OPTIONS") {
          return new Response(null, { headers: corsHeaders() });
        }
        // The dashboard is a static, secret-free HTML shell. Serve it before the
        // API-key gate so a browser can open it by navigation (which cannot send
        // an Authorization header). The data it renders comes from /v1/usage,
        // which stays behind the gate; cross-origin access is blocked above.
        if (request.method === "GET" && apiPath === "/dashboard") {
          return dashboardResponse();
        }
        if (!isAuthorized(request, apiKey)) {
          logger.warn({ event: "http.request.unauthorized" }, "invalid hoopilot api key");
          return jsonError(401, "invalid_api_key", "Invalid or missing Hoopilot API key.");
        }
      })
      // Reproduce the hand-rolled catch block: map the typed errors the handlers
      // throw (and Elysia's NOT_FOUND) onto the same status/code/log events.
      // Registered before the routes: Elysia applies an error hook only to routes
      // declared after it, so a trailing onError would never see handler throws.
      .onError(({ code, error, request }) => {
        const { logger, originalPath } = contextFor(request);
        if (code === "NOT_FOUND") {
          // Report the caller's original path, not the canonicalized inner path
          // the router matched, so an unknown `/foo/` 404s as `/foo/` (matching
          // the pre-Elysia handler) rather than the slash-stripped `/foo`.
          return jsonError(404, "not_found", `No route for ${request.method} ${originalPath}.`);
        }
        if (error instanceof CopilotAuthError) {
          logger.warn(
            { err: errorDetails(error), event: "copilot.auth.missing" },
            "copilot auth failed",
          );
          return jsonError(401, "copilot_auth_error", error.message);
        }
        const message = errorMessage(error);
        if (error instanceof InvalidJsonError || error instanceof JsonNotObjectError) {
          logger.warn(
            { err: errorDetails(error), event: "http.request.failed" },
            "request body was not usable json",
          );
          return jsonError(400, "invalid_request_error", message);
        }
        if (
          error instanceof OpenAICompatibilityError ||
          error instanceof AnthropicCompatibilityError
        ) {
          logger.warn(
            { err: errorDetails(error), event: "http.request.failed" },
            "request body used unsupported compatibility fields",
          );
          return jsonError(400, "invalid_request_error", message);
        }
        if (error instanceof RequestBodyTooLargeError) {
          logger.warn(
            { err: errorDetails(error), event: "http.request.failed" },
            "request body exceeded size limit",
          );
          return jsonError(413, "request_too_large", message);
        }
        logger.error({ err: errorDetails(error), event: "http.request.failed" }, "request failed");
        return jsonError(500, "internal_error", message);
      })
      .get("/", () => jsonResponse({ name: "hoopilot", object: "health", status: "ok" }))
      .get("/healthz", () => jsonResponse({ name: "hoopilot", object: "health", status: "ok" }))
      .get("/metrics", () => metricsResponse(metrics))
      .get("/v1/usage", ({ request }) => handleUsage(metrics, readUsage, request.signal))
      .get("/v1/models", ({ request }) =>
        handleModels(client, metrics, request.signal, loggerFor(request)),
      )
      .get("/v1/responses", () => websocketUnsupportedResponse())
      .post(
        "/v1/messages",
        ({ request }) =>
          handleAnthropicMessages(
            client,
            metrics,
            recordTokens,
            recordExtraction,
            request,
            loggerFor(request),
            bufferProxyBodies,
          ),
        noBody,
      )
      .post(
        "/v1/messages/count_tokens",
        ({ request }) => handleAnthropicCountTokens(request),
        noBody,
      )
      .post(
        "/v1/chat/completions",
        ({ request }) =>
          handleChatCompletions(
            client,
            metrics,
            recordTokens,
            recordExtraction,
            request,
            loggerFor(request),
            bufferProxyBodies,
          ),
        noBody,
      )
      .post(
        "/v1/completions",
        ({ request }) =>
          handleCompletions(
            client,
            metrics,
            recordTokens,
            recordExtraction,
            request,
            loggerFor(request),
            bufferProxyBodies,
          ),
        noBody,
      )
      .post(
        "/v1/responses/compact",
        ({ request }) =>
          handleResponsesCompact(
            client,
            metrics,
            recordTokens,
            recordExtraction,
            request,
            loggerFor(request),
          ),
        noBody,
      )
      .post(
        "/v1/responses",
        ({ request }) =>
          handleResponses(
            client,
            metrics,
            recordTokens,
            recordExtraction,
            request,
            loggerFor(request),
            bufferProxyBodies,
          ),
        noBody,
      )
  );
}

// Normalize the path the Elysia router matches against — map bare aliases like
// `/responses` onto `/v1/responses` and strip trailing slashes (reusing the
// single-source canonicalApiPath table) — while leaving the request's body
// stream and abort signal intact for the handlers. Bun's Request constructor
// copies the body and makes the new signal follow the original's abort, so the
// clone forwards bytes and cancels upstream on disconnect exactly as before.
// Returns the request unchanged when no rewrite is needed.
function normalizeInnerRequest(request: Request, canonicalPath: string, url: URL): Request {
  if (canonicalPath === url.pathname) {
    return request;
  }
  const target = new URL(url);
  target.pathname = canonicalPath;
  const init: RequestInit & { duplex?: "half" } = {
    headers: request.headers,
    method: request.method,
    signal: request.signal,
  };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(target, init);
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
  recordExtraction: ExtractionRecorder,
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
      recordResponseTextUsage(text, true, model, recordTokens, recordExtraction);
      return proxyResponse(
        responseFromText(upstream, responsesSseTextToAnthropicSseText(text, { model })),
      );
    }
    const observed = observeResponseUsage(
      upstream,
      model,
      recordTokens,
      request.signal,
      recordExtraction,
    );
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
  recordExtraction(usage !== undefined);
  return jsonResponse(responsesResponseToAnthropicMessage(body, model));
}

async function handleAnthropicCountTokens(request: Request): Promise<Response> {
  const body = await readJson(request);
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
  recordExtraction: ExtractionRecorder,
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
      recordExtraction,
    ),
  );
}

async function handleCompletions(
  client: CopilotClient,
  metrics: MetricsRegistry,
  recordTokens: TokenRecorder,
  recordExtraction: ExtractionRecorder,
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
      recordResponseTextUsage(upstreamText, true, model, recordTokens, recordExtraction);
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
        recordExtraction,
      ),
    );
  }
  const completion = asRecord(await upstream.json());
  const usage = extractTokenUsage(completion.usage);
  if (usage) {
    const responseModel = typeof completion.model === "string" ? completion.model.trim() : "";
    recordTokens(responseModel || model, usage);
  }
  recordExtraction(usage !== undefined);
  return jsonResponse(chatCompletionToCompletion(completion));
}

async function handleResponses(
  client: CopilotClient,
  metrics: MetricsRegistry,
  recordTokens: TokenRecorder,
  recordExtraction: ExtractionRecorder,
  request: Request,
  logger: HoopilotLogger,
  bufferProxyBodies: boolean,
): Promise<Response> {
  const { json, text: body } = await readJsonText(request);
  const upstream = await client.responses(body, request.signal);
  metrics.recordUpstream("/responses", upstream.ok);
  if (!upstream.ok) {
    return proxyError(upstream, logger);
  }
  logUpstreamSuccess(logger, "/responses", upstream.status);
  const model = normalizeRequestedModel(json.model);
  return proxyResponse(
    await responseWithObservedUsage(
      upstream,
      model,
      recordTokens,
      request.signal,
      bufferProxyBodies,
      recordExtraction,
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
  recordExtraction: ExtractionRecorder,
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
  recordResponseTextUsage(
    text,
    isSse,
    normalizeRequestedModel(body.model),
    recordTokens,
    recordExtraction,
  );
  return jsonResponse(responsesCompactionResult(text, isSse));
}

async function responseWithObservedUsage(
  response: Response,
  fallbackModel: string,
  recordTokens: TokenRecorder,
  signal: AbortSignal,
  bufferBody: boolean,
  recordExtraction: ExtractionRecorder,
): Promise<Response> {
  const isSse = isStreamingResponse(response);
  if (bufferBody && response.body) {
    const text = await response.text();
    recordResponseTextUsage(text, isSse, fallbackModel, recordTokens, recordExtraction);
    return responseFromText(response, text);
  }
  return observeResponseUsage(response, fallbackModel, recordTokens, signal, recordExtraction);
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
    throw new InvalidJsonError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JsonNotObjectError();
  }
  return parsed as JsonObject;
}

async function readJsonText(request: Request): Promise<{ json: JsonObject; text: string }> {
  const text = await readRequestText(request);
  return { json: parseJsonObject(text), text };
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

function jsonResponse(body: object, status = 200): Response {
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
  const parsedError = asRecord(asRecord(safeJsonParse(text)).error);
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

// Compare two secrets in constant time. Both sides are hashed to a fixed-width
// digest first so neither the key length nor a prefix match leaks via timing.
function secretEquals(candidate: string, secret: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

function isAuthorized(request: Request, apiKey: string | undefined): boolean {
  if (!apiKey) {
    return true;
  }
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return (
    (bearer !== undefined && secretEquals(bearer, apiKey)) ||
    secretEquals(request.headers.get("x-api-key") ?? "", apiKey)
  );
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
  return isLoopbackHostname(host);
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
  return parseStreamingProxyMode(value);
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
  // Release the source reader's lock on every terminal path so it is never
  // leaked. Idempotent: the first terminal branch wins.
  const release = (): void => {
    if (fired) {
      return;
    }
    fired = true;
    onComplete();
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          release();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (!fired) {
        fired = true;
        onComplete();
      }
      // The lock must be released after the cancel settles, not before, so a
      // pending read is not orphaned mid-cancel.
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
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

// Single source of truth mapping (method, path) to a stable route name. Both the
// request dispatch (switch on `route`) and routeFor() derive from this table, so
// adding or renaming a route only touches one list. Names double as metrics and
// log labels, so they must stay stable.
const API_ROUTES: ReadonlyArray<{ method: string; path: string; name: string }> = [
  { method: "GET", path: "/", name: "health" },
  { method: "GET", path: "/healthz", name: "health" },
  { method: "GET", path: "/dashboard", name: "dashboard" },
  { method: "GET", path: "/metrics", name: "metrics" },
  { method: "GET", path: "/v1/usage", name: "usage" },
  { method: "GET", path: "/v1/models", name: "models" },
  { method: "GET", path: "/v1/responses", name: "responses_websocket" },
  { method: "POST", path: "/v1/messages", name: "anthropic_messages" },
  { method: "POST", path: "/v1/messages/count_tokens", name: "anthropic_count_tokens" },
  { method: "POST", path: "/v1/chat/completions", name: "chat_completions" },
  { method: "POST", path: "/v1/completions", name: "completions" },
  { method: "POST", path: "/v1/responses/compact", name: "responses_compact" },
  { method: "POST", path: "/v1/responses", name: "responses" },
];

function routeFor(method: string, path: string): string {
  if (method === "OPTIONS") {
    return "cors.preflight";
  }
  return (
    API_ROUTES.find((entry) => entry.method === method && entry.path === path)?.name ?? "not_found"
  );
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

// Serve the self-contained dashboard HTML. The per-request CORS and request-id
// headers are layered on by finishResponse; the page itself embeds no secrets.
// A strict CSP and frame-busting headers harden the page even though it handles
// the local API key in the browser: it loads zero external resources and only
// fetches the same-origin /v1/usage, so 'self'/'unsafe-inline' suffice, and
// frame-ancestors/X-Frame-Options close any clickjacking surface on engines that
// do not send Sec-Fetch-Metadata (which the cross-origin block relies on).
function dashboardResponse(): Response {
  return new Response(DASHBOARD_HTML, {
    headers: {
      ...corsHeaders(),
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
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
  const body: UsageResponseBody = {
    copilot: copilot ?? null,
    object: "usage",
    proxy,
    version: await getVersion(),
  };
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
      // api.github.com returns the x-ratelimit-* budget on every reply — on the
      // error path too, where retry-after / a spent budget is the useful signal —
      // so capture it off the quota call without spending an extra request.
      metrics.recordGithubRateLimit(parseRateLimitHeaders(upstream.headers, now()));
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
