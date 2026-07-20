# XYCLI 系统架构

> 当前生产主链路已经迁移到 Rust。`src/` 中的 TypeScript 实现作为行为对照和兼容基线保留，默认 Rust 二进制不会加载 Node.js 代码。

## 1. 系统定位

XYCLI 是运行在开发者本机终端中的 AI 编程 Agent。它接收自然语言任务，通过模型推理、受控工具调用和本地会话持久化完成编码工作，不是常驻 Web 服务。

主要外部边界包括模型 API、当前工作区文件系统和本地可执行程序。网络搜索、MCP、插件、审批中心等仍属于后续里程碑。

## 2. Rust 工作区

```text
Cargo workspace
├── xycli-cli
│   ├── clap 参数解析
│   ├── 单次模式与交互模式
│   ├── Ctrl+C 取消
│   └── 退出码
└── xycli-core
    ├── agent.rs          Agent 主循环
    ├── provider.rs       Anthropic / DeepSeek
    ├── permission.rs     显式权限矩阵
    ├── tools/            注册中心与三个内置工具
    ├── session.rs        JSON 会话存储
    ├── prompt.rs         系统提示词
    └── error.rs          错误类别与退出码
```

拆分为核心库和 CLI 的原因是让 Agent 运行时不依赖具体终端，后续桌面端、服务端或测试程序可以直接复用 `xycli-core`。

## 3. 运行数据流

1. CLI 校验 Provider、模型、最大轮次、会话 ID 和权限模式。
2. CLI 初始化 Provider、ToolRegistry 与 JsonSessionStore。
3. Agent Loop 创建新会话，或从 UUID 对应的 JSON 文件继续会话。
4. Agent Loop 将历史消息、中文系统提示词和工具 JSON Schema 发给 Provider。
5. Provider 返回最终文本或结构化工具调用。
6. ToolRegistry 先执行工具级权限检查，再严格校验 JSON 输入。
7. 工具执行路径或命令级安全检查，并接受超时和取消信号。
8. 工具结果和审计记录写入会话，然后回传模型进入下一轮。
9. 正常结束、达到轮次、输出截断、中断和错误分别保存为不同终态与退出码。

## 4. 核心接口

| 接口 | 职责 |
| --- | --- |
| `Provider` | 统一模型请求和工具调用响应 |
| `Tool` | 工具定义、运行时校验和异步执行 |
| `ToolRegistry` | 注册、权限、超时、取消与统一错误 |
| `SessionStore` | 会话创建、更新、读取和列表 |
| `run_agent` | 驱动模型与工具之间的多轮闭环 |

依赖均通过结构体字段或 trait 引用传入，不使用全局单例，因此可以用 MockProvider 和临时会话目录完成离线测试。

## 5. 权限与安全边界

权限检查分三层：

```text
PermissionMode 显式允许矩阵
  → Tool 输入类型、长度与未知字段校验
    → 文件真实路径或命令动作策略
```

| 模式 | 允许能力 |
| --- | --- |
| `read-only` | 仅只读工具 |
| `auto-safe` | 工作区文件读写和受限安全命令 |
| `full-access` | 所有工具级别及任意本地可执行文件 |

文件策略会规范化工作区根目录。已存在路径使用真实路径判断；待创建路径寻找最近的已存在祖先并解析符号链接。目标不在真实工作区根目录下时返回 `PATH_OUTSIDE_WORKSPACE`。

命令工具有以下不变量：

- `command` 只能是单个程序名，参数必须放在 `args`；
- 始终使用 `tokio::process::Command`，不调用 shell；
- `auto-safe` 只允许 `pwd`、`echo`、工作区内的 `ls`，以及 `git status/diff/log/show`；
- 安全命令必须解析到工作区外的可信 PATH，防止仓库内同名程序劫持；
- stdout 和 stderr 会持续排空但最多各保留 100,000 字节，避免输出导致内存无限增长；
- 超时或取消会终止子进程。

## 6. Provider 层

Anthropic 使用 `/v1/messages`、`x-api-key` 和 `anthropic-version`；DeepSeek 使用 `/chat/completions` 和 Bearer Token。两者都通过 `reqwest` 的 rustls 后端访问，不依赖系统 OpenSSL。

Provider 负责内部消息与厂商协议互转、文本和工具调用归一化、Token 用量归一化、HTTP 错误映射以及取消正在等待的网络请求。

默认测试会启动绑定到 `127.0.0.1` 的临时 HTTP 服务，验证实际 URL、请求头、请求体和响应解析，不访问真实模型 API。

## 7. 会话与兼容

会话继续保存在 `.xycli/sessions/json/<uuid>.json`。Rust 结构体使用 `camelCase` 字段和既有状态值，保持与 TypeScript 会话格式兼容。

写入流程为：序列化到同目录唯一临时文件，然后原子重命名。单进程内另有异步互斥，防止并发更新互相覆盖。损坏的单个会话文件不会阻断会话列表。

## 8. 终态和退出码

| 状态 | 退出码 | 含义 |
| --- | ---: | --- |
| `completed` | 0 | 模型正常确认结束 |
| `incomplete` / `interrupted` | 1 | 未完成或用户中断 |
| 参数校验错误 | 2 | CLI 或运行配置无效 |
| 权限错误 | 3 | 顶层权限错误 |
| Provider 错误 | 4 | 模型或网络适配失败 |
| Tool 致命错误 | 5 | 工具运行时错误 |

单个工具调用失败会作为工具结果返回模型，并记录为 `failed` 或 `denied`；不会无条件终止整个 Agent。

## 9. TypeScript 兼容层

`src/`、`test/` 和 npm 依赖暂时保留，用于对比迁移前后的行为、运行原有回归用例，并为后续删除旧实现提供证据。

默认 `npm test` 会先运行 Rust 测试，再运行 TypeScript 测试。`npm run test:ts` 可只执行旧实现测试。

## 10. 后续演进

下一阶段计划按优先级增加流式终端渲染、Provider 重试与 fallback、SQLite 会话仓库、显式审批流、上下文压缩、MCP 和插件系统。Rust 核心库保持接口隔离，避免这些能力反向耦合 CLI。
