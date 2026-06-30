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
import {
  CopilotClient,
  CopilotUpstreamTimeoutError,
  normalizeCopilotUsage,
  parseRateLimitHeaders,
} from "./copilot";
import { DASHBOARD_HTML } from "./dashboard";
import {
  InvalidJsonError,
  JsonNotObjectError,
  RequestBodyTooLargeError,
  readJson,
  readJsonText,
} from "./http/body";
import {
  jsonError,
  jsonResponse,
  proxyResponse,
  responseFromText,
  textResponse,
  upstreamErrorResponse,
  websocketUnsupportedResponse,
} from "./http/responses";
import {
  apiKeyRejectionReason,
  corsHeaders,
  FORBIDDEN_BROWSER_ORIGIN_MESSAGE,
  forbiddenBrowserOrigin,
  isAuthorized,
  isLoopbackHost,
  parseAllowedOrigins,
  resolveCorsAllowOrigin,
  urlHost,
} from "./http/security";
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
  isResponsesCompactionRequest,
  normalizeChatCompletionRequest,
  normalizeModelsResponse,
  normalizeRequestedModel,
  normalizeResponsesRequestForCopilotBody,
  OpenAICompatibilityError,
  responsesCompactionRequestBody,
  responsesCompactionResponse,
  responsesCompactionResult,
  responsesCompactionSseText,
  responsesRequestNeedsCopilotNormalization,
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
import { asRecord, envValue, errorMessage, parseStreamingProxyMode } from "./util";
import { getVersion, IS_STANDALONE_BINARY } from "./version";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4141;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const USAGE_CACHE_TTL_MS = 60_000;
const DASHBOARD_USAGE_VIEW = "dashboard";
const DASHBOARD_EXCLUDED_ROUTES = [
  "cors.preflight",
  "dashboard",
  "health",
  "metrics",
  "usage",
] as const;
const DASHBOARD_EXCLUDED_UPSTREAM_PATHS = ["/copilot_internal/user"] as const;

interface UsageReadResult {
  copilot?: CopilotUsage;
  error?: string;
}

type UsageReader = (signal?: AbortSignal) => Promise<UsageReadResult>;
type TokenRecorder = (model: string, usage: TokenUsage) => void;
type ExtractionRecorder = (extracted: boolean) => void;

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
    metrics.startRequest(route);
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
        if (error instanceof CopilotUpstreamTimeoutError) {
          logger.warn(
            { err: errorDetails(error), event: "copilot.request.timeout" },
            "copilot upstream request timed out",
          );
          return jsonError(504, "copilot_timeout", message);
        }
        logger.error({ err: errorDetails(error), event: "http.request.failed" }, "request failed");
        return jsonError(500, "internal_error", message);
      })
      .get("/", () => jsonResponse({ name: "hoopilot", object: "health", status: "ok" }))
      .get("/healthz", () => jsonResponse({ name: "hoopilot", object: "health", status: "ok" }))
      .get("/metrics", () => metricsResponse(metrics))
      .get("/v1/usage", ({ request }) => handleUsage(metrics, readUsage, request))
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
    const rejection = apiKey ? apiKeyRejectionReason(apiKey) : undefined;
    if (rejection) {
      throw new Error(`Refusing to listen on a non-loopback host: ${rejection}`);
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
  if (isResponsesCompactionRequest(json)) {
    return handleResponsesCompactionV2(
      client,
      metrics,
      recordTokens,
      recordExtraction,
      json,
      request,
      logger,
    );
  }

  const upstream = await client.responses(
    responsesRequestNeedsCopilotNormalization(json)
      ? normalizeResponsesRequestForCopilotBody(json)
      : body,
    request.signal,
  );
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
  const upstream = await client.responses(responsesCompactionRequestBody(body), request.signal);
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

async function handleResponsesCompactionV2(
  client: CopilotClient,
  metrics: MetricsRegistry,
  recordTokens: TokenRecorder,
  recordExtraction: ExtractionRecorder,
  json: JsonObject,
  request: Request,
  logger: HoopilotLogger,
): Promise<Response> {
  const upstream = await client.responses(responsesCompactionRequestBody(json), request.signal);
  metrics.recordUpstream("/responses", upstream.ok);
  if (!upstream.ok) {
    return proxyError(upstream, logger);
  }
  logUpstreamSuccess(logger, "/responses", upstream.status);
  const isSse = isStreamingResponse(upstream);
  const text = await upstream.text();
  const model = normalizeRequestedModel(json.model);
  recordResponseTextUsage(text, isSse, model, recordTokens, recordExtraction);
  if (json.stream === true) {
    return textResponse(responsesCompactionSseText(text, isSse, model), "text/event-stream");
  }
  return jsonResponse(responsesCompactionResponse(text, isSse, model));
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

function isUpstreamAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function upstreamAuthMessage(message: string): string {
  return `GitHub Copilot rejected the credential or account access: ${message}`;
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
  request: Request,
): Promise<Response> {
  const view = new URL(request.url).searchParams.get("view");
  const { copilot, error } = await readUsage(request.signal);
  const proxy =
    view === DASHBOARD_USAGE_VIEW
      ? metrics.snapshot({
          excludeRoutes: DASHBOARD_EXCLUDED_ROUTES,
          excludeUpstreamPaths: DASHBOARD_EXCLUDED_UPSTREAM_PATHS,
        })
      : metrics.snapshot();
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
  let cache: { atMs: number; result: UsageReadResult } | undefined;
  return async (signal) => {
    if (cache && now() - cache.atMs < ttlMs) {
      return cache.result;
    }
    try {
      const upstream = await client.usage(signal);
      metrics.recordUpstream(usagePath, upstream.ok);
      // api.github.com returns the x-ratelimit-* budget on every reply — on the
      // error path too, where retry-after / a spent budget is the useful signal —
      // so capture it off the quota call without spending an extra request.
      metrics.recordGithubRateLimit(parseRateLimitHeaders(upstream.headers, now()));
      if (!upstream.ok) {
        const result = { error: `GitHub Copilot usage request failed with ${upstream.status}.` };
        cache = { atMs: now(), result };
        return result;
      }
      const value = normalizeCopilotUsage(await upstream.json().catch(() => ({})));
      const result = { copilot: value };
      cache = { atMs: now(), result };
      metrics.recordCopilotQuota(value);
      return result;
    } catch (error) {
      if (error instanceof CopilotAuthError) {
        return { error: error.message };
      }
      metrics.recordUpstream(usagePath, false);
      const result = { error: errorMessage(error) };
      cache = { atMs: now(), result };
      return result;
    }
  };
}
