#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { CopilotAuthError } from "./auth";
import { authStorePath, writeStoredCopilotAuth } from "./auth-store";
import { githubCopilotDeviceLogin } from "./github-device";
import { startHoopilotServer } from "./server";
import type { CopilotAccess, FetchLike, HoopilotServerOptions } from "./types";
import { cleanupOldBinary, maybeNotifyUpdate, runUpdate } from "./update";
import { getVersion, IS_STANDALONE_BINARY } from "./version";

const DEFAULT_COPILOT_API_BASE_URL = "https://api.githubcopilot.com";

interface ParsedArgs extends HoopilotServerOptions {
  help?: boolean;
  noUpdateCheck?: boolean;
  version?: boolean;
}

interface VerifyCopilotOAuthTokenOptions {
  copilotApiBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  // Clear any leftover ".old" binary from a prior Windows self-update.
  cleanupOldBinary();

  const command = argv[0];
  if (command === "update" || command === "upgrade") {
    await runUpdate(await getVersion());
    return;
  }
  if (command === "login") {
    const args = parseArgs(argv.slice(1));
    if (args.help) {
      console.log(helpText(await getVersion()));
      return;
    }
    await runLogin(args);
    return;
  }

  const args = parseArgs(argv);
  if (args.help) {
    console.log(helpText(await getVersion()));
    return;
  }
  if (args.version) {
    console.log(await getVersion());
    return;
  }

  const started = startHoopilotServer(args);
  console.log(`hoopilot listening on ${started.url}`);
  console.log(`OpenAI base URL: ${started.url}/v1`);
  console.log("Use Ctrl+C to stop.");

  if (!args.noUpdateCheck && process.env.HOOPILOT_NO_UPDATE_CHECK !== "1") {
    // Non-blocking: prints a notice from the previous check and refreshes the
    // cache in the background. The running server keeps the refresh alive.
    void maybeNotifyUpdate(await getVersion(), IS_STANDALONE_BINARY ? "binary" : "npm");
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  const rest = [...argv];
  if (rest[0] === "serve") {
    rest.shift();
  }

  while (rest.length > 0) {
    const arg = rest.shift();
    if (!arg) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      args.version = true;
      continue;
    }
    if (arg === "--allow-unauthenticated") {
      args.allowUnauthenticated = true;
      continue;
    }
    if (arg === "--no-update-check") {
      args.noUpdateCheck = true;
      continue;
    }

    const [name, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? rest.shift();
    if (!value) {
      throw new Error(`Missing value for ${arg}.`);
    }

    switch (name) {
      case "--api-key":
        args.apiKey = value;
        break;
      case "--auth-file":
        args.authStorePath = value;
        break;
      case "--copilot-api-base-url":
        args.copilotApiBaseUrl = value;
        break;
      case "--host":
        args.host = value;
        break;
      case "--port":
      case "-p":
        args.port = Number(value);
        if (!Number.isInteger(args.port) || args.port <= 0) {
          throw new Error(`Invalid port: ${value}.`);
        }
        break;
      default:
        throw new Error(`Unknown option: ${name}.`);
    }
  }

  return args;
}

async function runLogin(options: HoopilotServerOptions = {}): Promise<void> {
  console.log("Starting GitHub Copilot browser login...");
  const login = await githubCopilotDeviceLogin({
    env: options.env,
    logger: console,
    openBrowser: openBrowserBestEffort,
  });

  console.log("Checking GitHub Copilot access...");
  const access = await verifyCopilotOAuthToken(login.token, options);
  const path = options.authStorePath ?? authStorePath(options.env);
  writeStoredCopilotAuth(
    {
      apiBaseUrl: access.apiBaseUrl,
      githubDomain: login.domain,
      source: "github-device-oauth",
      token: login.token,
    },
    path,
  );
  console.log(`Copilot OAuth credential stored at ${path}`);
  console.log("Copilot authentication ready.");
}

export async function verifyCopilotOAuthToken(
  token: string,
  options: VerifyCopilotOAuthTokenOptions = {},
): Promise<CopilotAccess> {
  const apiBaseUrl = trimTrailingSlash(
    options.copilotApiBaseUrl ?? options.env?.COPILOT_API_BASE_URL ?? DEFAULT_COPILOT_API_BASE_URL,
  );
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(`${apiBaseUrl}/models`, {
    headers: copilotHeaders(token),
    method: "GET",
  });

  if (!response.ok) {
    const message = `GitHub Copilot API verification failed with ${
      response.status
    }: ${await safeResponseText(response)}`;
    if (response.status === 401 || response.status === 403) {
      throw new CopilotAuthError(message);
    }
    throw new Error(message);
  }

  return {
    apiBaseUrl,
    expiresAtMs: Date.now() + 10 * 60_000,
    source: "github-copilot-oauth",
    token,
  };
}

function openBrowserBestEffort(url: string): void {
  const platform = process.platform;
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // The device login code and URL were already printed.
  }
}

function copilotHeaders(token: string): Headers {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  headers.set("copilot-integration-id", "vscode-chat");
  headers.set("editor-plugin-version", "hoopilot/0.1.0");
  headers.set("editor-version", "Hoopilot/0.1.0");
  headers.set("openai-intent", "conversation-panel");
  headers.set("user-agent", "hoopilot/0.1.0");
  headers.set("x-github-api-version", "2026-06-01");
  return headers;
}

async function safeResponseText(response: Response): Promise<string> {
  const text = await response.text();
  return text.slice(0, 500);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function helpText(version: string): string {
  return `hoopilot ${version}

OpenAI-compatible proxy for GitHub Copilot.

Usage:
  hoopilot [serve] [options]
  hoopilot login [options]
  hoopilot update
  npx @openhoo/hoopilot [options]

Commands:
  serve                             Start the proxy server (default)
  login                             Sign in through GitHub OAuth in a browser and verify Copilot access
  update, upgrade                   Update hoopilot to the latest release

Options:
  -p, --port <port>                 Port to listen on. Default: 4141
      --host <host>                 Host to listen on. Default: 127.0.0.1
      --api-key <key>               Require clients to send Authorization: Bearer <key>
      --auth-file <path>            OAuth credential store path
      --copilot-api-base-url <url>  Copilot API base URL override
      --no-update-check             Do not check GitHub for a newer release
      --allow-unauthenticated       Allow non-loopback bind without --api-key
  -h, --help                        Show help
  -v, --version                     Show version

Environment:
  HOOPILOT_API_KEY
  HOOPILOT_AUTH_FILE
  HOOPILOT_GITHUB_CLIENT_ID
  HOOPILOT_GITHUB_DOMAIN
  COPILOT_API_BASE_URL
  HOOPILOT_NO_UPDATE_CHECK          Set to disable update checks (also NO_UPDATE_NOTIFIER)
`;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
