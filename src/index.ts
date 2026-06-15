export { CopilotAuth, CopilotAuthError } from "./auth";
export { authStorePath, readStoredCopilotAuth, writeStoredCopilotAuth } from "./auth-store";
export { CopilotClient } from "./copilot";
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
  chatCompletionToCompletion,
  chatCompletionToResponse,
  completionsRequestToChatCompletion,
  DEFAULT_MODEL,
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
  StartedHoopilotServer,
} from "./types";
