import { CopilotAuth } from "./auth";
import type { CopilotAuthOptions, FetchLike, JsonObject } from "./types";

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
    const headers = new Headers(init.headers);
    headers.set("accept", headers.get("accept") ?? "application/json");
    headers.set("authorization", `Bearer ${access.token}`);
    headers.set("copilot-integration-id", "vscode-chat");
    headers.set("editor-plugin-version", "hoopilot/0.1.0");
    headers.set("editor-version", "Hoopilot/0.1.0");
    headers.set("openai-intent", "conversation-panel");
    headers.set("user-agent", "hoopilot/0.1.0");
    headers.set("x-github-api-version", "2026-06-01");

    return this.#fetch(`${access.apiBaseUrl}${path}`, {
      ...init,
      headers,
    });
  }
}
