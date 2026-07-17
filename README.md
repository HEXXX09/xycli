# XYCLI

终端原生的 AI 编程助手 —— 像 Claude Code 一样在命令行里写代码，但开放、可扩展。

直接用自然语言在终端里完成编码、调试、重构、测试和部署。

## 主流 AI Agent CLI 工具对比

| 工具 | 语言 | 分发方式 |
|------|------|----------|
| **Claude Code** (Anthropic) | TypeScript | npm |
| **Codex CLI** (OpenAI) | TypeScript | npm |
| **Hermes Agent** (Nous) | Python | pip / CLI |
| **Aider** | Python | pip |
| **Goose** (Block) | Rust | 二进制 |
| **XYCLI** | TypeScript | npm ✅ |

TypeScript 是 AI CLI Agent 的主流选择：npm 生态成熟、跨平台终端支持好、流式处理强。XYCLI 与 Claude Code 技术栈一致。

## 当前状态

**M1 骨架** — 核心 agent loop、Anthropic provider、3 个内置工具。CLI 可运行，44 个测试通过。

| 里程碑 | 目标 | 状态 |
|--------|------|------|
| M1 | 核心骨架（agent loop + Anthropic + 文件/终端工具） | ✅ 已完成 |
| M2 | 更多工具 + 流式输出 UI | 🔜 下一步 |
| M3 | 多 provider 支持（OpenAI） | 计划中 |
| M4 | SQLite 持久化 + 会话恢复 | 计划中 |
| M5 | Plan 模式（先计划后执行） | 计划中 |
| M6 | 跨会话记忆 | 计划中 |
| M7 | Computer Use（终端增强 + 浏览器 + 截图） | 计划中 |
| M8 | MCP 协议 + 插件系统 | 计划中 |
| M9 | 安全（权限引擎、审批、脱敏、撤销） | 计划中 |
| M10 | 打磨（遥测、诊断、npm 发布、CI/CD） | 计划中 |

## 快速开始

### 环境要求

- Node.js >= 18
- Anthropic API Key

### 安装运行

```bash
# 安装依赖
npm install

# 编译
npm run build

# 设置 API Key
export ANTHROPIC_API_KEY=sk-ant-...

# 运行 XYCLI
node dist/src/cli.js "列出当前目录的文件"
```

### 开发命令

```bash
npm run dev          # 热加载运行（tsx，无需编译）
npm test             # 运行全部测试（44 个用例）
npm run typecheck    # 类型检查
npm run build        # TypeScript 编译
```

## 架构

```
xycli "用自然语言描述任务"
    │
    ▼
CLI 入口 (Commander.js)
    │
    ▼
Agent Loop ── 观察 → 规划 → 执行 → 反思
    │              │
    ▼              ▼
Anthropic API    工具注册中心
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
      文件读取    文件写入    终端执行
          │
          ▼
    会话存储 (JSON)
```

- **工具接口** — 实现 `ITool` 接口并注册即可添加新工具，无需修改核心代码。
- **Provider 接口** — 实现 `IProvider` 接口即可接入新模型。M1 内置 Anthropic，M3 加入 OpenAI。
- **Agent Loop** — 可恢复的观察-规划-执行-反思循环，支持最大轮次控制和 Ctrl+C 中断。

## M1 内置工具

| 工具 | 权限级别 | 功能 |
|------|---------|------|
| `file_read` | 只读 | 读取文件，支持行范围、大小限制、SHA256 校验 |
| `file_write` | 写文件 | 原子写入，附带 unified diff 和哈希验证 |
| `terminal_exec` | 安全命令 | 执行 shell 命令，捕获 stdout/stderr，支持超时 |

## 项目结构

```
XYCLI/
├── docs/                    # 设计文档
│   ├── PRD.md              # 产品需求（18 功能需求，10 用户故事）
│   ├── ARCHITECTURE.md     # 系统架构（314 行）
│   ├── DESIGN.md           # 详细设计（1018 行，含完整 DDL/接口定义）
│   └── TASKS.md            # 任务拆解（10 里程碑，61 任务）
├── src/
│   ├── cli.ts              # CLI 入口（Commander.js）
│   ├── version.ts
│   ├── core/               # Agent Loop、类型定义、System Prompt、错误处理
│   ├── providers/          # Anthropic 适配器（IProvider 接口）
│   ├── tools/              # 工具注册中心 + 3 个内置工具（ITool 接口）
│   └── session/            # JSON 文件会话存储
├── test/
│   ├── e2e/                # 端到端测试
│   └── fixtures/           # Mock Provider
├── README.md
├── package.json
└── tsconfig.json
```

## License

MIT
