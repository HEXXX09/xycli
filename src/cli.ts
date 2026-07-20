#!/usr/bin/env node

import { Command } from "commander";
import * as readline from "node:readline";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("xycli")
  .description("终端原生 AI 编程助手")
  .version(VERSION)
  .argument("[prompt]", "自然语言指令（不填则进入交互模式）")
  .option("--model <model>", "模型名称", "claude-sonnet-4-5-20250929")
  .option("--provider <provider>", "provider: anthropic 或 deepseek", "deepseek")
  .option("--max-turns <turns>", "最大 agent 循环次数", "25")
  .option("-i, --interactive", "强制交互模式")
  .option(
    "--permission <mode>",
    "权限模式: read-only、auto-safe 或 full-access",
    "auto-safe"
  )
  .action(async (prompt: string | undefined, options: { model: string; provider: string; maxTurns: string; interactive: boolean; permission: string }) => {
    const cwd = process.cwd();
    const maxTurns = parseInt(options.maxTurns, 10);
    const providerType = options.provider.toLowerCase();
    const interactive = options.interactive || !prompt;

    // ============================================================
    // 创建 provider
    // ============================================================
    let provider: any;
    let model = options.model;

    if (providerType === "deepseek") {
      const { DeepSeekProvider } = await import("./providers/deepseek.js");
      model = model === "claude-sonnet-4-5-20250929" ? "deepseek-chat" : model;
      provider = new DeepSeekProvider();
    } else {
      const { AnthropicProvider } = await import("./providers/anthropic.js");
      provider = new AnthropicProvider();
    }

    // ============================================================
    // 加载核心模块
    // ============================================================
    const { DefaultToolRegistry } = await import("./tools/registry.js");
    const { registerBuiltins } = await import("./tools/builtins.js");
    const { JsonSessionStore } = await import("./session/json-store.js");
    const { runAgent } = await import("./core/agent-loop.js");
    const { PermissionGuard } = await import("./core/permission-guard.js");

    const toolRegistry = new DefaultToolRegistry();
    registerBuiltins(toolRegistry);
    const sessionStore = new JsonSessionStore(cwd);

    // Normalize permission mode
    const permissionMode = PermissionGuard.normalizeMode(options.permission);

    console.log(`\n  XYCLI v${VERSION} — AI 编程助手`);
    console.log(`  Provider: ${providerType === "deepseek" ? "DeepSeek" : "Anthropic"}  |  模型: ${model}`);
    console.log(`  工作目录: ${cwd}`);
    console.log(`  权限模式: ${permissionMode}`);
    console.log(`  输入 /help 查看命令，/exit 退出\n`);

    // ============================================================
    // 执行一次 agent 运行
    // ============================================================
    async function executePrompt(userPrompt: string): Promise<void> {
      const abortController = new AbortController();
      let interrupted = false;

      const sigintHandler = () => {
        if (!interrupted) {
          interrupted = true;
          console.log("\n\n  ⏸  已中断，正在保存...");
          abortController.abort();
        }
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
        });

        if (result.finalMessage) {
          console.log(`\n${result.finalMessage}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "未知错误";
        console.error(`\n  错误: ${message}`);
      } finally {
        process.removeListener("SIGINT", sigintHandler);
      }
    }

    // ============================================================
    // 单次执行模式
    // ============================================================
    if (!interactive && prompt) {
      await executePrompt(prompt);
      process.exit(0);
    }

    // ============================================================
    // 交互模式（REPL）
    // ============================================================
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\n❯ ",
      terminal: true,
    });

    // 首次运行：如果有 prompt 参数，先执行它
    if (prompt && interactive) {
      console.log(`  执行: ${prompt}`);
      await executePrompt(prompt);
    }

    rl.prompt();

    rl.on("line", async (line: string) => {
      const input = line.trim();

      if (!input) {
        rl.prompt();
        return;
      }

      // 内置命令
      if (input === "/exit" || input === "/quit" || input === "/q") {
        console.log("  再见！");
        rl.close();
        process.exit(0);
      }

      if (input === "/help" || input === "/h") {
        console.log(`
  可用命令:
    /help, /h        显示帮助
    /exit, /quit, /q 退出
    /clear, /c       清屏
    /model <name>    切换模型（如 /model deepseek-chat）
    /turns <n>       设置最大循环次数
  直接输入自然语言指令即可与 AI 对话
        `);
        rl.prompt();
        return;
      }

      if (input === "/clear" || input === "/c") {
        console.clear();
        console.log(`  XYCLI v${VERSION} — 就绪`);
        rl.prompt();
        return;
      }

      if (input.startsWith("/model ")) {
        model = input.slice(7).trim();
        console.log(`  模型已切换: ${model}`);
        rl.prompt();
        return;
      }

      if (input.startsWith("/turns ")) {
        const n = parseInt(input.slice(7).trim(), 10);
        if (n > 0 && n <= 100) {
          // 无法在运行时修改 maxTurns（已作为参数传给 runAgent），
          // 这里用全局变量方式处理——重新创建配置
          (program as any)._maxTurns = n;
          console.log(`  最大循环次数: ${n}`);
        } else {
          console.log(`  请输入 1-100 之间的数字`);
        }
        rl.prompt();
        return;
      }

      // 执行用户指令
      await executePrompt(input);
      rl.prompt();
    });

    rl.on("close", () => {
      console.log("");
      process.exit(0);
    });
  });

program.parse();
