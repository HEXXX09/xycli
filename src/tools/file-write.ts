// ============================================================================
// file_write 工具——创建或覆盖工作区内文件
// ============================================================================

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ITool, ToolResult, ToolExecutionContext, JSONSchema7 } from "./types.js";
import type { PermissionLevel } from "../core/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  resolveWritableWorkspacePath,
  WorkspacePathError,
} from "./path-policy.js";

// ---------------------------------------------------------------------------
// 输入输出类型
// ---------------------------------------------------------------------------

export interface FileWriteInput {
  path: string;
  content: string;
  createIfMissing?: boolean;
  expectedSha256?: string;
}

const MAX_CONTENT_LENGTH = 2 * 1024 * 1024;
const fileWriteInputValidator = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(MAX_CONTENT_LENGTH),
  createIfMissing: z.boolean().optional(),
  expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
}).strict();

export interface FileWriteOutput {
  path: string;
  created: boolean;
  preImageSha256: string | null;
  postImageSha256: string;
  unifiedDiff: string;
}

// ---------------------------------------------------------------------------
// 轻量 unified diff 生成器
// ---------------------------------------------------------------------------

function generateUnifiedDiff(
  filePath: string,
  oldContent: string | null,
  newContent: string
): string {
  const oldLines = oldContent ? oldContent.split("\n") : [];
  const newLines = newContent.split("\n");
  const header = oldContent
    ? `--- a/${filePath}\n+++ b/${filePath}\n`
    : `--- /dev/null\n+++ b/${filePath}\n`;

  // 当前实现按整段替换生成可审计差异。
  if (!oldContent) {
    // 新建文件只包含新增行。
    const diffLines = newLines.map((l) => `+${l}`);
    return `${header}@@ -0,0 +1,${newLines.length} @@\n${diffLines.join("\n")}\n`;
  }

  if (oldContent === newContent) {
    return `${header}@@ -1,${oldLines.length} +1,${newLines.length} @@\n (no changes)\n`;
  }

  // 已有文件先寻找公共前后缀，再输出变化区段。
  const lines: string[] = [];
  lines.push(header);
  lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);

  // 查找公共前缀。
  let commonStart = 0;
  while (
    commonStart < oldLines.length &&
    commonStart < newLines.length &&
    oldLines[commonStart] === newLines[commonStart]
  ) {
    lines.push(` ${oldLines[commonStart]}`);
    commonStart++;
  }

  // 查找公共后缀。
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (
    oldEnd >= commonStart &&
    newEnd >= commonStart &&
    oldLines[oldEnd] === newLines[newEnd]
  ) {
    oldEnd--;
    newEnd--;
  }

  // 输出变化区段。
  for (let i = commonStart; i <= oldEnd; i++) {
    lines.push(`-${oldLines[i]}`);
  }
  for (let i = commonStart; i <= newEnd; i++) {
    lines.push(`+${newLines[i]}`);
  }

  // 输出公共后缀。
  for (let i = oldEnd + 1; i < oldLines.length; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

export class FileWriteTool implements ITool<FileWriteInput, FileWriteOutput> {
  name = "file_write";
  description =
    "创建或覆盖工作区内文件，返回前后哈希和 unified diff。建议先读取文件并提供 expectedSha256。";
  permissionLevel: PermissionLevel = "write-files";
  defaultTimeoutMs = 30_000;
  inputValidator = fileWriteInputValidator;

  inputSchema: JSONSchema7 = {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "要写入的工作区内文件路径",
      },
      content: {
        type: "string",
        maxLength: MAX_CONTENT_LENGTH,
        description: "要写入的新内容",
      },
      createIfMissing: {
        type: "boolean",
        description: "文件不存在时是否创建，默认 true",
      },
      expectedSha256: {
        type: "string",
        pattern: "^[a-fA-F0-9]{64}$",
        description: "当前文件内容的预期 SHA-256，用于防止覆盖并发修改",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  };

  idempotencyKey(input: FileWriteInput, _context: ToolExecutionContext): string {
    const contentHash = createHash("sha256").update(input.content).digest("hex");
    return `file_write:${input.path}:${contentHash}`;
  }

  async execute(
    input: FileWriteInput,
    context: ToolExecutionContext
  ): Promise<ToolResult<FileWriteOutput>> {
    const startedAt = new Date().toISOString();
    const createIfMissing = input.createIfMissing !== false; // default true
    let tmpPath: string | undefined;

    try {
      const resolvedPath = await resolveWritableWorkspacePath(input.path, context.cwd);

      // 读取已有内容，用于哈希校验和差异生成。
      let preImageSha256: string | null = null;
      let oldContent: string | null = null;
      let created = false;

      try {
        oldContent = await fs.readFile(resolvedPath, "utf-8");
        preImageSha256 = createHash("sha256").update(oldContent).digest("hex");

        // 写入前检查调用方提供的预期哈希。
        if (input.expectedSha256 && preImageSha256 !== input.expectedSha256) {
          return {
            success: false,
            output: null,
            error: {
              code: "HASH_MISMATCH",
              message: `File hash mismatch. Expected ${input.expectedSha256}, got ${preImageSha256}. The file may have been modified since last read.`,
              retryable: false,
              details: {
                path: input.path,
                expectedSha256: input.expectedSha256,
                actualSha256: preImageSha256,
              },
            },
            durationMs: 0,
            startedAt,
            endedAt: new Date().toISOString(),
            metadata: {},
          };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        // 文件不存在时只在明确允许创建的情况下继续。
        if (!createIfMissing) {
          return {
            success: false,
            output: null,
            error: {
              code: "FILE_NOT_FOUND",
              message: `File does not exist and createIfMissing is false: ${input.path}`,
              retryable: false,
              details: { path: input.path },
            },
            durationMs: 0,
            startedAt,
            endedAt: new Date().toISOString(),
            metadata: {},
          };
        }
        created = true;
      }

      // 确保工作区内的父目录存在。
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

      // 先写唯一临时文件，再原子重命名到目标路径。
      tmpPath = `${resolvedPath}.xycli-tmp-${randomUUID()}`;
      await fs.writeFile(tmpPath, input.content, "utf-8");

      try {
        await fs.rename(tmpPath, resolvedPath);
      } catch {
        // 跨设备重命名失败时回退到复制后删除临时文件。
        await fs.copyFile(tmpPath, resolvedPath);
        await fs.unlink(tmpPath);
      }

      const postImageSha256 = createHash("sha256")
        .update(input.content)
        .digest("hex");
      const unifiedDiff = generateUnifiedDiff(input.path, oldContent, input.content);

      const endedAt = new Date().toISOString();
      return {
        success: true,
        output: {
          path: input.path,
          created,
          preImageSha256,
          postImageSha256,
          unifiedDiff,
        },
        error: null,
        durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
        startedAt,
        endedAt,
        metadata: {
          resolvedPath,
          contentLength: input.content.length,
        },
      };
    } catch (err: unknown) {
      if (tmpPath) {
        try {
          await fs.unlink(tmpPath);
        } catch {
          // 临时文件可能尚未创建或已经完成重命名。
        }
      }
      const endedAt = new Date().toISOString();
      const message = err instanceof Error ? err.message : "Unknown error writing file";
      return {
        success: false,
        output: null,
        error: {
          code: err instanceof WorkspacePathError ? err.code : "FILE_WRITE_ERROR",
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
