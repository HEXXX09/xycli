//! XYCLI Rust 命令行入口。

use std::{
    io::{self, IsTerminal, Write},
    path::PathBuf,
    process::ExitCode,
};

use clap::Parser;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use xycli_core::{
    AgentRunConfig, AgentRunResult, AnthropicProvider, DeepSeekProvider, JsonSessionStore,
    PermissionMode, Provider, ToolRegistry, XycliError, register_builtins, run_agent,
};

const DEFAULT_ANTHROPIC_MODEL: &str = "claude-sonnet-4-5-20250929";
const DEFAULT_DEEPSEEK_MODEL: &str = "deepseek-chat";

#[derive(Debug, Parser)]
#[command(name = "xycli", version, about = "终端原生 AI 编程助手")]
struct Cli {
    /// 自然语言指令；省略时进入交互模式，管道输入则作为一次性指令。
    prompt: Option<String>,

    /// 模型名称；默认值由 Provider 决定。
    #[arg(long)]
    model: Option<String>,

    /// Provider：anthropic 或 deepseek。
    #[arg(long, default_value = "anthropic")]
    provider: String,

    /// 单次任务最大 Agent 循环次数。
    #[arg(long, default_value_t = 25, value_parser = clap::value_parser!(u32).range(1..=100))]
    max_turns: u32,

    /// 强制进入交互模式。
    #[arg(short, long)]
    interactive: bool,

    /// 权限模式：read-only、auto-safe 或 full-access。
    #[arg(long, default_value = "auto-safe")]
    permission: String,

    /// 继续已有会话。
    #[arg(long)]
    session: Option<Uuid>,
}

struct Runtime {
    provider: Box<dyn Provider>,
    provider_display: &'static str,
    model: String,
    max_turns: u32,
    cwd: PathBuf,
    permission_mode: PermissionMode,
    registry: ToolRegistry,
    store: JsonSessionStore,
}

fn create_provider(
    name: &str,
) -> Result<(Box<dyn Provider>, &'static str, &'static str), XycliError> {
    match name.to_ascii_lowercase().as_str() {
        "anthropic" => Ok((
            Box::new(AnthropicProvider::from_env()?),
            "Anthropic",
            DEFAULT_ANTHROPIC_MODEL,
        )),
        "deepseek" => Ok((
            Box::new(DeepSeekProvider::from_env()?),
            "DeepSeek",
            DEFAULT_DEEPSEEK_MODEL,
        )),
        other => Err(XycliError::validation(format!(
            "不支持的 Provider：{other}。可选值：anthropic、deepseek。"
        ))),
    }
}

async fn execute_prompt(
    runtime: &Runtime,
    prompt: String,
    session_id: Option<Uuid>,
) -> Result<AgentRunResult, XycliError> {
    let cancellation = CancellationToken::new();
    let run = run_agent(AgentRunConfig {
        prompt,
        model: runtime.model.clone(),
        max_turns: runtime.max_turns,
        cwd: runtime.cwd.clone(),
        provider: runtime.provider.as_ref(),
        tool_registry: &runtime.registry,
        session_store: &runtime.store,
        permission_mode: runtime.permission_mode,
        cancellation: cancellation.clone(),
        session_id,
    });
    tokio::pin!(run);
    tokio::select! {
        result = &mut run => result,
        signal = tokio::signal::ctrl_c() => {
            if signal.is_ok() {
                eprintln!("\n  ⏸  已中断，正在保存...");
                cancellation.cancel();
            }
            run.await
        }
    }
}

fn print_banner(runtime: &Runtime, interactive: bool) {
    println!(
        "\n  XYCLI v{} — Rust AI 编程助手",
        env!("CARGO_PKG_VERSION")
    );
    println!(
        "  Provider: {}  |  模型: {}",
        runtime.provider_display, runtime.model
    );
    println!("  工作目录: {}", runtime.cwd.display());
    println!("  权限模式: {}", runtime.permission_mode.as_str());
    if interactive {
        println!("  输入 /help 查看命令，/exit 退出\n");
    }
}

async fn interactive_loop(
    mut runtime: Runtime,
    initial_prompt: Option<String>,
    initial_session: Option<Uuid>,
) -> Result<u8, XycliError> {
    let mut session_id = initial_session;
    if let Some(prompt) = initial_prompt {
        let result = execute_prompt(&runtime, prompt, session_id).await?;
        if !result.final_message.is_empty() {
            println!("\n{}", result.final_message);
        }
        session_id = Some(result.session_id);
    }

    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    loop {
        print!("\n❯ ");
        io::stdout().flush().map_err(XycliError::from)?;
        let Some(line) = lines.next_line().await.map_err(XycliError::from)? else {
            break;
        };
        let input = line.trim();
        if input.is_empty() {
            continue;
        }
        match input {
            "/exit" | "/quit" | "/q" => {
                println!("  再见！");
                break;
            }
            "/help" | "/h" => {
                println!(
                    "  /help        显示帮助\n  /exit        退出\n  /new         开始新会话\n  /model NAME  切换模型\n  /turns N     修改最大循环次数"
                );
                continue;
            }
            "/new" => {
                session_id = None;
                println!("  已开始新会话。");
                continue;
            }
            _ => {}
        }
        if let Some(model) = input
            .strip_prefix("/model ")
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            runtime.model = model.to_owned();
            println!("  模型已切换：{}", runtime.model);
            continue;
        }
        if let Some(turns) = input.strip_prefix("/turns ") {
            match turns.trim().parse::<u32>() {
                Ok(value) if (1..=100).contains(&value) => {
                    runtime.max_turns = value;
                    println!("  最大循环次数：{value}");
                }
                _ => println!("  最大循环次数必须是 1 到 100 之间的整数。"),
            }
            continue;
        }
        let result = execute_prompt(&runtime, input.to_owned(), session_id).await?;
        if !result.final_message.is_empty() {
            println!("\n{}", result.final_message);
        }
        session_id = Some(result.session_id);
    }
    Ok(0)
}

async fn run() -> Result<u8, XycliError> {
    let cli = Cli::parse();
    let permission_mode = cli.permission.parse::<PermissionMode>()?;
    let (provider, provider_display, default_model) = create_provider(&cli.provider)?;
    let cwd = std::env::current_dir().map_err(XycliError::from)?;
    let mut registry = ToolRegistry::new();
    register_builtins(&mut registry)?;
    let runtime = Runtime {
        provider,
        provider_display,
        model: cli.model.unwrap_or_else(|| default_model.to_owned()),
        max_turns: cli.max_turns,
        cwd: cwd.clone(),
        permission_mode,
        registry,
        store: JsonSessionStore::new(&cwd),
    };

    let piped = !io::stdin().is_terminal();
    let interactive = cli.interactive || (cli.prompt.is_none() && !piped);
    print_banner(&runtime, interactive);
    if interactive {
        return interactive_loop(runtime, cli.prompt, cli.session).await;
    }
    let prompt = if let Some(prompt) = cli.prompt {
        prompt
    } else {
        let mut input = String::new();
        tokio::io::stdin()
            .read_to_string(&mut input)
            .await
            .map_err(XycliError::from)?;
        input.trim().to_owned()
    };
    if prompt.is_empty() {
        return Err(XycliError::validation("prompt 不能为空。"));
    }
    let result = execute_prompt(&runtime, prompt, cli.session).await?;
    if !result.final_message.is_empty() {
        println!("\n{}", result.final_message);
    }
    Ok(result.exit_code)
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("\n  错误：{}", error.message);
            ExitCode::from(error.exit_code())
        }
    }
}
