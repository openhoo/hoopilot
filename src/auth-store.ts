import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  const data = `${JSON.stringify(
    {
      ...auth,
      createdAt: auth.createdAt ?? new Date().toISOString(),
    },
    null,
    2,
  )}\n`;
  // Write to a sibling temp file, then rename into place so a crash or full
  // disk mid-write can never leave a truncated credential file behind.
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, data, { mode: 0o600 });
  renameSync(tmpPath, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod is best-effort on Windows.
  }
}
