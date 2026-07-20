// ============================================================================
// 工具注册中心——统一负责注册、校验和执行
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { ITool, ToolResult, ToolExecutionContext } from "./types.js";
import type { PermissionLevel } from "../core/types.js";
import type { StructuredLogger } from "./types.js";
import { ToolError } from "../core/errors.js";
import { PermissionGuard, type PermissionMode } from "../core/permission-guard.js";

// ---------------------------------------------------------------------------
// M1 最小权限策略，M9 再扩展完整规则
// ---------------------------------------------------------------------------

function defaultPolicy(mode: PermissionMode) {
  return {
    mode,
    defaultLevel: "read-only" as PermissionLevel,
    allow: { commands: [], paths: [], domains: [], tools: [], mcpServers: [], plugins: [] },
    deny: { commands: [], paths: [], domains: [], tools: [], mcpServers: [], plugins: [] },
    secretPatterns: [] as RegExp[],
  };
}

function defaultLogger(): StructuredLogger {
  return {
    info: (_msg, _data?) => {},
    warn: (_msg, _data?) => {},
    error: (_msg, _data?) => {},
  };
}

// ---------------------------------------------------------------------------
// 工具注册中心接口与默认实现
// ---------------------------------------------------------------------------

export interface ToolRegistry {
  register(tool: ITool): void;
  get(name: string): ITool | undefined;
  getAll(): ITool[];
  list(): Array<{ name: string; description: string }>;
  execute(
    name: string,
    input: object,
    sessionId: string,
    cwd: string,
    signal?: AbortSignal,
    permissionMode?: PermissionMode
  ): Promise<ToolResult>;
}

export class DefaultToolRegistry implements ToolRegistry {
  private tools = new Map<string, ITool>();

  register(tool: ITool): void {
    if (this.tools.has(tool.name)) {
      throw new ToolError(`工具“${tool.name}”已经注册。`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  getAll(): ITool[] {
    return Array.from(this.tools.values());
  }

  list(): Array<{ name: string; description: string }> {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  async execute(
    name: string,
    input: object,
    sessionId: string,
    cwd: string,
    signal?: AbortSignal,
    permissionMode: PermissionMode = "auto-safe"
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: null,
        error: {
          code: "TOOL_NOT_FOUND",
          message: `工具“${name}”尚未注册。可用工具：${Array.from(this.tools.keys()).join(", ")}`,
          retryable: false,
          details: {},
        },
        durationMs: 0,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        metadata: {},
      };
    }

    if (!PermissionGuard.check(tool.permissionLevel, permissionMode)) {
      const denied = PermissionGuard.deniedPayload({
        toolName: tool.name,
        requiredLevel: tool.permissionLevel,
        mode: permissionMode,
      });
      const timestamp = new Date().toISOString();
      return {
        success: false,
        output: null,
        error: denied,
        durationMs: 0,
        startedAt: timestamp,
        endedAt: timestamp,
        metadata: {},
      };
    }

    const callId = uuidv4();
    const startedAt = new Date().toISOString();

    // 将工具超时和调用方中断信号合并到同一个控制器。
    const abortController = new AbortController();
    const timeoutMs = tool.defaultTimeoutMs || 120_000;
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    const abortListener = () => abortController.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    }

    const context: ToolExecutionContext = {
      sessionId,
      callId,
      cwd,
      env: { ...process.env } as Record<string, string>,
      signal: abortController.signal,
      permissions: defaultPolicy(permissionMode),
      logger: defaultLogger(),
      startedAt,
    };

    try {
      const parsed = tool.inputValidator.safeParse(input);
      if (!parsed.success) {
        return {
          success: false,
          output: null,
          error: {
            code: "INVALID_TOOL_INPUT",
            message: `工具“${name}”的输入参数无效。`,
            retryable: false,
            details: {
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            },
          },
          durationMs: Date.now() - new Date(startedAt).getTime(),
          startedAt,
          endedAt: new Date().toISOString(),
          metadata: {},
        };
      }

      const validatedInput = parsed.data;
      const idempotencyKey = tool.idempotencyKey(validatedInput, context);
      context.logger.info(`Executing tool: ${name}`, { callId, idempotencyKey });

      const result = await tool.execute(validatedInput, context);
      result.startedAt = startedAt;
      result.endedAt = result.endedAt || new Date().toISOString();

      return result;
    } catch (err: unknown) {
      const endedAt = new Date().toISOString();
      const durationMs = Date.now() - new Date(startedAt).getTime();

      if (err instanceof ToolError) {
        return {
          success: false,
          output: null,
          error: {
            code: err.code,
            message: err.message,
            retryable: err.retryable,
            details: err.details,
          },
          durationMs,
          startedAt,
          endedAt,
          metadata: {},
        };
      }

      const message = err instanceof Error ? err.message : "未知工具执行错误";
      return {
        success: false,
        output: null,
        error: {
          code: "TOOL_EXECUTION_ERROR",
          message,
          retryable: false,
          details: {},
        },
        durationMs,
        startedAt,
        endedAt,
        metadata: {},
      };
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortListener);
    }
  }
}
