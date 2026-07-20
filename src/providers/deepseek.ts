// DeepSeek Provider——兼容 OpenAI Chat Completions API
// API 地址：https://api.deepseek.com
// 支持模型：deepseek-chat、deepseek-reasoner

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
  ProviderContentBlock,
} from "./types.js";
import { ProviderError } from "../core/errors.js";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// ---------------------------------------------------------------------------
// 将 XYCLI 内部消息转换为 OpenAI 格式
// ---------------------------------------------------------------------------

function toOpenAIMessages(messages: ProviderMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  for (const m of messages) {
    if (typeof m.content === "string") {
      // 纯文本消息
      if (m.role === "tool") {
        throw new ProviderError("工具消息必须使用结构化 tool_result 内容块。", {
          retryable: false,
        });
      } else {
        result.push({ role: m.role as "user" | "assistant" | "system", content: m.content });
      }
      continue;
    }

    // 处理结构化内容块消息。
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
        // 将内部 tool_result 转换为 OpenAI 的 tool 消息。
        toolResults.push({
          tool_call_id: block.tool_use_id,
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
      // 将多个 tool_result 内容块展开为多条 OpenAI tool 消息。
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
// 将 XYCLI 工具定义转换为 OpenAI function 格式
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
// 从 OpenAI 响应中提取统一格式的工具调用
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
// 将 OpenAI 响应转换为内部 ProviderMessage
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
// DeepSeek Provider 实现
// ---------------------------------------------------------------------------

export class DeepSeekProvider implements IProvider {
  readonly name = "generic-openai" as const;
  private client: OpenAI;

  constructor(apiKey?: string, client?: OpenAI) {
    const key = apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!key) {
      throw new ProviderError(
        "DEEPSEEK_API_KEY 未设置。请设置环境变量: export DEEPSEEK_API_KEY=sk-...",
        { retryable: false }
      );
    }
    this.client = client ?? new OpenAI({
      apiKey: key,
      baseURL: process.env.DEEPSEEK_BASE_URL ?? DEFAULT_DEEPSEEK_BASE_URL,
    });
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    try {
      const messages = toOpenAIMessages(request.messages);

      // 将系统提示词插入消息列表首位。
      if (request.system) {
        messages.unshift({ role: "system", content: request.system });
      }

      const tools = request.tools.length > 0 ? toOpenAITools(request.tools) : undefined;

      // 非流式路径直接读取完整工具调用。
      const completion = await this.client.chat.completions.create({
        model: request.model,
        messages,
        tools,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxOutputTokens || 4096,
      }, { signal: request.signal });

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
              : choice.finish_reason === "content_filter"
                ? "content_filter"
                : "error";

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

      // 将系统提示词插入消息列表首位。
      if (request.system) {
        messages.unshift({ role: "system", content: request.system });
      }

      const tools = request.tools.length > 0 ? toOpenAITools(request.tools) : undefined;

      const stream = await this.client.chat.completions.create({
        model: request.model,
        messages,
        tools,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxOutputTokens || 4096,
        stream: true,
      }, { signal: request.signal });

      let fullContent = "";
      const toolBuffers = new Map<number, { id: string; name: string; arguments: string }>();
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      let finishReason: ProviderResponse["finishReason"] = "stop";

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          fullContent += delta.content;
          yield { type: "text_delta", text: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            const current = toolBuffers.get(index) ?? { id: "", name: "", arguments: "" };
            if (tc.id) current.id = tc.id;
            if (tc.function?.name) current.name += tc.function.name;
            if (tc.function?.arguments) current.arguments += tc.function.arguments;
            toolBuffers.set(index, current);
            yield {
              type: "tool_call_delta",
              call: { id: current.id, name: current.name },
            };
          }
        }

        const chunkFinishReason = chunk.choices[0]?.finish_reason;
        if (chunkFinishReason === "tool_calls") finishReason = "tool_calls";
        else if (chunkFinishReason === "length") finishReason = "length";
        else if (chunkFinishReason === "content_filter") finishReason = "content_filter";
        else if (chunkFinishReason === "stop") finishReason = "stop";

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

      const toolCalls: NormalizedToolCall[] = Array.from(toolBuffers.values()).map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: JSON.parse(toolCall.arguments || "{}") as Record<string, unknown>,
      }));

      // 流结束后发送包含完整工具参数的最终响应。
      const response: ProviderResponse = {
        message: { role: "assistant", content: fullContent || [{ type: "text", text: "" }] },
        toolCalls,
        usage,
        finishReason: toolCalls.length > 0 ? "tool_calls" : finishReason,
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
    // 中英文混合场景按平均约 1.5 个字符一个 Token 估算。
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
