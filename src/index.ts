export { CopilotAuth, CopilotAuthError, splitCommand } from "./auth";
export { CopilotClient } from "./copilot";
export {
  chatCompletionToCompletion,
  chatCompletionToResponse,
  completionsRequestToChatCompletion,
  DEFAULT_MODEL,
  fallbackModels,
  normalizeModelsResponse,
  responsesRequestToChatCompletion,
  responsesStreamFromChatStream,
} from "./openai";
export { createHoopilotHandler, startHoopilotServer } from "./server";
export type {
  AuthMode,
  CopilotAccess,
  CopilotAuthOptions,
  FetchLike,
  HoopilotServerOptions,
  JsonObject,
  Logger,
  StartedHoopilotServer,
} from "./types";
