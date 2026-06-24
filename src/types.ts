import type { MetricsRegistry } from "./metrics";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type LogFields = Record<string, unknown>;
export type LogFormat = "json" | "pretty";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
export type StreamingProxyMode = "auto" | "buffer" | "live";

export interface LogMethod {
  (message: string): void;
  (fields: LogFields, message: string): void;
}

export interface HoopilotLogger {
  child(bindings: LogFields): HoopilotLogger;
  debug: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
  info: LogMethod;
  trace: LogMethod;
  warn: LogMethod;
}

export interface HoopilotLoggerOptions {
  base?: LogFields;
  colorize?: boolean;
  env?: NodeJS.ProcessEnv;
  // `string & {}` keeps editor autocomplete for the known literals while still
  // accepting arbitrary raw env/CLI strings, which are validated at runtime.
  format?: LogFormat | (string & {});
  level?: LogLevel | (string & {});
  stream?: { write(message: string): unknown };
}

export interface CopilotAuthOptions {
  authStorePath?: string;
  copilotApiBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  githubApiBaseUrl?: string;
}

export interface CopilotAccess {
  apiBaseUrl: string;
  expiresAtMs: number;
  source: "github-copilot-oauth";
  token: string;
}

export interface HoopilotServerOptions extends CopilotAuthOptions {
  allowUnauthenticated?: boolean;
  apiKey?: string;
  host?: string;
  logger?: HoopilotLogger;
  logFormat?: LogFormat | (string & {});
  logLevel?: LogLevel | (string & {});
  metrics?: MetricsRegistry;
  port?: number;
  streamingProxyMode?: StreamingProxyMode | (string & {});
}

export interface StartedHoopilotServer {
  server: Bun.Server<undefined>;
  url: string;
}

export type JsonObject = Record<string, unknown>;

/** Normalized token usage extracted from an upstream OpenAI/Copilot response. */
export interface TokenUsage {
  cachedTokens?: number;
  completionTokens: number;
  promptTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
}

/** Per-model token totals accumulated by the metrics registry. */
export interface ModelTokenTotals {
  cached: number;
  completion: number;
  prompt: number;
  reasoning: number;
  requests: number;
  total: number;
}

/** A single completed request's facts, recorded into the metrics registry. */
export interface RequestObservation {
  durationMs: number;
  method: string;
  route: string;
  status: number;
}

/** One quota category (chat, completions, or premium_interactions/credits). */
export interface CopilotQuota {
  entitlement?: number;
  hasQuota?: boolean;
  overageCount?: number;
  overageEntitlement?: number;
  overagePermitted?: boolean;
  percentRemaining?: number;
  quotaId?: string;
  quotaResetAt?: string;
  remaining?: number;
  timestampUtc?: string;
  tokenBasedBilling?: boolean;
  unlimited?: boolean;
  used?: number;
}

/** A GitHub Copilot account's plan and quota snapshot. */
export interface CopilotUsage {
  accessTypeSku?: string;
  chatEnabled?: boolean;
  plan?: string;
  quotaResetDate?: string;
  quotas: Record<string, CopilotQuota>;
}

/**
 * GitHub REST API rate-limit budget parsed from the `x-ratelimit-*` headers that
 * `api.github.com` returns on every response. Hoopilot reads these off the
 * `copilot_internal/user` quota call it already makes, so the proxy's GitHub API
 * usage is visible without spending an extra request.
 */
export interface GithubRateLimit {
  /** `x-ratelimit-resource` — the bucket the request counted against (e.g. `core`). */
  resource: string;
  /** `x-ratelimit-limit` — maximum requests allowed in the current window. */
  limit?: number;
  /** `x-ratelimit-remaining` — requests left in the current window. */
  remaining?: number;
  /** `x-ratelimit-used` — requests already spent in the current window. */
  used?: number;
  /** `x-ratelimit-reset` — Unix epoch seconds when the window resets. */
  resetEpochSeconds?: number;
  /** `retry-after` — seconds to wait, present on 429 / secondary-limit responses. */
  retryAfterSeconds?: number;
  /** Wall-clock epoch ms when these values were observed. */
  observedAtMs: number;
}

/** JSON view of one GitHub rate-limit resource, as rendered into a snapshot. */
export interface GithubRateLimitSnapshot {
  limit?: number;
  observedAt: string;
  remaining?: number;
  resetAt?: string;
  retryAfterSeconds?: number;
  used?: number;
}

/** Request-latency summary for one route, in milliseconds. */
export interface RouteLatency {
  avgMs: number;
  count: number;
}

/**
 * Aggregate request-latency summary derived from the duration histogram. `avgMs`
 * is exact; the percentiles are estimated from the histogram buckets (Prometheus-
 * style linear interpolation), so they are approximate.
 */
export interface LatencySnapshot {
  avgMs: number;
  byRoute: Record<string, RouteLatency>;
  count: number;
  p50Ms: number;
  p95Ms: number;
}

/** A point-in-time JSON view of the in-process metrics. */
export interface MetricsSnapshot {
  githubRateLimit: Record<string, GithubRateLimitSnapshot>;
  inFlight: number;
  latency: LatencySnapshot;
  requests: {
    byRoute: Record<string, number>;
    byStatus: Record<string, number>;
    total: number;
  };
  startedAt: string;
  tokens: {
    byModel: Record<string, ModelTokenTotals>;
    cached: number;
    completion: number;
    extraction: { extracted: number; missing: number };
    prompt: number;
    reasoning: number;
    total: number;
  };
  upstream: {
    errors: number;
    total: number;
  };
  uptimeSeconds: number;
}

/** JSON body returned by the proxy's `/v1/usage` route. */
export interface UsageResponseBody {
  copilot: CopilotUsage | null;
  copilot_error?: string;
  object: "usage";
  proxy: MetricsSnapshot;
  version: string;
}
