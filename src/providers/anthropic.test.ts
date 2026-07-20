// ============================================================================
// Anthropic Provider 测试
// ============================================================================

import { describe, it, expect, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "./anthropic.js";
import type { ProviderRequest } from "./types.js";

// 只有显式设置 ANTHROPIC_API_KEY 时才运行真实 API 测试。
const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

describe("AnthropicProvider", () => {
  describe("constructor", () => {
    it("throws ProviderError when no API key is available", () => {
      // 临时清除环境变量。
      const saved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        expect(() => new AnthropicProvider()).toThrow(/ANTHROPIC_API_KEY/);
      } finally {
        if (saved) process.env.ANTHROPIC_API_KEY = saved;
      }
    });

    it("accepts an explicit API key", () => {
      const provider = new AnthropicProvider("test-key");
      expect(provider.name).toBe("anthropic");
    });

    it("reads API key from environment", () => {
      process.env.ANTHROPIC_API_KEY = "env-test-key";
      try {
        const provider = new AnthropicProvider();
        expect(provider.name).toBe("anthropic");
      } finally {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });
  });

  describe("supportsTools", () => {
    it("returns true for any model", () => {
      const provider = new AnthropicProvider("test-key");
      expect(provider.supportsTools("claude-sonnet-4-5-20250929")).toBe(true);
      expect(provider.supportsTools("unknown-model")).toBe(true);
    });
  });

  describe("estimateTokens", () => {
    it("returns a positive input token estimate", async () => {
      const provider = new AnthropicProvider("test-key");
      const estimate = await provider.estimateTokens({
        messages: [{ role: "user", content: "Hello, how are you?" }],
        system: "You are a helpful assistant.",
        tools: [{ name: "test", description: "A test tool", input_schema: { type: "object" } }],
      });
      expect(estimate.inputTokens).toBeGreaterThan(0);
      expect(typeof estimate.inputTokens).toBe("number");
    });
  });

  describe("chat (real API)", () => {
    it.runIf(hasApiKey)("returns a text response from Claude", async () => {
      const provider = new AnthropicProvider();
      const request: ProviderRequest = {
        sessionId: "test-session",
        model: "claude-sonnet-4-5-20250929",
        messages: [{ role: "user", content: "Reply with exactly: hello world" }],
        tools: [],
        system: "You are a test assistant. Follow instructions exactly.",
        temperature: 0,
        maxOutputTokens: 100,
        metadata: {},
      };

      const response = await provider.chat(request);
      expect(response.finishReason).toBe("stop");
      expect(response.toolCalls).toHaveLength(0);
      expect(response.usage.inputTokens).toBeGreaterThan(0);
      expect(response.usage.outputTokens).toBeGreaterThan(0);

      // 验证消息文本。
      if (typeof response.message.content === "string") {
        expect(response.message.content.toLowerCase()).toContain("hello");
      } else {
        const text = response.message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        expect(text.toLowerCase()).toContain("hello");
      }
    }, 30_000);

    it.runIf(hasApiKey)("handles tool definitions correctly", async () => {
      const provider = new AnthropicProvider();
      const request: ProviderRequest = {
        sessionId: "test-session",
        model: "claude-sonnet-4-5-20250929",
        messages: [
          {
            role: "user",
            content: "Use the greet tool to say hello to Bob.",
          },
        ],
        tools: [
          {
            name: "greet",
            description: "Greet a person by name",
            input_schema: {
              type: "object",
              properties: {
                name: { type: "string", description: "The name to greet" },
              },
              required: ["name"],
            },
          },
        ],
        system: "",
        temperature: 0,
        maxOutputTokens: 200,
        metadata: {},
      };

      const response = await provider.chat(request);
      expect(response.finishReason).toBe("tool_calls");
      expect(response.toolCalls.length).toBeGreaterThan(0);
      expect(response.toolCalls[0].name).toBe("greet");
      expect(response.toolCalls[0].input).toHaveProperty("name");
    }, 30_000);
  });

  describe("chat（模拟客户端）", () => {
    it("映射文本、用量并向 SDK 传递中断信号", async () => {
      const signal = new AbortController().signal;
      const create = vi.fn(async (_body: unknown, _options?: unknown) => ({
        id: "msg_test",
        type: "message" as const,
        role: "assistant" as const,
        model: "test-model",
        content: [{ type: "text" as const, text: "完成" }],
        stop_reason: "end_turn" as const,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      }));
      const client = { messages: { create } } as unknown as Anthropic;
      const provider = new AnthropicProvider("test-key", client);

      const response = await provider.chat({
        sessionId: "session",
        model: "test-model",
        messages: [{ role: "user", content: "测试" }],
        tools: [],
        system: "系统提示",
        temperature: 0,
        maxOutputTokens: 100,
        metadata: {},
        signal,
      });

      expect(response.finishReason).toBe("stop");
      expect(response.usage.inputTokens).toBe(10);
      expect(create.mock.calls[0][1]).toEqual({ signal });
    });
  });

  describe("streamChat（模拟客户端）", () => {
    it("使用 finalMessage 获取完整文本和工具参数", async () => {
      const finalMessage = {
        id: "msg_stream",
        type: "message" as const,
        role: "assistant" as const,
        model: "test-model",
        content: [{
          type: "tool_use" as const,
          id: "call_1",
          name: "file_read",
          input: { path: "README.md" },
        }],
        stop_reason: "tool_use" as const,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 4 },
      };
      const streamObject = {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "message_delta" as const,
            delta: { stop_reason: "tool_use" as const, stop_sequence: null },
            usage: { output_tokens: 4 },
          };
        },
        finalMessage: vi.fn(async () => finalMessage),
      };
      const stream = vi.fn((_body: unknown, _options?: unknown) => streamObject);
      const client = { messages: { stream } } as unknown as Anthropic;
      const provider = new AnthropicProvider("test-key", client);

      let response;
      for await (const event of provider.streamChat({
        sessionId: "session",
        model: "test-model",
        messages: [{ role: "user", content: "读取" }],
        tools: [],
        system: "",
        temperature: 0,
        maxOutputTokens: 100,
        metadata: {},
      })) {
        if (event.type === "done") response = event.response;
      }

      expect(streamObject.finalMessage).toHaveBeenCalledOnce();
      expect(response?.toolCalls[0]).toEqual({
        id: "call_1",
        name: "file_read",
        input: { path: "README.md" },
      });
    });
  });

  describe("streamChat (real API)", () => {
    it.runIf(hasApiKey)("streams text deltas and done event", async () => {
      const provider = new AnthropicProvider();
      const request: ProviderRequest = {
        sessionId: "test-session",
        model: "claude-sonnet-4-5-20250929",
        messages: [{ role: "user", content: "Say exactly: streaming works" }],
        tools: [],
        system: "Reply with exactly what the user asks.",
        temperature: 0,
        maxOutputTokens: 100,
        metadata: {},
      };

      const events: string[] = [];
      let doneReceived = false;

      for await (const event of provider.streamChat(request)) {
        events.push(event.type);
        if (event.type === "done") {
          doneReceived = true;
          expect(event.response.finishReason).toBe("stop");
        }
      }

      expect(events).toContain("text_delta");
      expect(doneReceived).toBe(true);
    }, 30_000);
  });
});
