// ============================================================================
// Provider 类型——对应 DESIGN.md 第 6 节
// ============================================================================

// ---------------------------------------------------------------------------
// Provider 消息
// ---------------------------------------------------------------------------

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ProviderContentBlock[];
}

export type ProviderContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

// ---------------------------------------------------------------------------
// 统一格式的工具调用
// ---------------------------------------------------------------------------

export interface NormalizedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Token 用量
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// ---------------------------------------------------------------------------
// Token 估算结果
// ---------------------------------------------------------------------------

export interface TokenEstimate {
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Token 估算输入
// ---------------------------------------------------------------------------

export interface ProviderTokenInput {
  messages: ProviderMessage[];
  system: string;
  tools: ProviderToolDefinition[];
}

// ---------------------------------------------------------------------------
// Provider 工具定义
// ---------------------------------------------------------------------------

export interface ProviderToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider 请求
// ---------------------------------------------------------------------------

export interface ProviderRequest {
  sessionId: string;
  model: string;
  messages: ProviderMessage[];
  tools: ProviderToolDefinition[];
  system: string;
  temperature: number;
  maxOutputTokens: number;
  metadata: Record<string, string>;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Provider 响应
// ---------------------------------------------------------------------------

export interface ProviderResponse {
  message: ProviderMessage;
  toolCalls: NormalizedToolCall[];
  usage: TokenUsage;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
}

// ---------------------------------------------------------------------------
// Provider 流式事件
// ---------------------------------------------------------------------------

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; call: Partial<NormalizedToolCall> }
  | { type: "usage"; usage: TokenUsage }
  | { type: "error"; error: ProviderErrorPayload }
  | { type: "done"; response: ProviderResponse };

// ---------------------------------------------------------------------------
// Provider 错误结构
// ---------------------------------------------------------------------------

export interface ProviderErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider 统一接口——对应 DESIGN.md 第 6 节
// ---------------------------------------------------------------------------

export interface IProvider {
  name: "anthropic" | "openai" | "generic-openai";
  chat(request: ProviderRequest): Promise<ProviderResponse>;
  streamChat(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
  supportsTools(model: string): boolean;
  estimateTokens(input: ProviderTokenInput): Promise<TokenEstimate>;
}
