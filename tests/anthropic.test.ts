import { describe, expect, it } from "bun:test";
import {
  anthropicMessagesToResponsesRequest,
  estimateAnthropicMessageTokens,
  responsesResponseToAnthropicMessage,
  responsesStreamToAnthropicStream,
} from "../src/anthropic";

describe("anthropicMessagesToResponsesRequest", () => {
  it("maps Claude Messages requests to Copilot Responses requests", () => {
    const response = anthropicMessagesToResponsesRequest({
      max_tokens: 128,
      messages: [
        {
          content: "Find the answer",
          role: "user",
        },
        {
          content: [
            { text: "Calling the tool", type: "text" },
            { id: "toolu_1", input: { query: "answer" }, name: "lookup", type: "tool_use" },
          ],
          role: "assistant",
        },
        {
          content: [{ content: "42", tool_use_id: "toolu_1", type: "tool_result" }],
          role: "user",
        },
      ],
      model: "claude-sonnet-4.5",
      system: [{ text: "Be concise", type: "text" }],
      tool_choice: { name: "lookup", type: "tool" },
      tools: [
        {
          description: "Lookup a value",
          input_schema: { additionalProperties: false, type: "object" },
          name: "lookup",
        },
      ],
    });

    expect(response).toMatchObject({
      input: [
        {
          content: [{ text: "Find the answer", type: "input_text" }],
          role: "user",
          type: "message",
        },
        {
          content: [{ text: "Calling the tool", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
        {
          arguments: '{"query":"answer"}',
          call_id: "toolu_1",
          name: "lookup",
          type: "function_call",
        },
        {
          call_id: "toolu_1",
          output: "42",
          type: "function_call_output",
        },
      ],
      instructions: "Be concise",
      max_output_tokens: 128,
      model: "claude-sonnet-4.5",
      tool_choice: { name: "lookup", type: "function" },
      tools: [
        {
          description: "Lookup a value",
          name: "lookup",
          parameters: { additionalProperties: false, type: "object" },
          type: "function",
        },
      ],
    });
  });

  it("maps Anthropic image blocks to Responses input images", () => {
    const response = anthropicMessagesToResponsesRequest({
      messages: [
        {
          content: [
            {
              source: { data: "aaa", media_type: "image/png", type: "base64" },
              type: "image",
            },
          ],
          role: "user",
        },
      ],
      model: "claude-sonnet-4.5",
    });

    expect(response.input).toEqual([
      {
        content: [
          {
            detail: "auto",
            image_url: "data:image/png;base64,aaa",
            type: "input_image",
          },
        ],
        role: "user",
        type: "message",
      },
    ]);
  });

  it("supports Claude Code request variants and optional controls", () => {
    const response = anthropicMessagesToResponsesRequest({
      max_tokens: 16,
      messages: [
        {
          content: [
            { text: "hello", type: "text" },
            { thinking: "internal", type: "thinking" },
          ],
        },
        {
          content: { id: "call_1", input: null, name: "save", type: "tool_use" },
          role: "assistant",
        },
        {
          content: { content: { ok: true }, tool_use_id: "call_1", type: "tool_result" },
          role: "user",
        },
        {
          content: [
            {
              source: { type: "url", url: "https://example.com/image.png" },
              type: "image",
            },
          ],
          role: "user",
        },
      ],
      model: "claude-sonnet-4.5",
      stop_sequences: ["END", ""],
      stream: true,
      thinking: { budget_tokens: 20_000, type: "enabled" },
      tool_choice: { type: "any" },
    });

    expect(response).toMatchObject({
      input: [
        {
          content: [{ text: "hello", type: "input_text" }],
          role: "user",
          type: "message",
        },
        { arguments: "{}", call_id: "call_1", name: "save", type: "function_call" },
        { call_id: "call_1", output: '{"ok":true}', type: "function_call_output" },
        {
          content: [
            {
              detail: "auto",
              image_url: "https://example.com/image.png",
              type: "input_image",
            },
          ],
          role: "user",
          type: "message",
        },
      ],
      max_output_tokens: 16,
      reasoning: { effort: "high" },
      stop: ["END"],
      stream: true,
      tool_choice: "required",
    });
  });

  it("preserves explicit Anthropic cache controls without adding its own", () => {
    const response = anthropicMessagesToResponsesRequest({
      cache_control: { type: "ephemeral", ttl: "5m" },
      max_tokens: 16,
      messages: [
        {
          content: [
            {
              cache_control: { type: "ephemeral" },
              text: "stable workspace context",
              type: "text",
            },
            { text: "fresh request", type: "text" },
          ],
          role: "user",
        },
      ],
      model: "claude-sonnet-4.5",
      system: [
        {
          cache_control: { type: "ephemeral", ttl: "1h" },
          text: "Long-lived system context",
          type: "text",
        },
      ],
      tools: [
        {
          cache_control: { type: "ephemeral", ttl: "5m" },
          input_schema: { type: "object" },
          name: "lookup",
        },
      ],
    });

    expect(response.instructions).toBeUndefined();
    expect(response.input).toEqual([
      {
        content: [
          {
            cache_control: { ttl: "1h", type: "ephemeral" },
            text: "Long-lived system context",
            type: "input_text",
          },
        ],
        role: "system",
        type: "message",
      },
      {
        content: [
          {
            cache_control: { type: "ephemeral" },
            text: "stable workspace context",
            type: "input_text",
          },
          {
            cache_control: { ttl: "5m", type: "ephemeral" },
            text: "fresh request",
            type: "input_text",
          },
        ],
        role: "user",
        type: "message",
      },
    ]);
    expect(response.tools).toEqual([
      {
        cache_control: { ttl: "5m", type: "ephemeral" },
        name: "lookup",
        parameters: { type: "object" },
        type: "function",
      },
    ]);
  });

  it("uses stable fallback tool call ids so converted history stays cacheable", () => {
    const request = {
      messages: [
        {
          content: { input: { query: "answer" }, name: "lookup", type: "tool_use" },
          role: "assistant",
        },
      ],
      model: "claude-sonnet-4.5",
    };

    expect(anthropicMessagesToResponsesRequest(request)).toEqual(
      anthropicMessagesToResponsesRequest(request),
    );
    expect(anthropicMessagesToResponsesRequest(request).input).toEqual([
      {
        arguments: '{"query":"answer"}',
        call_id: "call_hoopilot_0",
        name: "lookup",
        type: "function_call",
      },
    ]);
  });

  it("rejects unsupported Anthropic request shapes before proxying", () => {
    const invalidRequests = [
      {
        message: "messages[]",
        request: { messages: "hello" },
      },
      {
        message: 'role "system"',
        request: { messages: [{ content: "hi", role: "system" }] },
      },
      {
        message: "image content",
        request: {
          messages: [
            {
              content: [{ source: { data: "aaa", type: "base64" }, type: "image" }],
              role: "assistant",
            },
          ],
        },
      },
      {
        message: "source.data",
        request: {
          messages: [
            {
              content: [{ source: { media_type: "image/png", type: "base64" }, type: "image" }],
              role: "user",
            },
          ],
        },
      },
      {
        message: 'source type "file"',
        request: {
          messages: [{ content: [{ source: { type: "file" }, type: "image" }], role: "user" }],
        },
      },
      {
        message: 'block type "document"',
        request: { messages: [{ content: [{ type: "document" }], role: "user" }] },
      },
      {
        message: 'tool_choice type "weird"',
        request: { messages: [{ content: "hi", role: "user" }], tool_choice: { type: "weird" } },
      },
      {
        message: "tool_choice name",
        request: {
          messages: [{ content: "hi", role: "user" }],
          tool_choice: { name: " ", type: "tool" },
        },
      },
      {
        message: "tool name",
        request: {
          messages: [{ content: "hi", role: "user" }],
          tools: [{ input_schema: { type: "object" } }],
        },
      },
      {
        message: "tool_use name",
        request: {
          messages: [
            { content: [{ id: "toolu_1", input: {}, type: "tool_use" }], role: "assistant" },
          ],
        },
      },
      {
        message: 'cache_control ttl "24h"',
        request: {
          cache_control: { ttl: "24h", type: "ephemeral" },
          messages: [{ content: "hi", role: "user" }],
        },
      },
    ];

    for (const { message, request } of invalidRequests) {
      expect(() => anthropicMessagesToResponsesRequest(request)).toThrow(message);
    }
  });
});

describe("responsesResponseToAnthropicMessage", () => {
  it("maps Responses output text, tool calls, and usage to a Claude message", () => {
    const message = responsesResponseToAnthropicMessage(
      {
        id: "resp_1",
        model: "claude-sonnet-4.5",
        output: [
          {
            content: [{ text: "Done", type: "output_text" }],
            role: "assistant",
            type: "message",
          },
          {
            arguments: '{"path":"README.md"}',
            call_id: "call_1",
            name: "read_file",
            type: "function_call",
          },
        ],
        usage: { input_tokens: 9, output_tokens: 3 },
      },
      "fallback-model",
    );

    expect(message).toEqual({
      content: [
        { text: "Done", type: "text" },
        {
          id: "call_1",
          input: { path: "README.md" },
          name: "read_file",
          type: "tool_use",
        },
      ],
      id: "resp_1",
      model: "claude-sonnet-4.5",
      role: "assistant",
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: 9, output_tokens: 3 },
    });
  });

  it("uses fallback output, fallback model, max-token stops, and chat-style usage", () => {
    const message = responsesResponseToAnthropicMessage(
      {
        incomplete_details: { reason: "max_output_tokens" },
        output_text: "fallback text",
        status: "incomplete",
        usage: {
          cache_creation_input_tokens: 2,
          completion_tokens: 5,
          input_tokens_details: { cached_tokens: 3 },
          prompt_tokens: 11,
        },
      },
      "fallback-model",
    );

    expect(message).toMatchObject({
      content: [{ text: "fallback text", type: "text" }],
      model: "fallback-model",
      stop_reason: "max_tokens",
      usage: {
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        input_tokens: 11,
        output_tokens: 5,
      },
    });
  });

  it("falls back to empty tool input when Responses arguments are not JSON", () => {
    const message = responsesResponseToAnthropicMessage(
      {
        output: [
          {
            arguments: "not-json",
            id: "fc_1",
            name: "broken_args",
            type: "function_call",
          },
        ],
      },
      "fallback-model",
    );

    expect(message.content).toEqual([
      { id: "fc_1", input: {}, name: "broken_args", type: "tool_use" },
    ]);
  });
});

describe("responsesStreamToAnthropicStream", () => {
  it("maps Responses SSE text events to Anthropic message SSE events", async () => {
    const source = streamFromText(
      [
        sse("response.created", {
          response: { id: "resp_1", model: "claude-sonnet-4.5" },
          type: "response.created",
        }),
        sse("response.output_text.delta", {
          content_index: 0,
          delta: "Hi",
          output_index: 0,
          type: "response.output_text.delta",
        }),
        sse("response.output_text.done", {
          content_index: 0,
          output_index: 0,
          text: "Hi",
          type: "response.output_text.done",
        }),
        sse("response.completed", {
          response: {
            model: "claude-sonnet-4.5",
            usage: { input_tokens: 4, output_tokens: 2 },
          },
          type: "response.completed",
        }),
      ].join(""),
    );

    const text = await new Response(
      responsesStreamToAnthropicStream(source, { model: "fallback-model" }),
    ).text();

    expect(text).toContain("event: message_start");
    expect(text).toContain('"model":"claude-sonnet-4.5"');
    expect(text).toContain("event: content_block_start");
    expect(text).toContain('"text":"Hi"');
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain("event: content_block_stop");
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain('"input_tokens":4');
    expect(text).toContain("event: message_stop");
  });

  it("maps streamed Responses tool calls without duplicating final arguments", async () => {
    const source = streamFromText(
      [
        sse("response.created", {
          response: { id: "resp_1", model: "claude-sonnet-4.5" },
          type: "response.created",
        }),
        sse("response.output_item.added", {
          item: { call_id: "call_1", name: "read_file", type: "function_call" },
          output_index: 0,
          type: "response.output_item.added",
        }),
        sse("response.function_call_arguments.delta", {
          delta: '{"path"',
          output_index: 0,
          type: "response.function_call_arguments.delta",
        }),
        sse("response.function_call_arguments.delta", {
          delta: ':"README.md"}',
          output_index: 0,
          type: "response.function_call_arguments.delta",
        }),
        sse("response.function_call_arguments.done", {
          arguments: '{"path":"README.md"}',
          output_index: 0,
          type: "response.function_call_arguments.done",
        }),
        sse("response.completed", {
          response: {
            model: "claude-sonnet-4.5",
            usage: { input_tokens: 4, output_tokens: 2 },
          },
          type: "response.completed",
        }),
      ].join(""),
    );

    const text = await new Response(
      responsesStreamToAnthropicStream(source, { model: "fallback-model" }),
    ).text();

    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"name":"read_file"');
    expect(text.match(/input_json_delta/g)).toHaveLength(2);
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it("handles Responses stream fallback and error events", async () => {
    const textDoneOnly = await new Response(
      responsesStreamToAnthropicStream(
        streamFromText(
          'event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"done-only"}',
        ),
        { messageId: "msg_custom", model: "fallback-model" },
      ),
    ).text();
    expect(textDoneOnly).toContain('"id":"msg_custom"');
    expect(textDoneOnly).toContain('"text":"done-only"');

    const toolDoneOnly = await new Response(
      responsesStreamToAnthropicStream(
        streamFromText(
          sse("response.output_item.done", {
            item: {
              arguments: '{"path":"README.md"}',
              call_id: "call_1",
              name: "read_file",
              type: "function_call",
            },
            output_index: 0,
            type: "response.output_item.done",
          }),
        ),
        { model: "fallback-model" },
      ),
    ).text();
    expect(toolDoneOnly).toContain('"partial_json":"{\\"path\\":\\"README.md\\"}"');

    const errorText = await new Response(
      responsesStreamToAnthropicStream(
        streamFromText(
          sse("error", {
            message: "upstream broke",
            type: "response.failed",
          }),
        ),
        { model: "fallback-model" },
      ),
    ).text();
    expect(errorText).toContain("event: error");
    expect(errorText).toContain("upstream broke");
  });
});

describe("estimateAnthropicMessageTokens", () => {
  it("returns both Anthropic and proxy token-count fields", () => {
    const count = estimateAnthropicMessageTokens({
      messages: [{ content: "hello world", role: "user" }],
      model: "claude-sonnet-4.5",
    });

    expect(count.input_tokens).toBeNumber();
    expect(count.total_tokens).toBe(count.input_tokens);
  });

  it("counts primitive and object values in optional request sections", () => {
    const count = estimateAnthropicMessageTokens({
      messages: null,
      system: [{ text: "system" }],
      thinking: { budget_tokens: 1024, enabled: true },
      tool_choice: { type: "none" },
      tools: [{ description: "tool", name: "lookup" }],
    });

    expect(count.input_tokens).toBeGreaterThan(16);
    expect(count.total_tokens).toBe(count.input_tokens);
  });
});

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
