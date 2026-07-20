// ============================================================================
// 工具类型——对应 DESIGN.md 第 4 节
// ============================================================================

import type { PermissionLevel } from "../core/types.js";
import type { ZodType } from "zod";

// ---------------------------------------------------------------------------
// 工具定义使用的 JSON Schema 最小子集
// ---------------------------------------------------------------------------

export interface JSONSchema7 {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, JSONSchema7>;
  required?: string[];
  additionalProperties?: boolean | JSONSchema7;
  items?: JSONSchema7 | JSONSchema7[];
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  oneOf?: JSONSchema7[];
  anyOf?: JSONSchema7[];
  allOf?: JSONSchema7[];
}

// ---------------------------------------------------------------------------
// 权限策略——M1 简化实现，M9 再扩展完整规则
// ---------------------------------------------------------------------------

export interface PermissionPolicy {
  mode: "read-only" | "auto-safe" | "full-access";
  defaultLevel: PermissionLevel;
  allow: PermissionRules;
  deny: PermissionRules;
  secretPatterns: RegExp[];
}

export interface PermissionRules {
  commands: string[];
  paths: string[];
  domains: string[];
  tools: string[];
  mcpServers: string[];
  plugins: string[];
}

// ---------------------------------------------------------------------------
// 结构化日志——M1 最小接口
// ---------------------------------------------------------------------------

export interface StructuredLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// 工具执行上下文——对应 DESIGN.md 第 4.1 节
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
  sessionId: string;
  callId: string;
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  permissions: PermissionPolicy;
  logger: StructuredLogger;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// 工具错误结构
// ---------------------------------------------------------------------------

export interface ToolErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 工具执行结果——对应 DESIGN.md 第 4.1 节
// ---------------------------------------------------------------------------

export interface ToolResult<TOutput = unknown> {
  success: boolean;
  output: TOutput | null;
  error: ToolErrorPayload | null;
  durationMs: number;
  startedAt: string;
  endedAt: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 工具统一接口——对应 DESIGN.md 第 4.1 节
// ---------------------------------------------------------------------------

export interface ITool<TInput extends object = object, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  inputValidator: ZodType<TInput>;
  permissionLevel: PermissionLevel;
  defaultTimeoutMs: number;
  idempotencyKey(input: TInput, context: ToolExecutionContext): string;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult<TOutput>>;
}
