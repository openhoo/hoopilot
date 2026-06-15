import { describe, expect, it } from "bun:test";
import { buildCodexxInvocation } from "../src/codexx";

describe("buildCodexxInvocation", () => {
  it("points Codex at the local Hoopilot server without proxy variables", () => {
    const invocation = buildCodexxInvocation(["-m", "gpt-4.1", "hi"], {
      ALL_PROXY: "http://proxy.company.example:8080",
      HTTPS_PROXY: "http://proxy.company.example:8080",
      HOOPILOT_API_KEY: "local-key",
      NO_PROXY: "127.0.0.1",
      PATH: "/usr/bin",
      http_proxy: "http://proxy.company.example:8080",
    });

    expect(invocation.command).toBe("codex");
    expect(invocation.args).toEqual([
      "--disable",
      "network_proxy",
      "-c",
      'model_provider="hoopilot"',
      "-c",
      'model_providers.hoopilot={ name = "Hoopilot", base_url = "http://127.0.0.1:4141/v1", env_key = "OPENAI_API_KEY", wire_api = "responses", supports_websockets = false }',
      "-m",
      "gpt-4.1",
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
    });

    expect(invocation.command).toBe("/tmp/codex");
    expect(invocation.args).toEqual([
      "--disable",
      "network_proxy",
      "-c",
      'model_provider="hoopilot"',
      "-c",
      'model_providers.hoopilot={ name = "Hoopilot", base_url = "http://127.0.0.1:5151/v1", env_key = "OPENAI_API_KEY", wire_api = "responses", supports_websockets = false }',
      "exec",
      "status",
    ]);
    expect(invocation.env.OPENAI_API_KEY).toBe("override-key");
  });
});
