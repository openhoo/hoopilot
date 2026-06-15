export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
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
  port?: number;
}

export interface StartedHoopilotServer {
  server: Bun.Server<undefined>;
  url: string;
}

export type JsonObject = Record<string, unknown>;
