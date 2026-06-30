import type { JsonObject } from "../types";

const INVALID_JSON_MESSAGE = "Request body must be valid JSON.";
const JSON_OBJECT_MESSAGE = "Request body must be a JSON object.";
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const REQUEST_TOO_LARGE_MESSAGE = `Request body must be ${MAX_REQUEST_BODY_BYTES} bytes or smaller.`;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super(REQUEST_TOO_LARGE_MESSAGE);
    this.name = "RequestBodyTooLargeError";
  }
}

export class InvalidJsonError extends Error {
  constructor() {
    super(INVALID_JSON_MESSAGE);
    this.name = "InvalidJsonError";
  }
}

export class JsonNotObjectError extends Error {
  constructor() {
    super(JSON_OBJECT_MESSAGE);
    this.name = "JsonNotObjectError";
  }
}

export async function readJson(request: Request): Promise<JsonObject> {
  const text = await readRequestText(request);
  return parseJsonObject(text);
}

export async function readJsonText(request: Request): Promise<{ json: JsonObject; text: string }> {
  const text = await readRequestText(request);
  return { json: parseJsonObject(text), text };
}

async function readRequestText(request: Request): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
  }

  const body = request.body;
  if (!body) {
    return "";
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  const chunks: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
        }
        return chunks.join("");
      }
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

function parseJsonObject(text: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidJsonError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JsonNotObjectError();
  }
  return parsed as JsonObject;
}
