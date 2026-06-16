import { extractTokenUsage } from "./openai";
import type {
  CopilotUsage,
  MetricsSnapshot,
  ModelTokenTotals,
  RequestObservation,
  TokenUsage,
} from "./types";
import { asRecord } from "./util";

/** Content-Type for the Prometheus text exposition format (version 0.0.4). */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Upper bounds (seconds) for the request-duration histogram buckets. */
const DURATION_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const;

/** Cap on bytes buffered or scanned while extracting usage from a response body. */
const USAGE_BUFFER_LIMIT_BYTES = 16 * 1024 * 1024;

/** Bound the distinct model labels so a hostile client cannot blow up cardinality. */
const MAX_TRACKED_MODELS = 200;
const MAX_MODEL_LABEL_LENGTH = 200;

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
  #tokens = new Map<string, ModelTokenTotals>();
  #upstream = new Map<string, number>();
  #copilotQuota?: CopilotUsage;

  constructor(options: { now?: () => number } = {}) {
    this.#startedAtMs = (options.now ?? Date.now)();
  }

  /** Mark a request as started; pair with exactly one {@link observe}. */
  startRequest(): void {
    this.#inFlight += 1;
  }

  /** Record a completed request and clear its in-flight slot. */
  observe(observation: RequestObservation): void {
    if (this.#inFlight > 0) {
      this.#inFlight -= 1;
    }
    const key = labelKey(observation.route, observation.method, String(observation.status));
    this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1);
    this.#observeDuration(observation.route, observation.durationMs / 1000);
  }

  /** Accumulate token counts for a model from one upstream completion. */
  recordTokens(model: string, usage: TokenUsage): void {
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
    const key = labelKey(path, ok ? "ok" : "error");
    this.#upstream.set(key, (this.#upstream.get(key) ?? 0) + 1);
  }

  /** Store the latest Copilot quota so /metrics can expose it as gauges. */
  recordCopilotQuota(usage: CopilotUsage): void {
    this.#copilotQuota = usage;
  }

  // Sanitize the model into a bounded, control-char-free label. The model can
  // originate from a client request, so cap its length, strip characters that
  // would corrupt the exposition format, and fold overflow past the cardinality
  // limit into UNKNOWN_MODEL to keep the series count bounded.
  #modelLabel(model: string): string {
    const cleaned =
      model
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent.
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, MAX_MODEL_LABEL_LENGTH) || UNKNOWN_MODEL;
    if (!this.#tokens.has(cleaned) && this.#tokens.size >= MAX_TRACKED_MODELS) {
      return UNKNOWN_MODEL;
    }
    return cleaned;
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

  /** A JSON-friendly view of the current counters. */
  snapshot(now: () => number = Date.now): MetricsSnapshot {
    const byRoute: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let requestsTotal = 0;
    for (const [key, count] of this.#requests) {
      const [route = "", , status = ""] = key.split(LABEL_SEPARATOR);
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
      upstreamTotal += count;
      if (key.endsWith(`${LABEL_SEPARATOR}error`)) {
        upstreamErrors += count;
      }
    }

    return {
      inFlight: this.#inFlight,
      requests: { byRoute, byStatus, total: requestsTotal },
      startedAt: new Date(this.#startedAtMs).toISOString(),
      tokens: { byModel, ...tokenTotals },
      upstream: { errors: upstreamErrors, total: upstreamTotal },
      uptimeSeconds: Math.max(0, Math.round((now() - this.#startedAtMs) / 1000)),
    };
  }

  /** Render the Prometheus text exposition format (version 0.0.4). */
  renderPrometheus(now: () => number = Date.now): string {
    const lines: string[] = [];

    lines.push("# HELP hoopilot_process_start_time_seconds Unix epoch when the proxy started.");
    lines.push("# TYPE hoopilot_process_start_time_seconds gauge");
    lines.push(`hoopilot_process_start_time_seconds ${this.#startedAtMs / 1000}`);

    lines.push("# HELP hoopilot_uptime_seconds Seconds since the proxy started.");
    lines.push("# TYPE hoopilot_uptime_seconds gauge");
    lines.push(`hoopilot_uptime_seconds ${Math.max(0, (now() - this.#startedAtMs) / 1000)}`);

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

    this.#renderCopilotQuota(lines);

    return `${lines.join("\n")}\n`;
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
      pick: (quota: (typeof categories)[number][1]) => number | undefined,
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
    gauge(
      "percent_remaining",
      "Percent of quota remaining for the Copilot category.",
      (q) => q.percentRemaining,
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
  }
}

/**
 * Tee `response`'s body so the client receives an unchanged copy while a
 * background reader extracts token usage. Returns a new Response carrying the
 * client-facing branch and the original status/headers. Usage extraction never
 * throws into the client stream: a parse failure or an aborted client simply
 * yields no usage. When the body is absent the response is returned untouched.
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
): Response {
  const body = response.body;
  if (!body) {
    return response;
  }
  const [clientBranch, observerBranch] = body.tee();
  const isSse = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
  void consumeUsage(observerBranch, isSse, fallbackModel, onUsage, signal).catch(() => {});
  return new Response(clientBranch, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function consumeUsage(
  stream: ReadableStream<Uint8Array>,
  isSse: boolean,
  fallbackModel: string,
  onUsage: (model: string, usage: TokenUsage) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (signal?.aborted) {
    reader.cancel().catch(() => {});
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  const decoder = new TextDecoder();
  let model = fallbackModel;
  let usage: TokenUsage | undefined;
  let buffer = "";
  let bufferedBytes = 0;
  let overflowed = false;

  const consider = (payload: unknown): void => {
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
  };

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk = decoder.decode(result.value, { stream: true });
      if (isSse) {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          considerSseLine(line, consider);
        }
        // Drop a pathologically long newline-less line so the buffer stays bounded.
        if (buffer.length > USAGE_BUFFER_LIMIT_BYTES) {
          buffer = "";
        }
      } else if (!overflowed) {
        bufferedBytes += result.value.byteLength;
        if (bufferedBytes > USAGE_BUFFER_LIMIT_BYTES) {
          overflowed = true;
          buffer = "";
        } else {
          buffer += chunk;
        }
      }
    }
    // Flush any trailing bytes the streaming decoder is still holding.
    const finalBuffer = buffer + decoder.decode();
    if (isSse) {
      if (finalBuffer) {
        considerSseLine(finalBuffer, consider);
      }
    } else if (!overflowed && finalBuffer) {
      const parsed = safeParse(finalBuffer);
      if (parsed !== undefined) {
        consider(parsed);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  if (usage) {
    onUsage(model, usage);
  }
}

function considerSseLine(line: string, consider: (payload: unknown) => void): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return;
  }
  const data = trimmed.slice("data:".length).trim();
  if (!data || data === "[DONE]") {
    return;
  }
  const parsed = safeParse(data);
  if (parsed !== undefined) {
    consider(parsed);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function modelText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
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
