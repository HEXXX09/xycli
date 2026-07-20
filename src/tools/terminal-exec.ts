// ============================================================================
// terminal_exec 工具——以“可执行文件 + 参数数组”的形式运行命令
// ============================================================================

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolExecutionContext,
  JSONSchema7,
} from "./types.js";
import type { PermissionLevel } from "../core/types.js";
import {
  resolveExistingWorkspacePath,
  resolveWorkspaceDirectory,
  WorkspacePathError,
} from "./path-policy.js";

export interface TerminalExecInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface TerminalExecOutput {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  outputSummary: string;
  truncated: boolean;
}

const MAX_OUTPUT_LENGTH = 100_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const COMMAND_PATTERN = /^[A-Za-z0-9._+-]+$/;

const terminalExecInputValidator = z.object({
  command: z.string().min(1).max(128).regex(
    COMMAND_PATTERN,
    "command 只能是单个可执行文件名；参数必须放入 args，不能包含空格、路径或 shell 元字符"
  ),
  args: z.array(z.string().max(4096)).max(128).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  timeoutMs: z.number().int().min(1).max(DEFAULT_TIMEOUT_MS).optional(),
  env: z.record(z.string().max(32_768)).optional(),
}).strict();

type SafeCommandCheck = { allowed: true } | { allowed: false; reason: string };

function checkGitArgs(args: string[]): SafeCommandCheck {
  const subcommand = args[0];
  if (!subcommand || !["status", "diff", "log", "show"].includes(subcommand)) {
    return { allowed: false, reason: "auto-safe 只允许 git status、diff、log 和 show" };
  }

  const forbidden = [
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--no-index",
    "--ext-diff",
    "--output",
    "--exec",
  ];
  if (args.some((arg) => forbidden.some((item) => arg === item || arg.startsWith(`${item}=`)))) {
    return { allowed: false, reason: "git 参数可能改变仓库边界、执行外部程序或写入文件" };
  }
  return { allowed: true };
}

async function checkLsArgs(args: string[], cwd: string): Promise<SafeCommandCheck> {
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    try {
      await resolveExistingWorkspacePath(arg, cwd);
    } catch {
      return { allowed: false, reason: `ls 路径不在工作区内或不存在: ${arg}` };
    }
  }
  return { allowed: true };
}

async function checkAutoSafeCommand(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> | undefined
): Promise<SafeCommandCheck> {
  if (env && Object.keys(env).length > 0) {
    return { allowed: false, reason: "auto-safe 不允许覆盖环境变量" };
  }
  if (command === "pwd") {
    return args.length === 0
      ? { allowed: true }
      : { allowed: false, reason: "pwd 不接受参数" };
  }
  if (command === "echo") return { allowed: true };
  if (command === "ls") return checkLsArgs(args, cwd);
  if (command === "git") return checkGitArgs(args);
  return { allowed: false, reason: `命令“${command}”不在 auto-safe 白名单中` };
}

function isWithinPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveSafeExecutable(
  command: string,
  workspace: string,
  env: Record<string, string>
): Promise<string | null> {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  const realWorkspace = await fs.realpath(workspace);

  for (const pathEntry of pathValue.split(path.delimiter)) {
    if (!pathEntry || !path.isAbsolute(pathEntry)) continue;
    try {
      const realDirectory = await fs.realpath(pathEntry);
      if (isWithinPath(realWorkspace, realDirectory)) continue;
      for (const extension of extensions) {
        const candidate = path.join(realDirectory, `${command}${extension}`);
        try {
          const realCandidate = await fs.realpath(candidate);
          const stat = await fs.stat(realCandidate);
          if (!stat.isFile()) continue;
          if (process.platform !== "win32") {
            await fs.access(realCandidate, fsConstants.X_OK);
          }
          return realCandidate;
        } catch {
          // 当前 PATH 目录中不存在该可执行文件，继续查找。
        }
      }
    } catch {
      // 忽略不存在、不可访问或相对的 PATH 项。
    }
  }
  return null;
}

function failure(
  code: string,
  message: string,
  startedAt: string,
  details: Record<string, unknown> = {}
): ToolResult<TerminalExecOutput> {
  const endedAt = new Date().toISOString();
  return {
    success: false,
    output: null,
    error: { code, message, retryable: false, details },
    durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
    startedAt,
    endedAt,
    metadata: {},
  };
}

export class TerminalExecTool implements ITool<TerminalExecInput, TerminalExecOutput> {
  name = "terminal_exec";
  description =
    "运行一个可执行文件并返回 stdout、stderr 和退出码。command 必须是单个可执行文件名，" +
    "所有参数必须放在 args 数组中。auto-safe 只允许 pwd、echo、ls 和只读 git 子命令；" +
    "其他命令需要 full-access。输出最多保留 100,000 个字符。";
  permissionLevel: PermissionLevel = "run-safe-commands";
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS;
  inputValidator = terminalExecInputValidator;

  inputSchema: JSONSchema7 = {
    type: "object",
    properties: {
      command: {
        type: "string",
        pattern: COMMAND_PATTERN.source,
        description: "单个可执行文件名，例如 ls 或 git；不能包含空格和 shell 元字符",
      },
      args: {
        type: "array",
        items: { type: "string", maxLength: 4096 },
        description: "命令参数数组",
      },
      cwd: { type: "string", description: "工作区内的工作目录" },
      timeoutMs: {
        type: "number",
        minimum: 1,
        maximum: DEFAULT_TIMEOUT_MS,
        description: "超时时间，单位毫秒",
      },
      env: { type: "object", description: "仅 full-access 允许附加环境变量" },
    },
    required: ["command"],
    additionalProperties: false,
  };

  idempotencyKey(input: TerminalExecInput, context: ToolExecutionContext): string {
    return `terminal_exec:${input.command}:${JSON.stringify(input.args ?? [])}:${input.cwd ?? context.cwd}`;
  }

  async execute(
    input: TerminalExecInput,
    context: ToolExecutionContext
  ): Promise<ToolResult<TerminalExecOutput>> {
    const startedAt = new Date().toISOString();
    const args = input.args ?? [];

    let cwd: string;
    try {
      cwd = await resolveWorkspaceDirectory(input.cwd ?? context.cwd, context.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : "工作目录无效";
      return failure(
        error instanceof WorkspacePathError ? error.code : "INVALID_CWD",
        message,
        startedAt,
        { cwd: input.cwd ?? context.cwd }
      );
    }

    let executable = input.command;
    if (context.permissions.mode !== "full-access") {
      const decision = await checkAutoSafeCommand(input.command, args, cwd, input.env);
      if (!decision.allowed) {
        return failure("UNSAFE_COMMAND", decision.reason, startedAt, {
          command: input.command,
          args,
          permissionMode: context.permissions.mode,
        });
      }
      const safeExecutable = await resolveSafeExecutable(input.command, context.cwd, context.env);
      if (!safeExecutable) {
        return failure(
          "SAFE_EXECUTABLE_NOT_FOUND",
          `无法在工作区外的可信 PATH 中找到命令“${input.command}”。`,
          startedAt,
          { command: input.command }
        );
      }
      executable = safeExecutable;
    }

    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const childEnv = { ...context.env, ...(input.env ?? {}) };
    delete childEnv.GIT_EXTERNAL_DIFF;
    delete childEnv.GIT_CONFIG;
    delete childEnv.GIT_CONFIG_GLOBAL;
    delete childEnv.GIT_CONFIG_SYSTEM;

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let truncated = false;
      let settled = false;

      const finish = (result: ToolResult<TerminalExecOutput>) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const child = spawn(executable, args, {
        cwd,
        env: childEnv,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        signal: context.signal,
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => child.kill("SIGKILL"), 3000);
        forceKill.unref();
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length >= MAX_OUTPUT_LENGTH) return;
        stdout += chunk.toString("utf-8");
        if (stdout.length >= MAX_OUTPUT_LENGTH) {
          truncated = true;
          stdout = stdout.slice(0, MAX_OUTPUT_LENGTH);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length >= MAX_OUTPUT_LENGTH) return;
        stderr += chunk.toString("utf-8");
        if (stderr.length >= MAX_OUTPUT_LENGTH) {
          truncated = true;
          stderr = stderr.slice(0, MAX_OUTPUT_LENGTH);
        }
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        finish(failure(
          context.signal.aborted ? "COMMAND_ABORTED" : "COMMAND_SPAWN_ERROR",
          context.signal.aborted ? "命令已中断" : error.message,
          startedAt,
          { command: input.command }
        ));
      });

      child.on("close", (exitCode, signal) => {
        clearTimeout(timeout);
        const endedAt = new Date().toISOString();
        const outputSummary = (stdout || stderr).split("\n").slice(-20).join("\n");
        finish({
          success: exitCode === 0 && !timedOut,
          output: {
            exitCode,
            signal,
            stdout,
            stderr,
            outputSummary,
            truncated: truncated || timedOut,
          },
          error: exitCode === 0 && !timedOut
            ? null
            : {
                code: timedOut ? "COMMAND_TIMEOUT" : "NONZERO_EXIT",
                message: timedOut
                  ? `命令在 ${timeoutMs}ms 后超时`
                  : `命令退出码为 ${exitCode}`,
                retryable: timedOut,
                details: { command: input.command, exitCode, signal, timeoutMs },
              },
          durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
          startedAt,
          endedAt,
          metadata: { command: input.command, args, exitCode, signal, cwd: path.resolve(cwd) },
        });
      });
    });
  }
}
