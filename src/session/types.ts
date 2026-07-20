// ============================================================================
// 会话类型——对应 DESIGN.md 第 7 节
// ============================================================================

import type { SessionStatus, MessageRole, AgentLoopState } from "../core/types.js";
import type { NormalizedToolCall } from "../providers/types.js";

// ---------------------------------------------------------------------------
// 会话主体
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  currentState: AgentLoopState;
  plan: Record<string, unknown>;
  providerName: string;
  model: string;
  messages: Message[];
  toolCalls: ToolCallRecord[];
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// 会话消息
// ---------------------------------------------------------------------------

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: NormalizedToolCall[];
  toolCallId?: string;
  sequence: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 工具调用审计记录
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown | null;
  error: string | null;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "denied";
  durationMs: number | null;
  startedAt: string;
  endedAt: string | null;
}

// ---------------------------------------------------------------------------
// 会话存储接口——通过构造参数注入，不使用单例
// ---------------------------------------------------------------------------

export interface SessionStore {
  create(session: Session): Promise<void>;
  update(session: Session): Promise<void>;
  get(sessionId: string): Promise<Session | null>;
  list(limit?: number): Promise<Session[]>;
}
