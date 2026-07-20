#!/usr/bin/env node

import { Command } from "commander";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("xycli")
  .description("A terminal-native AI coding agent")
  .version(VERSION)
  .argument("[prompt]", "Natural language prompt for the AI agent")
  .option("--model <model>", "Model to use", "claude-sonnet-4-5-20250929")
  .option("--provider <provider>", "Provider: anthropic or deepseek", "anthropic")
  .option("--max-turns <turns>", "Maximum agent loop iterations", "25")
  .action(async (prompt: string | undefined, options: { model: string; provider: string; maxTurns: string }) => {
    if (!prompt) {
      program.outputHelp();
      process.exit(0);
    }

    const cwd = process.cwd();
    const maxTurns = parseInt(options.maxTurns, 10);

    // 根据 provider 参数创建对应的实例
    let provider;
    const providerType = options.provider.toLowerCase();
    
    if (providerType === "deepseek") {
      const { DeepSeekProvider } = await import("./providers/deepseek.js");
      const model = options.model === "claude-sonnet-4-5-20250929" ? "deepseek-chat" : options.model;
      try {
        provider = new DeepSeekProvider();
        console.log(`Provider: DeepSeek (${model})`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to initialize provider";
        console.error(message);
        console.error(
          "Set DEEPSEEK_API_KEY environment variable.\n" +
          "Example: export DEEPSEEK_API_KEY=sk-..."
        );
        process.exit(4);
      }
      // 用 deepseek 模型覆盖
      options.model = model;
    } else {
      // 默认 Anthropic
      const { AnthropicProvider } = await import("./providers/anthropic.js");
      try {
        provider = new AnthropicProvider();
        console.log(`Provider: Anthropic (${options.model})`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to initialize provider";
        console.error(message);
        console.error(
          "Set ANTHROPIC_API_KEY environment variable to use XYCLI.\n" +
          "Example: export ANTHROPIC_API_KEY=sk-ant-..."
        );
        process.exit(4);
      }
    }

    // 动态加载核心模块
    const { DefaultToolRegistry } = await import("./tools/registry.js");
    const { registerBuiltins } = await import("./tools/builtins.js");
    const { JsonSessionStore } = await import("./session/json-store.js");
    const { runAgent } = await import("./core/agent-loop.js");

    // Build tool registry with built-in tools
    const toolRegistry = new DefaultToolRegistry();
    registerBuiltins(toolRegistry);

    // Build session store
    const sessionStore = new JsonSessionStore(cwd);

    console.log(`XYCLI v${VERSION} — AI Coding Agent`);
    console.log(`Model: ${options.model}`);
    console.log(`CWD: ${cwd}`);
    console.log("");

    // Set up Ctrl+C handler
    const abortController = new AbortController();
    let interrupted = false;

    process.on("SIGINT", () => {
      if (!interrupted) {
        interrupted = true;
        console.log("\n\nInterrupted. Finishing current action...");
        abortController.abort();
      } else {
        console.log("\nForce quitting...");
        process.exit(1);
      }
    });

    try {
      const result = await runAgent({
        prompt,
        model: options.model,
        maxTurns,
        cwd,
        provider,
        toolRegistry,
        sessionStore,
        signal: abortController.signal,
      });

      console.log(`\n──────────────────────────────────────────`);
      console.log(`Session: ${result.sessionId}`);
      console.log(`Turns: ${result.turns}`);
      console.log(`Status: ${result.status}`);

      if (result.finalMessage) {
        console.log(`\n${result.finalMessage}`);
      }

      process.exit(0);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unexpected error";
      console.error(`\nFatal error: ${message}`);
      process.exit(1);
    }
  });

program.parse();
