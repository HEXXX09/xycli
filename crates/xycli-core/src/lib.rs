//! XYCLI 核心运行时。
//!
//! 本 crate 不依赖具体终端界面，负责 Agent 循环、模型适配、权限控制、
//! 工具执行和会话持久化，便于 CLI、桌面端或服务端复用同一套行为。

pub mod agent;
pub mod error;
pub mod permission;
pub mod prompt;
pub mod provider;
pub mod session;
pub mod tools;

pub use agent::{AgentRunConfig, AgentRunResult, run_agent};
pub use error::{ErrorKind, XycliError, XycliResult};
pub use permission::{PermissionLevel, PermissionMode};
pub use provider::{AnthropicProvider, DeepSeekProvider, Provider};
pub use session::{JsonSessionStore, SessionStore};
pub use tools::{ToolRegistry, register_builtins};
