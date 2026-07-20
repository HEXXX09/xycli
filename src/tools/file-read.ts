// ============================================================================
// file_read 工具——读取文件及指定行范围
// ============================================================================

import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ITool, ToolResult, ToolExecutionContext, JSONSchema7 } from "./types.js";
import type { PermissionLevel } from "../core/types.js";
import { z } from "zod";
import {
  resolveExistingWorkspacePath,
  WorkspacePathError,
} from "./path-policy.js";

// ---------------------------------------------------------------------------
// 输入输出类型
// ---------------------------------------------------------------------------

export interface FileReadInput {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}

export interface FileReadOutput {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  sha256: string;
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

const fileReadInputValidator = z.object({
  path: z.string().min(1).max(4096),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  maxBytes: z.number().int().min(1).max(DEFAULT_MAX_BYTES).optional(),
}).strict().refine(
  (input) => input.endLine === undefined || input.startLine === undefined || input.endLine >= input.startLine,
  { message: "endLine 必须大于或等于 startLine", path: ["endLine"] }
);

export class FileReadTool implements ITool<FileReadInput, FileReadOutput> {
  name = "file_read";
  description =
    "读取工作区内文件，可指定行范围。超过 2 MiB 的文件会被截断，并返回 SHA-256。";
  permissionLevel: PermissionLevel = "read-only";
  defaultTimeoutMs = 30_000;
  inputValidator = fileReadInputValidator;

  inputSchema: JSONSchema7 = {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "要读取的工作区内文件路径",
      },
      startLine: {
        type: "number",
        minimum: 1,
        description: "起始行，从 1 开始，默认第 1 行",
      },
      endLine: {
        type: "number",
        minimum: 1,
        description: "结束行，包含该行，默认到文件末尾",
      },
      maxBytes: {
        type: "number",
        minimum: 1,
        maximum: DEFAULT_MAX_BYTES,
        description: "最大读取字节数，默认 2 MiB",
      },
    },
    required: ["path"],
    additionalProperties: false,
  };

  idempotencyKey(input: FileReadInput, _context: ToolExecutionContext): string {
    return `file_read:${input.path}:${input.startLine ?? 0}:${input.endLine ?? 0}`;
  }

  async execute(
    input: FileReadInput,
    context: ToolExecutionContext
  ): Promise<ToolResult<FileReadOutput>> {
    const startedAt = new Date().toISOString();
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;

    try {
      // 统一解析真实路径，避免绝对路径、.. 和符号链接逃逸工作区。
      const resolvedPath = await resolveExistingWorkspacePath(input.path, context.cwd);

      // 检查目标是否为可访问的普通文件。
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(resolvedPath);
      } catch {
        return {
          success: false,
          output: null,
          error: {
            code: "FILE_NOT_FOUND",
            message: `File not found: ${input.path}`,
            retryable: false,
            details: { path: input.path, resolvedPath },
          },
          durationMs: 0,
          startedAt,
          endedAt: new Date().toISOString(),
          metadata: {},
        };
      }

      if (!stat.isFile()) {
        return {
          success: false,
          output: null,
          error: {
            code: "NOT_A_FILE",
            message: `Path is not a file: ${input.path}`,
            retryable: false,
            details: { path: input.path, resolvedPath },
          },
          durationMs: 0,
          startedAt,
          endedAt: new Date().toISOString(),
          metadata: {},
        };
      }

      // 按大小限制读取文件。
      let content: string;
      if (stat.size > maxBytes) {
        // 大文件只读取前 maxBytes 个字节。
        const buf = Buffer.alloc(maxBytes);
        const fd = await fs.open(resolvedPath, "r");
        try {
          await fd.read(buf, 0, maxBytes, 0);
        } finally {
          await fd.close();
        }
        content = buf.toString("utf-8");
      } else {
        content = await fs.readFile(resolvedPath, "utf-8");
      }

      const truncated = stat.size > maxBytes;
      const lines = content.split("\n");

      // 截取用户指定的行范围。
      const startLine = input.startLine ?? 1;
      const endLine = input.endLine ?? lines.length;
      const selectedLines = lines.slice(Math.max(0, startLine - 1), endLine);
      const selectedContent = selectedLines.join("\n");

      const sha256 = createHash("sha256").update(content).digest("hex");

      const endedAt = new Date().toISOString();
      return {
        success: true,
        output: {
          path: input.path,
          content: selectedContent,
          startLine,
          endLine: Math.min(endLine, lines.length),
          totalLines: lines.length,
          truncated,
          sha256,
        },
        error: null,
        durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
        startedAt,
        endedAt,
        metadata: {
          fileSize: stat.size,
          resolvedPath,
        },
      };
    } catch (err: unknown) {
      const endedAt = new Date().toISOString();
      const message = err instanceof Error ? err.message : "Unknown error reading file";
      return {
        success: false,
        output: null,
        error: {
          code: err instanceof WorkspacePathError
            ? err.code
            : (err as NodeJS.ErrnoException)?.code === "ENOENT"
              ? "FILE_NOT_FOUND"
              : "FILE_READ_ERROR",
          message,
          retryable: false,
          details: { path: input.path },
        },
        durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
        startedAt,
        endedAt,
        metadata: {},
      };
    }
  }
}
