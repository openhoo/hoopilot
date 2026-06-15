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
  port?: number;
}

export interface StartedHoopilotServer {
  server: Bun.Server<undefined>;
  url: string;
}

export type JsonObject = Record<string, unknown>;
