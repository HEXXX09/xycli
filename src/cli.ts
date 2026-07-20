#!/usr/bin/env node

import { Command } from "commander";
import * as readline from "node:readline";
import type { IProvider } from "./providers/types.js";
import type { AgentRunResult } from "./core/agent-loop.js";
import { ValidationError, XycliError } from "./core/errors.js";
import { VERSION } from "./version.js";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

interface CliOptions {
  model?: string;
  provider: string;
  maxTurns: string;
  interactive?: boolean;
  permission: string;
}

function parseMaxTurns(value: string): number {
  const turns = Number(value);
  if (!Number.isInteger(turns) || turns < 1 || turns > 100) {
    throw new ValidationError("--max-turns 必须是 1 到 100 之间的整数。");
  }
  return turns;
}

async function createProvider(
  providerName: string
): Promise<{ provider: IProvider; defaultModel: string; displayName: string }> {
  if (providerName === "anthropic") {
    const { AnthropicProvider } = await import("./providers/anthropic.js");
    return {
      provider: new AnthropicProvider(),
      defaultModel: DEFAULT_ANTHROPIC_MODEL,
      displayName: "Anthropic",
    };
  }
  if (providerName === "deepseek") {
    const { DeepSeekProvider } = await import("./providers/deepseek.js");
    return {
      provider: new DeepSeekProvider(),
      defaultModel: DEFAULT_DEEPSEEK_MODEL,
      displayName: "DeepSeek",
    };
  }

  throw new ValidationError(
    `不支持的 Provider: ${providerName}。可选值：anthropic、deepseek。`
  );
}

async function main(argv = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("xycli")
    .description("终端原生 AI 编程助手")
    .version(VERSION)
    .argument("[prompt]", "自然语言指令（不填则进入交互模式）")
    .option("--model <model>", "模型名称；默认值由 Provider 决定")
    .option("--provider <provider>", "Provider：anthropic 或 deepseek", "anthropic")
    .option("--max-turns <turns>", "单次任务最大 Agent 循环次数", "25")
    .option("-i, --interactive", "强制进入交互模式")
    .option(
      "--permission <mode>",
      "权限模式：read-only、auto-safe 或 full-access",
      "auto-safe"
    )
    .action(async (prompt: string | undefined, options: CliOptions) => {
      const cwd = process.cwd();
      let maxTurns = parseMaxTurns(options.maxTurns);
      const providerName = options.provider.toLowerCase();
      const interactive = Boolean(options.interactive || !prompt);

      const { PermissionGuard } = await import("./core/permission-guard.js");
      const permissionMode = PermissionGuard.normalizeMode(options.permission);
      const providerConfig = await createProvider(providerName);
      const provider = providerConfig.provider;
      let model = options.model ?? providerConfig.defaultModel;

      const { DefaultToolRegistry } = await import("./tools/registry.js");
      const { registerBuiltins } = await import("./tools/builtins.js");
      const { JsonSessionStore } = await import("./session/json-store.js");
      const { runAgent } = await import("./core/agent-loop.js");

      const toolRegistry = new DefaultToolRegistry();
      registerBuiltins(toolRegistry);
      const sessionStore = new JsonSessionStore(cwd);
      let interactiveSessionId: string | undefined;

      console.log(`\n  XYCLI v${VERSION} — AI 编程助手`);
      console.log(`  Provider: ${providerConfig.displayName}  |  模型: ${model}`);
      console.log(`  工作目录: ${cwd}`);
      console.log(`  权限模式: ${permissionMode}`);
      if (interactive) console.log("  输入 /help 查看命令，/exit 退出\n");

      async function executePrompt(
        userPrompt: string,
        sessionId?: string
      ): Promise<AgentRunResult> {
        const abortController = new AbortController();
        let interrupted = false;

        const sigintHandler = () => {
          if (interrupted) return;
          interrupted = true;
          console.log("\n\n  ⏸  已中断，正在保存...");
          abortController.abort(new Error("用户中断"));
        };

        process.on("SIGINT", sigintHandler);
        try {
          const result = await runAgent({
            prompt: userPrompt,
            model,
            maxTurns,
            cwd,
            provider,
            toolRegistry,
            sessionStore,
            permissionMode,
            signal: abortController.signal,
            sessionId,
          });
          if (result.finalMessage) console.log(`\n${result.finalMessage}`);
          return result;
        } finally {
          process.removeListener("SIGINT", sigintHandler);
        }
      }

      if (!interactive && prompt) {
        const result = await executePrompt(prompt);
        process.exitCode = result.exitCode;
        return;
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "\n❯ ",
        terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      });
      let readlineClosed = false;
      rl.once("close", () => { readlineClosed = true; });
      const showPrompt = () => {
        if (!readlineClosed) rl.prompt();
      };

      if (prompt) {
        console.log(`  执行: ${prompt}`);
        const result = await executePrompt(prompt, interactiveSessionId);
        interactiveSessionId = result.sessionId;
      }

      showPrompt();
      for await (const line of rl) {
        const input = line.trim();
        if (!input) {
          showPrompt();
          continue;
        }

        if (["/exit", "/quit", "/q"].includes(input)) {
          console.log("  再见！");
          break;
        }
        if (["/help", "/h"].includes(input)) {
          console.log(`
  可用命令:
    /help, /h         显示帮助
    /exit, /quit, /q  退出
    /clear, /c        清屏
    /new              开始一个新会话
    /model <name>     切换模型
    /turns <n>        设置单次任务最大循环次数
  直接输入自然语言指令即可继续当前会话
          `);
          showPrompt();
          continue;
        }
        if (["/clear", "/c"].includes(input)) {
          console.clear();
          console.log(`  XYCLI v${VERSION} — 就绪`);
          showPrompt();
          continue;
        }
        if (input === "/new") {
          interactiveSessionId = undefined;
          console.log("  已开始新会话。");
          showPrompt();
          continue;
        }
        if (input.startsWith("/model ")) {
          const nextModel = input.slice(7).trim();
          if (nextModel) {
            model = nextModel;
            console.log(`  模型已切换: ${model}`);
          }
          showPrompt();
          continue;
        }
        if (input.startsWith("/turns ")) {
          try {
            maxTurns = parseMaxTurns(input.slice(7).trim());
            console.log(`  最大循环次数: ${maxTurns}`);
          } catch (error) {
            console.log(`  ${error instanceof Error ? error.message : "参数无效"}`);
          }
          showPrompt();
          continue;
        }

        const result = await executePrompt(input, interactiveSessionId);
        interactiveSessionId = result.sessionId;
        showPrompt();
      }

      rl.close();
      console.log("");
    });

  await program.parseAsync(argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "未知错误";
  console.error(`\n  错误: ${message}`);
  process.exitCode = error instanceof XycliError ? error.exitCode : 1;
});
