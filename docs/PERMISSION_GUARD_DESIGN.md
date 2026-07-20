# PermissionGuard 与工具安全边界设计

> Rust 迁移说明：当前生产权限矩阵位于 `crates/xycli-core/src/permission.rs`，工具执行层位于 `crates/xycli-core/src/tools/`；本文保留原始安全设计和历史实现依据。

## 1. 目标

模型返回工具调用后、任何副作用发生前，系统必须完成：

1. 工具权限级别检查；
2. 工具输入 Schema 校验；
3. 路径或命令动作级校验；
4. 拒绝结果的会话审计。

单独检查 `permissionLevel` 不足以形成安全边界。例如 `terminal_exec` 即使属于 `run-safe-commands`，仍必须检查具体命令和参数。

## 2. 权限级别与模式

```ts
type PermissionLevel =
  | "read-only"
  | "write-files"
  | "run-safe-commands"
  | "network"
  | "full-access";

type PermissionMode = "read-only" | "auto-safe" | "full-access";
```

| 模式 | 允许级别 |
| --- | --- |
| `read-only` | `read-only` |
| `auto-safe` | `read-only`、`write-files`、`run-safe-commands` |
| `full-access` | 全部 |

允许关系采用显式矩阵，不使用数值大小比较。未来增加权限级别时，新级别默认不会被旧模式放行。

## 3. PermissionGuard 接口

```ts
class PermissionGuard {
  constructor(mode?: PermissionMode);
  get mode(): PermissionMode;

  static normalizeMode(mode: unknown): PermissionMode;
  static allowedLevelsFor(mode: PermissionMode): readonly PermissionLevel[];
  static check(level: PermissionLevel, mode?: PermissionMode): boolean;
  static evaluate(level: PermissionLevel, mode?: PermissionMode): PermissionDecision;
  static deniedPayload(params: DeniedParams): PermissionDeniedPayload;

  check(level: PermissionLevel): boolean;
  evaluate(level: PermissionLevel): PermissionDecision;
  deniedPayload(params: Omit<DeniedParams, "mode">): PermissionDeniedPayload;
}
```

非法模式抛出 `ValidationError`，不能静默回退到更宽松模式。

## 4. Agent Loop 集成

执行顺序：

```text
Provider 返回 tool call
  → ToolRegistry 查找工具
  → PermissionGuard.evaluate(permissionLevel)
  ├── 拒绝：写入 denied 记录并回传结构化错误
  └── 允许：进入 ToolRegistry.execute()
```

未知工具不参与权限判断，交由 ToolRegistry 返回 `TOOL_NOT_FOUND`。

拒绝记录包含：

- tool call ID；
- 工具名和输入；
- 所需权限级别；
- 当前权限模式；
- 允许级别；
- `status: "denied"`。

## 5. ToolRegistry 输入校验

每个工具同时声明 JSON Schema 和 Zod Validator。Registry 使用 Zod `safeParse()`：

- 成功：使用解析后的数据执行；
- 失败：返回 `INVALID_TOOL_INPUT` 和字段级问题；
- 不调用 `idempotencyKey()`；
- 不调用工具实现。

## 6. 文件动作级策略

`file_read` 和 `file_write` 始终限制在工作区内。即使使用 `full-access`，文件工具本身也不越界；需要访问工作区外资源时必须通过用户明确授权的其他能力。

防御项：

- 绝对路径越界；
- `../` 路径穿越；
- 工作区内符号链接指向外部；
- 待创建路径的中间目录为外部符号链接；
- 工作区根本身存在平台路径别名。

## 7. 命令动作级策略

`terminal_exec` 不使用 shell。示例：

```json
{
  "command": "git",
  "args": ["status", "--short"]
}
```

以下输入无效：

```json
{ "command": "git status" }
{ "command": "sh", "args": ["-c", "任意脚本"] }
```

第二个示例在 `full-access` 下可以执行，但在 `auto-safe` 下返回 `UNSAFE_COMMAND`。

安全白名单及参数限制定义在 `terminal-exec.ts`。不能把 `npm test` 视为只读安全命令，因为 package script 可以执行任意代码。

## 8. 测试矩阵

必须覆盖：

- 三种模式的权限矩阵；
- 非法模式；
- 未知工具；
- Schema 类型错误和未知字段；
- 绝对路径与 `..` 越界；
- 符号链接逃逸；
- shell 命令字符串；
- auto-safe 非白名单命令；
- full-access 显式可执行文件与参数；
- 拒绝调用的 Session 审计状态。

## 9. 后续增强

M9 将增加：

- 项目级和用户级 allowlist/denylist；
- 副作用审批提示；
- 命令语义风险扫描；
- 密钥和敏感输出脱敏；
- 文件变更追踪与撤销；
- 审批记录持久化。
