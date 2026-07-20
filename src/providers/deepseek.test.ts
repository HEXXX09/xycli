import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { DeepSeekProvider } from "./deepseek.js";

describe("DeepSeekProvider", () => {
  it("缺少 API Key 时给出明确错误", () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      expect(() => new DeepSeekProvider()).toThrow(/DEEPSEEK_API_KEY/);
    } finally {
      if (saved) process.env.DEEPSEEK_API_KEY = saved;
    }
  });

  it("传递系统提示和中断信号，并规范化工具调用", async () => {
    const signal = new AbortController().signal;
    const create = vi.fn(async (_body: unknown, _options?: unknown) => ({
      id: "completion",
      object: "chat.completion",
      created: 1,
      model: "deepseek-chat",
      choices: [{
        index: 0,
        logprobs: null,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          refusal: null,
          annotations: [],
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "file_read", arguments: "{\"path\":\"README.md\"}" },
          }],
        },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    }));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const provider = new DeepSeekProvider("test-key", client);

    const response = await provider.chat({
      sessionId: "session",
      model: "deepseek-chat",
      messages: [{ role: "user", content: "读取文件" }],
      tools: [{
        name: "file_read",
        description: "读取文件",
        input_schema: { type: "object" },
      }],
      system: "你是 XYCLI",
      temperature: 0,
      maxOutputTokens: 100,
      metadata: {},
      signal,
    });

    const request = create.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(request.messages[0]).toEqual({ role: "system", content: "你是 XYCLI" });
    expect(create.mock.calls[0][1]).toEqual({ signal });
    expect(response.toolCalls[0]).toEqual({
      id: "call_1",
      name: "file_read",
      input: { path: "README.md" },
    });
  });

  it("流式响应能够累积被拆分的工具 JSON 参数", async () => {
    async function* chunks() {
      yield {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "file_read", arguments: "{\"path\":" },
            }],
          },
          finish_reason: null,
        }],
      };
      yield {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: "\"README.md\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      };
    }
    const create = vi.fn(async (_body: unknown, _options?: unknown) => chunks());
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const provider = new DeepSeekProvider("test-key", client);

    let finalInput: Record<string, unknown> | undefined;
    for await (const event of provider.streamChat({
      sessionId: "session",
      model: "deepseek-chat",
      messages: [{ role: "user", content: "读取" }],
      tools: [],
      system: "",
      temperature: 0,
      maxOutputTokens: 100,
      metadata: {},
    })) {
      if (event.type === "done") finalInput = event.response.toolCalls[0].input;
    }

    expect(finalInput).toEqual({ path: "README.md" });
  });
});
