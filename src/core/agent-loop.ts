// ============================================================================
// Agent 循环——观察 → 规划 → 行动 → 反思
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { IProvider, ProviderMessage, ProviderToolDefinition } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SessionStore, Session, Message, ToolCallRecord } from "../session/types.js";
import type { AgentLoopState, SessionStatus } from "./types.js";
import { buildSystemPrompt } from "./prompts.js";
import { ProviderError, ValidationError, XycliError } from "./errors.js";
import { PermissionGuard } from "./permission-guard.js";
import type { PermissionMode } from "./permission-guard.js";

// ---------------------------------------------------------------------------
// 运行配置
// ---------------------------------------------------------------------------

export interface AgentRunConfig {
  prompt: string;
  model: string;
  maxTurns: number;
  cwd: string;
  provider: IProvider;
  toolRegistry: ToolRegistry;
  sessionStore: SessionStore;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  sessionId?: string;
}

export interface AgentRunResult {
  sessionId: string;
  status: SessionStatus;
  turns: number;
  finalMessage: string;
  exitCode: 0 | 1 | 2 | 3 | 4 | 5;
}

// ---------------------------------------------------------------------------
// runAgent——CLI 调用入口
// ---------------------------------------------------------------------------

export async function runAgent(config: AgentRunConfig): Promise<AgentRunResult> {
  const {
    prompt,
    model,
    maxTurns,
    cwd,
    provider,
    toolRegistry,
    sessionStore,
    permissionMode = "auto-safe",
    signal,
    sessionId: requestedSessionId,
  } = config;

  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) {
    throw new ValidationError("maxTurns 必须是 1 到 100 之间的整数。");
  }

  // 构造本次运行使用的权限守卫。
  const permissionGuard = new PermissionGuard(permissionMode);

  // 创建新会话或继续已有会话。
  const now = new Date().toISOString();
  let session: Session;
  let sessionId: string;

  if (requestedSessionId) {
    const existing = await sessionStore.get(requestedSessionId);
    if (!existing) {
      throw new ValidationError(`找不到要继续的会话: ${requestedSessionId}`);
    }
    if (existing.cwd !== cwd) {
      throw new ValidationError("不能在不同工作目录中继续已有会话。");
    }
    session = existing;
    sessionId = existing.id;
    session.status = "running";
    session.currentState = "PLANNING";
    session.providerName = provider.name;
    session.model = model;
    session.completedAt = null;
    session.messages.push({
      id: uuidv4(),
      role: "user",
      content: prompt,
      sequence: session.messages.length,
      createdAt: now,
    });
    await sessionStore.update(session);
  } else {
    sessionId = uuidv4();
    session = {
      id: sessionId,
      title: prompt.substring(0, 80),
      cwd,
      status: "running",
      currentState: "IDLE",
      plan: {},
      providerName: provider.name,
      model,
      messages: [
        {
          id: uuidv4(),
          role: "user",
          content: prompt,
          sequence: 0,
          createdAt: now,
        },
      ],
      toolCalls: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await sessionStore.create(session);
  }

  // 构造发送给 Provider 的工具定义。
  const tools = toolRegistry.getAll();
  const providerTools: ProviderToolDefinition[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Record<string, unknown>,
  }));

  const systemPrompt = buildSystemPrompt(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    cwd
  );

  let turns = 0;
  let finalMessage = "";
  let status: SessionStatus = "running";
  let currentState: AgentLoopState = "PLANNING";
  let exitCode: AgentRunResult["exitCode"] = 0;

  try {
    while (turns < maxTurns && status === "running") {
      // 每轮开始前检查中断信号。
      if (signal?.aborted) {
        status = "interrupted";
        finalMessage = "Session interrupted by user.";
        currentState = "ERROR";
        exitCode = 1;
        break;
      }

      turns++;
      currentState = turns === 1 ? "PLANNING" : "ACTING";

      // 根据会话历史构造 Provider 消息。
      const providerMessages: ProviderMessage[] = buildProviderMessages(session);

      // 请求模型给出下一步响应。
      let response;
      try {
        response = await provider.chat({
          sessionId,
          model,
          messages: providerMessages,
          tools: providerTools,
          system: systemPrompt,
          temperature: 0.2,
          maxOutputTokens: 4096,
          metadata: {},
          signal,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Provider error";
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(message, { retryable: false });
      }

      // 累加 Token 用量。
      session.totalInputTokens += response.usage.inputTokens;
      session.totalOutputTokens += response.usage.outputTokens;

      // 记录助手消息。
      const assistantMsg: Message = {
        id: uuidv4(),
        role: "assistant",
        content: extractTextContent(response.message),
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
        sequence: session.messages.length,
        createdAt: new Date().toISOString(),
      };
      session.messages.push(assistantMsg);

      // 根据结束原因决定最终状态。
      if (response.finishReason === "stop") {
        status = "completed";
        currentState = "COMPLETED";
        finalMessage = extractTextContent(response.message);
        break;
      }

      if (response.finishReason === "length") {
        status = "incomplete";
        currentState = "INCOMPLETE";
        exitCode = 1;
        const partial = extractTextContent(response.message);
        finalMessage = `${partial}${partial ? "\n\n" : ""}模型输出因长度限制被截断，任务尚未确认完成。`;
        break;
      }

      if (response.finishReason === "tool_calls" && response.toolCalls.length > 0) {
        currentState = "ACTING";

        // 按返回顺序执行工具调用。
        for (const toolCall of response.toolCalls) {
          if (signal?.aborted) {
            status = "interrupted";
            break;
          }

          const startedAt = new Date().toISOString();

          // -----------------------------------------------------------------
          // 权限级别检查（M1-T09）。
          // -----------------------------------------------------------------
          const tool = toolRegistry.get(toolCall.name);

          if (tool) {
            const decision = permissionGuard.evaluate(tool.permissionLevel);

            if (!decision.allowed) {
              const endedAt = new Date().toISOString();
              const durationMs =
                Date.now() - new Date(startedAt).getTime();
              const error = permissionGuard.deniedPayload({
                toolName: toolCall.name,
                requiredLevel: tool.permissionLevel,
              });

              const deniedRecord: ToolCallRecord = {
                id: toolCall.id,
                toolName: toolCall.name,
                input: toolCall.input,
                output: null,
                error: error.message,
                status: "denied",
                durationMs,
                startedAt,
                endedAt,
              };
              session.toolCalls.push(deniedRecord);

              const deniedMsg: Message = {
                id: uuidv4(),
                role: "tool",
                content: JSON.stringify({ error }),
                toolCallId: toolCall.id,
                sequence: session.messages.length,
                createdAt: endedAt,
              };
              session.messages.push(deniedMsg);

              continue;
            }
          }

          // -----------------------------------------------------------------
          // 执行已经通过权限检查的工具。
          // -----------------------------------------------------------------
          const toolResult = await toolRegistry.execute(
            toolCall.name,
            toolCall.input,
            sessionId,
            cwd,
            signal,
            permissionMode
          );

          const endedAt = new Date().toISOString();

          // 记录工具调用及其审计结果。
          const record: ToolCallRecord = {
            id: toolCall.id,
            toolName: toolCall.name,
            input: toolCall.input,
            output: toolResult.output,
            error: toolResult.error?.message ?? null,
            status: toolResult.success
              ? "succeeded"
              : ["UNSAFE_COMMAND", "PATH_OUTSIDE_WORKSPACE"].includes(toolResult.error?.code ?? "")
                ? "denied"
                : "failed",
            durationMs: toolResult.durationMs,
            startedAt,
            endedAt,
          };
          session.toolCalls.push(record);

          // 将工具结果追加为模型可见消息。
          const toolResultContent = toolResult.success
            ? JSON.stringify(toolResult.output)
            : `Error: ${toolResult.error?.message ?? "Unknown error"}`;

          const toolMsg: Message = {
            id: uuidv4(),
            role: "tool",
            content: toolResultContent,
            toolCallId: toolCall.id,
            sequence: session.messages.length,
            createdAt: new Date().toISOString(),
          };
          session.messages.push(toolMsg);
        }

        if (status === "interrupted") break;

        currentState = "OBSERVING";
        session.updatedAt = new Date().toISOString();
        await sessionStore.update(session);

        continue; // Next loop iteration
      }

      // 未知或错误终止原因不能当作成功。
      status = "error";
      currentState = "ERROR";
      exitCode = 4;
      finalMessage = `Provider 以异常原因结束: ${response.finishReason}`;
      break;
    }

    if (status === "running" && turns >= maxTurns) {
      status = "incomplete";
      currentState = "INCOMPLETE";
      exitCode = 1;
      finalMessage = `已达到最大轮次 ${maxTurns}，任务尚未确认完成。`;
    } else if (status === "interrupted" && !finalMessage) {
      finalMessage = "会话已被用户中断。";
      exitCode = 1;
      currentState = "ERROR";
    }
  } catch (err: unknown) {
    if (signal?.aborted) {
      status = "interrupted";
      currentState = "ERROR";
      finalMessage = "会话已被用户中断。";
      exitCode = 1;
    } else {
      status = "error";
      currentState = "ERROR";
      finalMessage = err instanceof Error ? err.message : "未知错误";
      exitCode = err instanceof XycliError ? err.exitCode : 1;
    }

    if (status === "error") {
      console.error(`\n错误: ${finalMessage}`);
    }
  }

  // 持久化会话最终状态。
  session.status = status;
  session.currentState = currentState;
  session.completedAt = new Date().toISOString();
  session.updatedAt = new Date().toISOString();

  try {
    await sessionStore.update(session);
  } catch {
    // 最终保存采用尽力而为策略，避免覆盖原始错误。
    console.error("Warning: Failed to save session state.");
  }

  return {
    sessionId,
    status,
    turns,
    finalMessage,
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// 根据会话历史构造 Provider 消息
// ---------------------------------------------------------------------------

function buildProviderMessages(session: Session): ProviderMessage[] {
  const messages: ProviderMessage[] = [];

  for (const msg of session.messages) {
    if (msg.role === "system") continue; // System goes separately

    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      // 带工具调用的助手消息。
      const blocks: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];

      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
      messages.push({ role: "assistant", content: blocks });
    } else if (msg.role === "tool" && msg.toolCallId) {
      // 工具结果在 Provider 协议中作为用户侧结果块发送。
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content: msg.content,
          },
        ],
      });
    } else {
      // 普通文本消息。
      messages.push({
        role: msg.role as ProviderMessage["role"],
        content: msg.content,
      });
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// 从 Provider 消息中提取文本内容
// ---------------------------------------------------------------------------

function extractTextContent(message: ProviderMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
