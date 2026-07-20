// ============================================================================
// M1 集成测试——使用模拟 Provider 验证完整 Agent 流程
// ============================================================================

import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runAgent } from "../../src/core/agent-loop.js";
import { MockAnthropicProvider, makeTextResponse, makeToolCallResponse } from "../fixtures/mock-anthropic.js";
import { DefaultToolRegistry } from "../../src/tools/registry.js";
import { registerBuiltins } from "../../src/tools/builtins.js";
import { JsonSessionStore } from "../../src/session/json-store.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xycli-e2e-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("M1 E2E", () => {
  describe("Full agent loop with mock provider", () => {
    it("completes a 'list files' task using terminal_exec", async () => {
      await withTempDir(async (dir) => {
        // 准备测试文件。
        await fs.writeFile(path.join(dir, "README.md"), "# Test Project");
        await fs.writeFile(path.join(dir, "package.json"), "{}");

        // 第一次响应调用 terminal_exec，第二次响应返回最终文本。
        const provider = new MockAnthropicProvider([
          makeToolCallResponse("terminal_exec", {
            command: "ls",
          }),
          makeTextResponse(
            "I found the following files in the directory:\n- README.md\n- package.json\n\nTask complete!"
          ),
        ]);

        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);

        const sessionStore = new JsonSessionStore(dir);

        const result = await runAgent({
          prompt: "list files in current directory",
          model: "claude-sonnet-4-5-20250929",
          maxTurns: 5,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
        });

        // 验证 Agent 正常完成。
        expect(result.status).toBe("completed");
        expect(result.turns).toBe(2);

        // 验证会话已经保存。
        const session = await sessionStore.get(result.sessionId);
        expect(session).not.toBeNull();
        expect(session!.title).toContain("list files");
        expect(session!.status).toBe("completed");
        expect(session!.messages).toHaveLength(4); // user, assistant(tool_call), tool_result, assistant(final)
        expect(session!.toolCalls).toHaveLength(1);
        expect(session!.toolCalls[0].toolName).toBe("terminal_exec");
        expect(session!.toolCalls[0].status).toBe("succeeded");
        expect(session!.toolCalls[0].output).toBeDefined();

        // 验证 ls 输出包含测试文件。
        const output = session!.toolCalls[0].output as { stdout: string };
        expect(output.stdout).toBeDefined();
        expect(output.stdout).toContain("README.md");
        expect(output.stdout).toContain("package.json");

        // 验证会话文件已经写入磁盘。
        const sessionFile = path.join(dir, ".xycli", "sessions", "json", `${result.sessionId}.json`);
        const exists = await fs.stat(sessionFile).then(() => true).catch(() => false);
        expect(exists).toBe(true);

        console.log("E2E test passed:", {
          sessionId: result.sessionId,
          turns: result.turns,
          status: result.status,
        });
      });
    });

    it("handles file_read + file_write workflow", async () => {
      await withTempDir(async (dir) => {
        const testFile = path.join(dir, "config.json");
        await fs.writeFile(testFile, JSON.stringify({ version: "1.0" }));

        const provider = new MockAnthropicProvider([
          makeToolCallResponse("file_read", { path: "config.json" }),
          makeToolCallResponse("file_write", {
            path: "config.json",
            content: JSON.stringify({ version: "2.0" }, null, 2),
            createIfMissing: false,
          }),
          makeTextResponse("Updated config.json from version 1.0 to 2.0."),
        ]);

        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);
        const sessionStore = new JsonSessionStore(dir);

        const result = await runAgent({
          prompt: "update config.json version to 2.0",
          model: "claude-sonnet-4-5-20250929",
          maxTurns: 10,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
        });

        expect(result.status).toBe("completed");
        expect(result.turns).toBe(3);

        const session = await sessionStore.get(result.sessionId);
        expect(session!.toolCalls).toHaveLength(2);
        expect(session!.toolCalls[0].toolName).toBe("file_read");
        expect(session!.toolCalls[0].status).toBe("succeeded");
        expect(session!.toolCalls[1].toolName).toBe("file_write");
        expect(session!.toolCalls[1].status).toBe("succeeded");

        // 验证文件内容确实已更新。
        const updatedContent = await fs.readFile(testFile, "utf-8");
        const updated = JSON.parse(updatedContent);
        expect(updated.version).toBe("2.0");
      });
    });

    it("preserves session state across multiple turns", async () => {
      await withTempDir(async (dir) => {
        const provider = new MockAnthropicProvider([
          makeToolCallResponse("terminal_exec", { command: "echo", args: ["step1"] }),
          makeToolCallResponse("terminal_exec", { command: "echo", args: ["step2"] }),
          makeToolCallResponse("terminal_exec", { command: "echo", args: ["step3"] }),
          makeTextResponse("All steps completed."),
        ]);

        const toolRegistry = new DefaultToolRegistry();
        registerBuiltins(toolRegistry);
        const sessionStore = new JsonSessionStore(dir);

        const result = await runAgent({
          prompt: "run three steps",
          model: "test-model",
          maxTurns: 10,
          cwd: dir,
          provider,
          toolRegistry,
          sessionStore,
        });

        expect(result.status).toBe("completed");
        expect(result.turns).toBe(4);

        // 验证会话累计了全部消息和工具调用。
        const session = await sessionStore.get(result.sessionId);
        expect(session!.toolCalls).toHaveLength(3);
        expect(session!.messages.length).toBe(8); // user + 3*(assistant+tool_result) + final_assistant

        // 全部工具调用都应成功。
        for (const tc of session!.toolCalls) {
          expect(tc.status).toBe("succeeded");
        }
      });
    });
  });
});
