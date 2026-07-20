// ============================================================================
// 工具注册中心与内置工具测试
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { DefaultToolRegistry } from "./registry.js";
import { registerBuiltins } from "./builtins.js";
import { FileReadTool } from "./file-read.js";
import { FileWriteTool } from "./file-write.js";
import { TerminalExecTool } from "./terminal-exec.js";
import type { ToolRegistry } from "./registry.js";
import type { ITool } from "./types.js";

// ---------------------------------------------------------------------------
// 测试辅助方法
// ---------------------------------------------------------------------------

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xycli-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 工具注册中心测试
// ---------------------------------------------------------------------------

describe("DefaultToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new DefaultToolRegistry();
  });

  it("registers and retrieves a tool", () => {
    const tool = new FileReadTool();
    registry.register(tool);
    expect(registry.get("file_read")).toBe(tool);
  });

  it("throws when registering duplicate tool name", () => {
    registry.register(new FileReadTool());
    expect(() => registry.register(new FileReadTool())).toThrow(
      /已经注册/
    );
  });

  it("returns undefined for unknown tool", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("lists all registered tools", () => {
    registerBuiltins(registry);
    const list = registry.list();
    expect(list).toHaveLength(3);
    expect(list.map((t) => t.name).sort()).toEqual([
      "file_read",
      "file_write",
      "terminal_exec",
    ]);
  });

  it("getAll returns tool instances", () => {
    registerBuiltins(registry);
    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all[0]).toBeDefined();
  });

  it("execute returns error for unknown tool", async () => {
    const result = await registry.execute(
      "nonexistent",
      {},
      "session-1",
      process.cwd()
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
  });

  it("rejects invalid tool input before execution", async () => {
    registry.register(new FileReadTool());
    const result = await registry.execute(
      "file_read",
      { path: 123 } as unknown as object,
      "session-1",
      process.cwd()
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_TOOL_INPUT");
    expect(result.error?.details.issues).toBeDefined();
  });

  it("直接调用注册中心时仍强制执行权限模式", async () => {
    registry.register(new FileWriteTool());
    const result = await registry.execute(
      "file_write",
      { path: "blocked.txt", content: "blocked" },
      "session-1",
      process.cwd(),
      undefined,
      "read-only"
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
  });
});

// ---------------------------------------------------------------------------
// FileReadTool 测试
// ---------------------------------------------------------------------------

describe("FileReadTool", () => {
  it("reads an existing file with content", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "test.txt");
      const content = "line1\nline2\nline3";
      await fs.writeFile(filePath, content);

      const tool = new FileReadTool();
      const result = await tool.execute(
        { path: filePath },
        {
          sessionId: "test",
          callId: "1",
          cwd: dir,
          env: {},
          signal: new AbortController().signal,
          permissions: {} as any,
          logger: { info() {}, warn() {}, error() {} },
          startedAt: new Date().toISOString(),
        }
      );

      expect(result.success).toBe(true);
      expect(result.output?.content).toContain("line1");
      expect(result.output?.totalLines).toBe(3);
      expect(result.output?.sha256).toBeDefined();
      expect(result.output?.truncated).toBe(false);
    });
  });

  it("returns error for non-existent file", async () => {
    const tool = new FileReadTool();
    const result = await tool.execute(
      { path: "/nonexistent/file.txt" },
      {
        sessionId: "test",
        callId: "1",
        cwd: "/",
        env: {},
        signal: new AbortController().signal,
        permissions: {} as any,
        logger: { info() {}, warn() {}, error() {} },
        startedAt: new Date().toISOString(),
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("FILE_NOT_FOUND");
  });

  it("supports line range reading", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "range.txt");
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
      await fs.writeFile(filePath, lines.join("\n"));

      const tool = new FileReadTool();
      const result = await tool.execute(
        { path: filePath, startLine: 5, endLine: 10 },
        {
          sessionId: "test",
          callId: "1",
          cwd: dir,
          env: {},
          signal: new AbortController().signal,
          permissions: {} as any,
          logger: { info() {}, warn() {}, error() {} },
          startedAt: new Date().toISOString(),
        }
      );

      expect(result.success).toBe(true);
      expect(result.output?.startLine).toBe(5);
      expect(result.output?.endLine).toBe(10);
      expect(result.output?.content).toContain("line5");
      expect(result.output?.content).not.toContain("line20");
    });
  });

  it("returns error for directories", async () => {
    await withTempDir(async (dir) => {
      const tool = new FileReadTool();
      const result = await tool.execute(
        { path: dir },
        {
          sessionId: "test",
          callId: "1",
          cwd: dir,
          env: {},
          signal: new AbortController().signal,
          permissions: {} as any,
          logger: { info() {}, warn() {}, error() {} },
          startedAt: new Date().toISOString(),
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("NOT_A_FILE");
    });
  });

  it("rejects paths outside the workspace", async () => {
    await withTempDir(async (dir) => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "xycli-outside-"));
      try {
        const outsideFile = path.join(outsideDir, "secret.txt");
        await fs.writeFile(outsideFile, "secret");
        const registry = new DefaultToolRegistry();
        registry.register(new FileReadTool());

        const result = await registry.execute(
          "file_read",
          { path: outsideFile },
          "session-1",
          dir
        );

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("rejects symlinks that escape the workspace", async () => {
    await withTempDir(async (dir) => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "xycli-link-outside-"));
      try {
        const outsideFile = path.join(outsideDir, "secret.txt");
        const linkPath = path.join(dir, "secret-link.txt");
        await fs.writeFile(outsideFile, "secret");
        await fs.symlink(outsideFile, linkPath);
        const registry = new DefaultToolRegistry();
        registry.register(new FileReadTool());

        const result = await registry.execute(
          "file_read",
          { path: "secret-link.txt" },
          "session-1",
          dir
        );

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// FileWriteTool 测试
// ---------------------------------------------------------------------------

describe("FileWriteTool", () => {
  it("creates a new file", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "newfile.txt");
      const tool = new FileWriteTool();

      const result = await tool.execute(
        { path: filePath, content: "hello world", createIfMissing: true },
        {
          sessionId: "test",
          callId: "1",
          cwd: dir,
          env: {},
          signal: new AbortController().signal,
          permissions: {} as any,
          logger: { info() {}, warn() {}, error() {} },
          startedAt: new Date().toISOString(),
        }
      );

      expect(result.success).toBe(true);
      expect(result.output?.created).toBe(true);
      expect(result.output?.preImageSha256).toBeNull();
      expect(result.output?.postImageSha256).toBeDefined();
      expect(result.output?.unifiedDiff).toContain("+hello world");

      // 验证文件已经实际写入。
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello world");
    });
  });

  it("overwrites an existing file", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "existing.txt");
      await fs.writeFile(filePath, "old content");

      const tool = new FileWriteTool();
      const result = await tool.execute(
        { path: filePath, content: "new content", createIfMissing: false },
        {
          sessionId: "test",
          callId: "1",
          cwd: dir,
          env: {},
          signal: new AbortController().signal,
          permissions: {} as any,
          logger: { info() {}, warn() {}, error() {} },
          startedAt: new Date().toISOString(),
        }
      );

      expect(result.success).toBe(true);
      expect(result.output?.created).toBe(false);
      expect(result.output?.preImageSha256).toBeDefined();
      expect(result.output?.unifiedDiff).toContain("-old content");
      expect(result.output?.unifiedDiff).toContain("+new content");

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("new content");
    });
  });

  it("rejects if createIfMissing is false and file doesn't exist", async () => {
    await withTempDir(async (dir) => {
      const tool = new FileWriteTool();
      const result = await tool.execute(
        {
          path: path.join(dir, "nonexistent.txt"),
          content: "test",
          createIfMissing: false,
        },
        {
          sessionId: "test",
          callId: "1",
          cwd: dir,
          env: {},
          signal: new AbortController().signal,
          permissions: {} as any,
          logger: { info() {}, warn() {}, error() {} },
          startedAt: new Date().toISOString(),
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("FILE_NOT_FOUND");
    });
  });

  it("detects hash mismatch", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "hashcheck.txt");
      await fs.writeFile(filePath, "actual content");

      const tool = new FileWriteTool();
      const result = await tool.execute(
        {
          path: filePath,
          content: "new content",
          createIfMissing: false,
          expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
        },
        {
          sessionId: "test",
          callId: "1",
          cwd: dir,
          env: {},
          signal: new AbortController().signal,
          permissions: {} as any,
          logger: { info() {}, warn() {}, error() {} },
          startedAt: new Date().toISOString(),
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("HASH_MISMATCH");
    });
  });

  it("rejects writes outside the workspace", async () => {
    await withTempDir(async (dir) => {
      const registry = new DefaultToolRegistry();
      registry.register(new FileWriteTool());
      const result = await registry.execute(
        "file_write",
        { path: "../escaped.txt", content: "blocked", createIfMissing: true },
        "session-1",
        dir
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
    });
  });
});

// ---------------------------------------------------------------------------
// TerminalExecTool 测试
// ---------------------------------------------------------------------------

describe("TerminalExecTool", () => {
  it("executes a simple command and returns output", async () => {
    const tool = new TerminalExecTool();
    const result = await tool.execute(
      { command: "echo", args: ["hello", "world"] },
      {
        sessionId: "test",
        callId: "1",
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        signal: new AbortController().signal,
        permissions: {} as any,
        logger: { info() {}, warn() {}, error() {} },
        startedAt: new Date().toISOString(),
      }
    );

    expect(result.success).toBe(true);
    expect(result.output?.stdout).toContain("hello world");
    expect(result.output?.exitCode).toBe(0);
  });

  it("reports non-zero exit codes", async () => {
    const tool = new TerminalExecTool();
    const result = await tool.execute(
      { command: "sh", args: ["-c", "exit 1"] },
      {
        sessionId: "test",
        callId: "1",
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        signal: new AbortController().signal,
          permissions: { mode: "full-access" } as any,
        logger: { info() {}, warn() {}, error() {} },
        startedAt: new Date().toISOString(),
      }
    );

    expect(result.output?.exitCode).toBe(1);
  });

  it("lists files in current directory", async () => {
    const tool = new TerminalExecTool();
    const result = await tool.execute(
      { command: "ls" },
      {
        sessionId: "test",
        callId: "1",
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        signal: new AbortController().signal,
        permissions: {} as any,
        logger: { info() {}, warn() {}, error() {} },
        startedAt: new Date().toISOString(),
      }
    );

    expect(result.success).toBe(true);
    expect(result.output?.stdout).toContain("package.json");
  });

  it("handles invalid commands gracefully", async () => {
    const tool = new TerminalExecTool();
    const result = await tool.execute(
      { command: "nonexistent_command_xyz_123" },
      {
        sessionId: "test",
        callId: "1",
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        signal: new AbortController().signal,
        permissions: {} as any,
        logger: { info() {}, warn() {}, error() {} },
        startedAt: new Date().toISOString(),
      }
    );

    // 不存在的命令不应返回成功退出码。
    expect(result.output?.exitCode).not.toBe(0);
  });

  it("rejects shell command strings instead of interpreting them", async () => {
    const registry = new DefaultToolRegistry();
    registry.register(new TerminalExecTool());
    const result = await registry.execute(
      "terminal_exec",
      { command: "echo injected" },
      "session-1",
      process.cwd(),
      undefined,
      "full-access"
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_TOOL_INPUT");
  });

  it("blocks commands outside the auto-safe allowlist", async () => {
    const registry = new DefaultToolRegistry();
    registry.register(new TerminalExecTool());
    const result = await registry.execute(
      "terminal_exec",
      { command: "sh", args: ["-c", "echo unsafe"] },
      "session-1",
      process.cwd(),
      undefined,
      "auto-safe"
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("UNSAFE_COMMAND");
  });

  it("allows an explicit executable and args in full-access mode", async () => {
    const registry = new DefaultToolRegistry();
    registry.register(new TerminalExecTool());
    const result = await registry.execute(
      "terminal_exec",
      { command: "echo", args: ["hello", "world"] },
      "session-1",
      process.cwd(),
      undefined,
      "full-access"
    );

    expect(result.success).toBe(true);
    expect((result.output as { stdout: string }).stdout).toContain("hello world");
  });

  it("auto-safe 不会执行工作区 PATH 中伪装成白名单命令的程序", async () => {
    await withTempDir(async (dir) => {
      const fakeLs = path.join(dir, "ls");
      const marker = path.join(dir, "executed.txt");
      await fs.writeFile(fakeLs, `#!/bin/sh\ntouch "${marker}"\n`);
      await fs.chmod(fakeLs, 0o755);
      const tool = new TerminalExecTool();

      const result = await tool.execute(
        { command: "ls" },
        {
          sessionId: "test",
          callId: "1",
          cwd: dir,
          env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` } as Record<string, string>,
          signal: new AbortController().signal,
          permissions: { mode: "auto-safe" } as any,
          logger: { info() {}, warn() {}, error() {} },
          startedAt: new Date().toISOString(),
        }
      );

      expect(result.success).toBe(true);
      await expect(fs.stat(marker)).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// 内置工具注册测试
// ---------------------------------------------------------------------------

describe("registerBuiltins", () => {
  it("registers all 3 M1 tools", () => {
    const registry = new DefaultToolRegistry();
    registerBuiltins(registry);

    expect(registry.get("file_read")).toBeDefined();
    expect(registry.get("file_write")).toBeDefined();
    expect(registry.get("terminal_exec")).toBeDefined();
    expect(registry.getAll()).toHaveLength(3);
  });

  it("each builtin implements ITool correctly", () => {
    const tools: ITool[] = [
      new FileReadTool(),
      new FileWriteTool(),
      new TerminalExecTool(),
    ];

    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.permissionLevel).toBeDefined();
      expect(tool.defaultTimeoutMs).toBeGreaterThan(0);
      expect(typeof tool.idempotencyKey).toBe("function");
      expect(typeof tool.execute).toBe("function");
    }
  });
});
