import { describe, expect, it } from "bun:test";
import { normalizeCopilotUsage, parseRateLimitHeaders } from "../src/copilot";
import { MetricsRegistry, observeResponseUsage, recordResponseTextUsage } from "../src/metrics";
import { extractTokenUsage } from "../src/openai";
import type { TokenUsage } from "../src/types";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRecorder(): {
  promise: Promise<void>;
  recorder: (model: string, usage: TokenUsage) => void;
  sink: Array<{ model: string; usage: TokenUsage }>;
} {
  const sink: Array<{ model: string; usage: TokenUsage }> = [];
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    promise,
    recorder: (model, usage) => {
      sink.push({ model, usage });
      resolve();
    },
    sink,
  };
}

function sseResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("extractTokenUsage", () => {
  it("maps the chat completions usage shape", () => {
    expect(
      extractTokenUsage({
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 2 },
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 4 },
        total_tokens: 15,
      }),
    ).toEqual({
      cachedTokens: 4,
      completionTokens: 5,
      promptTokens: 10,
      reasoningTokens: 2,
      totalTokens: 15,
    });
  });

  it("maps the Responses API usage shape", () => {
    expect(
      extractTokenUsage({
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 1 },
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 28,
      }),
    ).toEqual({
      cachedTokens: 1,
      completionTokens: 8,
      promptTokens: 20,
      reasoningTokens: 3,
      totalTokens: 28,
    });
  });

  it("derives total tokens when absent and returns undefined for empty usage", () => {
    expect(extractTokenUsage({ completion_tokens: 4, prompt_tokens: 6 })).toMatchObject({
      totalTokens: 10,
    });
    expect(extractTokenUsage(undefined)).toBeUndefined();
    expect(extractTokenUsage({})).toBeUndefined();
  });
});

describe("MetricsRegistry", () => {
  it("counts requests, tokens, upstream calls, and in-flight gauge", () => {
    const metrics = new MetricsRegistry({ now: () => 1_000 });
    metrics.startRequest();
    metrics.observe({ durationMs: 120, method: "POST", route: "chat_completions", status: 200 });
    metrics.recordTokens("gpt-4.1", {
      cachedTokens: 3,
      completionTokens: 5,
      promptTokens: 10,
      reasoningTokens: 2,
      totalTokens: 15,
    });
    metrics.recordTokens("gpt-4.1", { completionTokens: 1, promptTokens: 1, totalTokens: 2 });
    metrics.recordUpstream("/chat/completions", true);
    metrics.recordUpstream("/chat/completions", false);

    const snapshot = metrics.snapshot(() => 5_000);
    expect(snapshot.inFlight).toBe(0);
    expect(snapshot.requests.total).toBe(1);
    expect(snapshot.requests.byRoute.chat_completions).toBe(1);
    expect(snapshot.requests.byStatus["200"]).toBe(1);
    expect(snapshot.tokens.prompt).toBe(11);
    expect(snapshot.tokens.total).toBe(17);
    expect(snapshot.tokens.byModel["gpt-4.1"]).toMatchObject({ requests: 2, total: 17 });
    expect(snapshot.upstream).toEqual({ errors: 1, total: 2 });
    expect(snapshot.uptimeSeconds).toBe(4);
    expect(snapshot.startedAt).toBe(new Date(1_000).toISOString());
  });

  it("renders a valid Prometheus exposition", () => {
    const metrics = new MetricsRegistry({ now: () => 1_000 });
    metrics.observe({ durationMs: 120, method: "POST", route: "chat_completions", status: 200 });
    metrics.recordTokens("gpt-4.1", { completionTokens: 5, promptTokens: 10, totalTokens: 15 });
    metrics.recordUpstream("/chat/completions", true);

    const text = metrics.renderPrometheus(() => 5_000);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("# TYPE hoopilot_requests_total counter");
    expect(text).toContain(
      'hoopilot_requests_total{method="POST",route="chat_completions",status="200"} 1',
    );
    expect(text).toContain('hoopilot_tokens_total{model="gpt-4.1",type="prompt"} 10');
    expect(text).toContain(
      'hoopilot_upstream_requests_total{outcome="ok",path="/chat/completions"} 1',
    );
    expect(text).toContain("# TYPE hoopilot_request_duration_seconds histogram");
    // The +Inf bucket must equal the _count series.
    expect(text).toContain(
      'hoopilot_request_duration_seconds_bucket{le="+Inf",route="chat_completions"} 1',
    );
    expect(text).toContain(
      'hoopilot_request_duration_seconds_bucket{le="0.25",route="chat_completions"} 1',
    );
    expect(text).toContain('hoopilot_request_duration_seconds_count{route="chat_completions"} 1');
    expect(text).toContain("hoopilot_uptime_seconds 4");
  });

  it("escapes special characters in label values", () => {
    const metrics = new MetricsRegistry();
    metrics.recordTokens('gpt"x', { completionTokens: 1, promptTokens: 1, totalTokens: 2 });
    expect(metrics.renderPrometheus()).toContain(
      'hoopilot_tokens_total{model="gpt\\"x",type="prompt"} 1',
    );
  });

  it("strips control characters from and escapes backslashes in model labels", () => {
    const metrics = new MetricsRegistry();
    metrics.recordTokens("a\\b\nc", { completionTokens: 1, promptTokens: 1, totalTokens: 2 });
    expect(metrics.renderPrometheus()).toContain(
      'hoopilot_tokens_total{model="a\\\\bc",type="prompt"} 1',
    );
  });

  it("escapes newlines in Copilot info label values", () => {
    const metrics = new MetricsRegistry();
    metrics.recordCopilotQuota(
      normalizeCopilotUsage({
        copilot_plan: "x\ny",
        quota_snapshots: { chat: { unlimited: true } },
      }),
    );
    expect(metrics.renderPrometheus()).toContain('plan="x\\ny"');
  });

  it("bounds model-label cardinality by folding overflow into 'unknown'", () => {
    const metrics = new MetricsRegistry();
    for (let i = 0; i < 205; i += 1) {
      metrics.recordTokens(`model-${i}`, { completionTokens: 1, promptTokens: 1, totalTokens: 2 });
    }
    const models = Object.keys(metrics.snapshot().tokens.byModel);
    expect(models).toContain("unknown");
    expect(models.length).toBe(201);
  });

  it("exposes the last recorded Copilot quota as gauges", () => {
    const metrics = new MetricsRegistry();
    metrics.recordCopilotQuota(
      normalizeCopilotUsage({
        access_type_sku: "copilot_pro",
        copilot_plan: "individual_pro",
        quota_reset_date: "2026-07-01",
        quota_snapshots: {
          premium_interactions: {
            entitlement: 300,
            has_quota: true,
            overage_count: 2,
            overage_entitlement: 10,
            overage_permitted: true,
            percent_remaining: 88.5,
            quota_id: "quota-premium",
            quota_reset_at: "2026-07-01T00:00:00Z",
            remaining: 265.5,
            timestamp_utc: "2026-06-17T12:00:00Z",
            token_based_billing: false,
            unlimited: false,
          },
        },
      }),
    );

    const text = metrics.renderPrometheus();
    expect(text).toContain(
      'hoopilot_copilot_quota_remaining{category="premium_interactions"} 265.5',
    );
    expect(text).toContain(
      'hoopilot_copilot_quota_entitlement{category="premium_interactions"} 300',
    );
    expect(text).toContain('hoopilot_copilot_quota_used{category="premium_interactions"} 34.5');
    expect(text).toContain(
      'hoopilot_copilot_quota_percent_remaining{category="premium_interactions"} 88.5',
    );
    expect(text).toContain(
      'hoopilot_copilot_quota_overage_count{category="premium_interactions"} 2',
    );
    expect(text).toContain(
      'hoopilot_copilot_quota_overage_entitlement{category="premium_interactions"} 10',
    );
    expect(text).toContain(
      'hoopilot_copilot_quota_overage_permitted{category="premium_interactions"} 1',
    );
    expect(text).toContain('hoopilot_copilot_quota_has_quota{category="premium_interactions"} 1');
    expect(text).toContain(
      'hoopilot_copilot_quota_token_based_billing{category="premium_interactions"} 0',
    );
    expect(text).toContain('hoopilot_copilot_quota_unlimited{category="premium_interactions"} 0');
    expect(text).toContain(
      'hoopilot_copilot_quota_category_reset_timestamp_seconds{category="premium_interactions"} 1782864000',
    );
    expect(text).toContain(
      'hoopilot_copilot_quota_category_snapshot_timestamp_seconds{category="premium_interactions"} 1781697600',
    );
    expect(text).toContain("hoopilot_copilot_quota_reset_timestamp_seconds ");
    expect(text).toContain(
      'hoopilot_copilot_info{access_type_sku="copilot_pro",plan="individual_pro"} 1',
    );
  });

  it("records and renders GitHub rate-limit gauges per resource", () => {
    const metrics = new MetricsRegistry();
    metrics.recordGithubRateLimit({
      limit: 5000,
      observedAtMs: 1_000,
      remaining: 4998,
      resetEpochSeconds: 1782864000,
      resource: "core",
      retryAfterSeconds: 30,
      used: 2,
    });

    const text = metrics.renderPrometheus();
    expect(text).toContain("# TYPE hoopilot_github_ratelimit_limit gauge");
    expect(text).toContain('hoopilot_github_ratelimit_limit{resource="core"} 5000');
    expect(text).toContain('hoopilot_github_ratelimit_remaining{resource="core"} 4998');
    expect(text).toContain('hoopilot_github_ratelimit_used{resource="core"} 2');
    expect(text).toContain(
      'hoopilot_github_ratelimit_reset_timestamp_seconds{resource="core"} 1782864000',
    );
    expect(text).toContain('hoopilot_github_ratelimit_retry_after_seconds{resource="core"} 30');

    expect(metrics.snapshot().githubRateLimit.core).toEqual({
      limit: 5000,
      observedAt: new Date(1_000).toISOString(),
      remaining: 4998,
      resetAt: new Date(1782864000 * 1000).toISOString(),
      retryAfterSeconds: 30,
      used: 2,
    });
  });

  it("ignores undefined rate-limit and omits absent gauges", () => {
    const metrics = new MetricsRegistry();
    metrics.recordGithubRateLimit(undefined);
    metrics.recordGithubRateLimit({ observedAtMs: 5, remaining: 10, resource: "core" });

    const text = metrics.renderPrometheus();
    expect(text).toContain('hoopilot_github_ratelimit_remaining{resource="core"} 10');
    expect(text).not.toContain("hoopilot_github_ratelimit_limit");
    expect(text).not.toContain("hoopilot_github_ratelimit_retry_after_seconds");
    expect(Object.keys(metrics.snapshot().githubRateLimit)).toEqual(["core"]);
  });

  it("counts token-extraction outcomes", () => {
    const metrics = new MetricsRegistry();
    metrics.recordTokenExtraction(true);
    metrics.recordTokenExtraction(true);
    metrics.recordTokenExtraction(false);

    const text = metrics.renderPrometheus();
    expect(text).toContain("# TYPE hoopilot_token_extraction_total counter");
    expect(text).toContain('hoopilot_token_extraction_total{outcome="extracted"} 2');
    expect(text).toContain('hoopilot_token_extraction_total{outcome="missing"} 1');
    expect(metrics.snapshot().tokens.extraction).toEqual({ extracted: 2, missing: 1 });
  });
});

describe("observeResponseUsage", () => {
  it("captures usage from a non-streaming chat body without altering it", async () => {
    const { promise, recorder, sink } = makeRecorder();
    const upstream = Response.json({
      choices: [{ message: { content: "hi" } }],
      model: "gpt-4.1",
      usage: { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 },
    });

    const observed = observeResponseUsage(upstream, "fallback", recorder);
    const body = await observed.json();
    await promise;

    expect(body).toMatchObject({ choices: [{ message: { content: "hi" } }] });
    expect(sink[0]).toEqual({
      model: "gpt-4.1",
      usage: { completionTokens: 3, promptTokens: 7, totalTokens: 10 },
    });
  });

  it("captures usage from a streaming chat final chunk and forwards the stream", async () => {
    const { promise, recorder, sink } = makeRecorder();
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"model":"gpt-4.1","usage":{"completion_tokens":2,"prompt_tokens":5,"total_tokens":7}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const observed = observeResponseUsage(sseResponse(sse), "fallback", recorder);
    const text = await observed.text();
    await promise;

    expect(text).toContain('"content":"hi"');
    expect(text).toContain("[DONE]");
    expect(sink[0]).toEqual({
      model: "gpt-4.1",
      usage: { completionTokens: 2, promptTokens: 5, totalTokens: 7 },
    });
  });

  it("captures usage from a Responses API response.completed event", async () => {
    const { promise, recorder, sink } = makeRecorder();
    const sse = [
      'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.5","usage":{"input_tokens":20,"output_tokens":8,"output_tokens_details":{"reasoning_tokens":4},"total_tokens":28}}}\n\n',
    ].join("");

    const observed = observeResponseUsage(sseResponse(sse), "fallback", recorder);
    await observed.text();
    await promise;

    expect(sink[0]?.model).toBe("gpt-5.5");
    expect(sink[0]?.usage).toMatchObject({
      completionTokens: 8,
      promptTokens: 20,
      reasoningTokens: 4,
      totalTokens: 28,
    });
  });

  it("captures usage from buffered SSE text", () => {
    const { recorder, sink } = makeRecorder();
    recordResponseTextUsage(
      [
        'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.5","usage":{"input_tokens":20,"output_tokens":8,"total_tokens":28}}}\n\n',
      ].join(""),
      true,
      "fallback",
      recorder,
    );

    expect(sink[0]).toEqual({
      model: "gpt-5.5",
      usage: { completionTokens: 8, promptTokens: 20, totalTokens: 28 },
    });
  });

  it("records nothing when a streamed chat response omits usage", async () => {
    const { recorder, sink } = makeRecorder();
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';

    const observed = observeResponseUsage(sseResponse(sse), "gpt-4.1", recorder);
    await observed.text();
    await delay(10);

    expect(sink).toHaveLength(0);
  });

  it("returns bodyless responses untouched", () => {
    const { recorder } = makeRecorder();
    const response = new Response(null, { status: 204 });
    expect(observeResponseUsage(response, "gpt-4.1", recorder)).toBe(response);
  });

  it("keeps the client body byte-identical when the recorder throws", async () => {
    const recorder = () => {
      throw new Error("boom");
    };
    const upstream = Response.json({
      model: "gpt-4.1",
      usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    });

    const observed = observeResponseUsage(upstream, "gpt-4.1", recorder);
    const body = await observed.json();
    await delay(10);

    expect(body).toMatchObject({ model: "gpt-4.1" });
  });

  it("stops the observer and records nothing when the request signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { recorder, sink } = makeRecorder();
    const sse =
      'data: {"choices":[],"usage":{"completion_tokens":2,"prompt_tokens":5,"total_tokens":7}}\n\n';

    const observed = observeResponseUsage(sseResponse(sse), "gpt-4.1", recorder, controller.signal);
    await observed.text().catch(() => {});
    await delay(10);

    expect(sink).toHaveLength(0);
  });

  it("reports an extracted outcome when usage is present", async () => {
    const { promise, recorder } = makeRecorder();
    const outcomes: boolean[] = [];
    const upstream = Response.json({
      model: "gpt-4.1",
      usage: { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 },
    });

    const observed = observeResponseUsage(upstream, "fallback", recorder, undefined, (extracted) =>
      outcomes.push(extracted),
    );
    await observed.json();
    await promise;

    expect(outcomes).toEqual([true]);
  });

  it("reports a missing outcome when a streamed response omits usage", async () => {
    const outcomes: boolean[] = [];
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';

    const observed = observeResponseUsage(
      sseResponse(sse),
      "gpt-4.1",
      () => {},
      undefined,
      (extracted) => outcomes.push(extracted),
    );
    await observed.text();
    await delay(10);

    expect(outcomes).toEqual([false]);
  });

  it("does not report an outcome when the request is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcomes: boolean[] = [];
    const sse =
      'data: {"choices":[],"usage":{"completion_tokens":2,"prompt_tokens":5,"total_tokens":7}}\n\n';

    const observed = observeResponseUsage(
      sseResponse(sse),
      "gpt-4.1",
      () => {},
      controller.signal,
      (extracted) => outcomes.push(extracted),
    );
    await observed.text().catch(() => {});
    await delay(10);

    expect(outcomes).toEqual([]);
  });

  it("reports the extraction outcome from buffered text", () => {
    const outcomes: boolean[] = [];
    recordResponseTextUsage(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
      true,
      "gpt-4.1",
      () => {},
      (extracted) => outcomes.push(extracted),
    );
    recordResponseTextUsage(
      '{"model":"gpt-4.1","usage":{"completion_tokens":1,"prompt_tokens":1,"total_tokens":2}}',
      false,
      "gpt-4.1",
      () => {},
      (extracted) => outcomes.push(extracted),
    );

    expect(outcomes).toEqual([false, true]);
  });
});

describe("normalizeCopilotUsage", () => {
  it("normalizes paid quota_snapshots and derives used", () => {
    const usage = normalizeCopilotUsage({
      access_type_sku: "copilot_pro",
      copilot_plan: "individual_pro",
      quota_reset_date: "2026-07-01",
      quota_snapshots: {
        chat: { unlimited: true },
        premium_interactions: {
          entitlement: 300,
          has_quota: true,
          overage_count: 0,
          overage_entitlement: 10,
          percent_remaining: 88.5,
          quota_id: "quota-premium",
          quota_remaining: 265.5,
          quota_reset_at: "2026-07-01T00:00:00Z",
          remaining: 265.5,
          timestamp_utc: "2026-06-17T12:00:00Z",
          token_based_billing: false,
          unlimited: false,
        },
      },
    });

    expect(usage.plan).toBe("individual_pro");
    expect(usage.quotaResetDate).toBe("2026-07-01");
    expect(usage.quotas.premium_interactions).toMatchObject({
      entitlement: 300,
      hasQuota: true,
      overageEntitlement: 10,
      quotaId: "quota-premium",
      quotaResetAt: "2026-07-01T00:00:00Z",
      remaining: 265.5,
      timestampUtc: "2026-06-17T12:00:00Z",
      tokenBasedBilling: false,
      used: 34.5,
    });
    expect(usage.quotas.chat).toEqual({ unlimited: true });
  });

  it("normalizes the live paid quota_snapshots shape from copilot_internal/user", () => {
    const usage = normalizeCopilotUsage({
      access_type_sku: "copilot_for_business_seat_quota",
      chat_enabled: true,
      copilot_plan: "business",
      quota_reset_date: "2026-07-01",
      quota_snapshots: {
        chat: {
          entitlement: 0,
          has_quota: true,
          overage_count: 0,
          overage_entitlement: 0,
          overage_permitted: false,
          percent_remaining: 100,
          quota_id: "quota-chat",
          quota_remaining: 0,
          quota_reset_at: "2026-07-01T00:00:00Z",
          remaining: 0,
          timestamp_utc: "2026-06-17T12:00:00Z",
          token_based_billing: true,
          unlimited: true,
        },
        premium_interactions: {
          entitlement: 20000,
          has_quota: true,
          overage_count: 0,
          overage_entitlement: 1000,
          overage_permitted: true,
          percent_remaining: 75.8,
          quota_id: "quota-premium",
          quota_remaining: 15165,
          quota_reset_at: "2026-07-01T00:00:00Z",
          remaining: 15165,
          timestamp_utc: "2026-06-17T12:00:00Z",
          token_based_billing: true,
          unlimited: false,
        },
      },
    });

    expect(usage.accessTypeSku).toBe("copilot_for_business_seat_quota");
    expect(usage.chatEnabled).toBe(true);
    expect(usage.plan).toBe("business");
    expect(usage.quotas.premium_interactions).toMatchObject({
      entitlement: 20000,
      hasQuota: true,
      overageEntitlement: 1000,
      overagePermitted: true,
      percentRemaining: 75.8,
      quotaId: "quota-premium",
      quotaResetAt: "2026-07-01T00:00:00Z",
      remaining: 15165,
      timestampUtc: "2026-06-17T12:00:00Z",
      tokenBasedBilling: true,
      unlimited: false,
      used: 4835,
    });
  });

  it("uses overage_count when quota remaining is exhausted", () => {
    const usage = normalizeCopilotUsage({
      quota_snapshots: {
        premium_interactions: {
          entitlement: 300,
          overage_count: 7,
          remaining: 0,
        },
      },
    });

    expect(usage.quotas.premium_interactions).toMatchObject({ used: 307 });
  });

  it("normalizes the free-plan limited_user_quotas shape", () => {
    const usage = normalizeCopilotUsage({
      copilot_plan: "free",
      limited_user_quotas: { chat: 40, completions: 1000 },
      limited_user_reset_date: "2026-07-15",
      monthly_quotas: { chat: 50, completions: 2000 },
    });

    expect(usage.plan).toBe("free");
    expect(usage.quotaResetDate).toBe("2026-07-15");
    expect(usage.quotas.chat).toMatchObject({ entitlement: 50, remaining: 40, used: 10 });
  });

  it("returns empty quotas for an unrecognized body", () => {
    expect(normalizeCopilotUsage({}).quotas).toEqual({});
    expect(normalizeCopilotUsage("nope").quotas).toEqual({});
  });
});

describe("parseRateLimitHeaders", () => {
  it("parses the GitHub x-ratelimit headers", () => {
    const headers = new Headers({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4998",
      "x-ratelimit-reset": "1782864000",
      "x-ratelimit-resource": "core",
      "x-ratelimit-used": "2",
    });

    expect(parseRateLimitHeaders(headers, 1_000)).toEqual({
      limit: 5000,
      observedAtMs: 1_000,
      remaining: 4998,
      resetEpochSeconds: 1782864000,
      resource: "core",
      used: 2,
    });
  });

  it("captures retry-after and defaults the resource", () => {
    const headers = new Headers({ "retry-after": "60", "x-ratelimit-remaining": "0" });

    expect(parseRateLimitHeaders(headers, 5)).toEqual({
      observedAtMs: 5,
      remaining: 0,
      resource: "unknown",
      retryAfterSeconds: 60,
    });
  });

  it("returns undefined when no rate-limit headers are present", () => {
    expect(
      parseRateLimitHeaders(new Headers({ "content-type": "application/json" }), 0),
    ).toBeUndefined();
  });

  it("ignores malformed and negative values", () => {
    const headers = new Headers({
      "x-ratelimit-limit": "not-a-number",
      "x-ratelimit-remaining": "-5",
      "x-ratelimit-used": "7",
    });

    expect(parseRateLimitHeaders(headers, 0)).toEqual({
      observedAtMs: 0,
      resource: "unknown",
      used: 7,
    });
  });
});
