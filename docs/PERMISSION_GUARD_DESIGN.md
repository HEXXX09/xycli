# PermissionGuard 设计

## 目标

在 `agent-loop.ts` 调用工具执行逻辑之前，根据当前运行模式检查目标工具的 `permissionLevel`。越权工具调用必须被拒绝，不能进入 `tool.execute()`，同时仍要写入 session 的 `toolCalls`，状态为 `denied`，并向模型回传结构化错误信息。

现有约束：

- 不修改 `ITool` 接口；继续使用 `ITool.permissionLevel`。
- 不破坏现有测试；`permissionMode` 必须有默认值。
- 权限检查位置必须早于 `toolRegistry.execute()`，因为 `toolRegistry.execute()` 内部会调用具体 `tool.execute()`。
- `ToolCallRecord.status` 已支持 `"denied"`，无需扩展 session 类型。

## 权限模型

权限级别从低到高：

```ts
type PermissionLevel =
  | "read-only"
  | "write-files"
  | "run-safe-commands"
  | "network"
  | "full-access";
```

运行模式：

```ts
export type PermissionMode = "read-only" | "auto-safe" | "full-access";
```

允许矩阵：

| permissionMode | allowed permissionLevel |
| --- | --- |
| `read-only` | `read-only` |
| `auto-safe` | `read-only`, `write-files`, `run-safe-commands` |
| `full-access` | all levels |

注意：虽然权限级别存在顺序，`auto-safe` 不应简单理解为某个最高等级的数值比较，因为需求明确拒绝 `network` 和 `full-access`。实现时可以用显式 allow-list，避免未来插入新权限级别时被误放行。

## 1. PermissionGuard 接口设计

新增文件：`src/core/permission-guard.ts`

```ts
import type { PermissionLevel } from "./types.js";

export type PermissionMode = "read-only" | "auto-safe" | "full-access";

export interface PermissionDecision {
  allowed: boolean;
  mode: PermissionMode;
  requiredLevel: PermissionLevel;
  allowedLevels: PermissionLevel[];
  reason: string | null;
}

export interface PermissionDeniedPayload {
  code: "PERMISSION_DENIED";
  message: string;
  retryable: false;
  details: {
    toolName: string;
    requiredLevel: PermissionLevel;
    permissionMode: PermissionMode;
    allowedLevels: PermissionLevel[];
  };
}

export class PermissionGuard {
  constructor(mode?: PermissionMode);

  get mode(): PermissionMode;

  static normalizeMode(mode: unknown): PermissionMode;

  static allowedLevelsFor(mode: PermissionMode): readonly PermissionLevel[];

  static check(requiredLevel: PermissionLevel, mode?: PermissionMode): boolean;

  static evaluate(requiredLevel: PermissionLevel, mode?: PermissionMode): PermissionDecision;

  static deniedPayload(params: {
    toolName: string;
    requiredLevel: PermissionLevel;
    mode: PermissionMode;
  }): PermissionDeniedPayload;

  check(requiredLevel: PermissionLevel): boolean;

  evaluate(requiredLevel: PermissionLevel): PermissionDecision;

  deniedPayload(params: {
    toolName: string;
    requiredLevel: PermissionLevel;
  }): PermissionDeniedPayload;
}
```

设计说明：

- `PermissionMode` 放在 `permission-guard.ts` 中导出；`PermissionLevel` 继续沿用 `src/core/types.ts`。
- `constructor(mode?: PermissionMode)` 默认使用 `"auto-safe"`。
- `normalizeMode()` 负责 CLI 和配置层输入归一化。非法值应抛 `ValidationError`，不要静默降级到更宽松权限。
- `check()` 提供 M1-T09 要求的布尔接口。
- `evaluate()` 提供 agent-loop 记录审计信息所需的上下文。
- `deniedPayload()` 统一越权错误结构，保证 session 记录和 tool message 一致。

## 2. 集成到 agent-loop.ts

当前执行点在 `src/core/agent-loop.ts` 第 164 行附近：

```ts
const toolResult = await toolRegistry.execute(
  toolCall.name,
  toolCall.input,
  sessionId,
  cwd,
  signal
);
```

应在这段代码之前插入权限检查。建议插入位置是现有 `const startedAt = new Date().toISOString();` 之后、`toolRegistry.execute()` 之前。原因是 denied 记录也需要 `startedAt` 和 `endedAt`。

伪代码：

```ts
import { PermissionGuard } from "./permission-guard.js";
```

在 `runAgent()` 开始处构造 guard：

```ts
const permissionMode = config.permissionMode ?? "auto-safe";
const permissionGuard = new PermissionGuard(permissionMode);
```

在工具循环中：

```ts
const startedAt = new Date().toISOString();
const tool = toolRegistry.get(toolCall.name);

if (tool) {
  const decision = permissionGuard.evaluate(tool.permissionLevel);

  if (!decision.allowed) {
    const endedAt = new Date().toISOString();
    const error = permissionGuard.deniedPayload({
      toolName: toolCall.name,
      requiredLevel: tool.permissionLevel,
    });

    const record: ToolCallRecord = {
      id: toolCall.id,
      toolName: toolCall.name,
      input: toolCall.input,
      output: null,
      error: error.message,
      status: "denied",
      durationMs: Date.now() - new Date(startedAt).getTime(),
      startedAt,
      endedAt,
    };
    session.toolCalls.push(record);

    const toolMsg: Message = {
      id: uuidv4(),
      role: "tool",
      content: JSON.stringify({ error }),
      toolCallId: toolCall.id,
      sequence: session.messages.length,
      createdAt: endedAt,
    };
    session.messages.push(toolMsg);

    continue;
  }
}

const toolResult = await toolRegistry.execute(
  toolCall.name,
  toolCall.input,
  sessionId,
  cwd,
  signal
);
```

未注册工具的处理：

- 如果 `toolRegistry.get(toolCall.name)` 返回 `undefined`，不做 PermissionGuard 检查。
- 继续调用现有 `toolRegistry.execute()`，沿用当前 `TOOL_NOT_FOUND` 行为。
- 这样不会把“未知工具”误标为权限拒绝，也避免改变现有测试语义。

为什么不放在 `DefaultToolRegistry.execute()`：

- M1-T09 明确要求在 agent-loop 的 tool execution 前插入检查。
- agent-loop 持有 session，可直接记录 `denied`，不需要改 `ToolRegistry.execute()` 的签名。
- 避免破坏现有 registry 测试和直接调用 registry 的工具测试。

## 3. cli.ts 增加 --permission 参数

在现有 commander 参数附近增加：

```ts
.option(
  "--permission <mode>",
  "权限模式: read-only、auto-safe 或 full-access",
  "auto-safe"
)
```

`action` 的 options 类型增加字段：

```ts
options: {
  model: string;
  provider: string;
  maxTurns: string;
  interactive: boolean;
  permission: string;
}
```

在 action 内归一化：

```ts
const permissionMode = PermissionGuard.normalizeMode(options.permission);
```

传入 `runAgent()`：

```ts
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
```

启动信息建议增加一行或合并到现有输出：

```ts
console.log(`  权限模式: ${permissionMode}`);
```

非法参数行为：

- `--permission readonly`、`--permission auto` 等非法值应抛 `ValidationError` 或由 `normalizeMode()` 抛出。
- CLI 捕获后输出现有错误格式。
- 不应默认提升到 `full-access`。

交互模式：

- 初版不需要新增 REPL 命令。
- 同一 CLI 进程内的所有 prompt 使用启动时的 `permissionMode`。

## 4. 与 AgentRunConfig 对接

修改 `src/core/agent-loop.ts` 中的 `AgentRunConfig`：

```ts
import type { PermissionMode } from "./permission-guard.js";

export interface AgentRunConfig {
  prompt: string;
  model: string;
  maxTurns: number;
  cwd: string;
  provider: IProvider;
  toolRegistry: ToolRegistry;
  sessionStore: SessionStore;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
}
```

默认值：

```ts
const {
  prompt,
  model,
  maxTurns,
  cwd,
  provider,
  toolRegistry,
  sessionStore,
  permissionMode = "auto-safe",
  signal,
} = config;
```

兼容性：

- `permissionMode` 设为可选，现有测试构造 `AgentRunConfig` 时不需要立刻更新。
- 默认 `"auto-safe"` 满足 M1-T09。
- 不修改 `PermissionPolicy` 或 `ITool`，避免与 M9 的完整 permission engine 设计冲突。

与现有 `ToolExecutionContext.permissions` 的关系：

- M1-T09 的 guard 是 agent-loop 级别的硬拦截。
- `ToolExecutionContext.permissions` 目前由 registry 内部 `defaultPolicy()` 填充，不作为本次权限判定来源。
- 后续 M9 可以把 `PermissionGuard` 迁移或适配到中央 permission engine，但当前不要扩大改动范围。

## 5. 测试用例设计

新增文件：`src/core/permission-guard.test.ts`

至少覆盖以下场景：

1. `read-only` 模式允许 `read-only`
   - 输入：`PermissionGuard.check("read-only", "read-only")`
   - 期望：`true`

2. `read-only` 模式拒绝 `write-files`
   - 输入：`PermissionGuard.evaluate("write-files", "read-only")`
   - 期望：`allowed === false`，`allowedLevels === ["read-only"]`

3. `auto-safe` 模式允许 `run-safe-commands`
   - 输入：`PermissionGuard.check("run-safe-commands", "auto-safe")`
   - 期望：`true`

4. `auto-safe` 模式拒绝 `network`
   - 输入：`PermissionGuard.deniedPayload({ toolName: "fetch_url", requiredLevel: "network", mode: "auto-safe" })`
   - 期望：`code === "PERMISSION_DENIED"`，`retryable === false`，`details.permissionMode === "auto-safe"`

5. `auto-safe` 模式拒绝 `full-access`
   - 输入：`PermissionGuard.check("full-access", "auto-safe")`
   - 期望：`false`

6. `full-access` 模式允许全部权限
   - 遍历所有 `PermissionLevel`
   - 期望：全部 `true`

7. 未传 mode 时默认 `auto-safe`
   - 输入：`new PermissionGuard().check("network")`
   - 期望：`false`
   - 输入：`new PermissionGuard().check("write-files")`
   - 期望：`true`

8. 非法 mode 被拒绝
   - 输入：`PermissionGuard.normalizeMode("readonly")`
   - 期望：抛 `ValidationError` 或等价的配置校验错误

建议在 `agent-loop.test.ts` 增加集成测试，但不是 M1-T09 的最小必需：

1. 构造一个 `network` 权限工具，`permissionMode: "auto-safe"`。
2. provider 返回一次 `tool_calls`。
3. 断言工具的 `execute()` 没有被调用。
4. 断言 session `toolCalls[0].status === "denied"`。
5. 断言 tool message 内容包含 `PERMISSION_DENIED`。

## 6. 越权错误信息格式

面向 session 和 tool message 的结构化错误：

```json
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Permission denied: tool \"fetch_url\" requires \"network\" but current permission mode \"auto-safe\" allows only: read-only, write-files, run-safe-commands.",
    "retryable": false,
    "details": {
      "toolName": "fetch_url",
      "requiredLevel": "network",
      "permissionMode": "auto-safe",
      "allowedLevels": ["read-only", "write-files", "run-safe-commands"]
    }
  }
}
```

`ToolCallRecord` 写入格式：

```ts
const record: ToolCallRecord = {
  id: toolCall.id,
  toolName: toolCall.name,
  input: toolCall.input,
  output: null,
  error: error.message,
  status: "denied",
  durationMs,
  startedAt,
  endedAt,
};
```

错误码要求：

- `code`: 固定为 `"PERMISSION_DENIED"`。
- `retryable`: 固定为 `false`。
- `message`: 必须包含 tool name、required level、current mode、allowed levels，便于调试和审计。
- `details`: 使用机器可读字段，不从 message 反解析。

## 安全边界说明

该设计只依赖工具声明的 `permissionLevel` 做粗粒度拦截。它能防止 agent-loop 在低权限模式下调用高权限工具，但不负责解析命令内容、路径白名单、网络域名、secret redaction 或审批流。这些应留给 M9 的完整 permission engine。

当前 M1-T09 的最小安全保证是：

1. 模型即使请求越权工具，也不会进入 `tool.execute()`。
2. 越权行为会被写入 session 审计记录。
3. 模型会收到明确的 permission denied tool result，可继续选择低权限替代方案。
