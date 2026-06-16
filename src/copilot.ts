import { CopilotAuth } from "./auth";
import type { CopilotAuthOptions, FetchLike, JsonObject } from "./types";

/**
 * Set the GitHub Copilot API request headers on `headers`, leaving any
 * caller-provided `accept` intact. Single source of truth for the pinned
 * integration id, editor/plugin versions, and API version so the proxy client
 * and the login-time verification call cannot drift apart.
 */
export function applyCopilotHeaders(headers: Headers, token: string): Headers {
  headers.set("accept", headers.get("accept") ?? "application/json");
  headers.set("authorization", `Bearer ${token}`);
  headers.set("copilot-integration-id", "vscode-chat");
  headers.set("editor-plugin-version", "hoopilot/0.1.0");
  headers.set("editor-version", "Hoopilot/0.1.0");
  headers.set("openai-intent", "conversation-panel");
  headers.set("user-agent", "hoopilot/0.1.0");
  headers.set("x-github-api-version", "2026-06-01");
  return headers;
}

export class CopilotClient {
  readonly #auth: CopilotAuth;
  readonly #fetch: FetchLike;

  constructor(options: CopilotAuthOptions = {}) {
    this.#auth = new CopilotAuth(options);
    this.#fetch = options.fetch ?? fetch;
  }

  async chatCompletions(body: JsonObject, signal?: AbortSignal): Promise<Response> {
    return this.fetchCopilot("/chat/completions", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
      signal,
    });
  }

  async responses(body: string, signal?: AbortSignal): Promise<Response> {
    return this.fetchCopilot("/responses", {
      body,
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
      signal,
    });
  }

  async models(signal?: AbortSignal): Promise<Response> {
    return this.fetchCopilot("/models", {
      headers: {
        accept: "application/json",
      },
      method: "GET",
      signal,
    });
  }

  async fetchCopilot(path: string, init: RequestInit): Promise<Response> {
    const access = await this.#auth.getAccess();
    const headers = applyCopilotHeaders(new Headers(init.headers), access.token);

    return this.#fetch(`${access.apiBaseUrl}${path}`, {
      ...init,
      headers,
    });
  }
}
