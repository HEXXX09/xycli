# XYCLI

XYCLI 是一个以 Rust 为核心运行时的终端 AI 编程助手。它将自然语言任务交给模型，通过受控的文件和终端工具完成读取、修改、验证，并将完整过程保存为本地会话。

## 当前状态

项目已进入 Rust 核心迁移后的 `v0.2.0` 基线：

- Rust CLI 与可复用核心库；
- Anthropic Messages API 与 DeepSeek Chat Completions API；
- 可继续上下文的 Agent 工具调用循环；
- `file_read`、`file_write`、`terminal_exec` 三个内置工具；
- `read-only`、`auto-safe`、`full-access` 三种权限模式；
- 工作区路径隔离、符号链接逃逸防御和无 shell 命令执行；
- JSON 会话原子持久化；
- Rust 单元、协议、集成与安全测试；
- TypeScript 版本保留为迁移对照和兼容实现。

Rust 是默认开发和运行路径。原 TypeScript 代码位于 `src/`，不会参与 Rust 二进制运行。

## 环境要求

- Rust stable，项目通过 `rust-toolchain.toml` 固定工具链通道；
- 可选：Node.js 18 或更高版本，仅用于运行旧 TypeScript 回归测试；
- `ANTHROPIC_API_KEY` 或 `DEEPSEEK_API_KEY`。

安装 Rust：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup component add rustfmt clippy
```

## 本地构建与运行

```bash
cargo build --workspace
```

默认使用 Anthropic：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cargo run -p xycli -- "列出当前目录的文件"
```

使用 DeepSeek：

```bash
export DEEPSEEK_API_KEY=sk-...
cargo run -p xycli -- --provider deepseek "读取 README.md 并总结"
```

构建发布版本并直接运行：

```bash
cargo build --workspace --release
./target/release/xycli --help
./target/release/xycli "检查当前项目"
```

不提供 prompt 时进入交互模式：

```bash
cargo run -p xycli --
```

也支持管道输入：

```bash
printf '总结 README.md' | cargo run -p xycli -- --provider deepseek
```

## 常用参数

```text
--provider <provider>   anthropic 或 deepseek
--model <model>         覆盖 Provider 默认模型
--max-turns <1-100>     单次任务最大 Agent 循环次数
--permission <mode>     read-only、auto-safe 或 full-access
--session <uuid>        继续已有会话
-i, --interactive       强制进入交互模式
```

交互命令包括 `/help`、`/new`、`/model <name>`、`/turns <n>` 和 `/exit`。

## 权限说明

默认使用 `auto-safe`：

- 文件读写仅允许在启动工作区内；
- 真实路径校验会阻止绝对路径、`..` 和符号链接逃逸；
- `terminal_exec` 始终以“可执行文件 + 参数数组”运行，不经过 shell；
- 仅允许 `pwd`、`echo`、工作区内 `ls` 和受限的只读 Git 子命令；
- 任意其他可执行文件需要显式使用 `--permission full-access`。

`full-access` 仍然不会启用 shell 字符串拼接，但允许模型调用 PATH 中的任意程序。只应在任务和仓库可信时启用。

## 测试与质量检查

Rust 全量验证：

```bash
cargo test --workspace --all-targets
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace --release
```

一次运行 Rust 与 TypeScript 回归：

```bash
npm ci
npm test
npm run typecheck
```

真实模型 API 不属于默认自动化测试；Provider 协议测试使用本机临时 HTTP 服务，不会消耗 API 额度。

## 架构

```text
crates/xycli-cli
  └── 参数、交互模式、Ctrl+C 与进程退出码
        ↓
crates/xycli-core
  ├── Agent Loop
  ├── Provider：Anthropic / DeepSeek
  ├── PermissionMode + ToolRegistry
  ├── file_read / file_write / terminal_exec
  └── JsonSessionStore
```

详细资料：

- [Rust 迁移设计与验收](docs/RUST_MIGRATION.md)
- [系统架构](docs/ARCHITECTURE.md)
- [产品需求](docs/PRD.md)
- [详细设计](docs/DESIGN.md)
- [任务路线图](docs/TASKS.md)
- [稳定化修复设计](docs/REMEDIATION_PLAN.md)

## 项目结构

```text
Cargo.toml
crates/
├── xycli-cli/          # Rust 可执行程序
└── xycli-core/         # Rust 核心库和集成测试
src/                    # TypeScript 兼容实现
test/                   # TypeScript E2E 与 fixture
docs/                   # 中文设计文档
```

## 许可证

MIT
