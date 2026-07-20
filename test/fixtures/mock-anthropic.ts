// ============================================================================
// 测试使用的 Anthropic 模拟 Provider
// ============================================================================

import type {
  IProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderTokenInput,
  TokenEstimate,
} from "../../src/providers/types.js";

export interface MockScenario {
  name: string;
  responses: ProviderResponse[];
}

/**
 * 按顺序返回预配置响应的确定性模拟 Provider。
 */
export class MockAnthropicProvider implements IProvider {
  readonly name = "anthropic" as const;
  private responses: ProviderResponse[];
  private callCount = 0;
  readonly requests: ProviderRequest[] = [];
  onRequest?: (request: ProviderRequest) => void;

  constructor(responses: ProviderResponse[]) {
    this.responses = responses;
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    this.onRequest?.(request);
    const response = this.responses[this.callCount % this.responses.length];
    this.callCount++;
    return response;
  }

  async *streamChat(
    _request: ProviderRequest
  ): AsyncIterable<ProviderStreamEvent> {
    const response = this.responses[this.callCount % this.responses.length];
    this.callCount++;

    // 按内容块输出文本增量。
    if (typeof response.message.content === "string") {
      yield { type: "text_delta", text: response.message.content };
    } else {
      for (const block of response.message.content) {
        if (block.type === "text") {
          yield { type: "text_delta", text: block.text };
        }
      }
    }

    yield { type: "usage", usage: response.usage };
    yield { type: "done", response };
  }

  supportsTools(_model: string): boolean {
    return true;
  }

  async estimateTokens(_input: ProviderTokenInput): Promise<TokenEstimate> {
    return { inputTokens: 100, outputTokens: 0 };
  }

  reset(responses: ProviderResponse[]): void {
    this.responses = responses;
    this.callCount = 0;
    this.requests.length = 0;
  }
}

// ---------------------------------------------------------------------------
// 常用模拟响应构造方法
// ---------------------------------------------------------------------------

export function makeTextResponse(text: string): ProviderResponse {
  return {
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    toolCalls: [],
    usage: {
      inputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    finishReason: "stop",
  };
}

export function makeToolCallResponse(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = "tool_001"
): ProviderResponse {
  return {
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolCallId,
          name: toolName,
          input,
        },
      ],
    },
    toolCalls: [
      {
        id: toolCallId,
        name: toolName,
        input,
      },
    ],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    finishReason: "tool_calls",
  };
}

export function makeTextThenToolCallResponse(
  text: string,
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = "tool_001"
): ProviderResponse {
  return {
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        {
          type: "tool_use",
          id: toolCallId,
          name: toolName,
          input,
        },
      ],
    },
    toolCalls: [
      {
        id: toolCallId,
        name: toolName,
        input,
      },
    ],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    finishReason: "tool_calls",
  };
}
