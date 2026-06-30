export { CopilotAuth, CopilotAuthError, DEFAULT_COPILOT_API_BASE_URL } from "./auth";
export { authStorePath, readStoredCopilotAuth, writeStoredCopilotAuth } from "./auth-store";
export {
  applyCopilotHeaders,
  applyGithubApiHeaders,
  COPILOT_USAGE_API_VERSION,
  CopilotClient,
  DEFAULT_GITHUB_API_BASE_URL,
  normalizeCopilotUsage,
  parseRateLimitHeaders,
} from "./copilot";
export { DEFAULT_MODEL } from "./defaults";
export { githubCopilotDeviceLogin } from "./github-device";
export {
  createHoopilotLogger,
  DEFAULT_LOG_FORMAT,
  DEFAULT_LOG_LEVEL,
  noopLogger,
  parseLogFormat,
  parseLogLevel,
} from "./logger";
export { MetricsRegistry, PROMETHEUS_CONTENT_TYPE } from "./metrics";
export { createHoopilotHandler, startHoopilotServer } from "./server";
export type {
  CopilotAccess,
  CopilotAuthOptions,
  CopilotQuota,
  CopilotUsage,
  FetchLike,
  GithubRateLimit,
  GithubRateLimitSnapshot,
  HoopilotLogger,
  HoopilotLoggerOptions,
  HoopilotServerOptions,
  JsonObject,
  LatencySnapshot,
  LogFields,
  LogFormat,
  Logger,
  LogLevel,
  LogMethod,
  MetricsSnapshot,
  ModelTokenTotals,
  RequestObservation,
  RouteLatency,
  StartedHoopilotServer,
  StreamingProxyMode,
  TokenUsage,
  UsageResponseBody,
} from "./types";
