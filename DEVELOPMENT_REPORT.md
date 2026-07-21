# XYCLI 开发报告

> 更新时间：2026-07-21
> 当前版本：v0.3.0

## 总结

XYCLI 已完成 M2 产品化基础阶段。仓库保持 Rust-only，核心能力从“能运行的 Agent”扩展为“可配置、可安全保存凭据、可流式输出、可诊断并可持续发布的 CLI”。

本阶段采用独立提交拆分结构重构与行为变更；旧 TypeScript 实现不再参与构建、测试或发布。

## 已完成

| 能力 | 状态 |
| --- | --- |
| Provider 目录化拆分 | 已完成 |
| Anthropic 与 DeepSeek SSE 流式文本、工具调用聚合 | 已完成 |
| 分层配置、来源追踪和 TOML 写入 | 已完成 |
| 系统凭据存储、环境变量降级和秘密脱敏 | 已完成 |
| Provider Factory 与启动前校验 | 已完成 |
| AgentEvent、EventSink 和 CLI Renderer | 已完成 |
| JSON Lines、非流式和无颜色输出 | 已完成 |
| 错误分类、指数退避、抖动和 Retry-After | 已完成 |
| 最小请求间隔和取消感知 | 已完成 |
| doctor 与全局安装检查 | 已完成 |
| macOS、Linux、Windows CI | 已完成 |
| 多平台 Release 归档和 SHA-256 工作流 | 已完成 |

## 当前架构

```text
CLI 命令与 Renderer
  → 配置解析 + 凭据解析 + Provider Factory
    → RetryingProvider
      → Anthropic / DeepSeek 流式 Provider
        → Agent Loop + AgentEvent
          → PermissionMode + ToolRegistry
            → file_read / file_write / terminal_exec
          → JsonSessionStore
```

## 可靠性与安全不变量

- 配置优先级为 CLI、环境、项目、用户、默认值；
- 普通 TOML 不允许保存 API Key、Token 或 Secret；
- Secret 的 Debug、Display 和配置输出不会显示原文；
- Base URL 默认要求 HTTPS，仅本机协议测试允许 HTTP；
- 重试只包围单次模型请求，不重放已经执行成功的工具；
- SSE 已产生文本后发生中断时不自动重试；
- 工具仍通过权限矩阵、严格输入校验和工作区安全策略；
- CI 和默认测试不需要真实 API Key，也不请求公网模型。

## 验收命令

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
cargo build --workspace --release --locked
./target/release/xycli --version
./target/release/xycli --help
./target/release/xycli doctor --json
cargo install --path crates/xycli-cli --locked --force
```

## 当前边界

- 只支持 Anthropic 和 DeepSeek，OpenAI 与兼容网关进入 M3；
- 已有重试与节流，但熔断和显式 fallback 尚未实现；
- JSON 会话尚无跨进程锁、查询命令和上下文压缩；
- 写操作尚无逐次交互审批、敏感内容规则脱敏、变更账本和撤销；
- 尚未实现搜索、Web、Git 专用工具、Plan 模式、MCP 与插件；
- Release 工作流已定义，实际各平台结果需在 GitHub Actions 运行后确认。

## 下一阶段建议

按路线图进入 M3 Provider 扩展与容错，但建议仍拆成可独立验收的小阶段：先实现 OpenAI 与 OpenAI-compatible 协议复用，再做能力探测、熔断和显式 fallback。任何 fallback 都必须保留清晰的 Provider、模型和错误审计信息，且不能跨越已发生工具副作用的边界。
