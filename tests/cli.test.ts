import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli";

describe("parseArgs", () => {
  it("accepts the supported auth modes", () => {
    expect(parseArgs(["--auth-mode", "auto"]).authMode).toBe("auto");
    expect(parseArgs(["--auth-mode", "copilot-token"]).authMode).toBe("copilot-token");
  });

  it("rejects removed GitHub-token auth modes", () => {
    expect(() => parseArgs(["--auth-mode", "github-token"])).toThrow("Invalid auth mode");
    expect(() => parseArgs(["--auth-mode", "direct-github-token"])).toThrow("Invalid auth mode");
  });
});
