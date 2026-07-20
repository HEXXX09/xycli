# XYCLI Rust 核心迁移开发报告

> 更新时间：2026-07-20

## 总结

XYCLI 已在既有 TypeScript M1 稳定化成果上完成 Rust 核心迁移。默认主链路由 Cargo workspace 构建，TypeScript 保留为兼容回归基线。

项目远端：`https://github.com/HEXXX09/xycli`

## 已完成

| 项目 | 状态 |
| --- | --- |
| Rust workspace 与工具链配置 | 已完成 |
| 独立 `xycli-core` 和 `xycli` CLI | 已完成 |
| Agent 循环、终态、轮次与取消 | 已完成 |
| Anthropic 与 DeepSeek HTTP Provider | 已完成 |
| 权限矩阵和严格工具输入校验 | 已完成 |
| 工作区路径与符号链接隔离 | 已完成 |
| 原子文件写入和哈希冲突检查 | 已完成 |
| 无 shell 子进程、白名单、超时和输出上限 | 已完成 |
| JSON 会话兼容与原子持久化 | 已完成 |
| Rust 单元、HTTP、Agent 和安全集成测试 | 已完成 |
| 中文 README、架构与迁移文档 | 已完成 |

## 迁移中发现并修复的问题

集成测试发现：当可写目标本身已存在时，空相对后缀经 `PathBuf::join("")` 会生成带目录语义的路径，读取时返回 `ENOTDIR`。路径策略现已对空后缀直接返回真实目标，不再追加空路径，并通过哈希冲突回归测试。

## 当前架构

```text
Rust CLI
  → Agent Loop
    → Anthropic / DeepSeek Provider
    → PermissionMode + ToolRegistry
      → file_read / file_write / terminal_exec
    → JsonSessionStore
```

## 验收命令

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
cargo build --workspace --release
npm run test:ts
npm run typecheck:ts
npm run build:ts
```

## 已知边界

- 当前 Rust Provider 使用非流式主路径；
- 尚未实现 SQLite、跨进程锁、审批交互、重试和 fallback；
- 尚未实现 MCP、插件、浏览器和 Computer Use；
- `full-access` 允许任意本地程序，必须显式启用；
- TypeScript 旧实现的删除将在 Rust 稳定观察后单独处理。
