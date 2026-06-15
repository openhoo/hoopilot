import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface StoredCopilotAuth {
  apiBaseUrl?: string;
  createdAt?: string;
  githubDomain?: string;
  source?: string;
  token: string;
}

export function authStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HOOPILOT_AUTH_FILE) {
    return env.HOOPILOT_AUTH_FILE;
  }

  const base =
    env.XDG_CONFIG_HOME ??
    env.APPDATA ??
    (env.HOME ? join(env.HOME, ".config") : join(process.cwd(), ".config"));
  return join(base, "hoopilot", "auth.json");
}

export function readStoredCopilotAuth(path = authStorePath()): StoredCopilotAuth | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    if (!token) {
      return undefined;
    }
    return {
      apiBaseUrl: typeof parsed.apiBaseUrl === "string" ? parsed.apiBaseUrl : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
      githubDomain: typeof parsed.githubDomain === "string" ? parsed.githubDomain : undefined,
      source: typeof parsed.source === "string" ? parsed.source : undefined,
      token,
    };
  } catch {
    return undefined;
  }
}

export function writeStoredCopilotAuth(auth: StoredCopilotAuth, path = authStorePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        ...auth,
        createdAt: auth.createdAt ?? new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod is best-effort on Windows.
  }
}
