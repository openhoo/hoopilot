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
  format?: LogFormat | string;
  level?: LogLevel | string;
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
  logFormat?: LogFormat | string;
  logLevel?: LogLevel | string;
  metrics?: MetricsRegistry;
  port?: number;
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

/** A point-in-time JSON view of the in-process metrics. */
export interface MetricsSnapshot {
  inFlight: number;
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
