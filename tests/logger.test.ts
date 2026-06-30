import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import {
  createHoopilotLogger,
  noopLogger,
  parseLogFormat,
  parseLogLevel,
  shouldCreateLogger,
} from "../src/logger";

describe("createHoopilotLogger", () => {
  it("emits structured JSON logs with redacted credentials", async () => {
    const stream = new CapturingStream();
    const logger = createHoopilotLogger({
      base: { component: "test" },
      env: {},
      format: "json",
      level: "debug",
      stream,
    });

    logger.info(
      {
        headers: {
          authorization: "Bearer upstream-token",
          cookie: "session=secret",
          "x-api-key": "local-key",
        },
        token: "oauth-token",
      },
      "credential check",
    );

    await Bun.sleep(0);
    const log = JSON.parse(stream.output()) as Record<string, unknown>;
    expect(log.level).toBe(30);
    expect(log.time).toEqual(expect.any(String));
    expect(log.service).toBe("hoopilot");
    expect(log.component).toBe("test");
    expect(log.msg).toBe("credential check");
    expect(log.token).toBe("[Redacted]");
    expect(log.headers).toMatchObject({
      authorization: "[Redacted]",
      cookie: "[Redacted]",
      "x-api-key": "[Redacted]",
    });
    expect(stream.output()).not.toContain("upstream-token");
    expect(stream.output()).not.toContain("oauth-token");
    expect(stream.output()).not.toContain("local-key");
  });

  it("uses pretty output by default", async () => {
    const stream = new CapturingStream();
    const logger = createHoopilotLogger({
      colorize: false,
      env: {},
      stream,
    });

    logger.info("default pretty check");

    await Bun.sleep(10);
    expect(stream.output()).toContain("default pretty check");
    expect(() => JSON.parse(stream.output())).toThrow();
  });

  it("formats common pretty fields inline without a raw trailing object", async () => {
    const stream = new CapturingStream();
    const logger = createHoopilotLogger({
      colorize: false,
      env: {},
      stream,
    }).child({
      command: "serve",
      component: "server",
      method: "POST",
      path: "/v1/chat/completions",
      requestId: "req-test",
      route: "chat_completions",
    });

    logger.info(
      {
        durationMs: 42.37,
        event: "http.request.completed",
        status: 200,
        stream: true,
      },
      "request completed",
    );

    await Bun.sleep(10);
    const output = stream.output();
    expect(output).toMatch(/^INFO \[\d{2}:\d{2}:\d{2}\]: request completed /);
    expect(output).toContain("component=server");
    expect(output).toContain("command=serve");
    expect(output).toContain("event=http.request.completed");
    expect(output).toContain("method=POST");
    expect(output).toContain("path=/v1/chat/completions");
    expect(output).toContain("status=200");
    expect(output).toContain("duration=42.37ms");
    expect(output).toContain("stream=true");
    expect(output).toContain("route=chat_completions");
    expect(output).toContain("requestId=req-test");
    expect(output).not.toContain('{"');
  });

  it("keeps unknown and error fields visible in pretty output", async () => {
    const stream = new CapturingStream();
    const logger = createHoopilotLogger({
      colorize: false,
      env: {},
      stream,
    });

    logger.warn(
      {
        attempt: 2,
        err: {
          message: "upstream exploded",
          name: "Error",
        },
        event: "copilot.request.failed",
        upstreamStatus: 503,
      },
      "copilot upstream request failed",
    );

    await Bun.sleep(10);
    const output = stream.output();
    expect(output).toContain("copilot upstream request failed");
    expect(output).toContain("event=copilot.request.failed");
    expect(output).toContain("upstreamStatus=503");
    expect(output).toContain('"attempt":2');
    expect(output).toContain("upstream exploded");
  });

  it("can create a silent default logger without an injected stream", () => {
    const logger = createHoopilotLogger({ env: {}, level: "silent" });

    logger.info("suppressed");
  });

  it("provides a no-op logger for silent programmatic use", () => {
    const child = noopLogger.child({ component: "test" });

    child.trace("trace");
    child.debug("debug");
    child.info("info");
    child.warn("warn");
    child.error("error");
    child.fatal("fatal");
  });
});

describe("log option parsing", () => {
  it("accepts supported levels and formats", () => {
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("silent")).toBe("silent");
    expect(parseLogFormat(undefined)).toBe("pretty");
    expect(parseLogFormat("pretty")).toBe("pretty");
  });

  it("rejects unsupported levels and formats", () => {
    expect(() => parseLogLevel("verbose")).toThrow("Invalid log level");
    expect(() => parseLogFormat("text")).toThrow("Invalid log format");
  });

  it("detects whether options request a real logger", () => {
    expect(shouldCreateLogger({})).toBe(false);
    expect(shouldCreateLogger({ env: { HOOPILOT_LOG_LEVEL: "debug" } })).toBe(true);
    expect(shouldCreateLogger({ logFormat: "pretty" })).toBe(true);
    expect(shouldCreateLogger({ logLevel: "warn" })).toBe(true);
  });
});

class CapturingStream extends Writable {
  readonly #chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(String(chunk));
    callback();
  }

  output(): string {
    return this.#chunks.join("");
  }
}
