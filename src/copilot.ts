import { CopilotAuth } from "./auth";
import type {
  CopilotAuthOptions,
  CopilotQuota,
  CopilotUsage,
  FetchLike,
  JsonObject,
} from "./types";
import { asRecord, trimTrailingSlash } from "./util";

/** Default GitHub REST host that serves the `copilot_internal/user` quota route. */
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

/**
 * API version sent to the GitHub `copilot_internal` endpoints. This is a
 * different surface from the Copilot completions API (`x-github-api-version`
 * `2026-06-01`), so it is pinned separately and bumped independently.
 */
export const COPILOT_USAGE_API_VERSION = "2025-04-01";

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

/**
 * Set headers for the GitHub REST `copilot_internal/user` quota call. This host
 * is `api.github.com` (not the Copilot API host) and expects the `token` auth
 * scheme with the raw stored OAuth token — not the `Bearer` scheme used by the
 * Copilot completion endpoints.
 */
export function applyGithubApiHeaders(headers: Headers, token: string): Headers {
  headers.set("accept", headers.get("accept") ?? "application/json");
  headers.set("authorization", `token ${token}`);
  headers.set("editor-plugin-version", "hoopilot/0.1.0");
  headers.set("editor-version", "Hoopilot/0.1.0");
  headers.set("user-agent", "hoopilot/0.1.0");
  headers.set("x-github-api-version", COPILOT_USAGE_API_VERSION);
  return headers;
}

export class CopilotClient {
  readonly #auth: CopilotAuth;
  readonly #fetch: FetchLike;
  readonly #githubApiBaseUrl: string;

  constructor(options: CopilotAuthOptions = {}) {
    this.#auth = new CopilotAuth(options);
    this.#fetch = options.fetch ?? fetch;
    this.#githubApiBaseUrl = trimTrailingSlash(
      options.githubApiBaseUrl ??
        options.env?.HOOPILOT_GITHUB_API_BASE_URL ??
        DEFAULT_GITHUB_API_BASE_URL,
    );
  }

  /**
   * Fetch the Copilot account's quota / premium-request usage from the GitHub
   * REST `copilot_internal/user` endpoint. The stored device-flow OAuth token is
   * accepted directly here — no Copilot token exchange is required to read quota.
   */
  async usage(signal?: AbortSignal): Promise<Response> {
    // The quota call sends the raw, long-lived OAuth token. Never transmit it
    // over plaintext to a non-loopback host, so a misconfigured base URL cannot
    // exfiltrate the credential.
    if (!isHttpsOrLoopback(this.#githubApiBaseUrl)) {
      throw new Error(
        `Refusing to send the GitHub OAuth token to a non-HTTPS host: ${this.#githubApiBaseUrl}`,
      );
    }
    const access = await this.#auth.getAccess();
    const headers = applyGithubApiHeaders(new Headers(), access.token);
    return this.#fetch(`${this.#githubApiBaseUrl}/copilot_internal/user`, {
      headers,
      method: "GET",
      signal,
    });
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

/**
 * Normalize a `copilot_internal/user` response into {@link CopilotUsage}. Handles
 * both the paid-plan shape (`quota_snapshots.{chat,completions,premium_interactions}`)
 * and the free-plan shape (`limited_user_quotas` remaining + `monthly_quotas`
 * allowance). `remaining` may be fractional and negative under permitted overage,
 * so `used` is derived as `max(0, entitlement - remaining)`.
 */
export function normalizeCopilotUsage(body: unknown): CopilotUsage {
  const record = asRecord(body);
  const quotas: Record<string, CopilotQuota> = {};

  const snapshots = asRecord(record.quota_snapshots);
  for (const [category, detail] of Object.entries(snapshots)) {
    quotas[category] = normalizeQuotaDetail(asRecord(detail));
  }

  if (Object.keys(quotas).length === 0) {
    const remaining = asRecord(record.limited_user_quotas);
    const monthly = asRecord(record.monthly_quotas);
    for (const category of new Set([...Object.keys(remaining), ...Object.keys(monthly)])) {
      const entitlement = numberOrUndefined(monthly[category]);
      const left = numberOrUndefined(remaining[category]);
      quotas[category] = removeUndefinedQuota({
        entitlement,
        percentRemaining:
          entitlement !== undefined && entitlement > 0 && left !== undefined
            ? (left / entitlement) * 100
            : undefined,
        remaining: left,
        used: usedFrom(entitlement, left),
      });
    }
  }

  return removeUndefinedUsage({
    accessTypeSku: stringOrUndefined(record.access_type_sku),
    chatEnabled: typeof record.chat_enabled === "boolean" ? record.chat_enabled : undefined,
    plan: stringOrUndefined(record.copilot_plan),
    quotaResetDate:
      stringOrUndefined(record.quota_reset_date) ??
      stringOrUndefined(record.quota_reset_date_utc) ??
      stringOrUndefined(record.limited_user_reset_date),
    quotas,
  });
}

function normalizeQuotaDetail(detail: JsonObject): CopilotQuota {
  const entitlement = numberOrUndefined(detail.entitlement);
  const remaining =
    numberOrUndefined(detail.remaining) ?? numberOrUndefined(detail.quota_remaining);
  return removeUndefinedQuota({
    entitlement,
    overageCount: numberOrUndefined(detail.overage_count),
    overagePermitted:
      typeof detail.overage_permitted === "boolean" ? detail.overage_permitted : undefined,
    percentRemaining: numberOrUndefined(detail.percent_remaining),
    remaining,
    unlimited: typeof detail.unlimited === "boolean" ? detail.unlimited : undefined,
    used: usedFrom(entitlement, remaining),
  });
}

function usedFrom(
  entitlement: number | undefined,
  remaining: number | undefined,
): number | undefined {
  if (entitlement === undefined || remaining === undefined) {
    return undefined;
  }
  return Math.max(0, entitlement - remaining);
}

/** True for https URLs, or http only on loopback hosts (used by tests). */
function isHttpsOrLoopback(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
  );
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function removeUndefinedQuota(quota: CopilotQuota): CopilotQuota {
  return Object.fromEntries(
    Object.entries(quota).filter(([, value]) => value !== undefined),
  ) as CopilotQuota;
}

function removeUndefinedUsage(usage: CopilotUsage): CopilotUsage {
  const entries = Object.entries(usage).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as unknown as CopilotUsage;
}
