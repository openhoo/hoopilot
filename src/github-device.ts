import { setTimeout as sleep } from "node:timers/promises";
import type { FetchLike, Logger } from "./types";

export const DEFAULT_GITHUB_COPILOT_CLIENT_ID = "Iv23lijnNxm2e9UX3CF8";
const DEFAULT_GITHUB_DOMAIN = "github.com";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const POLLING_SAFETY_MARGIN_MS = 3_000;

export interface GithubCopilotDeviceLoginOptions {
  clientId?: string;
  domain?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  logger?: Logger;
  openBrowser?: (url: string) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface GithubCopilotDeviceLoginResult {
  domain: string;
  token: string;
}

interface DeviceCodeResponse {
  device_code?: string;
  expires_in?: number;
  interval?: number;
  user_code?: string;
  verification_uri?: string;
}

interface DeviceTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

export async function githubCopilotDeviceLogin(
  options: GithubCopilotDeviceLoginOptions = {},
): Promise<GithubCopilotDeviceLoginResult> {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? fetch;
  const sleeper = options.sleep ?? sleep;
  const domain = normalizeDomain(
    options.domain ?? env.HOOPILOT_GITHUB_DOMAIN ?? DEFAULT_GITHUB_DOMAIN,
  );
  const clientId =
    options.clientId ??
    env.HOOPILOT_GITHUB_CLIENT_ID ??
    env.COPILOT_GITHUB_CLIENT_ID ??
    DEFAULT_GITHUB_COPILOT_CLIENT_ID;

  const device = await requestDeviceCode(fetcher, domain, clientId);
  const verificationUrl = device.verification_uri;
  const userCode = device.user_code;
  const deviceCode = device.device_code;
  if (!verificationUrl || !userCode || !deviceCode) {
    throw new Error("GitHub device authorization response is missing required fields.");
  }

  options.logger?.info(`First copy your one-time code: ${userCode}`);
  options.logger?.info(`Open ${verificationUrl} in your browser to authorize Hoopilot.`);
  await options.openBrowser?.(verificationUrl);

  return {
    domain,
    token: await pollForAccessToken(fetcher, sleeper, domain, clientId, {
      deviceCode,
      expiresIn: positiveSeconds(device.expires_in, 900),
      interval: positiveSeconds(device.interval, 5),
    }),
  };
}

async function requestDeviceCode(
  fetcher: FetchLike,
  domain: string,
  clientId: string,
): Promise<DeviceCodeResponse> {
  const response = await fetcher(`https://${domain}/login/device/code`, {
    body: JSON.stringify({
      client_id: clientId,
      scope: "read:user",
    }),
    headers: oauthHeaders(),
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `GitHub device authorization failed with ${response.status}: ${await safeResponseText(
        response,
      )}`,
    );
  }
  return (await response.json()) as DeviceCodeResponse;
}

async function pollForAccessToken(
  fetcher: FetchLike,
  sleeper: (ms: number) => Promise<void>,
  domain: string,
  clientId: string,
  device: { deviceCode: string; expiresIn: number; interval: number },
): Promise<string> {
  let intervalMs = device.interval * 1000 + POLLING_SAFETY_MARGIN_MS;
  const deadline = Date.now() + device.expiresIn * 1000;

  while (Date.now() < deadline) {
    await sleeper(intervalMs);
    const response = await fetcher(`https://${domain}/login/oauth/access_token`, {
      body: JSON.stringify({
        client_id: clientId,
        device_code: device.deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      }),
      headers: oauthHeaders(),
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(
        `GitHub device token exchange failed with ${response.status}: ${await safeResponseText(
          response,
        )}`,
      );
    }

    const data = (await response.json()) as DeviceTokenResponse;
    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === "authorization_pending") {
      continue;
    }
    if (data.error === "slow_down") {
      intervalMs =
        positiveSeconds(data.interval, device.interval + 5) * 1000 + POLLING_SAFETY_MARGIN_MS;
      continue;
    }
    if (data.error === "expired_token") {
      throw new Error("GitHub device login expired. Run `hoopilot login` again.");
    }
    if (data.error === "access_denied") {
      throw new Error("GitHub device login was cancelled.");
    }
    if (data.error) {
      throw new Error(data.error_description || `GitHub device login failed: ${data.error}`);
    }
  }

  throw new Error("GitHub device login timed out. Run `hoopilot login` again.");
}

function oauthHeaders(): Headers {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  headers.set("user-agent", "hoopilot");
  return headers;
}

function normalizeDomain(value: string): string {
  return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

async function safeResponseText(response: Response): Promise<string> {
  const text = await response.text();
  return text.slice(0, 500);
}
