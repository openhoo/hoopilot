#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

const DEFAULT_BASE_URL = "http://127.0.0.1:4141/v1";
const DEFAULT_API_KEY = "local-key";
const DEFAULT_CODEX_BIN = "codex";
const PROXY_ENV_KEYS = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
];

export interface CodexxInvocation {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
}

export function buildCodexxInvocation(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CodexxInvocation {
  const baseUrl = env.CODEXX_BASE_URL ?? DEFAULT_BASE_URL;
  const apiKey =
    env.CODEXX_API_KEY ?? env.HOOPILOT_API_KEY ?? env.OPENAI_API_KEY ?? DEFAULT_API_KEY;
  const command = env.CODEXX_CODEX_BIN ?? DEFAULT_CODEX_BIN;
  const providerConfig = [
    '{ name = "Hoopilot"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    "supports_websockets = false }",
  ].join(", ");

  return {
    args: [
      "--disable",
      "network_proxy",
      "-c",
      'model_provider="hoopilot"',
      "-c",
      `model_providers.hoopilot=${providerConfig}`,
      ...argv,
    ],
    command,
    env: withoutProxyEnv({
      ...env,
      OPENAI_API_KEY: apiKey,
    }),
  };
}

function withoutProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of PROXY_ENV_KEYS) {
    delete next[key];
  }
  return next;
}

export async function main(argv = Bun.argv.slice(2), env = process.env): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(helpText());
    return;
  }

  const invocation = buildCodexxInvocation(argv, env);
  const child = spawn(invocation.command, invocation.args, {
    env: invocation.env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
        return;
      }
      resolve(signal ? 128 + signalNumber(signal) : 1);
    });
  });

  process.exitCode = exitCode;
}

function helpText(): string {
  return `codexx

Run Codex against an already-running local Hoopilot server.

Usage:
  codexx [codex options] [prompt]

Environment:
  CODEXX_BASE_URL      OpenAI-compatible base URL. Default: ${DEFAULT_BASE_URL}
  CODEXX_API_KEY       API key sent to the local Hoopilot server.
  HOOPILOT_API_KEY     Used as the API key when CODEXX_API_KEY is unset.
  OPENAI_API_KEY       Used as the API key when both CODEXX_API_KEY and HOOPILOT_API_KEY are unset.
  CODEXX_CODEX_BIN     Codex executable to run. Default: ${DEFAULT_CODEX_BIN}

codexx does not start Hoopilot and does not change your shell environment. It selects a temporary Hoopilot model provider with Responses WebSockets disabled, disables Codex's network_proxy feature, and removes proxy variables only from the spawned Codex process.`;
}

function signalNumber(signal: NodeJS.Signals): number {
  return osConstants.signals[signal] ?? 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
