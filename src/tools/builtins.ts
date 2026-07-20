// ============================================================================
// 内置工具——注册 M1 提供的全部工具
// ============================================================================

import type { ToolRegistry } from "./registry.js";
import { FileReadTool } from "./file-read.js";
import { FileWriteTool } from "./file-write.js";
import { TerminalExecTool } from "./terminal-exec.js";

/**
 * 将全部 M1 内置工具注册到指定注册中心。
 */
export function registerBuiltins(registry: ToolRegistry): void {
  registry.register(new FileReadTool());
  registry.register(new FileWriteTool());
  registry.register(new TerminalExecTool());
}
