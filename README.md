# XYCLI

XYCLI 是一个使用 Rust 实现的终端 AI 编程助手。它把自然语言任务交给模型，通过受控的文件与终端工具完成读取、修改和验证，并将执行过程保存为本地会话。

## 当前状态

当前版本为 Rust-only 的 `v0.3.0`：

- Anthropic Messages API 与 DeepSeek Chat Completions API；
- 支持文本和工具调用的 SSE 流式响应；
- 可继续上下文的 Agent 工具调用循环；
- `file_read`、`file_write`、`terminal_exec` 三个内置工具；
- `read-only`、`auto-safe`、`full-access` 三种权限模式；
- 工作区路径隔离、符号链接逃逸防御和无 shell 命令执行；
- CLI、环境变量、项目文件、用户文件和默认值组成的分层配置；
- 环境变量或操作系统凭据库保存 API Key，普通配置文件拒绝明文密钥；
- 统一 Agent 事件、终端流式渲染、JSON Lines 和无颜色输出；
- Provider 指数退避、抖动、`Retry-After`、请求节流和取消；
- `auth`、`config`、`doctor` 命令；
- macOS、Linux、Windows CI 与多平台 Release 归档工作流。

旧 TypeScript 运行时及 npm 构建链已删除，项目只需要 Rust 工具链。

## 环境要求

- Rust stable；项目通过 `rust-toolchain.toml` 声明 `rustfmt` 和 `clippy`；
- Anthropic 或 DeepSeek API Key；
- macOS、Linux 或 Windows。

安装 Rust：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

## 构建和首次运行

```bash
cd /Users/hxy/XYCLI
cargo build --workspace --release
./target/release/xycli --version
./target/release/xycli doctor
```

推荐把密钥保存到系统凭据库，只需录入一次：

```bash
./target/release/xycli auth login deepseek
./target/release/xycli auth status
./target/release/xycli --provider deepseek
```

也可以只给当前终端临时设置环境变量：

```bash
export DEEPSEEK_API_KEY='你的密钥'
./target/release/xycli --provider deepseek
```

Anthropic 对应 `anthropic` 和 `ANTHROPIC_API_KEY`：

```bash
./target/release/xycli auth login anthropic
./target/release/xycli --provider anthropic
```

不提供 prompt 时进入交互模式；单次任务可以直接跟在命令后：

```bash
./target/release/xycli --provider deepseek "读取 README.md 并总结"
./target/release/xycli run --provider deepseek "运行测试并解释失败原因"
```

交互命令包括 `/help`、`/new`、`/model <name>`、`/turns <n>` 和 `/exit`。

## 安装为全局命令

```bash
cd /Users/hxy/XYCLI
cargo install --path crates/xycli-cli --locked --force
xycli --version
xycli doctor
```

如果新终端找不到 `xycli`，把 Cargo 二进制目录加入 `PATH`：

```bash
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> "$HOME/.zshrc"
source "$HOME/.zshrc"
```

之后可在任意项目目录直接运行：

```bash
cd /你的/项目目录
xycli --provider deepseek
```

## 配置

配置优先级固定为：

```text
CLI 参数 > 环境变量 > .xycli/config.toml > ~/.config/xycli/config.toml > 内置默认值
```

常用命令：

```bash
xycli config show
xycli config explain provider.model
xycli config path
xycli config set provider.name deepseek --user
xycli config set agent.max_turns 30 --project
```

可配置项包括 `provider.name`、`provider.model`、`provider.base_url`、`provider.timeout_seconds`、`provider.max_attempts`、`provider.retry_base_ms`、`provider.min_request_interval_ms`、`agent.max_turns`、`agent.permission`、`output.json`、`output.no_stream` 和 `output.color`。

API Key 不属于普通配置。项目或用户 TOML 中出现 key、token、secret 等秘密字段时，加载器会拒绝该配置。

## 输出模式

```bash
xycli --provider deepseek "总结项目"              # 终端流式输出
xycli --provider deepseek --no-stream "总结项目"  # 聚合后输出
xycli --provider deepseek --json "总结项目"       # JSON Lines 事件
NO_COLOR=1 xycli --provider deepseek               # 禁用颜色
```

Provider 发生连接失败、超时、HTTP 408、409、429 或 5xx 时，可以在尚未产生有效流式输出的前提下安全重试。已输出内容后不会自动重放，避免重复文本和副作用。

## 常用参数

```text
--provider <provider>   anthropic 或 deepseek
--model <model>         覆盖配置中的模型
--base-url <url>        覆盖 Provider 地址
--max-turns <1-100>     单次任务最大 Agent 循环次数
--permission <mode>     read-only、auto-safe 或 full-access
--session <uuid>        继续已有会话
--json                  输出 JSON Lines 事件
--no-stream             禁用流式终端渲染
--no-color              禁用颜色
-i, --interactive       强制进入交互模式
```

## 权限和安全

默认使用 `auto-safe`：

- 文件读写仅允许在启动工作区内；
- 真实路径校验会阻止绝对路径、`..` 和符号链接逃逸；
- `terminal_exec` 始终以“可执行文件 + 参数数组”运行，不经过 shell；
- 仅允许 `pwd`、`echo`、工作区内 `ls` 和受限只读 Git 子命令；
- 其他可执行文件需要显式使用 `--permission full-access`。

`full-access` 仍不会启用 shell 字符串拼接，但允许模型调用 PATH 中的任意程序，只应在任务和仓库可信时使用。

## 测试与质量检查

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
cargo build --workspace --release --locked
./target/release/xycli --help
./target/release/xycli doctor --json
```

Provider 协议测试使用本机临时 HTTP 服务，不访问真实模型 API，也不会消耗额度。

## 架构

```text
xycli CLI
  ├── clap 命令、交互模式和 Ctrl+C
  ├── Renderer：终端 / JSON Lines / 非流式
  └── doctor、auth、config
        ↓
xycli-core
  ├── Config + SecretStore + ProviderFactory
  ├── Agent Loop + AgentEvent
  ├── Provider：Anthropic / DeepSeek / Stream / Retry
  ├── PermissionMode + ToolRegistry
  ├── file_read / file_write / terminal_exec
  └── JsonSessionStore
```

详细资料：

- [系统架构](docs/ARCHITECTURE.md)
- [详细设计](docs/DESIGN.md)
- [v0.3.0 阶段设计与验收](docs/NEXT_PHASE_DESIGN.md)
- [产品需求](docs/PRD.md)
- [任务路线图](docs/TASKS.md)
- [Rust 迁移记录](docs/RUST_MIGRATION.md)

## 许可证

MIT
