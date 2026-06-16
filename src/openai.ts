import type { JsonObject, TokenUsage } from "./types";
import { asRecord } from "./util";

export const DEFAULT_MODEL = "gpt-4.1";

interface ResponseStreamOptions {
  model: string;
  responseId?: string;
}

interface AccumulatedToolCall {
  arguments: string;
  id: string;
  index: number;
  name: string;
}

export function responsesRequestToChatCompletion(request: JsonObject): JsonObject {
  const messages: unknown[] = [];
  const instructions = contentToText(request.instructions);
  if (instructions) {
    messages.push({ content: instructions, role: "system" });
  }

  for (const message of inputToMessages(request.input)) {
    messages.push(message);
  }

  return removeUndefined({
    frequency_penalty: request.frequency_penalty,
    max_tokens: request.max_output_tokens ?? request.max_tokens,
    messages,
    metadata: request.metadata,
    model: normalizeRequestedModel(request.model),
    presence_penalty: request.presence_penalty,
    reasoning_effort: asRecord(request.reasoning).effort,
    response_format: asRecord(request.text).format,
    seed: request.seed,
    stream: request.stream === true,
    temperature: request.temperature,
    tool_choice: chatToolChoice(request.tool_choice),
    tools: chatTools(request.tools),
    top_p: request.top_p,
  });
}

export function normalizeChatCompletionRequest(request: JsonObject): JsonObject {
  return removeUndefined({
    ...request,
    model: normalizeRequestedModel(request.model),
  });
}

export function completionsRequestToChatCompletion(request: JsonObject): JsonObject {
  return removeUndefined({
    max_tokens: request.max_tokens,
    messages: [{ content: promptToText(request.prompt), role: "user" }],
    model: normalizeRequestedModel(request.model),
    stream: request.stream === true,
    temperature: request.temperature,
    top_p: request.top_p,
  });
}

export function normalizeRequestedModel(model: unknown): string {
  const requested = contentToText(model).trim();
  return requested || DEFAULT_MODEL;
}

export function chatCompletionToResponse(completion: JsonObject, responseId?: string): JsonObject {
  const id = responseId ?? `resp_${randomId()}`;
  const choice = firstChoice(completion);
  const message = asRecord(choice.message);
  const model = contentToText(completion.model) || DEFAULT_MODEL;
  const output = outputItemsFromMessage(message);
  const usage = responseUsage(completion.usage);

  return removeUndefined({
    created_at: epochSeconds(),
    error: null,
    id,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    metadata: {},
    model,
    object: "response",
    output,
    output_text: outputText(output),
    parallel_tool_calls: true,
    status: "completed",
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    usage,
  });
}

export function chatCompletionToCompletion(completion: JsonObject): JsonObject {
  const choice = firstChoice(completion);
  const message = asRecord(choice.message);
  return removeUndefined({
    choices: [
      {
        finish_reason: choice.finish_reason ?? "stop",
        index: 0,
        logprobs: null,
        text: contentToText(message.content),
      },
    ],
    created: completion.created ?? epochSeconds(),
    id: completion.id ?? `cmpl_${randomId()}`,
    model: completion.model ?? DEFAULT_MODEL,
    object: "text_completion",
    usage: completion.usage,
  });
}

export function normalizeModelsResponse(upstream: unknown): JsonObject {
  const record = asRecord(upstream);
  const data = Array.isArray(record.data) ? record.data : Array.isArray(upstream) ? upstream : [];
  const models = data
    .map((model) => asRecord(model))
    .filter((model) => typeof model.id === "string")
    .map((model) => ({
      created: model.created ?? 0,
      id: model.id,
      object: "model",
      owned_by: model.owned_by ?? "github-copilot",
    }));

  return {
    data: models.length > 0 ? models : fallbackModels(),
    object: "list",
  };
}

export function fallbackModels(): Array<JsonObject> {
  return [
    {
      created: 0,
      id: DEFAULT_MODEL,
      object: "model",
      owned_by: "github-copilot",
    },
  ];
}

export function responsesStreamFromChatStream(
  chatStream: ReadableStream<Uint8Array>,
  options: ResponseStreamOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const responseId = options.responseId ?? `resp_${randomId()}`;
  const messageId = `msg_${randomId()}`;
  const createdAt = epochSeconds();
  let buffer = "";
  let text = "";
  const tools = new Map<number, AccumulatedToolCall>();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: string, data: JsonObject | "[DONE]") => {
        controller.enqueue(encoder.encode(encodeSse(event, data)));
      };

      enqueue("response.created", {
        response: baseStreamResponse(responseId, options.model, createdAt, "in_progress", []),
        type: "response.created",
      });
      enqueue("response.output_item.added", {
        item: {
          content: [],
          id: messageId,
          role: "assistant",
          status: "in_progress",
          type: "message",
        },
        output_index: 0,
        type: "response.output_item.added",
      });
      enqueue("response.content_part.added", {
        content_index: 0,
        item_id: messageId,
        output_index: 0,
        part: {
          annotations: [],
          text: "",
          type: "output_text",
        },
        type: "response.content_part.added",
      });

      const reader = chatStream.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          buffer += decoder.decode(result.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            processChatSseLine(messageId, line, enqueue, tools, (delta) => {
              text += delta;
            });
          }
        }
        if (buffer) {
          processChatSseLine(messageId, buffer, enqueue, tools, (delta) => {
            text += delta;
          });
        }

        // Build the output items once so the ids emitted in the per-tool stream
        // events match the ids embedded in the final response.completed payload.
        const toolItems = [...tools.values()].map(functionCallItem);
        const output = [messageOutputItem(text, messageId), ...toolItems];
        enqueue("response.output_text.done", {
          content_index: 0,
          item_id: messageId,
          output_index: 0,
          text,
          type: "response.output_text.done",
        });
        enqueue("response.content_part.done", {
          content_index: 0,
          item_id: messageId,
          output_index: 0,
          part: {
            annotations: [],
            text,
            type: "output_text",
          },
          type: "response.content_part.done",
        });
        enqueue("response.output_item.done", {
          item: output[0],
          output_index: 0,
          type: "response.output_item.done",
        });

        toolItems.forEach((item, index) => {
          const outputIndex = index + 1;
          enqueue("response.output_item.added", {
            item,
            output_index: outputIndex,
            type: "response.output_item.added",
          });
          enqueue("response.function_call_arguments.done", {
            arguments: item.arguments,
            item_id: item.id,
            output_index: outputIndex,
            type: "response.function_call_arguments.done",
          });
          enqueue("response.output_item.done", {
            item,
            output_index: outputIndex,
            type: "response.output_item.done",
          });
        });

        enqueue("response.completed", {
          response: baseStreamResponse(responseId, options.model, createdAt, "completed", output),
          type: "response.completed",
        });
        enqueue("done", "[DONE]");
        controller.close();
      } catch (error) {
        // Tear down the upstream body so an output-side error/abort cannot leak it.
        await reader.cancel(error).catch(() => {});
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function inputToMessages(input: unknown): unknown[] {
  if (typeof input === "string") {
    return [{ content: input, role: "user" }];
  }
  if (!Array.isArray(input)) {
    return [];
  }

  const messages: unknown[] = [];
  for (const item of input) {
    const record = asRecord(item);
    if (record.type === "function_call_output") {
      messages.push({
        content: contentToText(record.output),
        role: "tool",
        tool_call_id: contentToText(record.call_id),
      });
      continue;
    }
    if (record.type === "function_call") {
      messages.push({
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: contentToText(record.arguments),
              name: contentToText(record.name),
            },
            id: contentToText(record.call_id) || contentToText(record.id),
            type: "function",
          },
        ],
      });
      continue;
    }
    const role = roleToChatRole(contentToText(record.role));
    const content = chatMessageContent(record.content);
    if (role && content !== undefined) {
      messages.push({ content, role });
    }
  }
  return messages;
}

function chatMessageContent(content: unknown): string | Array<JsonObject> | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return contentToText(content) || undefined;
  }

  const parts: JsonObject[] = [];
  for (const part of content) {
    const record = asRecord(part);
    const type = contentToText(record.type);
    if (type === "input_text" || type === "output_text" || type === "text") {
      parts.push({ text: contentToText(record.text), type: "text" });
    }
    if (type === "input_image") {
      const imageUrl = contentToText(record.image_url);
      if (imageUrl) {
        parts.push({ image_url: { url: imageUrl }, type: "image_url" });
      }
    }
  }

  if (parts.length === 0) {
    return undefined;
  }
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => contentToText(part.text)).join("\n");
  }
  return parts;
}

function promptToText(prompt: unknown): string {
  if (Array.isArray(prompt)) {
    return prompt.map((item) => contentToText(item)).join("\n");
  }
  return contentToText(prompt);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (typeof content === "number" || typeof content === "boolean") {
    return String(content);
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => contentToText(item))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.output_text === "string") {
      return record.output_text;
    }
    return JSON.stringify(content);
  }
  return "";
}

function roleToChatRole(role: string): string | undefined {
  if (role === "assistant" || role === "developer" || role === "system" || role === "tool") {
    return role === "developer" ? "system" : role;
  }
  return "user";
}

function chatTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const converted = tools
    .map((tool) => asRecord(tool))
    .filter((tool) => tool.type === "function")
    .map((tool) => ({
      function: removeUndefined({
        description: tool.description,
        name: tool.name,
        parameters: tool.parameters,
        strict: tool.strict,
      }),
      type: "function",
    }));
  return converted.length > 0 ? converted : undefined;
}

function chatToolChoice(toolChoice: unknown): unknown {
  if (typeof toolChoice === "string" || toolChoice === undefined) {
    return toolChoice;
  }
  const record = asRecord(toolChoice);
  if (record.type === "function" && typeof record.name === "string") {
    return { function: { name: record.name }, type: "function" };
  }
  return toolChoice;
}

function outputItemsFromMessage(message: Record<string, unknown>): JsonObject[] {
  const output: JsonObject[] = [];
  const text = contentToText(message.content);
  if (text) {
    output.push(messageOutputItem(text));
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    const record = asRecord(toolCall);
    const fn = asRecord(record.function);
    output.push(
      functionCallItem({
        arguments: contentToText(fn.arguments),
        id: contentToText(record.id) || `call_${randomId()}`,
        index: output.length,
        name: contentToText(fn.name),
      }),
    );
  }
  return output;
}

function messageOutputItem(text: string, id = `msg_${randomId()}`): JsonObject {
  return {
    content: [
      {
        annotations: [],
        text,
        type: "output_text",
      },
    ],
    id,
    role: "assistant",
    status: "completed",
    type: "message",
  };
}

function functionCallItem(tool: AccumulatedToolCall): JsonObject {
  return {
    arguments: tool.arguments,
    call_id: tool.id,
    id: `fc_${randomId()}`,
    name: tool.name,
    status: "completed",
    type: "function_call",
  };
}

function outputText(output: JsonObject[]): string {
  return output
    .flatMap((item) => {
      const content = item.content;
      return Array.isArray(content) ? content : [];
    })
    .map((part) => contentToText(asRecord(part).text))
    .filter(Boolean)
    .join("");
}

function responseUsage(usage: unknown): JsonObject | null {
  const record = asRecord(usage);
  if (Object.keys(record).length === 0) {
    return null;
  }
  return removeUndefined({
    input_tokens: record.prompt_tokens,
    input_tokens_details: record.prompt_tokens_details,
    output_tokens: record.completion_tokens,
    output_tokens_details: record.completion_tokens_details,
    total_tokens: record.total_tokens,
  });
}

/**
 * Normalize an upstream `usage` object into {@link TokenUsage}. Accepts both the
 * Chat Completions shape (`prompt_tokens`/`completion_tokens`) and the Responses
 * shape (`input_tokens`/`output_tokens`), and pulls nested reasoning/cached
 * details when present. Returns undefined when no token counts are available so
 * callers can distinguish "no usage reported" from "zero tokens".
 */
export function extractTokenUsage(usage: unknown): TokenUsage | undefined {
  const record = asRecord(usage);
  const prompt = firstNumber(record.prompt_tokens, record.input_tokens);
  const completion = firstNumber(record.completion_tokens, record.output_tokens);
  const total = firstNumber(record.total_tokens);
  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined;
  }
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  const reasoning = firstNumber(
    asRecord(record.completion_tokens_details).reasoning_tokens,
    asRecord(record.output_tokens_details).reasoning_tokens,
  );
  const cached = firstNumber(
    asRecord(record.prompt_tokens_details).cached_tokens,
    asRecord(record.input_tokens_details).cached_tokens,
  );
  return removeUndefined({
    cachedTokens: cached,
    completionTokens,
    promptTokens,
    reasoningTokens: reasoning,
    totalTokens: total ?? promptTokens + completionTokens,
  }) as unknown as TokenUsage;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function firstChoice(completion: JsonObject): Record<string, unknown> {
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  return asRecord(choices[0]);
}

function processChatSseLine(
  messageId: string,
  line: string,
  enqueue: (event: string, data: JsonObject | "[DONE]") => void,
  tools: Map<number, AccumulatedToolCall>,
  appendText: (delta: string) => void,
): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return;
  }
  const data = trimmed.slice("data:".length).trim();
  if (!data || data === "[DONE]") {
    return;
  }

  const parsed = parseJson(data);
  if (!parsed) {
    return;
  }
  const choice = firstChoice(parsed);
  const delta = asRecord(choice.delta);
  const content = contentToText(delta.content);
  if (content) {
    appendText(content);
    enqueue("response.output_text.delta", {
      content_index: 0,
      delta: content,
      item_id: messageId,
      output_index: 0,
      type: "response.output_text.delta",
    });
  }

  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const toolCall of toolCalls) {
    const record = asRecord(toolCall);
    const fn = asRecord(record.function);
    const index = typeof record.index === "number" ? record.index : tools.size;
    const existing = tools.get(index) ?? {
      arguments: "",
      id: contentToText(record.id) || `call_${randomId()}`,
      index,
      name: "",
    };
    existing.id = contentToText(record.id) || existing.id;
    existing.name += contentToText(fn.name);
    existing.arguments += contentToText(fn.arguments);
    tools.set(index, existing);
  }
}

function baseStreamResponse(
  id: string,
  model: string,
  createdAt: number,
  status: "in_progress" | "completed",
  output: JsonObject[],
): JsonObject {
  return {
    created_at: createdAt,
    error: null,
    id,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    metadata: {},
    model,
    object: "response",
    output,
    parallel_tool_calls: true,
    status,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  };
}

function encodeSse(event: string, data: JsonObject | "[DONE]"): string {
  if (data === "[DONE]") {
    return "data: [DONE]\n\n";
  }
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseJson(data: string): JsonObject | undefined {
  try {
    return asRecord(JSON.parse(data));
  } catch {
    return undefined;
  }
}

function removeUndefined(record: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function randomId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
