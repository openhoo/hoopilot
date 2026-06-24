export {
  AnthropicCompatibilityError,
  anthropicMessagesToResponsesRequest,
  estimateAnthropicMessageTokens,
  responsesResponseToAnthropicMessage,
  responsesStreamToAnthropicStream,
} from "./anthropic";
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
export { githubCopilotDeviceLogin } from "./github-device";
export {
  createHoopilotLogger,
  DEFAULT_LOG_FORMAT,
  DEFAULT_LOG_LEVEL,
  noopLogger,
  parseLogFormat,
  parseLogLevel,
} from "./logger";
export {
  MetricsRegistry,
  observeResponseUsage,
  PROMETHEUS_CONTENT_TYPE,
  recordResponseTextUsage,
} from "./metrics";
export {
  chatCompletionToCompletion,
  chatCompletionToResponse,
  completionStreamFromChatStream,
  completionsRequestToChatCompletion,
  DEFAULT_MODEL,
  extractTokenUsage,
  fallbackModels,
  normalizeChatCompletionRequest,
  normalizeModelsResponse,
  normalizeRequestedModel,
  OpenAICompatibilityError,
  responsesCompactionResult,
  responsesRequestToChatCompletion,
  responsesStreamFromChatStream,
} from "./openai";
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
