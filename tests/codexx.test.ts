import { describe, expect, it } from "bun:test";
import { buildCodexxInvocation, verifyCodexxModel } from "../src/codexx";

describe("buildCodexxInvocation", () => {
  it("points Codex at the local Hoopilot server with gpt-5.5 xhigh defaults", () => {
    const invocation = buildCodexxInvocation(["hi"], {
      ALL_PROXY: "http://proxy.company.example:8080",
      HTTPS_PROXY: "http://proxy.company.example:8080",
      HOOPILOT_API_KEY: "local-key",
      NO_PROXY: "127.0.0.1",
      PATH: "/usr/bin",
      http_proxy: "http://proxy.company.example:8080",
    });

    expect(invocation.command).toBe("codex");
    expect(invocation.baseUrl).toBe("http://127.0.0.1:4141/v1");
    expect(invocation.model).toBe("gpt-5.5");
    expect(invocation.args).toEqual([
      "--disable",
      "network_proxy",
      "-c",
      "permissions.workspace.network.enabled=false",
      "-c",
      'model_provider="hoopilot"',
      "-c",
      'model_providers.hoopilot={ name = "Hoopilot", base_url = "http://127.0.0.1:4141/v1", env_key = "OPENAI_API_KEY", wire_api = "responses", supports_websockets = false, stream_idle_timeout_ms = 120000 }',
      "-m",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="xhigh"',
      "hi",
    ]);
    expect(invocation.env.OPENAI_API_KEY).toBe("local-key");
    expect(invocation.env.PATH).toBe("/usr/bin");
    expect(invocation.env.ALL_PROXY).toBeUndefined();
    expect(invocation.env.HTTPS_PROXY).toBeUndefined();
    expect(invocation.env.NO_PROXY).toBeUndefined();
    expect(invocation.env.http_proxy).toBeUndefined();
  });

  it("allows explicit codexx overrides while forwarding normal Codex arguments", () => {
    const invocation = buildCodexxInvocation(["exec", "status"], {
      CODEXX_API_KEY: "override-key",
      CODEXX_BASE_URL: "http://127.0.0.1:5151/v1",
      CODEXX_CODEX_BIN: "/tmp/codex",
      CODEXX_MODEL: "claude-sonnet-4.6",
      CODEXX_MODEL_REASONING_EFFORT: "high",
      CODEXX_STREAM_IDLE_TIMEOUT_MS: "45000",
    });

    expect(invocation.command).toBe("/tmp/codex");
    expect(invocation.baseUrl).toBe("http://127.0.0.1:5151/v1");
    expect(invocation.model).toBe("claude-sonnet-4.6");
    expect(invocation.args).toEqual([
      "--disable",
      "network_proxy",
      "-c",
      "permissions.workspace.network.enabled=false",
      "-c",
      'model_provider="hoopilot"',
      "-c",
      'model_providers.hoopilot={ name = "Hoopilot", base_url = "http://127.0.0.1:5151/v1", env_key = "OPENAI_API_KEY", wire_api = "responses", supports_websockets = false, stream_idle_timeout_ms = 45000 }',
      "-m",
      "claude-sonnet-4.6",
      "-c",
      'model_reasoning_effort="high"',
      "exec",
      "status",
    ]);
    expect(invocation.env.OPENAI_API_KEY).toBe("override-key");
  });

  it("can leave the Codex stream idle timeout at Codex's own default", () => {
    const invocation = buildCodexxInvocation([], {
      CODEXX_STREAM_IDLE_TIMEOUT_MS: "0",
    });

    expect(invocation.args).toContain(
      'model_providers.hoopilot={ name = "Hoopilot", base_url = "http://127.0.0.1:4141/v1", env_key = "OPENAI_API_KEY", wire_api = "responses", supports_websockets = false }',
    );
  });

  it("rejects invalid Codex stream idle timeout overrides", () => {
    expect(() =>
      buildCodexxInvocation([], {
        CODEXX_STREAM_IDLE_TIMEOUT_MS: "soon",
      }),
    ).toThrow("CODEXX_STREAM_IDLE_TIMEOUT_MS");
  });

  it("does not reuse an ambient OpenAI API key as the local Hoopilot key", async () => {
    const requests: Request[] = [];
    const invocation = buildCodexxInvocation([], {
      OPENAI_API_KEY: "sk-real-openai-key",
    });

    await verifyCodexxModel(invocation, async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ data: [{ id: "gpt-5.5" }] });
    });

    const generatedKey = invocation.env.OPENAI_API_KEY ?? "";
    expect(generatedKey).not.toBe("sk-real-openai-key");
    expect(generatedKey).toMatch(/^codexx-[0-9a-f-]{36}$/);
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${generatedKey}`);
    expect(requests[0]!.headers.get("authorization")).not.toContain("sk-real-openai-key");
  });

  it("does not fall back to a public default key when no key is configured", () => {
    const first = buildCodexxInvocation([], { PATH: "/usr/bin" });
    const second = buildCodexxInvocation([], { PATH: "/usr/bin" });

    // The old behavior leaked the predictable, public "local-key" as a credential.
    expect(first.env.OPENAI_API_KEY).not.toBe("local-key");
    expect(first.env.OPENAI_API_KEY).toMatch(/^codexx-[0-9a-f-]{36}$/);
    // Each invocation gets its own throwaway key, so nothing predictable is reused.
    expect(first.env.OPENAI_API_KEY).not.toBe(second.env.OPENAI_API_KEY);
  });

  it("preflights the requested model against the local models endpoint", async () => {
    const requests: Request[] = [];
    const invocation = buildCodexxInvocation([], {
      HOOPILOT_API_KEY: "local-key",
    });

    await verifyCodexxModel(invocation, async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ data: [{ id: "gpt-5.5" }] });
    });

    expect(requests[0]!.url).toBe("http://127.0.0.1:4141/v1/models");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer local-key");
  });

  it("reports when the logged-in Copilot account does not advertise the requested model", async () => {
    const invocation = buildCodexxInvocation([], {
      HOOPILOT_API_KEY: "local-key",
    });

    await expect(
      verifyCodexxModel(invocation, async () =>
        Response.json({ data: [{ id: "gpt-4o" }, { id: "gpt-41-copilot" }] }),
      ),
    ).rejects.toThrow('The logged-in Copilot account does not advertise model "gpt-5.5"');
  });
});
