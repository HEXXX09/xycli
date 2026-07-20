// DeepSeek Provider — 兼容 OpenAI Chat Completions API
// api: https://api.deepseek.com
// 模型: deepseek-chat, deepseek-reasoner

import OpenAI from "openai";
import type {
  IProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderTokenInput,
  ProviderMessage,
  ProviderToolDefinition,
  TokenEstimate,
  NormalizedToolCall,
  TokenUsage,
  ProviderErrorPayload,
  ProviderContentBlock,
} from "./types.js";
import { ProviderError } from "../core/errors.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// ---------------------------------------------------------------------------
// 将 XYCLI 内部消息转为 OpenAI 格式
// ---------------------------------------------------------------------------

function toOpenAIMessages(messages: ProviderMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  for (const m of messages) {
    if (typeof m.content === "string") {
      // 纯文本消息
      if (m.role === "tool") {
        result.push({ role: "tool", tool_call_id: (m as any).tool_use_id || (m as any).toolCallId || "", content: m.content });
      } else {
        result.push({ role: m.role as "user" | "assistant" | "system", content: m.content });
      }
      continue;
    }

    // content blocks 消息
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
    let textContent = "";
    const toolResults: Array<{ tool_call_id: string; content: string }> = [];

    for (const block of m.content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      } else if (block.type === "tool_result") {
        // Anthropic 格式的 tool_result → OpenAI 格式的 tool 消息
        toolResults.push({
          tool_call_id: (block as any).tool_use_id || "",
          content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
        });
      }
    }

    if (toolCalls.length > 0) {
      result.push({
        role: "assistant" as const,
        content: textContent || null,
        tool_calls: toolCalls,
      });
    } else if (toolResults.length > 0) {
      // 将 Anthropic tool_result blocks 展开为多条 OpenAI tool 消息
      for (const tr of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: tr.tool_call_id,
          content: tr.content,
        });
      }
    } else {
      result.push({ role: m.role as "user" | "assistant", content: textContent });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 将 XYCLI 工具定义转为 OpenAI function 格式
// ---------------------------------------------------------------------------

function toOpenAITools(tools: ProviderToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

// ---------------------------------------------------------------------------
// 从 OpenAI 回复中提取标准化 tool call
// ---------------------------------------------------------------------------

function extractToolCalls(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice
): NormalizedToolCall[] {
  if (!choice.message.tool_calls) return [];
  return choice.message.tool_calls
    .filter((tc) => tc.type === "function")
    .map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
    }));
}

// ---------------------------------------------------------------------------
// 构建回复中的 ProviderMessage
// ---------------------------------------------------------------------------

function toProviderMessage(
  msg: OpenAI.Chat.Completions.ChatCompletionMessage
): ProviderMessage {
  const blocks: ProviderContentBlock[] = [];

  if (msg.content) {
    blocks.push({ type: "text", text: msg.content });
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      if (tc.type === "function") {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        });
      }
    }
  }

  return { role: "assistant", content: blocks.length > 0 ? blocks : msg.content || "" };
}

// ---------------------------------------------------------------------------
// DeepSeekProvider
// ---------------------------------------------------------------------------

export class DeepSeekProvider implements IProvider {
  readonly name = "generic-openai" as const;
  private client: OpenAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!key) {
      throw new ProviderError(
        "DEEPSEEK_API_KEY 未设置。请设置环境变量: export DEEPSEEK_API_KEY=sk-...",
        { retryable: false }
      );
    }
    this.client = new OpenAI({ apiKey: key, baseURL: DEEPSEEK_BASE_URL });
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    try {
      const messages = toOpenAIMessages(request.messages);
      const tools = request.tools.length > 0 ? toOpenAITools(request.tools) : undefined;

      // DeepSeek 目前只支持非流式 tool calling
      const completion = await this.client.chat.completions.create({
        model: request.model,
        messages,
        tools,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxOutputTokens || 4096,
      });

      const choice = completion.choices[0];
      const message = toProviderMessage(choice.message);
      const toolCalls = extractToolCalls(choice);

      const finishReason: ProviderResponse["finishReason"] =
        choice.finish_reason === "tool_calls"
          ? "tool_calls"
          : choice.finish_reason === "length"
            ? "length"
            : choice.finish_reason === "stop"
              ? "stop"
              : "stop";

      const usage: TokenUsage = {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };

      return { message, toolCalls, usage, finishReason };
    } catch (err: unknown) {
      throw this.wrapError(err);
    }
  }

  async *streamChat(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    try {
      const messages = toOpenAIMessages(request.messages);
      const tools = request.tools.length > 0 ? toOpenAITools(request.tools) : undefined;

      const stream = await this.client.chat.completions.create({
        model: request.model,
        messages,
        tools,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxOutputTokens || 4096,
        stream: true,
      });

      let fullContent = "";
      const toolCalls: NormalizedToolCall[] = [];
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          fullContent += delta.content;
          yield { type: "text_delta", text: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              toolCalls.push({
                id: tc.id,
                name: tc.function?.name || "",
                input: {},
              });
              yield {
                type: "tool_call_delta",
                call: { id: tc.id, name: tc.function?.name || "", input: {} },
              };
            }
            // 累积 JSON 参数（DeepSeek 流式可能一次性返回完整参数）
            if (tc.function?.arguments && toolCalls.length > 0) {
              try {
                const last = toolCalls[toolCalls.length - 1];
                last.input = JSON.parse(tc.function.arguments);
              } catch {
                // 部分 JSON，跳过
              }
            }
          }
        }

        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          };
          yield { type: "usage", usage };
        }
      }

      // 流结束，发送最终响应
      const response: ProviderResponse = {
        message: { role: "assistant", content: fullContent || [{ type: "text", text: "" }] },
        toolCalls,
        usage,
        finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      };

      yield { type: "done", response };
    } catch (err: unknown) {
      const wrapped = this.wrapError(err);
      yield {
        type: "error",
        error: {
          code: wrapped.code,
          message: wrapped.message,
          retryable: wrapped.retryable,
          details: wrapped.details,
        },
      };
    }
  }

  supportsTools(_model: string): boolean {
    return true; // deepseek-chat 支持 function calling
  }

  async estimateTokens(input: ProviderTokenInput): Promise<TokenEstimate> {
    // 中英文约 1.5 字符/token
    let totalChars = input.system.length;
    for (const msg of input.messages) {
      if (typeof msg.content === "string") {
        totalChars += msg.content.length;
      } else {
        totalChars += JSON.stringify(msg.content).length;
      }
    }
    totalChars += JSON.stringify(input.tools).length;
    const inputTokens = Math.ceil(totalChars / 1.5);
    return { inputTokens, outputTokens: 0 };
  }

  private wrapError(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;

    if (err instanceof OpenAI.APIError) {
      const retryable =
        err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503;
      return new ProviderError(`DeepSeek API 错误: ${err.message}`, {
        retryable,
        status: err.status,
      });
    }

    if (err instanceof Error) {
      return new ProviderError(err.message, { retryable: false });
    }

    return new ProviderError("未知 provider 错误", { retryable: false });
  }
}
