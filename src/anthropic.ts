import { normalizeRequestedModel } from "./openai";
import type { JsonObject } from "./types";
import { asRecord } from "./util";

interface AnthropicStreamOptions {
  model: string;
  messageId?: string;
}

interface StreamBlock {
  index: number;
  sentText: string;
  stopped: boolean;
  type: "text" | "tool_use";
}

interface AnthropicStreamState {
  blocks: Map<string, StreamBlock>;
  completed: boolean;
  messageId: string;
  model: string;
  nextBlockIndex: number;
  sawToolUse: boolean;
  started: boolean;
  usage: JsonObject;
}

export class AnthropicCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicCompatibilityError";
  }
}

export function anthropicMessagesToResponsesRequest(request: JsonObject): JsonObject {
  return removeUndefined({
    input: anthropicMessagesToResponsesInput(request.messages),
    instructions: anthropicSystemToInstructions(request.system),
    max_output_tokens:
      typeof request.max_tokens === "number" && Number.isFinite(request.max_tokens)
        ? request.max_tokens
        : undefined,
    metadata: request.metadata,
    model: normalizeRequestedModel(request.model),
    parallel_tool_calls: true,
    reasoning: anthropicThinkingToReasoning(request.thinking),
    stop: anthropicStopSequences(request.stop_sequences),
    stream: request.stream === true,
    temperature: request.temperature,
    tool_choice: anthropicToolChoice(request.tool_choice),
    tools: anthropicTools(request.tools),
    top_p: request.top_p,
  });
}

export function responsesResponseToAnthropicMessage(
  response: JsonObject,
  fallbackModel: string,
): JsonObject {
  const content = anthropicContentFromResponsesOutput(response);
  const usage = anthropicUsage(response.usage);
  return {
    content,
    id: textValue(response.id) || `msg_${randomId()}`,
    model: textValue(response.model) || fallbackModel,
    role: "assistant",
    stop_reason: anthropicStopReason(response, content),
    stop_sequence: null,
    type: "message",
    usage,
  };
}

export function responsesStreamToAnthropicStream(
  stream: ReadableStream<Uint8Array>,
  options: AnthropicStreamOptions,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state: AnthropicStreamState = {
    blocks: new Map(),
    completed: false,
    messageId: options.messageId ?? `msg_${randomId()}`,
    model: options.model,
    nextBlockIndex: 0,
    sawToolUse: false,
    started: false,
    usage: anthropicUsage(undefined),
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: string, data: JsonObject) => {
        controller.enqueue(encoder.encode(encodeSse(event, data)));
      };
      const reader = stream.getReader();
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
            processResponsesSseBlock(block, state, enqueue);
          }
        }
        const tail = `${buffer}${decoder.decode()}`;
        if (tail.trim()) {
          processResponsesSseBlock(tail, state, enqueue);
        }
        finishAnthropicStream(state, enqueue);
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

export function estimateAnthropicMessageTokens(request: JsonObject): JsonObject {
  const chars =
    estimatedTextSize(request.system) +
    estimatedTextSize(request.messages) +
    estimatedTextSize(request.tools) +
    estimatedTextSize(request.tool_choice) +
    estimatedTextSize(request.thinking);
  const messageCount = Array.isArray(request.messages) ? request.messages.length : 1;
  const toolCount = Array.isArray(request.tools) ? request.tools.length : 0;
  const inputTokens = Math.max(1, Math.ceil(chars / 4) + messageCount * 4 + toolCount * 16);
  return {
    input_tokens: inputTokens,
    total_tokens: inputTokens,
  };
}

function anthropicMessagesToResponsesInput(messages: unknown): JsonObject[] {
  if (!Array.isArray(messages)) {
    throw new AnthropicCompatibilityError("Anthropic Messages requests require messages[].");
  }

  const input: JsonObject[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    const role = anthropicRole(record.role);
    const parts = anthropicContentParts(record.content);
    const messageParts: JsonObject[] = [];
    const flushMessage = () => {
      if (messageParts.length === 0) {
        return;
      }
      input.push({
        content: [...messageParts],
        role,
        type: "message",
      });
      messageParts.length = 0;
    };

    for (const part of parts) {
      const type = textValue(part.type) || "text";
      if (type === "text") {
        const text = textValue(part.text);
        if (text) {
          messageParts.push({
            text,
            type: role === "assistant" ? "output_text" : "input_text",
          });
        }
        continue;
      }
      if (type === "image") {
        if (role !== "user") {
          throw new AnthropicCompatibilityError(
            "Anthropic image content is only supported for user messages.",
          );
        }
        messageParts.push(anthropicImageToResponsesPart(part));
        continue;
      }
      if (type === "tool_use") {
        flushMessage();
        input.push({
          arguments: JSON.stringify(asRecord(part.input)),
          call_id: textValue(part.id) || `call_${randomId()}`,
          name: textValue(part.name),
          type: "function_call",
        });
        continue;
      }
      if (type === "tool_result") {
        flushMessage();
        input.push({
          call_id: textValue(part.tool_use_id),
          output: anthropicToolResultOutput(part.content),
          type: "function_call_output",
        });
        continue;
      }
      if (type === "thinking" || type === "redacted_thinking") {
        continue;
      }
      throw new AnthropicCompatibilityError(
        `Anthropic content block type "${type}" is not supported.`,
      );
    }
    flushMessage();
  }
  return input;
}

function anthropicRole(value: unknown): "assistant" | "user" {
  const role = textValue(value);
  if (role === "assistant" || role === "user") {
    return role;
  }
  if (!role) {
    return "user";
  }
  throw new AnthropicCompatibilityError(`Anthropic message role "${role}" is not supported.`);
}

function anthropicContentParts(content: unknown): JsonObject[] {
  if (typeof content === "string") {
    return [{ text: content, type: "text" }];
  }
  if (Array.isArray(content)) {
    return content.map((part) =>
      typeof part === "string" ? { text: part, type: "text" } : asRecord(part),
    );
  }
  if (content === undefined || content === null) {
    return [];
  }
  return [asRecord(content)];
}

function anthropicImageToResponsesPart(part: JsonObject): JsonObject {
  const source = asRecord(part.source);
  const sourceType = textValue(source.type);
  if (sourceType === "base64") {
    const mediaType = textValue(source.media_type) || "image/png";
    const data = textValue(source.data);
    if (!data) {
      throw new AnthropicCompatibilityError("Anthropic base64 image content requires source.data.");
    }
    return {
      detail: "auto",
      image_url: `data:${mediaType};base64,${data}`,
      type: "input_image",
    };
  }
  if (sourceType === "url") {
    const url = textValue(source.url);
    if (!url) {
      throw new AnthropicCompatibilityError("Anthropic URL image content requires source.url.");
    }
    return {
      detail: "auto",
      image_url: url,
      type: "input_image",
    };
  }
  throw new AnthropicCompatibilityError(
    `Anthropic image source type "${sourceType || "unknown"}" is not supported.`,
  );
}

function anthropicToolResultOutput(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = asRecord(part);
        return textValue(record.text) || textValue(record.content) || JSON.stringify(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content === undefined || content === null) {
    return "";
  }
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

function anthropicSystemToInstructions(system: unknown): string | undefined {
  if (typeof system === "string") {
    return system || undefined;
  }
  if (!Array.isArray(system)) {
    return undefined;
  }
  const text = system
    .map((part) => textValue(asRecord(part).text) || textValue(part))
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function anthropicTools(tools: unknown): JsonObject[] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const converted = tools.map((tool) => {
    const record = asRecord(tool);
    return removeUndefined({
      description: record.description,
      name: record.name,
      parameters: record.input_schema,
      strict: record.strict,
      type: "function",
    });
  });
  return converted.length > 0 ? converted : undefined;
}

function anthropicToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === undefined || toolChoice === null) {
    return undefined;
  }
  const record = asRecord(toolChoice);
  const type = textValue(record.type);
  if (type === "auto") {
    return "auto";
  }
  if (type === "any") {
    return "required";
  }
  if (type === "none") {
    return "none";
  }
  if (type === "tool") {
    return { name: textValue(record.name), type: "function" };
  }
  throw new AnthropicCompatibilityError(
    `Anthropic tool_choice type "${type || "unknown"}" is not supported.`,
  );
}

function anthropicThinkingToReasoning(thinking: unknown): JsonObject | undefined {
  const record = asRecord(thinking);
  if (Object.keys(record).length === 0) {
    return undefined;
  }
  const type = textValue(record.type);
  if (type && type !== "enabled") {
    return undefined;
  }
  const budget = typeof record.budget_tokens === "number" ? record.budget_tokens : 0;
  return {
    effort: budget >= 16_000 ? "high" : budget >= 4_000 ? "medium" : "low",
  };
}

function anthropicStopSequences(stopSequences: unknown): unknown {
  if (!Array.isArray(stopSequences) || stopSequences.length === 0) {
    return undefined;
  }
  return stopSequences.map((sequence) => textValue(sequence)).filter(Boolean);
}

function anthropicContentFromResponsesOutput(response: JsonObject): JsonObject[] {
  const content: JsonObject[] = [];
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    const record = asRecord(item);
    const type = textValue(record.type);
    if (type === "message") {
      const parts = Array.isArray(record.content) ? record.content : [];
      for (const part of parts) {
        const partRecord = asRecord(part);
        const text = textValue(partRecord.text) || textValue(partRecord.output_text);
        if (text) {
          content.push({ text, type: "text" });
        }
      }
      continue;
    }
    if (type === "function_call") {
      content.push({
        id: textValue(record.call_id) || textValue(record.id) || `call_${randomId()}`,
        input: parseToolInput(textValue(record.arguments)),
        name: textValue(record.name),
        type: "tool_use",
      });
    }
  }

  if (content.length === 0) {
    const outputText = textValue(response.output_text);
    if (outputText) {
      content.push({ text: outputText, type: "text" });
    }
  }
  return content;
}

function anthropicStopReason(response: JsonObject, content: JsonObject[]): string {
  if (content.some((part) => part.type === "tool_use")) {
    return "tool_use";
  }
  const incompleteReason = textValue(asRecord(response.incomplete_details).reason);
  if (textValue(response.status) === "incomplete" || incompleteReason === "max_output_tokens") {
    return "max_tokens";
  }
  return "end_turn";
}

function anthropicUsage(usage: unknown): JsonObject {
  const record = asRecord(usage);
  const inputTokens = firstNumber(record.input_tokens, record.prompt_tokens) ?? 0;
  const outputTokens = firstNumber(record.output_tokens, record.completion_tokens) ?? 0;
  const details = asRecord(record.input_tokens_details);
  return removeUndefined({
    cache_creation_input_tokens: firstNumber(record.cache_creation_input_tokens),
    cache_read_input_tokens:
      firstNumber(record.cache_read_input_tokens, details.cached_tokens) ?? undefined,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  });
}

function processResponsesSseBlock(
  block: string,
  state: AnthropicStreamState,
  enqueue: (event: string, data: JsonObject) => void,
): void {
  const { data, event } = parseSseBlock(block);
  if (!data || data === "[DONE]") {
    return;
  }
  const parsed = parseJsonObject(data);
  if (!parsed) {
    return;
  }
  const type = textValue(parsed.type) || event;
  if (type === "response.created") {
    const response = asRecord(parsed.response);
    state.messageId = textValue(response.id) || state.messageId;
    state.model = textValue(response.model) || state.model;
    startAnthropicMessage(state, enqueue);
    return;
  }
  if (type === "response.output_item.added") {
    const item = asRecord(parsed.item);
    if (textValue(item.type) === "function_call") {
      ensureToolBlock(state, parsed, item, enqueue);
    }
    return;
  }
  if (type === "response.output_text.delta") {
    const blockState = ensureTextBlock(state, parsed, enqueue);
    const delta = textValue(parsed.delta);
    if (delta) {
      blockState.sentText += delta;
      enqueue("content_block_delta", {
        delta: { text: delta, type: "text_delta" },
        index: blockState.index,
        type: "content_block_delta",
      });
    }
    return;
  }
  if (type === "response.output_text.done" || type === "response.content_part.done") {
    const blockState = ensureTextBlock(state, parsed, enqueue);
    const text = textValue(parsed.text) || textValue(asRecord(parsed.part).text);
    if (text && !blockState.sentText) {
      blockState.sentText = text;
      enqueue("content_block_delta", {
        delta: { text, type: "text_delta" },
        index: blockState.index,
        type: "content_block_delta",
      });
    }
    stopBlock(blockState, enqueue);
    return;
  }
  if (type === "response.function_call_arguments.delta") {
    const blockState = ensureToolBlock(state, parsed, {}, enqueue);
    const delta = textValue(parsed.delta);
    if (delta) {
      blockState.sentText += delta;
      enqueue("content_block_delta", {
        delta: { partial_json: delta, type: "input_json_delta" },
        index: blockState.index,
        type: "content_block_delta",
      });
    }
    return;
  }
  if (type === "response.function_call_arguments.done") {
    const blockState = ensureToolBlock(state, parsed, {}, enqueue);
    const args = textValue(parsed.arguments);
    if (args && !blockState.sentText) {
      blockState.sentText = args;
      enqueue("content_block_delta", {
        delta: { partial_json: args, type: "input_json_delta" },
        index: blockState.index,
        type: "content_block_delta",
      });
    }
    stopBlock(blockState, enqueue);
    return;
  }
  if (type === "response.output_item.done") {
    const item = asRecord(parsed.item);
    if (textValue(item.type) === "function_call") {
      const blockState = ensureToolBlock(state, parsed, item, enqueue);
      const args = textValue(item.arguments);
      if (args && !blockState.sentText) {
        blockState.sentText = args;
        enqueue("content_block_delta", {
          delta: { partial_json: args, type: "input_json_delta" },
          index: blockState.index,
          type: "content_block_delta",
        });
      }
      stopBlock(blockState, enqueue);
    }
    return;
  }
  if (type === "response.completed") {
    const response = asRecord(parsed.response);
    state.model = textValue(response.model) || state.model;
    state.usage = anthropicUsage(response.usage);
    finishAnthropicStream(state, enqueue);
    return;
  }
  if (type === "response.failed" || event === "error") {
    const error = asRecord(asRecord(parsed.response).error);
    enqueue("error", {
      error: {
        message: textValue(error.message) || textValue(parsed.message) || "Upstream stream failed.",
        type: textValue(error.type) || "api_error",
      },
      type: "error",
    });
    state.completed = true;
  }
}

function startAnthropicMessage(
  state: AnthropicStreamState,
  enqueue: (event: string, data: JsonObject) => void,
): void {
  if (state.started) {
    return;
  }
  state.started = true;
  enqueue("message_start", {
    message: {
      content: [],
      id: state.messageId,
      model: state.model,
      role: "assistant",
      stop_reason: null,
      stop_sequence: null,
      type: "message",
      usage: anthropicUsage(undefined),
    },
    type: "message_start",
  });
}

function finishAnthropicStream(
  state: AnthropicStreamState,
  enqueue: (event: string, data: JsonObject) => void,
): void {
  if (state.completed) {
    return;
  }
  startAnthropicMessage(state, enqueue);
  for (const block of [...state.blocks.values()].sort((left, right) => left.index - right.index)) {
    stopBlock(block, enqueue);
  }
  enqueue("message_delta", {
    delta: {
      stop_reason: state.sawToolUse ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    type: "message_delta",
    usage: state.usage,
  });
  enqueue("message_stop", { type: "message_stop" });
  state.completed = true;
}

function ensureTextBlock(
  state: AnthropicStreamState,
  payload: JsonObject,
  enqueue: (event: string, data: JsonObject) => void,
): StreamBlock {
  startAnthropicMessage(state, enqueue);
  const key = `text:${indexValue(payload.output_index)}:${indexValue(payload.content_index)}`;
  let block = state.blocks.get(key);
  if (!block) {
    block = { index: state.nextBlockIndex++, sentText: "", stopped: false, type: "text" };
    state.blocks.set(key, block);
    enqueue("content_block_start", {
      content_block: { text: "", type: "text" },
      index: block.index,
      type: "content_block_start",
    });
  }
  return block;
}

function ensureToolBlock(
  state: AnthropicStreamState,
  payload: JsonObject,
  item: JsonObject,
  enqueue: (event: string, data: JsonObject) => void,
): StreamBlock {
  startAnthropicMessage(state, enqueue);
  state.sawToolUse = true;
  const key = `tool:${indexValue(payload.output_index)}`;
  let block = state.blocks.get(key);
  if (!block) {
    block = { index: state.nextBlockIndex++, sentText: "", stopped: false, type: "tool_use" };
    state.blocks.set(key, block);
    enqueue("content_block_start", {
      content_block: {
        id: textValue(item.call_id) || textValue(item.id) || `call_${randomId()}`,
        input: {},
        name: textValue(item.name),
        type: "tool_use",
      },
      index: block.index,
      type: "content_block_start",
    });
  }
  return block;
}

function stopBlock(block: StreamBlock, enqueue: (event: string, data: JsonObject) => void): void {
  if (block.stopped) {
    return;
  }
  block.stopped = true;
  enqueue("content_block_stop", {
    index: block.index,
    type: "content_block_stop",
  });
}

function parseSseBlock(block: string): { data: string; event: string } {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("event:")) {
      event = trimmed.slice("event:".length).trim() || event;
    } else if (trimmed.startsWith("data:")) {
      data.push(trimmed.slice("data:".length).trim());
    }
  }
  return { data: data.join("\n"), event };
}

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function parseToolInput(argumentsText: string): JsonObject {
  const parsed = parseJsonObject(argumentsText);
  return parsed ?? {};
}

function estimatedTextSize(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value === "string") {
    return value.length;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).length;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimatedTextSize(item), 0);
  }
  if (typeof value === "object") {
    return Object.values(value).reduce((sum, item) => sum + estimatedTextSize(item), 0);
  }
  return 0;
}

function textValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function indexValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function removeUndefined(record: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function encodeSse(event: string, data: JsonObject): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function randomId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
