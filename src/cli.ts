#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { CopilotAuthError, DEFAULT_COPILOT_API_BASE_URL } from "./auth";
import { authStorePath, writeStoredCopilotAuth } from "./auth-store";
import { main as codexxMain } from "./codexx";
import {
  applyCopilotHeaders,
  CopilotClient,
  normalizeCopilotUsage,
  parseRateLimitHeaders,
} from "./copilot";
import {
  type GithubCopilotDeviceLoginOptions,
  type GithubCopilotDeviceLoginResult,
  githubCopilotDeviceLogin,
} from "./github-device";
import { createHoopilotLogger, noopLogger, parseLogFormat, parseLogLevel } from "./logger";
import { startHoopilotServer } from "./server";
import type {
  CopilotAccess,
  CopilotQuota,
  CopilotUsage,
  FetchLike,
  GithubRateLimit,
  HoopilotLogger,
  HoopilotServerOptions,
  Logger,
} from "./types";
import { cleanupOldBinary, maybeNotifyUpdate, runUpdate } from "./update";
import {
  asRecord,
  envValue,
  isTrustedTokenBaseUrl,
  trimTrailingSlash,
  truncatedResponseText,
} from "./util";
import { getVersion, IS_STANDALONE_BINARY } from "./version";

interface ParsedArgs extends HoopilotServerOptions {
  help?: boolean;
  noUpdateCheck?: boolean;
  printToken?: boolean;
  version?: boolean;
}

type DeviceLogin = (
  options: GithubCopilotDeviceLoginOptions,
) => Promise<GithubCopilotDeviceLoginResult>;

interface RunLoginOptions extends HoopilotServerOptions {
  deviceLogin?: DeviceLogin;
  printToken?: boolean;
}

interface VerifyCopilotOAuthTokenOptions {
  copilotApiBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}

const ALLOWED_COPILOT_API_HOSTS = ["api.githubcopilot.com"] as const;

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  // Clear any leftover ".old" binary from a prior Windows self-update.
  cleanupOldBinary();

  const command = argv[0];
  if (command === "update" || command === "upgrade") {
    const args = withRuntimeEnv(parseArgs(argv.slice(1)));
    if (await printMetaOption(args)) {
      return;
    }
    const logger = commandLogger(args, command);
    await runUpdate(await getVersion(), logger);
    return;
  }
  if (command === "codexx") {
    await codexxMain(argv.slice(1), process.env);
    return;
  }
  if (command === "login") {
    const args = withRuntimeEnv(parseArgs(argv.slice(1)));
    if (await printMetaOption(args)) {
      return;
    }
    args.logger = commandLogger(args, "login", args.printToken ? process.stderr : undefined);
    await runLogin(args);
    return;
  }
  if (command === "models") {
    const args = withRuntimeEnv(parseArgs(argv.slice(1)));
    if (await printMetaOption(args)) {
      return;
    }
    args.logger = commandLogger(args, "models");
    await runModels(args);
    return;
  }
  if (command === "usage") {
    const args = withRuntimeEnv(parseArgs(argv.slice(1)));
    if (await printMetaOption(args)) {
      return;
    }
    args.logger = commandLogger(args, "usage");
    await runUsage(args);
    return;
  }

  const args = withRuntimeEnv(parseArgs(argv));
  if (await printMetaOption(args)) {
    return;
  }

  const logger = commandLogger(args, "serve");
  args.logger = logger;
  const started = startHoopilotServer(args);
  logger.info(
    {
      baseUrl: `${started.url}/v1`,
      event: "server.started",
      url: started.url,
    },
    "hoopilot server started",
  );

  if (!args.noUpdateCheck) {
    // Non-blocking: prints a notice from the previous check and refreshes the
    // cache in the background. The running server keeps the refresh alive.
    // Env-based disabling (HOOPILOT_NO_UPDATE_CHECK, NO_UPDATE_NOTIFIER, CI, …)
    // is handled centrally by isUpdateCheckDisabled inside maybeNotifyUpdate.
    void maybeNotifyUpdate(
      await getVersion(),
      IS_STANDALONE_BINARY ? "binary" : "npm",
      logger.child({ component: "update" }),
    );
  }
}

async function printMetaOption(args: ParsedArgs): Promise<boolean> {
  if (args.help) {
    console.log(helpText(await getVersion()));
    return true;
  }
  if (args.version) {
    console.log(await getVersion());
    return true;
  }
  return false;
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
    if (arg === "--print-key" || arg === "--print-token") {
      args.printToken = true;
      continue;
    }

    if (!arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}.`);
    }

    const [name, inlineValue] = splitOption(arg);
    switch (name) {
      case "--api-key":
        args.apiKey = optionValue(name, inlineValue, rest);
        break;
      case "--api-key-file":
        args.apiKey = readApiKeyFile(optionValue(name, inlineValue, rest));
        break;
      case "--auth-file":
        args.authStorePath = optionValue(name, inlineValue, rest);
        break;
      case "--copilot-api-base-url":
        args.copilotApiBaseUrl = optionValue(name, inlineValue, rest);
        break;
      case "--log-format":
        args.logFormat = parseLogFormat(optionValue(name, inlineValue, rest));
        break;
      case "--log-level":
        args.logLevel = parseLogLevel(optionValue(name, inlineValue, rest));
        break;
      case "--stream-mode":
        args.streamingProxyMode = parseStreamMode(optionValue(name, inlineValue, rest));
        break;
      case "--host":
        args.host = optionValue(name, inlineValue, rest);
        break;
      case "--port":
      case "-p": {
        const value = optionValue(name, inlineValue, rest);
        args.port = Number(value);
        if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65_535) {
          throw new Error(`Invalid port: ${value}.`);
        }
        break;
      }
      default:
        throw new Error(`Unknown option: ${name}.`);
    }
  }

  return args;
}

function parseStreamMode(value: string): "auto" | "buffer" | "live" {
  if (value === "auto" || value === "buffer" || value === "live") {
    return value;
  }
  throw new Error(`Invalid stream mode: ${value}. Expected auto, live, or buffer.`);
}

function optionValue(name: string, inlineValue: string | undefined, rest: string[]): string {
  const value = inlineValue ?? rest.shift();
  if (!value) {
    throw new Error(`Missing value for ${name}.`);
  }
  return value;
}

function splitOption(arg: string): [string, string | undefined] {
  const separator = arg.indexOf("=");
  if (separator === -1) {
    return [arg, undefined];
  }
  return [arg.slice(0, separator), arg.slice(separator + 1)];
}

function readApiKeyFile(path: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (!value) {
    throw new Error(`API key file is empty: ${path}.`);
  }
  return value;
}

export async function runLogin(options: RunLoginOptions = {}): Promise<void> {
  const logger = options.logger?.child({ component: "auth" }) ?? noopLogger;
  const status = loginStatusLogger(Boolean(options.printToken));
  logger.debug({ event: "auth.login.started" }, "starting github copilot browser login");
  status.info("Starting GitHub Copilot browser login...");
  const deviceLogin = options.deviceLogin ?? githubCopilotDeviceLogin;
  const login = await deviceLogin({
    env: options.env,
    logger: status,
    openBrowser: openBrowserBestEffort,
  });

  status.info("Checking GitHub Copilot access...");
  const access = await verifyCopilotOAuthToken(login.token, options);
  logger.debug(
    { apiBaseUrl: access.apiBaseUrl, event: "auth.login.verified" },
    "github copilot oauth token verified",
  );
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
  logger.debug({ authStorePath: path, event: "auth.login.stored" }, "copilot credential stored");
  status.info(`Copilot OAuth credential stored at ${path}`);
  status.info("Copilot authentication ready.");
  if (options.printToken) {
    console.log(login.token);
  }
}

export async function runModels(options: HoopilotServerOptions = {}): Promise<string[]> {
  const logger = options.logger?.child({ component: "models" }) ?? noopLogger;
  logger.debug({ event: "models.list.started" }, "fetching github copilot models");

  const response = await new CopilotClient(options).models();
  if (!response.ok) {
    const message = `GitHub Copilot API model list failed with ${
      response.status
    }: ${await truncatedResponseText(response)}`;
    if (response.status === 401 || response.status === 403) {
      throw new CopilotAuthError(message);
    }
    throw new Error(message);
  }

  const ids = modelIdsFromResponse(await response.json().catch(() => undefined));
  if (ids.length === 0) {
    throw new Error("GitHub Copilot API returned no model IDs.");
  }

  logger.debug(
    { count: ids.length, event: "models.list.succeeded" },
    "github copilot models fetched",
  );
  for (const id of ids) {
    console.log(id);
  }
  return ids;
}

export async function runUsage(options: HoopilotServerOptions = {}): Promise<CopilotUsage> {
  const logger = options.logger?.child({ component: "usage" }) ?? noopLogger;
  logger.debug({ event: "usage.fetch.started" }, "fetching github copilot quota");

  const response = await new CopilotClient(options).usage();
  if (!response.ok) {
    const message = `GitHub Copilot usage request failed with ${
      response.status
    }: ${await truncatedResponseText(response)}`;
    if (response.status === 401 || response.status === 403) {
      throw new CopilotAuthError(message);
    }
    throw new Error(message);
  }

  const rateLimit = parseRateLimitHeaders(response.headers);
  const usage = normalizeCopilotUsage(await response.json().catch(() => ({})));
  logger.debug(
    { event: "usage.fetch.succeeded", plan: usage.plan },
    "github copilot quota fetched",
  );
  for (const line of formatCopilotUsage(usage)) {
    console.log(line);
  }
  if (rateLimit) {
    console.log(formatGithubRateLimit(rateLimit));
  }
  return usage;
}

function formatGithubRateLimit(rateLimit: GithubRateLimit): string {
  const parts: string[] = [];
  if (rateLimit.remaining !== undefined && rateLimit.limit !== undefined) {
    parts.push(`${rateLimit.remaining}/${rateLimit.limit} requests remaining`);
  } else if (rateLimit.remaining !== undefined) {
    parts.push(`${rateLimit.remaining} requests remaining`);
  } else if (rateLimit.used !== undefined) {
    parts.push(`${rateLimit.used} requests used`);
  }
  if (rateLimit.resetEpochSeconds !== undefined) {
    parts.push(`resets ${new Date(rateLimit.resetEpochSeconds * 1000).toISOString()}`);
  }
  if (rateLimit.retryAfterSeconds !== undefined) {
    parts.push(`retry after ${rateLimit.retryAfterSeconds}s`);
  }
  const detail = parts.length > 0 ? parts.join(", ") : "n/a";
  const resource =
    rateLimit.resource && rateLimit.resource !== "unknown" ? ` (${rateLimit.resource})` : "";
  return `GitHub API rate limit${resource}: ${detail}`;
}

function formatCopilotUsage(usage: CopilotUsage): string[] {
  const lines: string[] = [];
  if (usage.plan) {
    lines.push(`Plan: ${usage.plan}`);
  }
  if (usage.quotaResetDate) {
    lines.push(`Quota resets: ${usage.quotaResetDate}`);
  }

  const order = ["premium_interactions", "chat", "completions"];
  const names = Object.keys(usage.quotas).sort(
    (a, b) => quotaRank(order, a) - quotaRank(order, b) || a.localeCompare(b),
  );
  for (const name of names) {
    const quota = usage.quotas[name];
    if (quota) {
      lines.push(`${quotaLabel(name)}: ${formatQuota(quota)}`);
    }
  }
  if (lines.length === 0) {
    lines.push("No GitHub Copilot quota information available for this account.");
  }
  return lines;
}

function quotaRank(order: string[], name: string): number {
  const index = order.indexOf(name);
  return index === -1 ? order.length : index;
}

function quotaLabel(name: string): string {
  switch (name) {
    case "premium_interactions":
      return "Premium requests";
    case "chat":
      return "Chat";
    case "completions":
      return "Completions";
    default:
      return name;
  }
}

function formatQuota(quota: CopilotQuota): string {
  if (quota.unlimited) {
    return "unlimited";
  }
  const parts: string[] = [];
  if (quota.used !== undefined && quota.entitlement !== undefined) {
    parts.push(`${roundQuota(quota.used)}/${roundQuota(quota.entitlement)} used`);
  } else if (quota.remaining !== undefined) {
    parts.push(`${roundQuota(quota.remaining)} remaining`);
  }
  if (quota.percentRemaining !== undefined) {
    parts.push(`${roundQuota(quota.percentRemaining)}% remaining`);
  }
  if (quota.overageCount) {
    parts.push(`${roundQuota(quota.overageCount)} overage`);
  }
  return parts.length > 0 ? parts.join(", ") : "n/a";
}

function roundQuota(value: number): number {
  return Number.isInteger(value) ? value : Math.round(value * 10) / 10;
}

export async function verifyCopilotOAuthToken(
  token: string,
  options: VerifyCopilotOAuthTokenOptions = {},
): Promise<CopilotAccess> {
  const apiBaseUrl = trimTrailingSlash(
    options.copilotApiBaseUrl ??
      envValue(options.env?.COPILOT_API_BASE_URL) ??
      DEFAULT_COPILOT_API_BASE_URL,
  );
  const allowUnsafeUpstream = envValue(options.env?.HOOPILOT_ALLOW_UNSAFE_UPSTREAM) === "1";
  if (!isTrustedTokenBaseUrl(apiBaseUrl, ALLOWED_COPILOT_API_HOSTS, allowUnsafeUpstream)) {
    throw new Error(
      `Refusing to send the GitHub OAuth token to an untrusted Copilot API host: ${apiBaseUrl}`,
    );
  }
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(`${apiBaseUrl}/models`, {
    headers: applyCopilotHeaders(new Headers(), token),
    method: "GET",
  });

  if (!response.ok) {
    const message = `GitHub Copilot API verification failed with ${
      response.status
    }: ${await truncatedResponseText(response)}`;
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

type BrowserOpenerChild = {
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
};

type BrowserOpenerSpawn = (
  command: string,
  args: string[],
  options: {
    detached: true;
    stdio: "ignore";
  },
) => BrowserOpenerChild;

export function openBrowserBestEffort(url: string, spawnOpener: BrowserOpenerSpawn = spawn): void {
  const platform = process.platform;
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawnOpener(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // The device login code and URL were already printed.
    });
    child.unref();
  } catch {
    // The device login code and URL were already printed.
  }
}

function modelIdsFromResponse(body: unknown): string[] {
  const record = asRecord(body);
  const data = Array.isArray(record.data) ? record.data : Array.isArray(body) ? body : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const model of data) {
    const id = asRecord(model).id;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function withRuntimeEnv(args: ParsedArgs): ParsedArgs {
  return { ...args, env: process.env };
}

function commandLogger(
  args: ParsedArgs,
  command: string,
  stream?: { write(message: string): unknown },
): HoopilotLogger {
  return createHoopilotLogger({
    env: args.env,
    format: args.logFormat,
    level: args.logLevel,
    stream,
  }).child({ command, component: "cli" });
}

function loginStatusLogger(writeSecretsToStdout: boolean): Logger {
  if (writeSecretsToStdout) {
    return {
      error: (message) => console.error(message),
      info: (message) => console.error(message),
      warn: (message) => console.error(message),
    };
  }
  return {
    error: (message) => console.error(message),
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
  };
}

function helpText(version: string): string {
  return `hoopilot ${version}

OpenAI-compatible proxy for GitHub Copilot.

Usage:
  hoopilot [serve] [options]
  hoopilot codexx [codex options] [prompt]
  hoopilot login [options]
  hoopilot models [options]
  hoopilot usage [options]
  hoopilot update
  npx @openhoo/hoopilot [options]

Commands:
  serve                             Start the proxy server (default)
  codexx                            Run Codex through the local Hoopilot server
  login                             Sign in through GitHub OAuth in a browser and verify Copilot access
  models                            List available GitHub Copilot model IDs
  usage                             Show GitHub Copilot quota and premium-request usage
  update, upgrade                   Update hoopilot to the latest release

While the server runs, GET /metrics exposes Prometheus metrics (request counts,
token usage, latency) and GET /v1/usage returns those metrics plus live Copilot
quota as JSON. Open GET /dashboard in a browser for a live usage and status view.

Options:
  -p, --port <port>                 Port to listen on. Default: 4141
      --host <host>                 Host to listen on. Default: 127.0.0.1
      --api-key <key>               Require clients to send Authorization: Bearer <key> or x-api-key: <key>
      --api-key-file <path>         Read the local API key from a file instead of argv
      --auth-file <path>            OAuth credential store path
      --copilot-api-base-url <url>  Copilot API base URL override
      --print-key                   Login: print the received OAuth token to stdout
      --log-level <level>           trace, debug, info, warn, error, fatal, or silent
      --log-format <format>         json or pretty. Default: pretty
      --stream-mode <mode>          auto, live, or buffer. Auto buffers Windows standalone streams.
      --no-update-check             Do not check GitHub for a newer release
      --allow-unauthenticated       Allow non-loopback bind without --api-key
  -h, --help                        Show help
  -v, --version                     Show version

Environment:
  HOOPILOT_API_KEY
  HOOPILOT_AUTH_FILE
  HOOPILOT_GITHUB_CLIENT_ID
  HOOPILOT_GITHUB_DOMAIN
  HOOPILOT_LOG_FORMAT               json or pretty. Default: pretty
  HOOPILOT_LOG_LEVEL                trace, debug, info, warn, error, fatal, or silent
  HOOPILOT_STREAM_MODE              auto, live, or buffer
  COPILOT_API_BASE_URL
  HOOPILOT_GITHUB_API_BASE_URL      GitHub REST base for the usage/quota lookup. Default: https://api.github.com
  HOOPILOT_ALLOW_UNSAFE_UPSTREAM    Set to 1 to allow nonstandard HTTPS token hosts
  HOOPILOT_NO_UPDATE_CHECK          Set to disable update checks (also NO_UPDATE_NOTIFIER)
`;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
