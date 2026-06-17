#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { CopilotAuthError, DEFAULT_COPILOT_API_BASE_URL } from "./auth";
import { authStorePath, writeStoredCopilotAuth } from "./auth-store";
import { main as codexxMain } from "./codexx";
import { applyCopilotHeaders, CopilotClient, normalizeCopilotUsage } from "./copilot";
import { githubCopilotDeviceLogin } from "./github-device";
import { createHoopilotLogger, noopLogger, parseLogFormat, parseLogLevel } from "./logger";
import { startHoopilotServer } from "./server";
import type {
  CopilotAccess,
  CopilotQuota,
  CopilotUsage,
  FetchLike,
  HoopilotLogger,
  HoopilotServerOptions,
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
  version?: boolean;
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
    args.logger = commandLogger(args, "login");
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

async function runLogin(options: HoopilotServerOptions = {}): Promise<void> {
  const logger = options.logger?.child({ component: "auth" }) ?? noopLogger;
  logger.debug({ event: "auth.login.started" }, "starting github copilot browser login");
  console.log("Starting GitHub Copilot browser login...");
  const login = await githubCopilotDeviceLogin({
    env: options.env,
    logger: console,
    openBrowser: openBrowserBestEffort,
  });

  console.log("Checking GitHub Copilot access...");
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
  console.log(`Copilot OAuth credential stored at ${path}`);
  console.log("Copilot authentication ready.");
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

  const usage = normalizeCopilotUsage(await response.json().catch(() => ({})));
  logger.debug(
    { event: "usage.fetch.succeeded", plan: usage.plan },
    "github copilot quota fetched",
  );
  for (const line of formatCopilotUsage(usage)) {
    console.log(line);
  }
  return usage;
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

function commandLogger(args: ParsedArgs, command: string): HoopilotLogger {
  return createHoopilotLogger({
    env: args.env,
    format: args.logFormat,
    level: args.logLevel,
  }).child({ command, component: "cli" });
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
quota as JSON.

Options:
  -p, --port <port>                 Port to listen on. Default: 4141
      --host <host>                 Host to listen on. Default: 127.0.0.1
      --api-key <key>               Require clients to send Authorization: Bearer <key> or x-api-key: <key>
      --api-key-file <path>         Read the local API key from a file instead of argv
      --auth-file <path>            OAuth credential store path
      --copilot-api-base-url <url>  Copilot API base URL override
      --log-level <level>           trace, debug, info, warn, error, fatal, or silent
      --log-format <format>         json or pretty. Default: pretty
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
