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
  itemId?: string;
  name: string;
  outputIndex?: number;
}

export class OpenAICompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAICompatibilityError";
  }
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
  assertSupportedLegacyCompletionRequest(request);
  return removeUndefined({
    frequency_penalty: request.frequency_penalty,
    logit_bias: request.logit_bias,
    max_tokens: request.max_tokens,
    messages: [{ content: legacyPromptToText(request.prompt), role: "user" }],
    model: normalizeRequestedModel(request.model),
    n: request.n,
    presence_penalty: request.presence_penalty,
    seed: request.seed,
    stop: request.stop,
    stream: request.stream === true,
    stream_options: request.stream_options,
    temperature: request.temperature,
    top_p: request.top_p,
    user: request.user,
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
  return removeUndefined({
    choices: completionChoices(completion).map((choice, index) => {
      const message = asRecord(choice.message);
      return {
        finish_reason: choice.finish_reason ?? "stop",
        index: typeof choice.index === "number" ? choice.index : index,
        logprobs: choice.logprobs ?? null,
        text: contentToText(choice.text) || contentToText(message.content),
      };
    }),
    created: completion.created ?? epochSeconds(),
    id: completion.id ?? `cmpl_${randomId()}`,
    model: completion.model ?? DEFAULT_MODEL,
    object: "text_completion",
    system_fingerprint: completion.system_fingerprint,
    usage: completion.usage,
  });
}

export function completionStreamFromChatStream(
  chatStream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminalEvent = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (data: JsonObject | "[DONE]") => {
        controller.enqueue(encoder.encode(encodeDataSse(data)));
      };
      const markTerminal = () => {
        sawTerminalEvent = true;
      };
      const reader = chatStream.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          buffer += decoder.decode(result.value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            processCompletionSseBlock(block, enqueue, markTerminal);
          }
        }
        const tail = `${buffer}${decoder.decode()}`;
        if (tail.trim()) {
          processCompletionSseBlock(tail, enqueue, markTerminal);
        }
        if (!sawTerminalEvent) {
          enqueue("[DONE]");
        }
        controller.close();
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export function completionSseTextFromChatSseText(text: string): string {
  const chunks: string[] = [];
  let sawTerminalEvent = false;
  const enqueue = (data: JsonObject | "[DONE]") => {
    chunks.push(encodeDataSse(data));
  };
  const markTerminal = () => {
    sawTerminalEvent = true;
  };

  for (const block of text.split(/\r?\n\r?\n/)) {
    if (block.trim()) {
      processCompletionSseBlock(block, enqueue, markTerminal);
    }
  }
  if (!sawTerminalEvent) {
    enqueue("[DONE]");
  }
  return chunks.join("");
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
  let messageOutputIndex: number | undefined;
  let nextOutputIndex = 0;
  let sequenceNumber = 0;
  const tools = new Map<number, AccumulatedToolCall>();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: string, data: JsonObject | "[DONE]") => {
        controller.enqueue(
          encoder.encode(
            encodeSse(
              event,
              data === "[DONE]" ? data : { ...data, sequence_number: sequenceNumber++ },
            ),
          ),
        );
      };

      enqueue("response.created", {
        response: baseStreamResponse(responseId, options.model, createdAt, "in_progress", []),
        type: "response.created",
      });

      const ensureMessageStarted = () => {
        if (messageOutputIndex !== undefined) {
          return;
        }
        messageOutputIndex = nextOutputIndex++;
        enqueue("response.output_item.added", {
          item: {
            content: [],
            id: messageId,
            role: "assistant",
            status: "in_progress",
            type: "message",
          },
          output_index: messageOutputIndex,
          type: "response.output_item.added",
        });
        enqueue("response.content_part.added", {
          content_index: 0,
          item_id: messageId,
          output_index: messageOutputIndex,
          part: {
            annotations: [],
            text: "",
            type: "output_text",
          },
          type: "response.content_part.added",
        });
      };

      const appendText = (delta: string) => {
        ensureMessageStarted();
        text += delta;
        enqueue("response.output_text.delta", {
          content_index: 0,
          delta,
          item_id: messageId,
          output_index: messageOutputIndex ?? 0,
          type: "response.output_text.delta",
        });
      };

      const appendToolCall = (toolCall: JsonObject) => {
        const fn = asRecord(toolCall.function);
        const index = typeof toolCall.index === "number" ? toolCall.index : tools.size;
        let existing = tools.get(index);
        const isNew = !existing;
        existing ??= {
          arguments: "",
          id: contentToText(toolCall.id) || `call_${randomId()}`,
          index,
          itemId: `fc_${randomId()}`,
          name: "",
          outputIndex: nextOutputIndex++,
        };
        existing.id = contentToText(toolCall.id) || existing.id;
        existing.name += contentToText(fn.name);
        tools.set(index, existing);

        if (isNew) {
          enqueue("response.output_item.added", {
            item: functionCallItem(existing, "in_progress"),
            output_index: existing.outputIndex ?? 0,
            type: "response.output_item.added",
          });
        }

        const argumentDelta = contentToText(fn.arguments);
        if (argumentDelta) {
          existing.arguments += argumentDelta;
          enqueue("response.function_call_arguments.delta", {
            delta: argumentDelta,
            item_id: existing.itemId,
            output_index: existing.outputIndex ?? 0,
            type: "response.function_call_arguments.delta",
          });
        }
      };

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
            processChatSseLine(line, { appendText, appendToolCall });
          }
        }
        if (buffer) {
          processChatSseLine(buffer, { appendText, appendToolCall });
        }

        // Build the output items once so the ids emitted in the per-tool stream
        // events match the ids embedded in the final response.completed payload.
        const outputEntries: Array<[number, JsonObject]> = [];
        if (messageOutputIndex !== undefined) {
          const item = messageOutputItem(text, messageId);
          outputEntries.push([messageOutputIndex, item]);
          enqueue("response.output_text.done", {
            content_index: 0,
            item_id: messageId,
            output_index: messageOutputIndex,
            text,
            type: "response.output_text.done",
          });
          enqueue("response.content_part.done", {
            content_index: 0,
            item_id: messageId,
            output_index: messageOutputIndex,
            part: {
              annotations: [],
              text,
              type: "output_text",
            },
            type: "response.content_part.done",
          });
          enqueue("response.output_item.done", {
            item,
            output_index: messageOutputIndex,
            type: "response.output_item.done",
          });
        }

        for (const tool of [...tools.values()].sort(
          (a, b) => (a.outputIndex ?? 0) - (b.outputIndex ?? 0),
        )) {
          const item = functionCallItem(tool);
          const outputIndex = tool.outputIndex ?? 0;
          outputEntries.push([outputIndex, item]);
          enqueue("response.function_call_arguments.done", {
            arguments: tool.arguments,
            item_id: item.id,
            output_index: outputIndex,
            type: "response.function_call_arguments.done",
          });
          enqueue("response.output_item.done", {
            item,
            output_index: outputIndex,
            type: "response.output_item.done",
          });
        }

        const output = outputEntries
          .sort(([left], [right]) => left - right)
          .map(([, item]) => item);

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
    const type = contentToText(record.type);
    if (type === "function_call_output") {
      messages.push({
        content: contentToText(record.output),
        role: "tool",
        tool_call_id: contentToText(record.call_id),
      });
      continue;
    }
    if (type === "function_call") {
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
    if (type && type !== "message") {
      unsupportedResponsesFeature(`input item type "${type}"`);
    }
    const role = responsesRoleToChatRole(contentToText(record.role));
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
    if (content === undefined || content === null) {
      return undefined;
    }
    unsupportedResponsesFeature("non-array message content objects");
  }

  const parts: JsonObject[] = [];
  for (const part of content) {
    const record = asRecord(part);
    const type = contentToText(record.type);
    if (type === "input_text" || type === "output_text" || type === "text") {
      parts.push({ text: contentToText(record.text), type: "text" });
      continue;
    }
    if (type === "input_image") {
      if (contentToText(record.file_id)) {
        unsupportedResponsesFeature("input_image file_id parts");
      }
      const imageUrl = contentToText(record.image_url);
      if (!imageUrl) {
        unsupportedResponsesFeature("input_image parts without image_url");
      }
      const image: JsonObject = { url: imageUrl };
      const detail = contentToText(record.detail);
      if (detail) {
        image.detail = detail;
      }
      parts.push({ image_url: image, type: "image_url" });
      continue;
    }
    if (type === "input_file") {
      unsupportedResponsesFeature("input_file parts");
    }
    if (type === "input_audio") {
      unsupportedResponsesFeature("input_audio parts");
    }
    unsupportedResponsesFeature(`content part type "${type || "unknown"}"`);
  }

  if (parts.length === 0) {
    return undefined;
  }
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => contentToText(part.text)).join("\n");
  }
  return parts;
}

function legacyPromptToText(prompt: unknown): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  if (Array.isArray(prompt) && prompt.length === 1 && typeof prompt[0] === "string") {
    return prompt[0];
  }
  throw new OpenAICompatibilityError(
    "Hoopilot legacy completions compatibility supports exactly one string prompt per request.",
  );
}

function assertSupportedLegacyCompletionRequest(request: JsonObject): void {
  if (request.echo === true) {
    throw new OpenAICompatibilityError(
      "Hoopilot legacy completions compatibility does not support echo=true.",
    );
  }
  if (typeof request.best_of === "number" && request.best_of > 1) {
    throw new OpenAICompatibilityError(
      "Hoopilot legacy completions compatibility does not support best_of greater than 1.",
    );
  }
  if (typeof request.logprobs === "number" && request.logprobs > 0) {
    throw new OpenAICompatibilityError(
      "Hoopilot legacy completions compatibility does not support legacy logprobs.",
    );
  }
  if (contentToText(request.suffix)) {
    throw new OpenAICompatibilityError(
      "Hoopilot legacy completions compatibility does not support suffix.",
    );
  }
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

function responsesRoleToChatRole(role: string): string | undefined {
  if (!role) {
    return "user";
  }
  if (
    role === "assistant" ||
    role === "developer" ||
    role === "system" ||
    role === "tool" ||
    role === "user"
  ) {
    return role === "developer" ? "system" : role;
  }
  unsupportedResponsesFeature(`message role "${role}"`);
}

function chatTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const converted = tools.map((tool) => {
    const record = asRecord(tool);
    const type = contentToText(record.type);
    if (type !== "function") {
      unsupportedResponsesFeature(`tool type "${type || "unknown"}"`);
    }
    return {
      function: removeUndefined({
        description: record.description,
        name: record.name,
        parameters: record.parameters,
        strict: record.strict,
      }),
      type: "function",
    };
  });
  return converted.length > 0 ? converted : undefined;
}

function chatToolChoice(toolChoice: unknown): unknown {
  if (typeof toolChoice === "string" || toolChoice === undefined) {
    return toolChoice;
  }
  const record = asRecord(toolChoice);
  const type = contentToText(record.type);
  if (type === "function" && typeof record.name === "string") {
    return { function: { name: record.name }, type: "function" };
  }
  unsupportedResponsesFeature(`tool_choice type "${type || "unknown"}"`);
}

function unsupportedResponsesFeature(feature: string): never {
  throw new OpenAICompatibilityError(
    `Hoopilot Responses-to-chat compatibility does not support ${feature}.`,
  );
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

function functionCallItem(
  tool: AccumulatedToolCall,
  status: "in_progress" | "completed" = "completed",
): JsonObject {
  return {
    arguments: tool.arguments,
    call_id: tool.id,
    id: tool.itemId ?? `fc_${randomId()}`,
    name: tool.name,
    status,
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
  const inputTokens = record.prompt_tokens;
  const outputTokens = record.completion_tokens;
  return removeUndefined({
    input_tokens: inputTokens,
    input_tokens_details: responseUsageDetails(record.prompt_tokens_details, inputTokens, {
      cached_tokens: 0,
    }),
    output_tokens: outputTokens,
    output_tokens_details: responseUsageDetails(record.completion_tokens_details, outputTokens, {
      reasoning_tokens: 0,
    }),
    total_tokens: record.total_tokens,
  });
}

function responseUsageDetails(
  value: unknown,
  tokenCount: unknown,
  fallback: JsonObject,
): JsonObject | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length > 0) {
    return record;
  }
  return typeof tokenCount === "number" && Number.isFinite(tokenCount) ? fallback : undefined;
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
  return completionChoices(completion)[0] ?? {};
}

function completionChoices(completion: JsonObject): Array<Record<string, unknown>> {
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  return choices.map((choice) => asRecord(choice));
}

function processCompletionSseBlock(
  block: string,
  enqueue: (data: JsonObject | "[DONE]") => void,
  markTerminal: () => void,
): void {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("event:")) {
      event = trimmed.slice("event:".length).trim() || event;
    } else if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice("data:".length).trim());
    }
  }
  const data = dataLines.join("\n");
  if (!data) {
    return;
  }
  if (data === "[DONE]") {
    markTerminal();
    enqueue("[DONE]");
    return;
  }

  const parsed = parseJson(data);
  if (!parsed) {
    return;
  }
  const error = completionStreamError(event, parsed);
  if (error) {
    markTerminal();
    enqueue({ error });
    return;
  }
  const choices = completionChoices(parsed)
    .map((choice, index) => {
      const delta = asRecord(choice.delta);
      const text = contentToText(delta.content);
      const finishReason = choice.finish_reason ?? null;
      if (!text && finishReason === null) {
        return undefined;
      }
      return {
        finish_reason: finishReason,
        index: typeof choice.index === "number" ? choice.index : index,
        logprobs: choice.logprobs ?? null,
        text,
      };
    })
    .filter((choice) => choice !== undefined);
  const usage = asRecord(parsed.usage);
  const hasUsage = Object.keys(usage).length > 0;
  if (choices.length === 0 && !hasUsage) {
    return;
  }

  enqueue(
    removeUndefined({
      choices,
      created: typeof parsed.created === "number" ? parsed.created : epochSeconds(),
      id: contentToText(parsed.id) || `cmpl_${randomId()}`,
      model: contentToText(parsed.model) || DEFAULT_MODEL,
      object: "text_completion",
      usage: hasUsage ? usage : undefined,
    }),
  );
}

function completionStreamError(event: string, parsed: JsonObject): JsonObject | undefined {
  const responseError = asRecord(asRecord(parsed.response).error);
  const directError = asRecord(parsed.error);
  const error =
    Object.keys(directError).length > 0
      ? directError
      : Object.keys(responseError).length > 0
        ? responseError
        : undefined;
  if (error) {
    return error;
  }
  if (event === "error" || parsed.type === "response.failed") {
    return removeUndefined({
      code: contentToText(parsed.code) || undefined,
      message: contentToText(parsed.message) || "Upstream streaming request failed.",
      type: contentToText(parsed.type) || "upstream_stream_error",
    });
  }
  return undefined;
}

function processChatSseLine(
  line: string,
  handlers: {
    appendText: (delta: string) => void;
    appendToolCall: (toolCall: JsonObject) => void;
  },
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
    handlers.appendText(content);
  }

  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const toolCall of toolCalls) {
    handlers.appendToolCall(asRecord(toolCall));
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

function encodeDataSse(data: JsonObject | "[DONE]"): string {
  if (data === "[DONE]") {
    return "data: [DONE]\n\n";
  }
  return `data: ${JSON.stringify(data)}\n\n`;
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
