import { extractTokenUsage } from "./openai";
import { sseDataFromLine } from "./sse";
import type {
  CopilotQuota,
  CopilotUsage,
  GithubRateLimit,
  GithubRateLimitSnapshot,
  LatencySnapshot,
  MetricsSnapshot,
  MetricsSnapshotOptions,
  ModelTokenTotals,
  RequestObservation,
  RouteLatency,
  TokenUsage,
} from "./types";
import { asRecord, safeJsonParse } from "./util";

/** Content-Type for the Prometheus text exposition format (version 0.0.4). */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Upper bounds (seconds) for the request-duration histogram buckets. */
const DURATION_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const;

/** Cap on bytes buffered or scanned while extracting usage from a response body. */
const USAGE_BUFFER_LIMIT_BYTES = 16 * 1024 * 1024;
const PROMETHEUS_CACHE_TTL_MS = 1_000;
const PROMETHEUS_CACHE_NEUTRAL_ROUTES = new Set(["metrics"]);

/** Bound the distinct model labels so a hostile client cannot blow up cardinality. */
const MAX_TRACKED_MODELS = 200;
const MAX_MODEL_LABEL_LENGTH = 200;

/** GitHub exposes a small fixed set of rate-limit resources; bound it anyway. */
const MAX_TRACKED_RATELIMIT_RESOURCES = 32;

// Unit separator (ASCII 0x1f): joins label parts; cannot collide with a label value.
const LABEL_SEPARATOR = "\u001f";
const UNKNOWN_MODEL = "unknown";

interface RouteDuration {
  buckets: number[];
  count: number;
  sum: number;
}

function emptyModelTotals(): ModelTokenTotals {
  return { cached: 0, completion: 0, prompt: 0, reasoning: 0, requests: 0, total: 0 };
}

function isPrometheusCacheNeutralRoute(route: string | undefined): boolean {
  return route !== undefined && PROMETHEUS_CACHE_NEUTRAL_ROUTES.has(route);
}

/**
 * In-process metrics for the running proxy. Counters are monotonic for the life
 * of the process and reset on restart, which Prometheus handles natively. The
 * registry is intentionally allocation-light and synchronous; the single-
 * threaded event loop makes its mutations atomic with respect to each request.
 */
export class MetricsRegistry {
  readonly #startedAtMs: number;
  #inFlight = 0;
  #requests = new Map<string, number>();
  #durations = new Map<string, RouteDuration>();
  #inFlightByRoute = new Map<string, number>();
  #tokens = new Map<string, ModelTokenTotals>();
  #upstream = new Map<string, number>();
  #copilotQuota?: CopilotUsage;
  #githubRateLimit = new Map<string, GithubRateLimit>();
  #extraction = { extracted: 0, missing: 0 };
  #generation = 0;
  #prometheusCache?: { generation: number; renderedAtMs: number; text: string };

  constructor(options: { now?: () => number } = {}) {
    this.#startedAtMs = (options.now ?? Date.now)();
  }

  /** Mark a request as started; pair with exactly one {@link observe}. */
  startRequest(route?: string): void {
    if (!isPrometheusCacheNeutralRoute(route)) {
      this.#changed();
    }
    this.#inFlight += 1;
    if (route) {
      this.#inFlightByRoute.set(route, (this.#inFlightByRoute.get(route) ?? 0) + 1);
    }
  }

  /** Record a completed request and clear its in-flight slot. */
  observe(observation: RequestObservation): void {
    if (!isPrometheusCacheNeutralRoute(observation.route)) {
      this.#changed();
    }
    if (this.#inFlight > 0) {
      this.#inFlight -= 1;
    }
    const inFlightForRoute = this.#inFlightByRoute.get(observation.route) ?? 0;
    if (inFlightForRoute > 1) {
      this.#inFlightByRoute.set(observation.route, inFlightForRoute - 1);
    } else if (inFlightForRoute === 1) {
      this.#inFlightByRoute.delete(observation.route);
    }
    const key = labelKey(observation.route, observation.method, String(observation.status));
    this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1);
    this.#observeDuration(observation.route, observation.durationMs / 1000);
  }

  /**
   * Record whether one upstream completion reported token usage. `missing`
   * counts responses that carried no usage object — most often streamed Chat
   * Completions sent without `stream_options: {"include_usage": true}` — so a
   * rising miss rate flags clients whose token usage is going unaccounted.
   */
  recordTokenExtraction(extracted: boolean): void {
    this.#changed();
    if (extracted) {
      this.#extraction.extracted += 1;
    } else {
      this.#extraction.missing += 1;
    }
  }

  /** Accumulate token counts for a model from one upstream completion. */
  recordTokens(model: string, usage: TokenUsage): void {
    this.#changed();
    const name = this.#modelLabel(model);
    const totals = this.#tokens.get(name) ?? emptyModelTotals();
    totals.requests += 1;
    totals.prompt += nonNegative(usage.promptTokens);
    totals.completion += nonNegative(usage.completionTokens);
    totals.total += nonNegative(usage.totalTokens);
    totals.reasoning += nonNegative(usage.reasoningTokens ?? 0);
    totals.cached += nonNegative(usage.cachedTokens ?? 0);
    this.#tokens.set(name, totals);
  }

  /** Record one upstream Copilot call and whether it succeeded. */
  recordUpstream(path: string, ok: boolean): void {
    this.#changed();
    const key = labelKey(path, ok ? "ok" : "error");
    this.#upstream.set(key, (this.#upstream.get(key) ?? 0) + 1);
  }

  /** Store the latest Copilot quota so /metrics can expose it as gauges. */
  recordCopilotQuota(usage: CopilotUsage): void {
    this.#changed();
    this.#copilotQuota = usage;
  }

  /**
   * Store the latest GitHub REST rate-limit budget, keyed by its resource bucket.
   * A no-op when `rateLimit` is undefined (the response carried no rate-limit
   * headers) so callers can pass {@link parseRateLimitHeaders} output directly.
   */
  recordGithubRateLimit(rateLimit: GithubRateLimit | undefined): void {
    if (!rateLimit) {
      return;
    }
    this.#changed();
    const resource = this.#rateLimitResource(rateLimit.resource);
    this.#githubRateLimit.set(resource, { ...rateLimit, resource });
  }

  // Clean a raw value into a bounded exposition-format label: cap its length,
  // strip characters that would corrupt the format, and fold overflow past the
  // cardinality limit into UNKNOWN_MODEL so the series count stays bounded.
  #boundedLabel(
    value: string,
    tracked: { has(key: string): boolean; size: number },
    maxEntries: number,
  ): string {
    const cleaned = cleanLabel(value).slice(0, MAX_MODEL_LABEL_LENGTH) || UNKNOWN_MODEL;
    if (!tracked.has(cleaned) && tracked.size >= maxEntries) {
      return UNKNOWN_MODEL;
    }
    return cleaned;
  }

  // The model can originate from a (possibly hostile) client request.
  #modelLabel(model: string): string {
    return this.#boundedLabel(model, this.#tokens, MAX_TRACKED_MODELS);
  }

  // The resource comes from a trusted upstream header, but is bounded the same way.
  #rateLimitResource(resource: string): string {
    return this.#boundedLabel(resource, this.#githubRateLimit, MAX_TRACKED_RATELIMIT_RESOURCES);
  }

  #observeDuration(route: string, seconds: number): void {
    const value = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    const entry = this.#durations.get(route) ?? {
      buckets: new Array(DURATION_BUCKETS_SECONDS.length).fill(0),
      count: 0,
      sum: 0,
    };
    entry.count += 1;
    entry.sum += value;
    // Values larger than the last bucket bound only appear in the +Inf bucket,
    // which renderPrometheus derives from entry.count.
    const index = DURATION_BUCKETS_SECONDS.findIndex((bound) => value <= bound);
    if (index !== -1) {
      entry.buckets[index] = (entry.buckets[index] ?? 0) + 1;
    }
    this.#durations.set(route, entry);
  }

  #changed(): void {
    this.#generation += 1;
  }

  /** A JSON-friendly view of the current counters. */
  snapshot(nowOrOptions: (() => number) | MetricsSnapshotOptions = Date.now): MetricsSnapshot {
    const options = typeof nowOrOptions === "function" ? { now: nowOrOptions } : nowOrOptions;
    const now = options.now ?? Date.now;
    const excludeRoutes = new Set(options.excludeRoutes ?? []);
    const excludeUpstreamPaths = new Set(options.excludeUpstreamPaths ?? []);
    const byRoute: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let requestsTotal = 0;
    for (const [key, count] of this.#requests) {
      const [route = "", , status = ""] = key.split(LABEL_SEPARATOR);
      if (excludeRoutes.has(route)) {
        continue;
      }
      byRoute[route] = (byRoute[route] ?? 0) + count;
      byStatus[status] = (byStatus[status] ?? 0) + count;
      requestsTotal += count;
    }

    const byModel: Record<string, ModelTokenTotals> = {};
    const tokenTotals = { cached: 0, completion: 0, prompt: 0, reasoning: 0, total: 0 };
    for (const [model, totals] of this.#tokens) {
      byModel[model] = { ...totals };
      tokenTotals.prompt += totals.prompt;
      tokenTotals.completion += totals.completion;
      tokenTotals.total += totals.total;
      tokenTotals.reasoning += totals.reasoning;
      tokenTotals.cached += totals.cached;
    }

    let upstreamTotal = 0;
    let upstreamErrors = 0;
    for (const [key, count] of this.#upstream) {
      const [path = "", outcome = ""] = key.split(LABEL_SEPARATOR);
      if (excludeUpstreamPaths.has(path)) {
        continue;
      }
      upstreamTotal += count;
      if (outcome === "error") {
        upstreamErrors += count;
      }
    }

    const githubRateLimit: Record<string, GithubRateLimitSnapshot> = {};
    for (const [resource, rateLimit] of this.#githubRateLimit) {
      githubRateLimit[resource] = toRateLimitSnapshot(rateLimit);
    }

    return {
      githubRateLimit,
      inFlight: this.#filteredInFlight(excludeRoutes),
      latency: this.#latencySnapshot(excludeRoutes),
      requests: { byRoute, byStatus, total: requestsTotal },
      startedAt: new Date(this.#startedAtMs).toISOString(),
      tokens: { byModel, extraction: { ...this.#extraction }, ...tokenTotals },
      upstream: { errors: upstreamErrors, total: upstreamTotal },
      uptimeSeconds: Math.max(0, Math.round((now() - this.#startedAtMs) / 1000)),
    };
  }

  #filteredInFlight(excludeRoutes: ReadonlySet<string>): number {
    if (excludeRoutes.size === 0) {
      return this.#inFlight;
    }
    let excluded = 0;
    for (const [route, count] of this.#inFlightByRoute) {
      if (excludeRoutes.has(route)) {
        excluded += count;
      }
    }
    return Math.max(0, this.#inFlight - excluded);
  }

  // Summarize the duration histogram into a JSON latency view: per-route count and
  // exact average, plus overall average and estimated p50/p95. The percentiles come
  // from the buckets aggregated across routes, so they share /metrics' resolution.
  #latencySnapshot(excludeRoutes: ReadonlySet<string> = new Set()): LatencySnapshot {
    const byRoute: Record<string, RouteLatency> = {};
    const aggregateBuckets = new Array<number>(DURATION_BUCKETS_SECONDS.length).fill(0);
    let totalCount = 0;
    let totalSum = 0;
    for (const [route, entry] of this.#durations) {
      if (excludeRoutes.has(route)) {
        continue;
      }
      byRoute[route] = {
        avgMs: entry.count > 0 ? round2((entry.sum / entry.count) * 1000) : 0,
        count: entry.count,
      };
      totalCount += entry.count;
      totalSum += entry.sum;
      for (let i = 0; i < aggregateBuckets.length; i += 1) {
        aggregateBuckets[i] = (aggregateBuckets[i] ?? 0) + (entry.buckets[i] ?? 0);
      }
    }
    return {
      avgMs: totalCount > 0 ? round2((totalSum / totalCount) * 1000) : 0,
      byRoute,
      count: totalCount,
      p50Ms: round2(
        quantileFromBuckets(aggregateBuckets, DURATION_BUCKETS_SECONDS, totalCount, 0.5) * 1000,
      ),
      p95Ms: round2(
        quantileFromBuckets(aggregateBuckets, DURATION_BUCKETS_SECONDS, totalCount, 0.95) * 1000,
      ),
    };
  }

  /** Render the Prometheus text exposition format (version 0.0.4). */
  renderPrometheus(now: () => number = Date.now): string {
    const nowMs = now();
    const cached = this.#prometheusCache;
    if (
      cached &&
      cached.generation === this.#generation &&
      nowMs - cached.renderedAtMs < PROMETHEUS_CACHE_TTL_MS
    ) {
      return cached.text;
    }

    const lines: string[] = [];

    lines.push("# HELP hoopilot_process_start_time_seconds Unix epoch when the proxy started.");
    lines.push("# TYPE hoopilot_process_start_time_seconds gauge");
    lines.push(`hoopilot_process_start_time_seconds ${this.#startedAtMs / 1000}`);

    lines.push("# HELP hoopilot_uptime_seconds Seconds since the proxy started.");
    lines.push("# TYPE hoopilot_uptime_seconds gauge");
    lines.push(`hoopilot_uptime_seconds ${Math.max(0, (nowMs - this.#startedAtMs) / 1000)}`);

    lines.push("# HELP hoopilot_requests_in_flight Requests currently being served.");
    lines.push("# TYPE hoopilot_requests_in_flight gauge");
    lines.push(`hoopilot_requests_in_flight ${this.#inFlight}`);

    lines.push("# HELP hoopilot_requests_total Completed requests by route, method, and status.");
    lines.push("# TYPE hoopilot_requests_total counter");
    for (const [key, count] of this.#requests) {
      const [route = "", method = "", status = ""] = key.split(LABEL_SEPARATOR);
      lines.push(`hoopilot_requests_total${labels({ method, route, status })} ${count}`);
    }

    lines.push(
      "# HELP hoopilot_upstream_requests_total Copilot upstream calls by path and outcome.",
    );
    lines.push("# TYPE hoopilot_upstream_requests_total counter");
    for (const [key, count] of this.#upstream) {
      const [path = "", outcome = ""] = key.split(LABEL_SEPARATOR);
      lines.push(`hoopilot_upstream_requests_total${labels({ outcome, path })} ${count}`);
    }

    lines.push(
      "# HELP hoopilot_tokens_total Tokens reported by upstream usage, by model and type.",
    );
    lines.push("# TYPE hoopilot_tokens_total counter");
    for (const [model, totals] of this.#tokens) {
      lines.push(`hoopilot_tokens_total${labels({ model, type: "prompt" })} ${totals.prompt}`);
      lines.push(
        `hoopilot_tokens_total${labels({ model, type: "completion" })} ${totals.completion}`,
      );
      lines.push(
        `hoopilot_tokens_total${labels({ model, type: "reasoning" })} ${totals.reasoning}`,
      );
      lines.push(`hoopilot_tokens_total${labels({ model, type: "cached" })} ${totals.cached}`);
    }

    lines.push("# HELP hoopilot_model_requests_total Completions with usage observed, by model.");
    lines.push("# TYPE hoopilot_model_requests_total counter");
    for (const [model, totals] of this.#tokens) {
      lines.push(`hoopilot_model_requests_total${labels({ model })} ${totals.requests}`);
    }

    lines.push(
      "# HELP hoopilot_token_extraction_total Completions by whether upstream reported token usage.",
    );
    lines.push("# TYPE hoopilot_token_extraction_total counter");
    lines.push(
      `hoopilot_token_extraction_total${labels({ outcome: "extracted" })} ${this.#extraction.extracted}`,
    );
    lines.push(
      `hoopilot_token_extraction_total${labels({ outcome: "missing" })} ${this.#extraction.missing}`,
    );

    lines.push("# HELP hoopilot_request_duration_seconds Request duration by route.");
    lines.push("# TYPE hoopilot_request_duration_seconds histogram");
    for (const [route, entry] of this.#durations) {
      let cumulative = 0;
      for (let i = 0; i < DURATION_BUCKETS_SECONDS.length; i += 1) {
        cumulative += entry.buckets[i] ?? 0;
        const le = formatNumber(DURATION_BUCKETS_SECONDS[i] ?? 0);
        lines.push(
          `hoopilot_request_duration_seconds_bucket${labels({ le, route })} ${cumulative}`,
        );
      }
      lines.push(
        `hoopilot_request_duration_seconds_bucket${labels({ le: "+Inf", route })} ${entry.count}`,
      );
      lines.push(`hoopilot_request_duration_seconds_sum${labels({ route })} ${entry.sum}`);
      lines.push(`hoopilot_request_duration_seconds_count${labels({ route })} ${entry.count}`);
    }

    this.#renderGithubRateLimit(lines);
    this.#renderCopilotQuota(lines);

    const text = `${lines.join("\n")}\n`;
    this.#prometheusCache = { generation: this.#generation, renderedAtMs: nowMs, text };
    return text;
  }

  #renderGithubRateLimit(lines: string[]): void {
    const entries = [...this.#githubRateLimit.values()];
    if (entries.length === 0) {
      return;
    }

    const gauge = (
      suffix: string,
      help: string,
      pick: (rateLimit: GithubRateLimit) => number | undefined,
    ): void => {
      const present = entries.filter((rateLimit) => pick(rateLimit) !== undefined);
      if (present.length === 0) {
        return;
      }
      lines.push(`# HELP hoopilot_github_ratelimit_${suffix} ${help}`);
      lines.push(`# TYPE hoopilot_github_ratelimit_${suffix} gauge`);
      for (const rateLimit of present) {
        lines.push(
          `hoopilot_github_ratelimit_${suffix}${labels({ resource: rateLimit.resource })} ${pick(rateLimit)}`,
        );
      }
    };

    gauge("limit", "GitHub REST API request ceiling for the resource window.", (r) => r.limit);
    gauge("remaining", "Requests remaining in the GitHub REST API window.", (r) => r.remaining);
    gauge("used", "Requests used in the GitHub REST API window.", (r) => r.used);
    gauge(
      "reset_timestamp_seconds",
      "Unix epoch when the GitHub REST API window resets.",
      (r) => r.resetEpochSeconds,
    );
    gauge(
      "retry_after_seconds",
      "Seconds to wait after a GitHub secondary-limit response.",
      (r) => r.retryAfterSeconds,
    );
  }

  #renderCopilotQuota(lines: string[]): void {
    const usage = this.#copilotQuota;
    if (!usage) {
      return;
    }
    const categories = Object.entries(usage.quotas);

    const gauge = (
      suffix: string,
      help: string,
      pick: (quota: CopilotQuota) => number | undefined,
    ): void => {
      const present = categories.filter(([, quota]) => pick(quota) !== undefined);
      if (present.length === 0) {
        return;
      }
      lines.push(`# HELP hoopilot_copilot_quota_${suffix} ${help}`);
      lines.push(`# TYPE hoopilot_copilot_quota_${suffix} gauge`);
      for (const [category, quota] of present) {
        lines.push(`hoopilot_copilot_quota_${suffix}${labels({ category })} ${pick(quota)}`);
      }
    };

    gauge("remaining", "Remaining quota for the Copilot category.", (q) => q.remaining);
    gauge("entitlement", "Quota entitlement for the Copilot category.", (q) => q.entitlement);
    gauge("used", "Used quota (entitlement minus remaining) for the category.", (q) => q.used);
    gauge("overage_count", "Overage count for the Copilot category.", (q) => q.overageCount);
    gauge(
      "overage_entitlement",
      "Overage entitlement for the Copilot category.",
      (q) => q.overageEntitlement,
    );
    gauge(
      "percent_remaining",
      "Percent of quota remaining for the Copilot category.",
      (q) => q.percentRemaining,
    );
    booleanGauge(
      "unlimited",
      "Whether the Copilot quota category is unlimited.",
      (q) => q.unlimited,
    );
    booleanGauge(
      "overage_permitted",
      "Whether overage is permitted for the Copilot category.",
      (q) => q.overagePermitted,
    );
    booleanGauge("has_quota", "Whether the Copilot quota category has a quota.", (q) => q.hasQuota);
    booleanGauge(
      "token_based_billing",
      "Whether the Copilot quota category uses token-based billing.",
      (q) => q.tokenBasedBilling,
    );
    dateGauge(
      "category_reset_timestamp_seconds",
      "Unix epoch of the Copilot category-specific quota reset.",
      (q) => q.quotaResetAt,
    );
    dateGauge(
      "category_snapshot_timestamp_seconds",
      "Unix epoch of the Copilot category quota snapshot.",
      (q) => q.timestampUtc,
    );

    const resetMs = usage.quotaResetDate ? Date.parse(usage.quotaResetDate) : Number.NaN;
    if (Number.isFinite(resetMs)) {
      lines.push(
        "# HELP hoopilot_copilot_quota_reset_timestamp_seconds Unix epoch of the next reset.",
      );
      lines.push("# TYPE hoopilot_copilot_quota_reset_timestamp_seconds gauge");
      lines.push(`hoopilot_copilot_quota_reset_timestamp_seconds ${resetMs / 1000}`);
    }

    if (usage.plan || usage.accessTypeSku) {
      lines.push("# HELP hoopilot_copilot_info Copilot plan metadata as a constant-1 info gauge.");
      lines.push("# TYPE hoopilot_copilot_info gauge");
      lines.push(
        `hoopilot_copilot_info${labels({
          access_type_sku: usage.accessTypeSku ?? "",
          plan: usage.plan ?? "",
        })} 1`,
      );
    }

    function booleanGauge(
      suffix: string,
      help: string,
      pick: (quota: CopilotQuota) => boolean | undefined,
    ): void {
      const present = categories.filter(([, quota]) => pick(quota) !== undefined);
      if (present.length === 0) {
        return;
      }
      lines.push(`# HELP hoopilot_copilot_quota_${suffix} ${help}`);
      lines.push(`# TYPE hoopilot_copilot_quota_${suffix} gauge`);
      for (const [category, quota] of present) {
        lines.push(
          `hoopilot_copilot_quota_${suffix}${labels({ category })} ${pick(quota) ? 1 : 0}`,
        );
      }
    }

    function dateGauge(
      suffix: string,
      help: string,
      pick: (quota: CopilotQuota) => string | undefined,
    ): void {
      const present = categories
        .map(([category, quota]) => [category, Date.parse(pick(quota) ?? "")] as const)
        .filter(([, timestamp]) => Number.isFinite(timestamp));
      if (present.length === 0) {
        return;
      }
      lines.push(`# HELP hoopilot_copilot_quota_${suffix} ${help}`);
      lines.push(`# TYPE hoopilot_copilot_quota_${suffix} gauge`);
      for (const [category, timestamp] of present) {
        lines.push(`hoopilot_copilot_quota_${suffix}${labels({ category })} ${timestamp / 1000}`);
      }
    }
  }
}

/**
 * Wrap `response`'s body so the client receives unchanged bytes while the same
 * read pass extracts token usage. Returns a new Response carrying the observed
 * body and the original status/headers. Usage extraction never throws into the
 * client stream: a parse failure or an aborted client simply yields no usage.
 * When the body is absent the response is returned untouched.
 *
 * Pass the request's `signal` so a client disconnect cancels the observer
 * branch; combined with the runtime cancelling the client branch, that releases
 * the shared upstream connection instead of draining it in the background.
 */
export function observeResponseUsage(
  response: Response,
  fallbackModel: string,
  onUsage: (model: string, usage: TokenUsage) => void,
  signal?: AbortSignal,
  onOutcome?: (extracted: boolean) => void,
): Response {
  const body = response.body;
  if (!body) {
    return response;
  }
  const isSse = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
  return new Response(
    streamWithUsageObservation(body, isSse, fallbackModel, onUsage, signal, onOutcome),
    {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
}

/** Extract and record token usage from an already-buffered response body. */
export function recordResponseTextUsage(
  text: string,
  isSse: boolean,
  fallbackModel: string,
  onUsage: (model: string, usage: TokenUsage) => void,
  onOutcome?: (extracted: boolean) => void,
): void {
  const accumulator = createUsageAccumulator(fallbackModel, onUsage, onOutcome);
  if (isSse) {
    for (const line of text.split(/\r?\n/)) {
      considerSseLine(line, accumulator.consider);
    }
  } else {
    const parsed = safeJsonParse(text);
    if (parsed !== undefined) {
      accumulator.consider(parsed);
    }
  }
  accumulator.finish();
}

export function streamWithUsageObservation(
  stream: ReadableStream<Uint8Array>,
  isSse: boolean,
  fallbackModel: string,
  onUsage: (model: string, usage: TokenUsage) => void,
  signal?: AbortSignal,
  onOutcome?: (extracted: boolean) => void,
  onComplete?: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let aborted = signal?.aborted ?? false;
  let completed = false;
  let released = false;
  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => {});
  };
  if (aborted) {
    reader.cancel().catch(() => {});
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  const decoder = new TextDecoder();
  // A client disconnect cancels the reader mid-stream; don't count that as a
  // missing-usage completion — only record outcomes for streams we finished.
  const guardedOutcome = onOutcome
    ? (extracted: boolean) => {
        if (!aborted) {
          onOutcome(extracted);
        }
      }
    : undefined;
  const accumulator = createUsageAccumulator(fallbackModel, onUsage, guardedOutcome);
  let buffer = "";
  let bufferedBytes = 0;
  let overflowed = false;

  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    signal?.removeEventListener("abort", onAbort);
    if (!completed) {
      completed = true;
      onComplete?.();
    }
    reader.releaseLock();
  };

  const observeChunk = (chunkBytes: Uint8Array): void => {
    const chunk = decoder.decode(chunkBytes, { stream: true });
    if (isSse) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        considerSseLine(line, accumulator.consider);
      }
      // Drop a pathologically long newline-less line so the buffer stays bounded.
      if (buffer.length > USAGE_BUFFER_LIMIT_BYTES) {
        buffer = "";
      }
      return;
    }
    if (overflowed) {
      return;
    }
    bufferedBytes += chunkBytes.byteLength;
    if (bufferedBytes > USAGE_BUFFER_LIMIT_BYTES) {
      overflowed = true;
      buffer = "";
      return;
    }
    buffer += chunk;
  };

  const finishObservation = (): void => {
    const finalBuffer = buffer + decoder.decode();
    if (isSse) {
      if (finalBuffer) {
        considerSseLine(finalBuffer, accumulator.consider);
      }
    } else if (!overflowed && finalBuffer) {
      const parsed = safeJsonParse(finalBuffer);
      if (parsed !== undefined) {
        accumulator.consider(parsed);
      }
    }
    if (!aborted) {
      safeFinishAccumulator(accumulator);
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read().catch((error: unknown) => {
        release();
        controller.error(error);
        return undefined;
      });
      if (!result) {
        return;
      }
      if (result.done) {
        finishObservation();
        controller.close();
        release();
        return;
      }
      try {
        observeChunk(result.value);
      } catch {
        // Metrics extraction is best-effort and must not affect the client body.
      }
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      aborted = true;
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

function createUsageAccumulator(
  fallbackModel: string,
  onUsage: (model: string, usage: TokenUsage) => void,
  onOutcome?: (extracted: boolean) => void,
): { consider: (payload: unknown) => void; finish: () => void } {
  let model = fallbackModel;
  let usage: TokenUsage | undefined;
  return {
    consider(payload) {
      const record = asRecord(payload);
      const found =
        extractTokenUsage(record.usage) ?? extractTokenUsage(asRecord(record.response).usage);
      if (found) {
        usage = found;
      }
      const candidateModel = modelText(record.model) || modelText(asRecord(record.response).model);
      if (candidateModel) {
        model = candidateModel;
      }
    },
    finish() {
      if (usage) {
        onUsage(model, usage);
      }
      onOutcome?.(usage !== undefined);
    },
  };
}

function safeFinishAccumulator(accumulator: { finish: () => void }): void {
  try {
    accumulator.finish();
  } catch {
    // Best-effort metrics extraction must never disturb the proxied response.
  }
}

function considerSseLine(line: string, consider: (payload: unknown) => void): void {
  const data = sseDataFromLine(line);
  if (!data || data === "[DONE]") {
    return;
  }
  if (!data.includes('"usage"')) {
    return;
  }
  const parsed = safeJsonParse(data);
  if (parsed !== undefined) {
    consider(parsed);
  }
}

function modelText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Estimate a latency quantile from histogram bucket counts via Prometheus-style
// linear interpolation within the bucket the target rank lands in. `bucketCounts[i]`
// is the number of observations in `(bounds[i-1], bounds[i]]`; observations above the
// last finite bound live only in the implicit +Inf bucket, for which that bound is
// returned. Returns seconds.
function quantileFromBuckets(
  bucketCounts: number[],
  bounds: readonly number[],
  count: number,
  q: number,
): number {
  if (count <= 0) {
    return 0;
  }
  const rank = q * count;
  let cumulative = 0;
  for (let i = 0; i < bounds.length; i += 1) {
    const inBucket = bucketCounts[i] ?? 0;
    if (inBucket > 0 && cumulative + inBucket >= rank) {
      const lower = i === 0 ? 0 : (bounds[i - 1] ?? 0);
      const upper = bounds[i] ?? lower;
      return lower + (upper - lower) * ((rank - cumulative) / inBucket);
    }
    cumulative += inBucket;
  }
  return bounds[bounds.length - 1] ?? 0;
}

// Drop ASCII control characters (and DEL) that would corrupt the Prometheus
// exposition format, then trim. Used for labels sourced from an upstream header,
// mirroring the control-char stripping applied to client-supplied model labels.
function cleanLabel(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code > 0x1f && code !== 0x7f) {
      result += char;
    }
  }
  return result.trim();
}

// Convert the internal rate-limit record into its JSON snapshot shape: the epoch
// reset and observation times become ISO strings, and absent fields stay absent.
function toRateLimitSnapshot(rateLimit: GithubRateLimit): GithubRateLimitSnapshot {
  const snapshot: GithubRateLimitSnapshot = {
    observedAt: new Date(rateLimit.observedAtMs).toISOString(),
  };
  if (rateLimit.limit !== undefined) {
    snapshot.limit = rateLimit.limit;
  }
  if (rateLimit.remaining !== undefined) {
    snapshot.remaining = rateLimit.remaining;
  }
  if (rateLimit.used !== undefined) {
    snapshot.used = rateLimit.used;
  }
  if (rateLimit.resetEpochSeconds !== undefined) {
    snapshot.resetAt = new Date(rateLimit.resetEpochSeconds * 1000).toISOString();
  }
  if (rateLimit.retryAfterSeconds !== undefined) {
    snapshot.retryAfterSeconds = rateLimit.retryAfterSeconds;
  }
  return snapshot;
}

function labelKey(...parts: string[]): string {
  return parts.join(LABEL_SEPARATOR);
}

function labels(pairs: Record<string, string>): string {
  const entries = Object.entries(pairs);
  if (entries.length === 0) {
    return "";
  }
  const rendered = entries.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`);
  return `{${rendered.join(",")}}`;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : String(value);
}
