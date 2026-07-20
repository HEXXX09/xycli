# XYCLI Rust 核心迁移设计与验收

> 迁移版本：v0.2.0
> 日期：2026-07-20
> 状态：实现完成，进入发布验收

## 1. 迁移目标

本次不是机械翻译 TypeScript，而是保持外部行为兼容的核心运行时替换。迁移范围包括 CLI、Agent 循环、权限、工具注册、文件工具、终端工具、会话存储、Anthropic 和 DeepSeek Provider。

TypeScript 暂不删除，作为回归基线。Rust 验证完成后，默认运行入口和开发命令切换到 Cargo。

## 2. 模块映射

| TypeScript 基线 | Rust 实现 | 兼容要求 |
| --- | --- | --- |
| `src/cli.ts` | `crates/xycli-cli/src/main.rs` | 参数、交互模式、退出码 |
| `src/core/agent-loop.ts` | `crates/xycli-core/src/agent.rs` | 状态、轮次、工具闭环 |
| `src/core/permission-guard.ts` | `permission.rs` | 显式允许矩阵 |
| `src/providers/` | `provider.rs` | 双 Provider 协议 |
| `src/tools/` | `tools/` | Schema、权限、路径、命令 |
| `src/session/json-store.ts` | `session.rs` | camelCase JSON 与原子写入 |

## 3. 关键设计决定

### 3.1 工作区而非单体 crate

`xycli-core` 是不依赖终端的库，`xycli` 是薄 CLI。这样可以独立测试核心，也为未来桌面端或服务端复用留出边界。

### 3.2 异步运行时

统一使用 Tokio 管理 HTTP、文件、子进程、超时、信号和取消。取消通过 `CancellationToken` 从 CLI 传到 Agent、Provider 与工具。

### 3.3 动态工具输入

Provider 的工具参数保留为 `serde_json::Value`，因为工具集合是运行时动态的。每个工具在执行前进行严格校验，包括必填字段、类型、长度、数值范围和未知字段。

### 3.4 安全命令

不提供 shell 字符串入口。即使在 `full-access` 下，分号、管道和重定向也只是普通参数，不会被解释。默认模式额外使用命令和参数白名单。

### 3.5 会话格式

Rust 使用 Serde 重命名保持既有 `camelCase` 字段和状态字符串。已有 JSON 会话可以继续读取，新的 Rust 会话也可供旧代码审计。

## 4. 测试策略

测试分为四层：

1. 纯单元测试：权限矩阵、协议解析、diff、命令规则；
2. Agent 测试：MockProvider、多轮工具调用、轮次上限、会话落盘；
3. 安全集成测试：路径逃逸、符号链接、哈希冲突、命令注入、权限拒绝；
4. Provider HTTP 测试：本机临时服务接收真实 HTTP 请求，检查端点、认证头和 JSON 映射。

Provider HTTP 测试只绑定 `127.0.0.1`，不使用真实 API Key，也不会产生模型费用。

## 5. 本地验收流程

```bash
rustup component add rustfmt clippy
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
cargo build --workspace --release
./target/release/xycli --help
```

兼容回归：

```bash
npm ci
npm run test:ts
npm run typecheck:ts
npm run build:ts
```

## 6. 已知边界

- 当前 Provider 主循环使用非流式请求，流式终端渲染放在下一阶段；
- JSON 会话存储只提供单进程写互斥，跨进程并发将在 SQLite 迁移时解决；
- `full-access` 允许调用任意本地程序，因此仍需显式选择；
- Rust 与 TypeScript 会在稳定观察期内并存，后续单独提交旧实现删除方案。

## 7. 完成门槛

- Rust 格式检查零差异；
- Clippy 以 `-D warnings` 通过；
- Rust 全部单元和集成测试通过；
- Release 构建和 CLI 冒烟通过；
- TypeScript 原有回归、类型检查和生产构建继续通过；
- README、架构、迁移报告和本地命令全部更新为中文且与实际一致；
- 最终 Git 差异经审查后再提交和推送。
