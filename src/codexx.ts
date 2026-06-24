#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { FetchLike } from "./types";
import {
  envValue,
  errorMessage,
  modelIdsFromResponse,
  trimTrailingSlash,
  truncatedResponseText,
} from "./util";

const DEFAULT_BASE_URL = "http://127.0.0.1:4141/v1";
const DEFAULT_CODEX_BIN = "codex";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT = "xhigh";
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
  baseUrl: string;
  command: string;
  env: NodeJS.ProcessEnv;
  model: string;
}

export function buildCodexxInvocation(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CodexxInvocation {
  const baseUrl = envValue(env.CODEXX_BASE_URL) ?? DEFAULT_BASE_URL;
  // Never fall back to a public, predictable key: a shared constant like the old
  // "local-key" default is also a credential a malicious local/browser client
  // could guess. When no key is configured the local server is expected to run
  // unauthenticated, which accepts any value, so a random throwaway key is safe.
  const apiKey =
    envValue(env.CODEXX_API_KEY) ?? envValue(env.HOOPILOT_API_KEY) ?? generateEphemeralApiKey();
  const command = envValue(env.CODEXX_CODEX_BIN) ?? DEFAULT_CODEX_BIN;
  const model = envValue(env.CODEXX_MODEL) ?? DEFAULT_MODEL;
  const reasoningEffort = envValue(env.CODEXX_MODEL_REASONING_EFFORT) ?? DEFAULT_REASONING_EFFORT;
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
      "-m",
      model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
      ...argv,
    ],
    baseUrl,
    command,
    env: withoutProxyEnv({
      ...env,
      OPENAI_API_KEY: apiKey,
    }),
    model,
  };
}

// A random, non-guessable placeholder key for when neither CODEXX_API_KEY nor
// HOOPILOT_API_KEY is set. An unauthenticated local Hoopilot accepts any value;
// a keyed server rejects it with a 401, which the model preflight surfaces.
function generateEphemeralApiKey(): string {
  return `codexx-${crypto.randomUUID()}`;
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
  if (env.CODEXX_SKIP_MODEL_PREFLIGHT !== "1") {
    await verifyCodexxModel(invocation);
  }
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

export async function verifyCodexxModel(
  invocation: Pick<CodexxInvocation, "baseUrl" | "env" | "model">,
  fetcher: FetchLike = fetch,
): Promise<void> {
  const modelsUrl = `${trimTrailingSlash(invocation.baseUrl)}/models`;
  const apiKey = invocation.env.OPENAI_API_KEY;
  if (apiKey === undefined) {
    throw new Error(
      "verifyCodexxModel requires invocation.env.OPENAI_API_KEY; build the invocation with buildCodexxInvocation.",
    );
  }
  let response: Response;
  try {
    response = await fetcher(modelsUrl, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      method: "GET",
    });
  } catch (error) {
    throw new Error(
      `Could not reach Hoopilot at ${modelsUrl}. Start Hoopilot first, or set CODEXX_SKIP_MODEL_PREFLIGHT=1 to skip this check. ${errorMessage(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Could not verify model ${JSON.stringify(invocation.model)} because ${modelsUrl} returned ${response.status}: ${await truncatedResponseText(response)}`,
    );
  }

  const models = modelIdsFromResponse(await response.json().catch(() => undefined));
  if (models.length > 0 && !models.includes(invocation.model)) {
    throw new Error(
      `The logged-in Copilot account does not advertise model ${JSON.stringify(invocation.model)} at ${modelsUrl}. Available models: ${models.join(", ")}. After upgrading Hoopilot, rerun "hoopilot login" to refresh the Copilot OAuth token, or set CODEXX_MODEL to one of the advertised model IDs.`,
    );
  }
}

function helpText(): string {
  return `codexx

Run Codex against an already-running local Hoopilot server.

Usage:
  codexx [codex options] [prompt]

Environment:
  CODEXX_BASE_URL      OpenAI-compatible base URL. Default: ${DEFAULT_BASE_URL}
  CODEXX_API_KEY       API key sent to the local Hoopilot server.
  HOOPILOT_API_KEY     Used as the API key when CODEXX_API_KEY is unset. When
                       neither is set, a random throwaway key is generated for
                       an unauthenticated local server.
  CODEXX_CODEX_BIN     Codex executable to run. Default: ${DEFAULT_CODEX_BIN}
  CODEXX_MODEL         Codex model to use. Default: ${DEFAULT_MODEL}
  CODEXX_MODEL_REASONING_EFFORT
                       Codex reasoning effort. Default: ${DEFAULT_REASONING_EFFORT}
  CODEXX_SKIP_MODEL_PREFLIGHT
                       Set to 1 to skip checking /v1/models before starting Codex.

codexx does not start Hoopilot and does not change your shell environment. It selects a temporary Hoopilot model provider with Responses WebSockets disabled, uses ${DEFAULT_MODEL} with ${DEFAULT_REASONING_EFFORT} reasoning by default, disables Codex's network_proxy feature, and removes proxy variables only from the spawned Codex process.`;
}

function signalNumber(signal: NodeJS.Signals): number {
  return osConstants.signals[signal] ?? 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}
