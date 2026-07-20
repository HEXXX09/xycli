// ============================================================================
// Agent 循环测试
// ============================================================================

import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runAgent } from "./agent-loop.js";
import type { AgentRunConfig } from "./agent-loop.js";
import { MockAnthropicProvider, makeTextResponse, makeToolCallResponse, makeTextThenToolCallResponse } from "../../test/fixtures/mock-anthropic.js";
import { DefaultToolRegistry } from "../tools/registry.js";
import { registerBuiltins } from "../tools/builtins.js";
import { JsonSessionStore } from "../session/json-store.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xycli-agent-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function setupConfig(
  overrides: Partial<AgentRunConfig> & { responses: ReturnType<typeof makeTextResponse>[] }
): AgentRunConfig {
  const provider = new MockAnthropicProvider(overrides.responses);
  const toolRegistry = new DefaultToolRegistry();
  registerBuiltins(toolRegistry);
  const sessionStore = new JsonSessionStore(overrides.cwd ?? process.cwd());

  return {
    prompt: "test prompt",
    model: "claude-sonnet-4-5-20250929",
    maxTurns: 5,
    cwd: process.cwd(),
    provider,
    toolRegistry,
    sessionStore,
    ...overrides,
  };
}

describe("AgentLoop", () => {
  describe("simple text response", () => {
    it("completes in one turn with a text response", async () => {
      await withTempDir(async (dir) => {
        const config = setupConfig({
          cwd: dir,
          responses: [makeTextResponse("Hello! I have completed your task.")],
        });

        const result = await runAgent(config);
        expect(result.status).toBe("completed");
        expect(result.turns).toBe(1);
        expect(result.finalMessage).toContain("Hello");
      });
    });

    it("creates a session with messages", async () => {
      await withTempDir(async (dir) => {
        const sessionStore = new JsonSessionStore(dir);
        const provider = new MockAnthropicProvider([
          makeTextResponse("Task done."),
        ]);
        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);

        const result = await runAgent({
          prompt: "Do something",
          model: "test-model",
          maxTurns: 5,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
        });

        // 验证会话已经保存。
        const session = await sessionStore.get(result.sessionId);
        expect(session).not.toBeNull();
        expect(session?.messages.length).toBeGreaterThanOrEqual(2); // user + assistant
        expect(session?.status).toBe("completed");
      });
    });
  });

  describe("tool call loop", () => {
    it("executes tool calls and continues", async () => {
      await withTempDir(async (dir) => {
        // 预先写入测试文件。
        await fs.mkdir(dir, { recursive: true });
        const testFile = path.join(dir, "test.txt");
        await fs.writeFile(testFile, "content of the file");

        const provider = new MockAnthropicProvider([
          makeToolCallResponse("file_read", { path: testFile }),
          makeTextResponse("I read the file. It says: content of the file. Task complete."),
        ]);
        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);
        const sessionStore = new JsonSessionStore(dir);

        const result = await runAgent({
          prompt: "Read the test file",
          model: "test-model",
          maxTurns: 5,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
        });

        expect(result.status).toBe("completed");
        expect(result.turns).toBe(2);

        // 验证会话包含工具调用。
        const session = await sessionStore.get(result.sessionId);
        expect(session?.toolCalls.length).toBeGreaterThan(0);
        expect(session?.toolCalls[0].toolName).toBe("file_read");
        expect(session?.toolCalls[0].status).toBe("succeeded");
      });
    });

    it("handles terminal_exec tool calls", async () => {
      await withTempDir(async (dir) => {
        const provider = new MockAnthropicProvider([
          makeToolCallResponse("terminal_exec", {
            command: "ls",
            args: [],
          }),
          makeTextResponse("I listed the files. Task complete."),
        ]);
        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);
        const sessionStore = new JsonSessionStore(dir);

        const result = await runAgent({
          prompt: "List files",
          model: "test-model",
          maxTurns: 5,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
        });

        expect(result.status).toBe("completed");
        const session = await sessionStore.get(result.sessionId);
        const execCalls = session?.toolCalls.filter(
          (tc) => tc.toolName === "terminal_exec"
        );
        expect(execCalls?.length).toBeGreaterThan(0);
        expect(execCalls![0].status).toBe("succeeded");
      });
    });

    it("tool with text response", async () => {
      await withTempDir(async (dir) => {
        const testFile = path.join(dir, "sample.txt");
        await fs.writeFile(testFile, "sample content here");

        const provider = new MockAnthropicProvider([
          makeTextThenToolCallResponse(
            "Let me check the file...",
            "file_read",
            { path: testFile }
          ),
          makeTextResponse("The file contains: sample content here. Done."),
        ]);
        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);
        const sessionStore = new JsonSessionStore(dir);

        const result = await runAgent({
          prompt: "Read sample.txt",
          model: "test-model",
          maxTurns: 5,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
        });

        expect(result.status).toBe("completed");
      });
    });
  });

  describe("max turns", () => {
    it("stops after reaching max turns", async () => {
      await withTempDir(async (dir) => {
        // Provider 持续返回工具调用，使循环达到最大轮次。
        const provider = new MockAnthropicProvider(
          Array.from({ length: 10 }, () =>
            makeToolCallResponse("terminal_exec", { command: "echo", args: ["hi"] })
          )
        );
        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);
        const sessionStore = new JsonSessionStore(dir);

        const result = await runAgent({
          prompt: "Loop forever",
          model: "test-model",
          maxTurns: 3,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
        });

        expect(result.turns).toBe(3);
        expect(result.status).toBe("incomplete");
        expect(result.exitCode).toBe(1);
        expect(result.finalMessage).toContain("最大轮次");

        const session = await sessionStore.get(result.sessionId);
        expect(session?.status).toBe("incomplete");
        expect(session?.currentState).toBe("INCOMPLETE");
      });
    });

    it("模型输出达到长度限制时标记为未完成", async () => {
      await withTempDir(async (dir) => {
        const response = makeTextResponse("部分响应");
        response.finishReason = "length";
        const config = setupConfig({ cwd: dir, responses: [response] });

        const result = await runAgent(config);

        expect(result.status).toBe("incomplete");
        expect(result.exitCode).toBe(1);
        expect(result.finalMessage).toContain("部分响应");
        expect(result.finalMessage).toContain("截断");
      });
    });
  });

  describe("error handling", () => {
    it("records failed tool calls but continues", async () => {
      await withTempDir(async (dir) => {
        const provider = new MockAnthropicProvider([
          makeToolCallResponse("file_read", { path: "/nonexistent/file.txt" }),
          makeTextResponse("The file was not found. Let me try something else."),
        ]);
        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);
        const sessionStore = new JsonSessionStore(dir);

        const result = await runAgent({
          prompt: "Read missing file",
          model: "test-model",
          maxTurns: 5,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
        });

        // 工具失败后 Agent 仍应继续生成最终响应。
        expect(result.status).toBe("completed");

        const session = await sessionStore.get(result.sessionId);
        expect(session?.toolCalls[0].status).toBe("failed");
      });
    });

    it("handles unknown tool names", async () => {
      await withTempDir(async (dir) => {
        const provider = new MockAnthropicProvider([
          makeToolCallResponse("unknown_tool", {}),
          makeTextResponse("That tool doesn't exist, but I can still help."),
        ]);
        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);
        const sessionStore = new JsonSessionStore(dir);

        const result = await runAgent({
          prompt: "Use unknown tool",
          model: "test-model",
          maxTurns: 5,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
        });

        expect(result.status).toBe("completed");
        const session = await sessionStore.get(result.sessionId);
        expect(session?.toolCalls.length).toBeGreaterThan(0);
      });
    });
  });

  describe("interruption", () => {
    it("interrupts when signal is already aborted", async () => {
      await withTempDir(async (dir) => {
        const abortController = new AbortController();
        abortController.abort(); // Already aborted

        const provider = new MockAnthropicProvider([
          makeTextResponse("Should not reach here"),
        ]);
        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);
        const sessionStore = new JsonSessionStore(dir);

        const result = await runAgent({
          prompt: "Do something",
          model: "test-model",
          maxTurns: 5,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
          signal: abortController.signal,
        });

        expect(result.status).toBe("interrupted");
        expect(result.exitCode).toBe(1);
      });
    });

    it("将 AbortSignal 传递给 Provider 请求", async () => {
      await withTempDir(async (dir) => {
        const abortController = new AbortController();
        let receivedSignal: AbortSignal | undefined;
        const provider = new MockAnthropicProvider([makeTextResponse("完成")]);
        provider.onRequest = (request) => {
          receivedSignal = request.signal;
        };
        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);

        await runAgent({
          prompt: "测试信号",
          model: "test-model",
          maxTurns: 2,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore: new JsonSessionStore(dir),
          signal: abortController.signal,
        });

        expect(receivedSignal).toBe(abortController.signal);
      });
    });

    it("Provider 请求期间中断时返回 interrupted", async () => {
      await withTempDir(async (dir) => {
        const abortController = new AbortController();
        const provider = new MockAnthropicProvider([makeTextResponse("不会返回")]);
        provider.onRequest = (request) => {
          abortController.abort();
          request.signal?.throwIfAborted();
        };
        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);

        const result = await runAgent({
          prompt: "中断请求",
          model: "test-model",
          maxTurns: 2,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore: new JsonSessionStore(dir),
          signal: abortController.signal,
        });

        expect(result.status).toBe("interrupted");
        expect(result.exitCode).toBe(1);
      });
    });
  });

  describe("会话恢复", () => {
    it("在已有会话中追加用户消息并保留上下文", async () => {
      await withTempDir(async (dir) => {
        const provider = new MockAnthropicProvider([
          makeTextResponse("第一轮完成"),
          makeTextResponse("第二轮完成"),
        ]);
        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);
        const sessionStore = new JsonSessionStore(dir);

        const first = await runAgent({
          prompt: "第一条消息",
          model: "test-model",
          maxTurns: 2,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
        });
        const second = await runAgent({
          prompt: "第二条消息",
          model: "test-model",
          maxTurns: 2,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
          sessionId: first.sessionId,
        });

        expect(second.sessionId).toBe(first.sessionId);
        const session = await sessionStore.get(first.sessionId);
        expect(session?.messages.filter((message) => message.role === "user"))
          .toHaveLength(2);
        expect(provider.requests[1].messages.some((message) =>
          typeof message.content === "string" && message.content === "第一条消息"
        )).toBe(true);
      });
    });
  });
});
