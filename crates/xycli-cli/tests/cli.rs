use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    thread,
    time::Duration,
};

use serde_json::json;
use tempfile::tempdir;

fn xycli() -> Command {
    Command::new(env!("CARGO_BIN_EXE_xycli"))
}

fn read_http_request(stream: &mut std::net::TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut request = Vec::new();
    let mut buffer = [0_u8; 4096];
    let mut expected_length = None;
    loop {
        let read = stream.read(&mut buffer).unwrap();
        if read == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..read]);
        if let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
            let header_end = header_end + 4;
            if expected_length.is_none() {
                let headers = String::from_utf8_lossy(&request[..header_end]);
                expected_length = headers.lines().find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")?
                        .trim()
                        .parse::<usize>()
                        .ok()
                });
            }
            if request.len() >= header_end + expected_length.unwrap_or(0) {
                break;
            }
        }
    }
}

fn write_http_json(stream: &mut std::net::TcpStream, body: serde_json::Value) {
    let body = serde_json::to_string(&body).unwrap();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .unwrap();
}

fn two_turn_anthropic_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    thread::spawn(move || {
        let (mut first, _) = listener.accept().unwrap();
        read_http_request(&mut first);
        write_http_json(
            &mut first,
            json!({
                "content":[{"type":"tool_use","id":"call-1","name":"file_read","input":{"path":"fixture.txt"}}],
                "stop_reason":"tool_use",
                "usage":{"input_tokens":1,"output_tokens":1}
            }),
        );
        let (mut second, _) = listener.accept().unwrap();
        read_http_request(&mut second);
        write_http_json(
            &mut second,
            json!({
                "content":[{"type":"text","text":"Rust CLI E2E 完成"}],
                "stop_reason":"end_turn",
                "usage":{"input_tokens":2,"output_tokens":2}
            }),
        );
    });
    format!("http://{address}")
}

#[test]
fn help_可以在没有_api_key_时运行() {
    let output = xycli().arg("--help").output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("终端原生 AI 编程助手"));
    assert!(stdout.contains("--permission"));
}

#[test]
fn 非法权限模式返回参数退出码() {
    let output = xycli()
        .args(["--permission", "unknown", "test"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("非法权限模式"));
}

#[test]
fn 未知_provider_返回参数退出码() {
    let output = xycli()
        .args(["--provider", "unknown", "test"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("不支持的 Provider"));
}

#[test]
fn 缺少_api_key_返回配置退出码和登录指引() {
    let output = xycli()
        .env_remove("ANTHROPIC_API_KEY")
        .arg("test")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("ANTHROPIC_API_KEY"));
    assert!(stderr.contains("xycli auth login anthropic"));
}

#[test]
fn config_命令无需_api_key_并展示来源() {
    let dir = tempdir().unwrap();
    let output = xycli()
        .current_dir(dir.path())
        .env_remove("ANTHROPIC_API_KEY")
        .args(["config", "show"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"provider\""));
    assert!(stdout.contains("\"sources\""));
    assert!(!stdout.contains("API_KEY"));
}

#[test]
fn config_set_写入项目配置并可解释来源() {
    let dir = tempdir().unwrap();
    let set = xycli()
        .current_dir(dir.path())
        .args(["config", "set", "agent.max_turns", "31"])
        .output()
        .unwrap();
    assert!(set.status.success());
    let explain = xycli()
        .current_dir(dir.path())
        .args(["config", "explain", "agent.max_turns"])
        .output()
        .unwrap();
    assert!(explain.status.success());
    let stdout = String::from_utf8_lossy(&explain.stdout);
    assert!(stdout.contains("31"));
    assert!(stdout.contains("project"));
}

#[test]
fn rust_cli_真实进程完成工具循环并保存会话() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("fixture.txt"), "fixture content").unwrap();
    let base_url = two_turn_anthropic_server();
    let output = xycli()
        .current_dir(dir.path())
        .env("ANTHROPIC_API_KEY", "test-key")
        .env("ANTHROPIC_BASE_URL", base_url)
        .arg("读取 fixture.txt")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("Rust CLI E2E 完成"));

    let sessions_dir = dir.path().join(".xycli/sessions/json");
    let session_file = fs::read_dir(sessions_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let session: serde_json::Value =
        serde_json::from_slice(&fs::read(session_file).unwrap()).unwrap();
    assert_eq!(session["status"], "completed");
    assert_eq!(session["toolCalls"][0]["toolName"], "file_read");
    assert_eq!(session["toolCalls"][0]["status"], "succeeded");
}
