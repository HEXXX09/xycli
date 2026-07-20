# XYCLI 详细设计

> Rust 迁移说明：本文保留完整目标设计。当前核心运行时已迁移到 Rust，实际模块和完成边界以 `ARCHITECTURE.md` 与 `RUST_MIGRATION.md` 为准。

> 当前版本：M1 稳定化基线。本文中的“当前实现”可直接对应代码；“后续设计”属于 M2–M10。

## 1. 模块划分

```text
src/
├── cli.ts                 # CLI 入口与 REPL
├── core/
│   ├── agent-loop.ts      # Agent 状态机
│   ├── permission-guard.ts
│   ├── prompts.ts
│   ├── errors.ts
│   └── types.ts
├── providers/
│   ├── anthropic.ts
│   ├── deepseek.ts
│   └── types.ts
├── session/
│   ├── json-store.ts
│   └── types.ts
└── tools/
    ├── registry.ts
    ├── path-policy.ts
    ├── file-read.ts
    ├── file-write.ts
    ├── terminal-exec.ts
    └── types.ts
```

依赖方向：

```text
CLI → Core → Provider 接口
           → ToolRegistry 接口
           → SessionStore 接口
Tool → Core 基础类型
Provider → Core 错误类型
Session → Core 状态类型
```

Core 不直接创建具体 Provider、工具或存储，由 CLI 注入实现。

## 2. 工具接口

```ts
interface ITool<TInput extends object, TOutput> {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  inputValidator: ZodType<TInput>;
  permissionLevel: PermissionLevel;
  defaultTimeoutMs: number;
  idempotencyKey(input: TInput, context: ToolExecutionContext): string;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult<TOutput>>;
}
```

`inputSchema` 用于向模型描述工具，`inputValidator` 是运行时权威校验。ToolRegistry 必须先校验再计算幂等键和执行，防止无效模型参数进入工具实现。

### 2.1 执行上下文

```ts
interface ToolExecutionContext {
  sessionId: string;
  callId: string;
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  permissions: PermissionPolicy;
  logger: StructuredLogger;
  startedAt: string;
}
```

ToolRegistry 将工具默认超时和上游中断信号合并。执行结束后必须清理定时器和事件监听器。

### 2.2 统一结果

```ts
interface ToolResult<TOutput> {
  success: boolean;
  output: TOutput | null;
  error: ToolErrorPayload | null;
  durationMs: number;
  startedAt: string;
  endedAt: string;
  metadata: Record<string, unknown>;
}
```

工具业务失败通过结果返回，不抛出到 Agent Loop；只有编程错误或无法恢复的基础设施异常才允许抛出。

## 3. 内置工具

### 3.1 `file_read`

输入：

- `path`：必填，工作区内文件；
- `startLine`、`endLine`：可选，1 开始且范围有效；
- `maxBytes`：可选，不超过 2 MiB。

输出包含内容、行范围、截断标记和 SHA-256。真实路径必须位于工作区内。

### 3.2 `file_write`

输入：

- `path`：必填，工作区内目标；
- `content`：必填，最大 2 MiB；
- `createIfMissing`：默认允许创建；
- `expectedSha256`：可选，用于防止覆盖并发修改。

写入流程：

1. 校验目标和真实父目录没有逃逸工作区；
2. 读取旧内容并检查预期哈希；
3. 写入带随机后缀的临时文件；
4. 原子重命名；
5. 返回前后哈希与 unified diff；
6. 失败时尽力清理临时文件。

### 3.3 `terminal_exec`

输入：

- `command`：单个可执行文件名；
- `args`：参数数组；
- `cwd`：工作区内目录；
- `timeoutMs`：最大 120 秒；
- `env`：仅 `full-access` 允许覆盖。

执行固定使用 `shell: false`。`auto-safe` 白名单只包含 `pwd`、`echo`、`ls` 和受限的 `git status/diff/log/show`。安全命令会从工作区外的绝对 PATH 目录解析为真实可执行文件，避免仓库内同名程序劫持；Git 参数拒绝仓库切换、外部 diff、输出文件和命令执行能力。

## 4. 路径策略

路径策略分为三种入口：

- `resolveExistingWorkspacePath()`：读取已存在目标；
- `resolveWritableWorkspacePath()`：处理可能尚未创建的目标；
- `resolveWorkspaceDirectory()`：验证命令工作目录。

判断条件：

```ts
const relative = path.relative(workspaceRoot, realTarget);
const allowed =
  relative === "" ||
  (!relative.startsWith(`..${path.sep}`) &&
   relative !== ".." &&
   !path.isAbsolute(relative));
```

不允许只做字符串前缀比较，因为 `/repo-other` 可能错误匹配 `/repo`。对待创建文件必须先解析最近的已存在父目录，才能识别中间符号链接。

## 5. 权限模型

```ts
type PermissionLevel =
  | "read-only"
  | "write-files"
  | "run-safe-commands"
  | "network"
  | "full-access";

type PermissionMode = "read-only" | "auto-safe" | "full-access";
```

允许矩阵：

| 模式 | 权限级别 |
| --- | --- |
| `read-only` | `read-only` |
| `auto-safe` | `read-only`、`write-files`、`run-safe-commands` |
| `full-access` | 全部 |

PermissionGuard 负责工具级检查；文件和终端工具继续执行动作级检查。两层都通过后才能产生副作用。

## 6. Agent 循环

### 6.1 输入配置

```ts
interface AgentRunConfig {
  prompt: string;
  model: string;
  maxTurns: number;
  cwd: string;
  provider: IProvider;
  toolRegistry: ToolRegistry;
  sessionStore: SessionStore;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  sessionId?: string;
}
```

设置 `sessionId` 时加载已有会话并追加用户消息，用于 REPL 上下文保持。

### 6.2 状态机

```text
IDLE
  → PLANNING
  → ACTING
  → OBSERVING
  ├── PLANNING
  ├── COMPLETED
  ├── INCOMPLETE
  └── ERROR
```

会话终态：

- `completed`：模型正常结束；
- `incomplete`：达到最大轮次或模型输出被截断；
- `interrupted`：用户发出中断；
- `error`：Provider 或系统错误。

只有 `completed` 返回退出码 0。

### 6.3 单轮步骤

1. 检查中断；
2. 从 Session 构造 Provider 消息；
3. 发送带 AbortSignal 的请求；
4. 记录助手消息和 Token；
5. 正常文本则完成；
6. 工具调用则逐个进行权限检查和执行；
7. 将工具结果写回会话；
8. 进入下一轮。

## 7. Provider 设计

```ts
interface IProvider {
  name: "anthropic" | "openai" | "generic-openai";
  chat(request: ProviderRequest): Promise<ProviderResponse>;
  streamChat(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
  supportsTools(model: string): boolean;
  estimateTokens(input: ProviderTokenInput): Promise<TokenEstimate>;
}
```

### 7.1 Anthropic

- `system` 使用 Messages API 独立字段；
- `tool_use` 和 `tool_result` 转换为内部内容块；
- 流式结束通过 SDK `finalMessage()` 获取完整文本和工具 JSON；
- SDK 客户端可注入，便于无网络测试。

### 7.2 DeepSeek

- 使用 OpenAI Chat Completions 兼容协议；
- 系统提示词插入首条 `system` 消息；
- 流式工具参数按 `index` 累积字符串，结束后统一解析；
- `DEEPSEEK_BASE_URL` 仅用于兼容网关和测试；
- SDK 客户端可注入。

### 7.3 后续 Provider 工厂

M3 将把 CLI 中的创建逻辑迁入 Provider Factory，并加入配置优先级、重试、熔断和 fallback。

## 8. 会话设计

```ts
interface Session {
  id: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  currentState: AgentLoopState;
  providerName: string;
  model: string;
  messages: Message[];
  toolCalls: ToolCallRecord[];
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
```

JSON 文件是 M1 权威存储。`create()` 和 `update()` 都使用临时文件加重命名。M4 迁移 SQLite 时保持 `SessionStore` 接口稳定。

## 9. CLI 设计

CLI 使用 `program.parseAsync()`，所有异步 action 的异常交给顶层处理。退出码：

| 退出码 | 含义 |
| ---: | --- |
| 0 | 成功完成 |
| 1 | 一般错误、未完成或中断 |
| 2 | 参数或配置校验失败 |
| 3 | 权限拒绝 |
| 4 | Provider 错误 |
| 5 | 工具致命错误 |

REPL 使用 `for await...of` 串行处理输入；同一会话通过 `sessionId` 延续；`/new` 清除当前会话引用。

## 10. 错误处理

所有领域错误继承 `XycliError`，包含：

- `code`；
- `exitCode`；
- `retryable`；
- `details`。

ProviderError 可以从 details 中读取真实 `retryable`，避免所有错误都被错误标记为可重试。

工具输入错误返回 `INVALID_TOOL_INPUT`；路径越界返回 `PATH_OUTSIDE_WORKSPACE`；安全命令拒绝返回 `UNSAFE_COMMAND`。

## 11. 测试设计

测试分层：

1. 工具和权限单元测试；
2. Agent Loop 与 JsonSessionStore 集成测试；
3. Provider 模拟 SDK 测试；
4. Agent 全流程模拟 Provider 测试；
5. 真实 CLI 子进程 E2E。

真实 CLI E2E 在子进程中预加载测试专用 fetch 模拟模块，不访问公网，但完整覆盖 CLI 参数、SDK 请求格式、工具调用、会话落盘和退出码。

真实 API 冒烟测试只有在显式提供 API Key 时运行，不作为离线 CI 的必要条件。

## 12. 构建与打包

- `tsconfig.json`：类型检查与测试开发；
- `tsconfig.build.json`：只编译生产源码；
- `prebuild`：清理可再生的 `dist`；
- `postbuild`：为 `dist/cli.js` 设置可执行权限；
- `files: ["dist"]`：限制 npm 发布内容；
- `prepack`：打包前重新生产构建。

## 13. 后续设计

### M2

统一 Renderer、真实流式 UI、搜索、Web 和 Git 专用工具。

### M3

配置加载、OpenAI Provider、Provider Factory、重试、熔断与 fallback。

### M4–M10

SQLite 与 resume、Plan、Memory、Computer Use、MCP、插件、审批、脱敏、回滚、诊断与 CI/CD。后续模块必须继续通过现有 Provider、Tool 和 Session 接口接入，避免绕过权限与审计边界。
