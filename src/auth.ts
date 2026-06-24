import {
  readStoredCopilotAuth,
  type StoredCopilotAuth,
  StoredCopilotAuthError,
} from "./auth-store";
import type { CopilotAccess, CopilotAuthOptions } from "./types";
import { envValue, trimTrailingSlash } from "./util";

export const DEFAULT_COPILOT_API_BASE_URL = "https://api.githubcopilot.com";
const REFRESH_SKEW_MS = 60_000;
export const STORED_TOKEN_TTL_MS = 10 * 60_000;

export class CopilotAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopilotAuthError";
  }
}

export class CopilotAuth {
  readonly #authStorePath?: string;
  readonly #copilotApiBaseUrl: string;
  readonly #hasCopilotApiBaseUrlOverride: boolean;
  #cachedAccess?: CopilotAccess;

  constructor(options: CopilotAuthOptions = {}) {
    const envAuthStorePath = envValue(options.env?.HOOPILOT_AUTH_FILE);
    const envCopilotApiBaseUrl = envValue(options.env?.COPILOT_API_BASE_URL);
    this.#authStorePath = options.authStorePath ?? envAuthStorePath;
    this.#hasCopilotApiBaseUrlOverride = Boolean(options.copilotApiBaseUrl ?? envCopilotApiBaseUrl);
    this.#copilotApiBaseUrl = trimTrailingSlash(
      options.copilotApiBaseUrl ?? envCopilotApiBaseUrl ?? DEFAULT_COPILOT_API_BASE_URL,
    );
  }

  async getAccess(): Promise<CopilotAccess> {
    if (this.#cachedAccess && this.#cachedAccess.expiresAtMs - REFRESH_SKEW_MS > Date.now()) {
      return this.#cachedAccess;
    }

    let stored: StoredCopilotAuth | undefined;
    try {
      stored = readStoredCopilotAuth(this.#authStorePath);
    } catch (error) {
      if (error instanceof StoredCopilotAuthError) {
        throw new CopilotAuthError(error.message);
      }
      throw error;
    }
    if (stored) {
      this.#cachedAccess = {
        apiBaseUrl: trimTrailingSlash(
          this.#hasCopilotApiBaseUrlOverride
            ? this.#copilotApiBaseUrl
            : (stored.apiBaseUrl ?? this.#copilotApiBaseUrl),
        ),
        expiresAtMs: Date.now() + STORED_TOKEN_TTL_MS,
        source: "github-copilot-oauth",
        token: stored.token,
      };
      return this.#cachedAccess;
    }

    throw new CopilotAuthError(
      "No GitHub Copilot OAuth credential found. Run `hoopilot login` to sign in through your browser.",
    );
  }
}
