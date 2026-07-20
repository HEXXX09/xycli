# XYCLI 任务路线图

> 当前技术基线：核心运行时已迁移到 Rust。本文中的历史 TypeScript 任务用于追溯，新增功能默认在 Cargo workspace 中实现。

> 共 10 个里程碑、62 个任务。状态更新时间：2026-07-20。

## 里程碑总览

| 里程碑 | 目标 | 任务数 | 状态 |
| --- | --- | ---: | --- |
| M1 | 核心骨架与稳定化 | 9 | 已完成 |
| M2 | 更多工具与 CLI 体验 | 6 | 待开始 |
| M3 | 多 Provider 与容错 | 6 | 部分预研 |
| M4 | SQLite 与会话恢复 | 6 | 待开始 |
| M5 | Plan 模式 | 5 | 待开始 |
| M6 | 跨会话记忆 | 5 | 待开始 |
| M7 | Computer Use | 5 | 待开始 |
| M8 | MCP 与插件扩展 | 7 | 待开始 |
| M9 | 完整安全能力 | 7 | 部分基础已前置 |
| M10 | 诊断、发布与 CI/CD | 6 | 部分打包能力已前置 |

## M1：核心骨架与稳定化

- [x] M1-T01：建立根目录 TypeScript CLI 骨架。
- [x] M1-T02：定义 Core、Provider、Tool 和 Session 领域接口。
- [x] M1-T03：实现 JSON 文件会话存储与原子写入。
- [x] M1-T04：实现工具注册中心、Zod 校验、超时和结构化结果。
- [x] M1-T05：实现 `file_read`、`file_write`、`terminal_exec`。
- [x] M1-T06：实现 Anthropic Provider 适配器。
- [x] M1-T07：实现最小 Agent 循环、终态和中断。
- [x] M1-T08：实现 Agent 集成测试与真实 CLI 子进程 E2E。
- [x] M1-T09：实现权限模式、工作区隔离和安全命令边界。

M1 验收：

```bash
npm test
npm run typecheck
npm run build
node dist/cli.js --help
```

## M2：更多工具与 CLI 体验

- [ ] M2-T01：统一流式 Renderer，支持颜色、`NO_COLOR` 和非流式模式。
- [ ] M2-T02：实现 `search_text`，优先使用 `rg` 并提供 Node.js 回退。
- [ ] M2-T03：实现受网络策略和大小限制的 `web_fetch`。
- [ ] M2-T04：实现专用 `git_status` 与 `git_diff` 工具。
- [ ] M2-T05：实现工具进度、空闲状态和统一终端事件。
- [ ] M2-T06：完成 CLI 体验 E2E。

## M3：多 Provider 与容错

- [ ] M3-T01：实现 Provider 配置加载与优先级合并。
- [ ] M3-T02：实现 OpenAI Provider 适配器。
- [ ] M3-T03：实现 Provider Factory；现有 DeepSeek 创建逻辑迁入工厂。
- [ ] M3-T04：实现指数退避、抖动和可重试错误分类。
- [ ] M3-T05：实现熔断器与 fallback Provider。
- [ ] M3-T06：完成多 Provider、重试与 fallback E2E。

已前置实现：DeepSeek 非流式/流式映射、系统提示词、AbortSignal 和模拟 SDK 测试；这些不等同于完成 M3。

## M4：SQLite 与会话恢复

- [ ] M4-T01：建立 SQLite Schema 和迁移机制。
- [ ] M4-T02：实现 SQLite SessionStore，并保持仓储接口稳定。
- [ ] M4-T03：实现 `resume` 命令和工作区校验。
- [ ] M4-T04：实现 session list/show 命令。
- [ ] M4-T05：实现中断、崩溃和恢复日志持久化。
- [ ] M4-T06：完成持久化和恢复 E2E。

## M5：Plan 模式

- [ ] M5-T01：定义 Plan、步骤和状态数据模型。
- [ ] M5-T02：实现规划提示词与 Provider 流程。
- [ ] M5-T03：实现执行前审批提示。
- [ ] M5-T04：实现 Plan 模式 CLI 参数。
- [ ] M5-T05：完成 Plan 生成、审批、拒绝和执行 E2E。

## M6：跨会话记忆

- [ ] M6-T01：设计并实现 Memory Store Schema。
- [ ] M6-T02：生成可审查的记忆提取建议。
- [ ] M6-T03：按相关性向上下文注入记忆。
- [ ] M6-T04：实现 memory list/add/remove 命令。
- [ ] M6-T05：完成跨会话记忆 E2E。

## M7：Computer Use

- [ ] M7-T01：实现可持续终端会话和增量输出。
- [ ] M7-T02：实现截图工具及平台能力检查。
- [ ] M7-T03：定义浏览器自动化 Hook 接口。
- [ ] M7-T04：实现带运行时守卫的浏览器工具占位实现。
- [ ] M7-T05：完成 Computer Use 能力和降级 E2E。

## M8：MCP 与插件扩展

- [ ] M8-T01：在确有需要时拆分 npm workspaces。
- [ ] M8-T02：实现 YAML 配置和 allowlist/denylist。
- [ ] M8-T03：实现 MCP stdio 客户端。
- [ ] M8-T04：实现插件清单 Schema 与校验。
- [ ] M8-T05：通过统一 ToolRegistry 加载插件工具。
- [ ] M8-T06：实现 plugin list/enable/disable 命令。
- [ ] M8-T07：完成 MCP 与插件权限 E2E。

## M9：完整安全能力

- [ ] M9-T01：实现统一 Permission Engine。
- [ ] M9-T02：实现副作用审批 Gate 和审批记录。
- [ ] M9-T03：实现密钥、Token、私钥和用户规则脱敏。
- [ ] M9-T04：实现终端命令语义风险扫描。
- [ ] M9-T05：实现文件变化和会话范围追踪。
- [ ] M9-T06：实现基于哈希保护的 undo 命令。
- [ ] M9-T07：完成安全策略、脱敏、审批和回滚 E2E。

已前置实现：M1 工作区隔离、无 shell 拼接、命令白名单和结构化拒绝。仍缺审批、脱敏、策略配置和回滚。

## M10：诊断、发布与 CI/CD

- [ ] M10-T01：实现 `doctor` 诊断命令。
- [ ] M10-T02：实现默认关闭的遥测骨架与显式授权。
- [ ] M10-T03：完善 npm 发布元数据、许可证、来源证明和包大小检查。
- [ ] M10-T04：建立 GitHub Actions 类型检查、测试和发布流水线。
- [ ] M10-T05：补齐完整命令面与退出码一致性。
- [ ] M10-T06：完成安装、升级、诊断和发布 E2E。

已前置实现：生产专用 tsconfig、精简 `files`、可执行 bin 和 prepack 构建；尚不能视为完成正式发布任务。

## 最终验收清单

- [ ] 所有里程碑任务完成并有对应测试。
- [ ] 默认模式不能越过工作区或执行任意命令。
- [ ] 副作用、网络、MCP 和插件均经过统一审批与审计。
- [ ] 支持中断、恢复、回滚和诊断。
- [ ] npm 安装包不包含测试、私密数据或本地会话。
- [ ] CI 覆盖 Node.js 18、20、22 和主要操作系统。
- [ ] README、PRD、架构、设计和实际行为保持一致。
