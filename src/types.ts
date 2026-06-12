export type AuthMode = "auto" | "copilot-token" | "github-token" | "direct-github-token";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface CopilotAuthOptions {
  authMode?: AuthMode;
  copilotApiBaseUrl?: string;
  copilotToken?: string;
  githubToken?: string;
  githubTokenCommand?: string | false;
  tokenExchangeUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  logger?: Logger;
}

export interface CopilotAccess {
  apiBaseUrl: string;
  expiresAtMs: number;
  source: "copilot-token" | "github-token" | "direct-github-token";
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
