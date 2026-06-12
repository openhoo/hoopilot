import { execFileSync } from "node:child_process";
import type { CopilotAccess, CopilotAuthOptions, FetchLike, Logger } from "./types";

const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
const DEFAULT_TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";
const REFRESH_SKEW_MS = 60_000;

export class CopilotAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopilotAuthError";
  }
}

class CopilotTokenExchangeHttpError extends CopilotAuthError {}

export class CopilotAuth {
  readonly #authMode: NonNullable<CopilotAuthOptions["authMode"]>;
  readonly #copilotApiBaseUrl: string;
  readonly #copilotToken?: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #fetch: FetchLike;
  readonly #githubToken?: string;
  readonly #githubTokenCommand: string | false;
  readonly #logger?: Logger;
  readonly #tokenExchangeUrl: string;
  #cachedAccess?: CopilotAccess;

  constructor(options: CopilotAuthOptions = {}) {
    this.#authMode = options.authMode ?? "auto";
    this.#copilotApiBaseUrl = trimTrailingSlash(
      options.copilotApiBaseUrl ??
        options.env?.COPILOT_API_BASE_URL ??
        DEFAULT_COPILOT_API_BASE_URL,
    );
    this.#copilotToken = options.copilotToken;
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch ?? fetch;
    this.#githubToken = options.githubToken;
    this.#githubTokenCommand = options.githubTokenCommand ?? "gh auth token";
    this.#logger = options.logger;
    this.#tokenExchangeUrl =
      options.tokenExchangeUrl ??
      options.env?.COPILOT_TOKEN_EXCHANGE_URL ??
      DEFAULT_TOKEN_EXCHANGE_URL;
  }

  async getAccess(): Promise<CopilotAccess> {
    if (this.#cachedAccess && this.#cachedAccess.expiresAtMs - REFRESH_SKEW_MS > Date.now()) {
      return this.#cachedAccess;
    }

    const directCopilotToken = this.#resolveDirectCopilotToken();
    if (directCopilotToken) {
      return this.#cacheAccess({
        apiBaseUrl: this.#copilotApiBaseUrl,
        expiresAtMs: Date.now() + 10 * 60_000,
        source: "copilot-token",
        token: directCopilotToken,
      });
    }

    if (this.#authMode === "copilot-token") {
      throw new CopilotAuthError("COPILOT_API_TOKEN or GITHUB_COPILOT_API_TOKEN is required.");
    }

    const githubToken = this.#resolveGithubToken();
    if (!githubToken) {
      throw new CopilotAuthError(
        "No Copilot credential found. Set COPILOT_API_TOKEN, set COPILOT_GITHUB_TOKEN from gh auth token, or sign in with gh auth login.",
      );
    }

    if (isPersonalAccessToken(githubToken)) {
      throw new CopilotAuthError(
        "GitHub personal access tokens are not supported for Copilot authentication. Use gh auth login or COPILOT_API_TOKEN.",
      );
    }

    try {
      return this.#cacheAccess(await this.#exchangeGithubToken(githubToken));
    } catch (error) {
      if (!(error instanceof CopilotTokenExchangeHttpError)) {
        throw error;
      }
      this.#logger?.warn(
        `Copilot token exchange failed; falling back to GitHub CLI token mode: ${errorMessage(
          error,
        )}`,
      );
      return this.#cacheAccess({
        apiBaseUrl: this.#copilotApiBaseUrl,
        expiresAtMs: Date.now() + 10 * 60_000,
        source: "direct-github-token",
        token: githubToken,
      });
    }
  }

  #cacheAccess(access: CopilotAccess): CopilotAccess {
    this.#cachedAccess = access;
    return access;
  }

  async #exchangeGithubToken(githubToken: string): Promise<CopilotAccess> {
    const response = await this.#fetch(this.#tokenExchangeUrl, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `token ${githubToken}`,
        "editor-plugin-version": "hoopilot/0.1.0",
        "editor-version": "Hoopilot/0.1.0",
        "user-agent": "hoopilot/0.1.0",
      },
      method: "GET",
    });

    if (!response.ok) {
      throw new CopilotTokenExchangeHttpError(
        `GitHub Copilot token exchange failed with ${response.status}: ${await safeResponseText(
          response,
        )}`,
      );
    }

    const body = asRecord(await response.json());
    const token = getString(body, "token");
    if (!token) {
      throw new CopilotAuthError("GitHub Copilot token exchange response did not include a token.");
    }

    return {
      apiBaseUrl: endpointFromResponse(body) ?? this.#copilotApiBaseUrl,
      expiresAtMs: expiresAtFromResponse(body),
      source: "github-token",
      token,
    };
  }

  #resolveDirectCopilotToken(): string | undefined {
    return firstNonEmpty(
      this.#copilotToken,
      this.#env.COPILOT_API_TOKEN,
      this.#env.GITHUB_COPILOT_API_TOKEN,
      this.#env.GITHUB_COPILOT_TOKEN,
    );
  }

  #resolveGithubToken(): string | undefined {
    return firstNonEmpty(
      this.#githubToken,
      this.#env.COPILOT_GITHUB_TOKEN,
      this.#env.GITHUB_COPILOT_GITHUB_TOKEN,
      this.#readGithubTokenCommand(),
    );
  }

  #readGithubTokenCommand(): string | undefined {
    if (this.#githubTokenCommand === false) {
      return undefined;
    }
    const parts = splitCommand(this.#githubTokenCommand);
    const [command, ...args] = parts;
    if (!command) {
      return undefined;
    }
    try {
      const output = execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      });
      return output.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const character of command.trim()) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function endpointFromResponse(body: Record<string, unknown>): string | undefined {
  const endpoints = asRecord(body.endpoints);
  const apiUrl = getString(endpoints, "api") ?? getString(endpoints, "proxy");
  return apiUrl ? trimTrailingSlash(apiUrl) : undefined;
}

function expiresAtFromResponse(body: Record<string, unknown>): number {
  const expiresAt = body.expires_at;
  if (typeof expiresAt === "number") {
    return expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt;
  }
  if (typeof expiresAt === "string") {
    const asNumber = Number(expiresAt);
    if (Number.isFinite(asNumber)) {
      return asNumber < 10_000_000_000 ? asNumber * 1000 : asNumber;
    }
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const refreshIn = body.refresh_in;
  if (typeof refreshIn === "number" && Number.isFinite(refreshIn)) {
    return Date.now() + refreshIn * 1000;
  }
  return Date.now() + 10 * 60_000;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function safeResponseText(response: Response): Promise<string> {
  const text = await response.text();
  return text.slice(0, 500);
}

function isPersonalAccessToken(token: string): boolean {
  return token.startsWith("github_pat_") || token.startsWith("ghp_");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
