import { CopilotAuth } from "./auth";
import type {
  CopilotAuthOptions,
  CopilotQuota,
  CopilotUsage,
  FetchLike,
  GithubRateLimit,
  JsonObject,
} from "./types";
import {
  asRecord,
  envValue,
  firstNumber,
  isTrustedTokenBaseUrl,
  removeUndefined,
  trimTrailingSlash,
} from "./util";

/** Default GitHub REST host that serves the `copilot_internal/user` quota route. */
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
export const ALLOWED_COPILOT_API_HOSTS = ["api.githubcopilot.com"] as const;
const ALLOWED_GITHUB_API_HOSTS = ["api.github.com"] as const;

/**
 * API version sent to the GitHub `copilot_internal` endpoints. This is a
 * different surface from the Copilot completions API (`x-github-api-version`
 * `2026-06-01`), so it is pinned separately and bumped independently.
 */
export const COPILOT_USAGE_API_VERSION = "2025-04-01";

// Editor-identity strings spoofed to GitHub Copilot. Deliberately pinned (not
// derived from the package version) and shared by both header builders below.
const EDITOR_PLUGIN_VERSION = "hoopilot/0.1.0";
const EDITOR_VERSION = "Hoopilot/0.1.0";
const HOOPILOT_USER_AGENT = "hoopilot/0.1.0";

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
  headers.set("editor-plugin-version", EDITOR_PLUGIN_VERSION);
  headers.set("editor-version", EDITOR_VERSION);
  headers.set("openai-intent", "conversation-panel");
  headers.set("user-agent", HOOPILOT_USER_AGENT);
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
  headers.set("editor-plugin-version", EDITOR_PLUGIN_VERSION);
  headers.set("editor-version", EDITOR_VERSION);
  headers.set("user-agent", HOOPILOT_USER_AGENT);
  headers.set("x-github-api-version", COPILOT_USAGE_API_VERSION);
  return headers;
}

/**
 * Parse the GitHub REST `x-ratelimit-*` headers (plus `retry-after`) off a
 * response into a {@link GithubRateLimit}. `api.github.com` returns these on
 * every reply, so the proxy reads its GitHub API budget from the quota call it
 * already makes — no extra request is spent. Returns undefined when the response
 * carries no rate-limit headers (for example the Copilot completion host, which
 * does not emit them today) so callers record nothing rather than a phantom row.
 */
export function parseRateLimitHeaders(
  headers: Headers,
  nowMs: number = Date.now(),
): GithubRateLimit | undefined {
  const limit = headerInt(headers, "x-ratelimit-limit");
  const remaining = headerInt(headers, "x-ratelimit-remaining");
  const used = headerInt(headers, "x-ratelimit-used");
  const resetEpochSeconds = headerInt(headers, "x-ratelimit-reset");
  const retryAfterSeconds = headerInt(headers, "retry-after");
  if (
    limit === undefined &&
    remaining === undefined &&
    used === undefined &&
    resetEpochSeconds === undefined &&
    retryAfterSeconds === undefined
  ) {
    return undefined;
  }
  return removeUndefined({
    limit,
    observedAtMs: nowMs,
    remaining,
    resetEpochSeconds,
    resource: headers.get("x-ratelimit-resource")?.trim() || "unknown",
    retryAfterSeconds,
    used,
  });
}

// Parse a non-negative integer header (the rate-limit headers are all integers;
// retry-after is integer seconds on GitHub's secondary limits). A missing or
// malformed header yields undefined so it is simply omitted from the result.
function headerInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) {
    return undefined;
  }
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class CopilotClient {
  readonly #auth: CopilotAuth;
  readonly #allowUnsafeUpstream: boolean;
  readonly #fetch: FetchLike;
  readonly #githubApiBaseUrl: string;

  constructor(options: CopilotAuthOptions = {}) {
    this.#auth = new CopilotAuth(options);
    this.#allowUnsafeUpstream = envValue(options.env?.HOOPILOT_ALLOW_UNSAFE_UPSTREAM) === "1";
    this.#fetch = options.fetch ?? fetch;
    this.#githubApiBaseUrl = trimTrailingSlash(
      options.githubApiBaseUrl ??
        envValue(options.env?.HOOPILOT_GITHUB_API_BASE_URL) ??
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
    if (
      !isTrustedTokenBaseUrl(
        this.#githubApiBaseUrl,
        ALLOWED_GITHUB_API_HOSTS,
        this.#allowUnsafeUpstream,
      )
    ) {
      throw new Error(
        `Refusing to send the GitHub OAuth token to an untrusted GitHub API host: ${this.#githubApiBaseUrl}`,
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
    if (
      !isTrustedTokenBaseUrl(
        access.apiBaseUrl,
        ALLOWED_COPILOT_API_HOSTS,
        this.#allowUnsafeUpstream,
      )
    ) {
      throw new Error(
        `Refusing to send the GitHub OAuth token to an untrusted Copilot API host: ${access.apiBaseUrl}`,
      );
    }
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
      quotas[category] = removeUndefined({
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

  return removeUndefined({
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
  const overageCount = numberOrUndefined(detail.overage_count);
  const remaining =
    numberOrUndefined(detail.remaining) ?? numberOrUndefined(detail.quota_remaining);
  return removeUndefined({
    entitlement,
    hasQuota: typeof detail.has_quota === "boolean" ? detail.has_quota : undefined,
    overageCount,
    overageEntitlement: numberOrUndefined(detail.overage_entitlement),
    overagePermitted:
      typeof detail.overage_permitted === "boolean" ? detail.overage_permitted : undefined,
    percentRemaining: numberOrUndefined(detail.percent_remaining),
    quotaId: stringOrUndefined(detail.quota_id),
    quotaResetAt: stringOrUndefined(detail.quota_reset_at),
    remaining,
    timestampUtc: stringOrUndefined(detail.timestamp_utc),
    tokenBasedBilling:
      typeof detail.token_based_billing === "boolean" ? detail.token_based_billing : undefined,
    unlimited: typeof detail.unlimited === "boolean" ? detail.unlimited : undefined,
    used: usedFrom(entitlement, remaining, overageCount),
  });
}

function usedFrom(
  entitlement: number | undefined,
  remaining: number | undefined,
  overageCount?: number,
): number | undefined {
  if (entitlement === undefined || remaining === undefined) {
    return undefined;
  }
  const base = entitlement - remaining;
  const overage = remaining === 0 ? (overageCount ?? 0) : 0;
  return Math.max(0, base + overage);
}

// Single-argument case of the shared firstNumber helper.
const numberOrUndefined = firstNumber;

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
