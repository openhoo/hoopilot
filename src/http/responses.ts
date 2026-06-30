import { asRecord, safeJsonParse } from "../util";
import { corsHeaders } from "./security";

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;
const STALE_BODY_HEADERS = ["content-encoding", "content-length"] as const;

export function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });
}

export function textResponse(body: string, contentType: string, status = 200): Response {
  return new Response(body, {
    headers: {
      ...corsHeaders(),
      "content-type": `${contentType}; charset=utf-8`,
    },
    status,
  });
}

export function jsonError(status: number, code: string, message: string): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        type: code,
      },
    },
    status,
  );
}

export function responseFromText(source: Response, text: string): Response {
  return new Response(text, {
    headers: source.headers,
    status: source.status,
    statusText: source.statusText,
  });
}

export function proxyResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  stripProxyUnsafeHeaders(headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(upstream.body, {
    headers,
    status: upstream.status,
    statusText: upstream.statusText,
  });
}

export function upstreamErrorResponse(status: number, text: string): Response {
  const parsedError = asRecord(asRecord(safeJsonParse(text)).error);
  if (Object.keys(parsedError).length > 0) {
    return jsonResponse({ error: parsedError }, status);
  }
  return jsonError(status, "copilot_error", text);
}

export function websocketUnsupportedResponse(): Response {
  const response = jsonError(
    426,
    "websocket_not_supported",
    "Hoopilot does not support Responses WebSocket transport; retry with HTTP Responses API.",
  );
  response.headers.set("upgrade", "websocket");
  return response;
}

function stripProxyUnsafeHeaders(headers: Headers): void {
  const connection = headers.get("connection");
  if (connection) {
    for (const name of connection.split(",")) {
      const trimmed = name.trim();
      if (trimmed) {
        headers.delete(trimmed);
      }
    }
  }
  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }
  for (const name of STALE_BODY_HEADERS) {
    headers.delete(name);
  }
}
