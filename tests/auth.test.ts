import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotAuth } from "../src/auth";
import { authStorePath, writeStoredCopilotAuth } from "../src/auth-store";

describe("CopilotAuth", () => {
  it("loads the stored GitHub Copilot OAuth credential", async () => {
    const path = tempAuthPath();
    writeStoredCopilotAuth(
      {
        apiBaseUrl: "https://api.githubcopilot.example/",
        githubDomain: "github.example",
        source: "github-device-oauth",
        token: "oauth-token",
      },
      path,
    );

    const access = await new CopilotAuth({ authStorePath: path, env: {} }).getAccess();

    expect(access).toMatchObject({
      apiBaseUrl: "https://api.githubcopilot.example",
      source: "github-copilot-oauth",
      token: "oauth-token",
    });
  });

  it("uses the configured Copilot API base URL when the store has none", async () => {
    const path = tempAuthPath();
    writeStoredCopilotAuth({ token: "oauth-token" }, path);

    const access = await new CopilotAuth({
      authStorePath: path,
      copilotApiBaseUrl: "https://api.githubcopilot.override/",
      env: {},
    }).getAccess();

    expect(access.apiBaseUrl).toBe("https://api.githubcopilot.override");
  });

  it("lets an explicit Copilot API base URL override the stored URL", async () => {
    const path = tempAuthPath();
    writeStoredCopilotAuth(
      {
        apiBaseUrl: "https://api.githubcopilot.old/",
        token: "oauth-token",
      },
      path,
    );

    const access = await new CopilotAuth({
      authStorePath: path,
      copilotApiBaseUrl: "https://api.githubcopilot.new/",
      env: {},
    }).getAccess();

    expect(access.apiBaseUrl).toBe("https://api.githubcopilot.new");
  });

  it("supports HOOPILOT_AUTH_FILE for the OAuth credential store", async () => {
    const path = tempAuthPath();
    writeStoredCopilotAuth({ token: "oauth-token" }, path);

    const access = await new CopilotAuth({
      env: {
        HOOPILOT_AUTH_FILE: path,
      },
    }).getAccess();

    expect(access.token).toBe("oauth-token");
  });

  it("does not accept direct token environment variables", async () => {
    const auth = new CopilotAuth({
      authStorePath: tempAuthPath(),
      env: {
        COPILOT_API_TOKEN: "direct-token",
        COPILOT_GITHUB_TOKEN: "github-oauth-token",
      },
    });

    await expect(auth.getAccess()).rejects.toThrow("No GitHub Copilot OAuth credential found");
  });

  it("reports missing OAuth credentials", async () => {
    await expect(
      new CopilotAuth({
        authStorePath: tempAuthPath(),
        env: {},
      }).getAccess(),
    ).rejects.toThrow("hoopilot login");
  });

  it("reports malformed OAuth credential files distinctly from missing credentials", async () => {
    const path = tempAuthPath();
    writeFileSync(path, "{not-json", "utf8");

    await expect(
      new CopilotAuth({
        authStorePath: path,
        env: {},
      }).getAccess(),
    ).rejects.toThrow("is not valid JSON");
  });
});

describe("authStorePath", () => {
  it("uses explicit, XDG, appdata, and home-based config paths", () => {
    expect(authStorePath({ HOOPILOT_AUTH_FILE: "/tmp/hoopilot-auth.json" })).toBe(
      "/tmp/hoopilot-auth.json",
    );
    expect(authStorePath({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/hoopilot/auth.json");
    expect(authStorePath({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" })).toBe(
      "C:\\Users\\test\\AppData\\Roaming/hoopilot/auth.json",
    );
    expect(authStorePath({ HOME: "/home/test" })).toBe("/home/test/.config/hoopilot/auth.json");
  });
});

function tempAuthPath(): string {
  return join(mkdtempSync(join(tmpdir(), "hoopilot-auth-test-")), "auth.json");
}
