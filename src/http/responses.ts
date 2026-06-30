import { asRecord, safeJsonParse } from "../util";
import { corsHeaders } from "./security";

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
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
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
