// ============================================================================
// Agent Loop — observe → plan → act → reflect cycle
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { IProvider, ProviderMessage, ProviderToolDefinition, NormalizedToolCall } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SessionStore, Session, Message, ToolCallRecord } from "../session/types.js";
import type { AgentLoopState, SessionStatus } from "./types.js";
import { buildSystemPrompt } from "./prompts.js";
import { ProviderError, ToolError } from "./errors.js";
import { PermissionGuard } from "./permission-guard.js";
import type { PermissionMode } from "./permission-guard.js";

// ---------------------------------------------------------------------------
// Configuration
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
}

export interface AgentRunResult {
  sessionId: string;
  status: SessionStatus;
  turns: number;
  finalMessage: string;
}

// ---------------------------------------------------------------------------
// runAgent — entry point for CLI
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
  } = config;

  // Construct permission guard
  const permissionGuard = new PermissionGuard(permissionMode);

  // Create session
  const sessionId = uuidv4();
  const now = new Date().toISOString();

  const session: Session = {
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

  // Build tool definitions for provider
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

  try {
    while (turns < maxTurns && status === "running") {
      // Check for abort signal
      if (signal?.aborted) {
        status = "interrupted";
        finalMessage = "Session interrupted by user.";
        currentState = "ERROR";
        break;
      }

      turns++;
      currentState = turns === 1 ? "PLANNING" : "ACTING";

      // Build messages for provider
      const providerMessages: ProviderMessage[] = buildProviderMessages(session);

      // Call provider
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
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Provider error";
        throw new ProviderError(message, { retryable: false });
      }

      // Update token counts
      session.totalInputTokens += response.usage.inputTokens;
      session.totalOutputTokens += response.usage.outputTokens;

      // Record assistant message
      const assistantMsg: Message = {
        id: uuidv4(),
        role: "assistant",
        content: extractTextContent(response.message),
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
        sequence: session.messages.length,
        createdAt: new Date().toISOString(),
      };
      session.messages.push(assistantMsg);

      // Handle finish reason
      if (response.finishReason === "stop" || response.finishReason === "length") {
        status = "completed";
        currentState = "COMPLETED";
        finalMessage = extractTextContent(response.message);
        break;
      }

      if (response.finishReason === "tool_calls" && response.toolCalls.length > 0) {
        currentState = "ACTING";

        // Execute tool calls
        for (const toolCall of response.toolCalls) {
          if (signal?.aborted) {
            status = "interrupted";
            break;
          }

          const startedAt = new Date().toISOString();

          // -----------------------------------------------------------------
          // Permission check (M1-T09)
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
          // Execute tool
          // -----------------------------------------------------------------
          const toolResult = await toolRegistry.execute(
            toolCall.name,
            toolCall.input,
            sessionId,
            cwd,
            signal
          );

          const endedAt = new Date().toISOString();

          // Record tool call
          const record: ToolCallRecord = {
            id: toolCall.id,
            toolName: toolCall.name,
            input: toolCall.input,
            output: toolResult.output,
            error: toolResult.error?.message ?? null,
            status: toolResult.success ? "succeeded" : "failed",
            durationMs: toolResult.durationMs,
            startedAt,
            endedAt,
          };
          session.toolCalls.push(record);

          // Add tool result message
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

      // Unknown finish reason — stop
      status = "completed";
      currentState = "COMPLETED";
      finalMessage = extractTextContent(response.message);
      break;
    }
  } catch (err: unknown) {
    status = "error";
    currentState = "ERROR";
    finalMessage = err instanceof Error ? err.message : "Unknown error";

    // Log error but don't crash
    console.error(`\nError: ${finalMessage}`);
  }

  // Update session with final state
  session.status = status;
  session.currentState = currentState;
  session.completedAt = new Date().toISOString();
  session.updatedAt = new Date().toISOString();

  try {
    await sessionStore.update(session);
  } catch {
    // Best effort
    console.error("Warning: Failed to save session state.");
  }

  return {
    sessionId,
    status,
    turns,
    finalMessage,
  };
}

// ---------------------------------------------------------------------------
// Build provider messages from session history
// ---------------------------------------------------------------------------

function buildProviderMessages(session: Session): ProviderMessage[] {
  const messages: ProviderMessage[] = [];

  for (const msg of session.messages) {
    if (msg.role === "system") continue; // System goes separately

    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      // Assistant message with tool calls
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
      // Tool result message
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
      // Simple text message
      messages.push({
        role: msg.role as ProviderMessage["role"],
        content: msg.content,
      });
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Extract text content from provider message
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
