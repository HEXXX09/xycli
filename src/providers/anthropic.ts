// ============================================================================
// Anthropic Provider 适配器——对应 DESIGN.md 第 6 节
// ============================================================================

import Anthropic from "@anthropic-ai/sdk";
import type {
  IProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderTokenInput,
  ProviderToolDefinition,
  ProviderMessage,
  TokenEstimate,
  NormalizedToolCall,
  TokenUsage,
  ProviderContentBlock,
} from "./types.js";
import { ProviderError } from "../core/errors.js";

// ---------------------------------------------------------------------------
// Anthropic 协议到内部协议的映射方法
// ---------------------------------------------------------------------------

function toAnthropicTools(
  tools: ProviderToolDefinition[]
): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));
}

function toAnthropicMessages(
  messages: ProviderMessage[]
): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return { role: m.role as Anthropic.MessageParam["role"], content: m.content };
    }
    // 转换结构化内容块。
    const blocks: Anthropic.ContentBlockParam[] = m.content.map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text };
        case "tool_use":
          return {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          };
      }
    });
    return { role: m.role as Anthropic.MessageParam["role"], content: blocks };
  });
}

function normalizeToolCall(
  block: Anthropic.ToolUseBlock
): NormalizedToolCall {
  return {
    id: block.id,
    name: block.name,
    input: (block.input as Record<string, unknown>) ?? {},
  };
}

function normalizeUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function toProviderMessage(
  message: Anthropic.Message
): ProviderMessage {
  const blocks: ProviderContentBlock[] = message.content.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "tool_use":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: (block.input as Record<string, unknown>) ?? {},
        };
      default:
        return { type: "text", text: "" };
    }
  });
  return { role: "assistant", content: blocks };
}

// ---------------------------------------------------------------------------
// Anthropic Provider 实现
// ---------------------------------------------------------------------------

export class AnthropicProvider implements IProvider {
  readonly name = "anthropic" as const;
  private client: Anthropic;

  constructor(apiKey?: string, client?: Anthropic) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new ProviderError(
        "ANTHROPIC_API_KEY is not set. Set the environment variable or pass an API key to the constructor.",
        { retryable: false }
      );
    }
    this.client = client ?? new Anthropic({ apiKey: key });
  }

  // -----------------------------------------------------------------------
  // 非流式对话
  // -----------------------------------------------------------------------

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    try {
      const systemText = request.system || undefined;
      const tools = request.tools.length > 0 ? toAnthropicTools(request.tools) : undefined;

      const response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxOutputTokens || 4096,
        temperature: request.temperature ?? 0.2,
        system: systemText,
        messages: toAnthropicMessages(request.messages),
        tools,
      }, { signal: request.signal });

      const message = toProviderMessage(response);
      const toolCalls: NormalizedToolCall[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolCalls.push(normalizeToolCall(block));
        }
      }

      const finishReason: ProviderResponse["finishReason"] =
        response.stop_reason === "tool_use"
          ? "tool_calls"
          : response.stop_reason === "max_tokens"
            ? "length"
            : response.stop_reason === "end_turn"
              ? "stop"
              : "stop";

      return {
        message,
        toolCalls,
        usage: normalizeUsage(response.usage),
        finishReason,
      };
    } catch (err: unknown) {
      throw this.wrapError(err);
    }
  }

  // -----------------------------------------------------------------------
  // 通过异步生成器输出流式事件
  // -----------------------------------------------------------------------

  async *streamChat(
    request: ProviderRequest
  ): AsyncIterable<ProviderStreamEvent> {
    const systemText = request.system || undefined;
    const tools = request.tools.length > 0 ? toAnthropicTools(request.tools) : undefined;
    try {
      const stream = this.client.messages.stream({
        model: request.model,
        max_tokens: request.maxOutputTokens || 4096,
        temperature: request.temperature ?? 0.2,
        system: systemText,
        messages: toAnthropicMessages(request.messages),
        tools,
      }, { signal: request.signal });

      // 按事件增量收集用量、停止原因和工具调用信息。
      let currentToolUse: Partial<Anthropic.ToolUseBlock> | null = null;
      let finalUsage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      let stopReason: Anthropic.Message["stop_reason"] = "end_turn";

      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            finalUsage = normalizeUsage(event.message.usage);
            yield { type: "usage", usage: finalUsage };
            break;

          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              currentToolUse = {
                type: "tool_use",
                id: event.content_block.id,
                name: event.content_block.name,
                input: {},
              };
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              yield { type: "text_delta", text: event.delta.text };
            } else if (
              event.delta.type === "input_json_delta" &&
              currentToolUse
            ) {
              // 输出工具参数增量；完整 JSON 以 finalMessage() 为准。
              yield {
                type: "tool_call_delta",
                call: {
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input: event.delta.partial_json
                    ? { _partial: event.delta.partial_json }
                    : {},
                },
              };
            }
            break;

          case "content_block_stop":
            // 内容块已经结束，无需额外处理。
            break;

          case "message_delta":
            if (event.usage) {
              finalUsage = {
                inputTokens: finalUsage.inputTokens,
                outputTokens: event.usage.output_tokens,
                cacheReadTokens: finalUsage.cacheReadTokens,
                cacheWriteTokens: finalUsage.cacheWriteTokens,
              };
              yield { type: "usage", usage: finalUsage };
            }
            stopReason = event.delta.stop_reason ?? stopReason;
            break;

          case "message_stop":
            break;
        }
      }

      // SDK 会在 finalMessage() 中完成文本和工具 JSON 的累积。
      const finalMessage = await stream.finalMessage();
      finalUsage = normalizeUsage(finalMessage.usage);
      stopReason = finalMessage.stop_reason;

      const message = toProviderMessage(finalMessage);
      const toolCalls: NormalizedToolCall[] = [];

      for (const block of finalMessage.content) {
        if (block.type === "tool_use") {
          toolCalls.push(normalizeToolCall(block));
        }
      }

      const finishReason: ProviderResponse["finishReason"] =
        stopReason === "tool_use"
          ? "tool_calls"
          : stopReason === "max_tokens"
            ? "length"
            : stopReason === "end_turn"
              ? "stop"
              : "stop";

      const response: ProviderResponse = {
        message,
        toolCalls,
        usage: finalUsage,
        finishReason,
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

  // -----------------------------------------------------------------------
  // 工具能力判断
  // -----------------------------------------------------------------------

  supportsTools(_model: string): boolean {
    // 当前支持的 Claude 模型均提供工具调用能力。
    return true;
  }

  // -----------------------------------------------------------------------
  // Token 粗略估算
  // -----------------------------------------------------------------------

  async estimateTokens(input: ProviderTokenInput): Promise<TokenEstimate> {
    // 英文文本按平均约 3.5 个字符一个 Token 估算。
    let totalChars = input.system.length;
    for (const msg of input.messages) {
      if (typeof msg.content === "string") {
        totalChars += msg.content.length;
      } else {
        totalChars += JSON.stringify(msg.content).length;
      }
    }
    totalChars += JSON.stringify(input.tools).length;

    const inputTokens = Math.ceil(totalChars / 3.5);
    return { inputTokens, outputTokens: 0 };
  }

  // -----------------------------------------------------------------------
  // 统一错误包装
  // -----------------------------------------------------------------------

  private wrapError(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;

    if (err instanceof Anthropic.APIError) {
      const retryable =
        err.status === 429 ||
        err.status === 500 ||
        err.status === 502 ||
        err.status === 503;

      return new ProviderError(
        `Anthropic API error: ${err.message}`,
        {
          retryable,
          status: err.status,
          requestId: err.request_id,
        }
      );
    }

    if (err instanceof Error) {
      return new ProviderError(err.message, { retryable: false });
    }

    return new ProviderError("Unknown provider error", { retryable: false });
  }
}
