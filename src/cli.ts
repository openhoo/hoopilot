#!/usr/bin/env bun

import { startHoopilotServer } from "./server";
import type { AuthMode, HoopilotServerOptions } from "./types";

interface ParsedArgs extends HoopilotServerOptions {
  help?: boolean;
  version?: boolean;
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(helpText(await packageVersion()));
    return;
  }
  if (args.version) {
    console.log(await packageVersion());
    return;
  }

  const started = startHoopilotServer(args);
  console.log(`hoopilot listening on ${started.url}`);
  console.log(`OpenAI base URL: ${started.url}/v1`);
  console.log("Use Ctrl+C to stop.");
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
    if (arg === "--no-gh") {
      args.githubTokenCommand = false;
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
      case "--auth-mode":
        args.authMode = parseAuthMode(value);
        break;
      case "--copilot-api-base-url":
        args.copilotApiBaseUrl = value;
        break;
      case "--copilot-token":
        args.copilotToken = value;
        break;
      case "--github-token":
        args.githubToken = value;
        break;
      case "--github-token-command":
        args.githubTokenCommand = value;
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

function parseAuthMode(value: string): AuthMode {
  if (
    value === "auto" ||
    value === "copilot-token" ||
    value === "github-token" ||
    value === "direct-github-token"
  ) {
    return value;
  }
  throw new Error(`Invalid auth mode: ${value}.`);
}

async function packageVersion(): Promise<string> {
  try {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function helpText(version: string): string {
  return `hoopilot ${version}

OpenAI-compatible proxy for GitHub Copilot.

Usage:
  hoopilot [serve] [options]
  npx @openhoo/hoopilot [options]

Options:
  -p, --port <port>                 Port to listen on. Default: 4141
      --host <host>                 Host to listen on. Default: 127.0.0.1
      --api-key <key>               Require clients to send Authorization: Bearer <key>
      --auth-mode <mode>            auto, github-token, direct-github-token, copilot-token
      --github-token <token>        GitHub OAuth token for a Copilot account
      --github-token-command <cmd>  Command used to read a GitHub token. Default: gh auth token
      --copilot-token <token>       Short-lived Copilot API bearer token
      --copilot-api-base-url <url>  Copilot API base URL override
      --no-gh                       Do not try gh auth token
      --allow-unauthenticated       Allow non-loopback bind without --api-key
  -h, --help                        Show help
  -v, --version                     Show version

Environment:
  HOOPILOT_API_KEY
  COPILOT_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN
  COPILOT_API_TOKEN, GITHUB_COPILOT_API_TOKEN
  COPILOT_API_BASE_URL
`;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
