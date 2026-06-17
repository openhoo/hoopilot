import { describe, expect, it } from "bun:test";
import {
  chatCompletionToCompletion,
  chatCompletionToResponse,
  completionStreamFromChatStream,
  completionsRequestToChatCompletion,
  fallbackModels,
  normalizeChatCompletionRequest,
  normalizeModelsResponse,
  normalizeRequestedModel,
  responsesRequestToChatCompletion,
  responsesStreamFromChatStream,
} from "../src/openai";

describe("responsesRequestToChatCompletion", () => {
  it("maps Responses API input and tools to chat completions", () => {
    const chat = responsesRequestToChatCompletion({
      input: [
        {
          content: [{ text: "Use the tool", type: "input_text" }],
          role: "user",
          type: "message",
        },
        {
          call_id: "call_1",
          output: "42",
          type: "function_call_output",
        },
      ],
      instructions: "Be concise",
      max_output_tokens: 100,
      model: "gpt-4.1",
      tools: [
        {
          description: "Lookup a value",
          name: "lookup",
          parameters: { additionalProperties: false, type: "object" },
          type: "function",
        },
      ],
    });

    expect(chat).toMatchObject({
      max_tokens: 100,
      messages: [
        { content: "Be concise", role: "system" },
        { content: "Use the tool", role: "user" },
        { content: "42", role: "tool", tool_call_id: "call_1" },
      ],
      model: "gpt-4.1",
      tools: [
        {
          function: {
            description: "Lookup a value",
            name: "lookup",
          },
          type: "function",
        },
      ],
    });
  });

  it("maps images, previous function calls, and function tool choice", () => {
    const chat = responsesRequestToChatCompletion({
      input: [
        {
          arguments: '{"query":"x"}',
          call_id: "call_1",
          name: "lookup",
          type: "function_call",
        },
        {
          content: [
            { image_url: "data:image/png;base64,aaa", type: "input_image" },
            { text: "What is in this image?", type: "input_text" },
          ],
          role: "user",
          type: "message",
        },
      ],
      text: { format: { type: "json_object" } },
      tool_choice: { name: "lookup", type: "function" },
    });

    expect(chat.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          tool_calls: [
            {
              function: { arguments: '{"query":"x"}', name: "lookup" },
              id: "call_1",
              type: "function",
            },
          ],
        }),
        expect.objectContaining({
          content: [
            { image_url: { url: "data:image/png;base64,aaa" }, type: "image_url" },
            { text: "What is in this image?", type: "text" },
          ],
          role: "user",
        }),
      ]),
    );
    expect(chat.tool_choice).toEqual({ function: { name: "lookup" }, type: "function" });
    expect(chat.response_format).toEqual({ type: "json_object" });
  });

  it("preserves Responses API model names for upstream Responses routing", () => {
    const chat = responsesRequestToChatCompletion({
      input: "hello",
      model: "gpt-5.5",
    });

    expect(chat.model).toBe("gpt-5.5");
  });
});

describe("normalizeChatCompletionRequest", () => {
  it("defaults blank direct chat models and preserves explicit model names", () => {
    expect(normalizeChatCompletionRequest({ messages: [], model: "gpt-5.5" })).toMatchObject({
      model: "gpt-5.5",
    });
    expect(
      normalizeChatCompletionRequest({ messages: [], model: "claude-sonnet-4" }),
    ).toMatchObject({
      model: "claude-sonnet-4",
    });
  });
});

describe("normalizeRequestedModel", () => {
  it("defaults blank models and preserves non-aliased model names", () => {
    expect(normalizeRequestedModel("")).toBe("gpt-4.1");
    expect(normalizeRequestedModel("gpt-5.5")).toBe("gpt-5.5");
    expect(normalizeRequestedModel("claude-sonnet-4")).toBe("claude-sonnet-4");
  });
});

describe("chatCompletionToResponse", () => {
  it("maps chat text and tool calls to Responses API output", () => {
    const response = chatCompletionToResponse({
      choices: [
        {
          message: {
            content: "Done",
            role: "assistant",
            tool_calls: [
              {
                function: { arguments: '{"x":1}', name: "save" },
                id: "call_123",
                type: "function",
              },
            ],
          },
        },
      ],
      model: "gpt-4.1",
      usage: {
        completion_tokens: 2,
        prompt_tokens: 4,
        total_tokens: 6,
      },
    });

    expect(response.output_text).toBe("Done");
    expect(response.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", type: "message" }),
        expect.objectContaining({
          arguments: '{"x":1}',
          call_id: "call_123",
          name: "save",
          type: "function_call",
        }),
      ]),
    );
    expect(response.usage).toMatchObject({
      input_tokens: 4,
      output_tokens: 2,
      total_tokens: 6,
    });
  });
});

describe("completions compatibility", () => {
  it("maps legacy completions requests and responses", () => {
    const chat = completionsRequestToChatCompletion({
      max_tokens: 8,
      model: "gpt-4.1",
      prompt: ["hello", "world"],
      stream: true,
    });
    expect(chat).toMatchObject({
      max_tokens: 8,
      messages: [{ content: "hello\nworld", role: "user" }],
      stream: true,
    });

    const completion = chatCompletionToCompletion({
      choices: [{ finish_reason: "stop", message: { content: "answer" } }],
      created: 123,
      id: "chatcmpl_1",
      model: "gpt-4.1",
    });
    expect(completion).toMatchObject({
      choices: [{ finish_reason: "stop", text: "answer" }],
      created: 123,
      model: "gpt-4.1",
      object: "text_completion",
    });
  });

  it("maps streamed chat deltas to legacy completion text chunks", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"id":"chatcmpl_1","created":123,"model":"gpt-4.1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
              'data: {"id":"chatcmpl_1","created":123,"model":"gpt-4.1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
              "data: [DONE]\n\n",
          ),
        );
        controller.close();
      },
    });

    const text = await new Response(completionStreamFromChatStream(source)).text();

    expect(text).toContain('"object":"text_completion"');
    expect(text).toContain('"text":"hi"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).not.toContain('"delta"');
  });
});

describe("normalizeModelsResponse", () => {
  it("normalizes upstream models", () => {
    expect(normalizeModelsResponse({ data: [{ id: "gpt-4.1" }] })).toEqual({
      data: [{ created: 0, id: "gpt-4.1", object: "model", owned_by: "github-copilot" }],
      object: "list",
    });
  });

  it("falls back when upstream returns no usable models", () => {
    expect(normalizeModelsResponse({ data: [{}] })).toEqual({
      data: fallbackModels(),
      object: "list",
    });
  });
});

describe("responsesStreamFromChatStream", () => {
  it("translates chat completion SSE chunks to Responses API SSE", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
              'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
              "data: [DONE]\n\n",
          ),
        );
        controller.close();
      },
    });

    const text = await new Response(
      responsesStreamFromChatStream(source, { model: "gpt-4.1", responseId: "resp_test" }),
    ).text();

    expect(text).toContain("response.output_text.delta");
    expect(text).toContain('"delta":"Hel"');
    expect(text).toContain('"text":"Hello"');
    expect(text).toContain("data: [DONE]");
  });

  it("correlates text deltas to the message item via a non-empty item_id", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });

    const events = parseSseEvents(
      await new Response(
        responsesStreamFromChatStream(source, { model: "gpt-4.1", responseId: "resp_test" }),
      ).text(),
    );
    const delta = events.find((e) => e.event === "response.output_text.delta");
    const messageItem = events.find((e) => e.event === "response.output_item.added");

    expect(delta?.data.item_id).toMatch(/^msg_/);
    expect(delta?.data.item_id).toBe(messageItem?.data.item?.id);
  });

  it("keeps function-call ids consistent between stream events and response.completed", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"save","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });

    const events = parseSseEvents(
      await new Response(
        responsesStreamFromChatStream(source, { model: "gpt-4.1", responseId: "resp_test" }),
      ).text(),
    );
    const argsDone = events.find((e) => e.event === "response.function_call_arguments.done");
    const completed = events.find((e) => e.event === "response.completed");
    const fnItem = completed?.data.response?.output.find((item) => item.type === "function_call");

    expect(fnItem?.id).toMatch(/^fc_/);
    expect(argsDone?.data.item_id).toBe(fnItem?.id);
  });

  it("translates streamed tool calls", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"save","arguments":"{\\"x\\""}}]}}]}\n\n' +
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}\n\n' +
              "data: [DONE]\n\n",
          ),
        );
        controller.close();
      },
    });

    const text = await new Response(
      responsesStreamFromChatStream(source, { model: "gpt-4.1", responseId: "resp_test" }),
    ).text();

    expect(text).toContain("response.function_call_arguments.done");
    expect(text).toContain('"name":"save"');
    expect(text).toContain('"{\\"x\\":1}"');
  });
});

interface ParsedSseEvent {
  event: string;
  data: {
    item_id?: string;
    item?: { id: string };
    response?: { output: Array<{ id: string; type: string }> };
  };
}

function parseSseEvents(text: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  for (const block of text.split("\n\n")) {
    let event = "";
    let dataRaw = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice("event: ".length);
      } else if (line.startsWith("data: ")) {
        dataRaw = line.slice("data: ".length);
      }
    }
    if (!dataRaw || dataRaw === "[DONE]") {
      continue;
    }
    events.push({ data: JSON.parse(dataRaw), event });
  }
  return events;
}
