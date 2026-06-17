export { CopilotAuth, CopilotAuthError } from "./auth";
export { authStorePath, readStoredCopilotAuth, writeStoredCopilotAuth } from "./auth-store";
export {
  applyCopilotHeaders,
  applyGithubApiHeaders,
  COPILOT_USAGE_API_VERSION,
  CopilotClient,
  DEFAULT_GITHUB_API_BASE_URL,
  normalizeCopilotUsage,
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
  HoopilotLogger,
  HoopilotLoggerOptions,
  HoopilotServerOptions,
  JsonObject,
  LogFields,
  LogFormat,
  Logger,
  LogLevel,
  LogMethod,
  MetricsSnapshot,
  ModelTokenTotals,
  RequestObservation,
  StartedHoopilotServer,
  TokenUsage,
} from "./types";
