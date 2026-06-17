import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class StoredCopilotAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredCopilotAuthError";
  }
}

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
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new StoredCopilotAuthError(`Could not read Hoopilot auth file at ${path}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StoredCopilotAuthError(
      `Hoopilot auth file at ${path} is not valid JSON. Run \`hoopilot login\` to replace it.`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StoredCopilotAuthError(`Hoopilot auth file at ${path} must contain a JSON object.`);
  }
  const record = parsed as Record<string, unknown>;
  const token = typeof record.token === "string" ? record.token.trim() : "";
  if (!token) {
    throw new StoredCopilotAuthError(`Hoopilot auth file at ${path} does not contain a token.`);
  }
  return {
    apiBaseUrl: typeof record.apiBaseUrl === "string" ? record.apiBaseUrl : undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
    githubDomain: typeof record.githubDomain === "string" ? record.githubDomain : undefined,
    source: typeof record.source === "string" ? record.source : undefined,
    token,
  };
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
