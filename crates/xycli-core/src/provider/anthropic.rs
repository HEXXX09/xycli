//! Anthropic Messages API 适配器。

use std::{env, time::Duration};

use async_trait::async_trait;
use reqwest::Client;
use serde_json::{Value, json};

use super::{
    ContentBlock, FinishReason, MessageContent, MessageRole, Provider, ProviderMessage,
    ProviderRequest, ProviderResponse, TokenUsage, ToolCall, http_client, parse_http_response,
};
use crate::error::{XycliError, XycliResult};

pub struct AnthropicProvider {
    api_key: String,
    base_url: String,
    client: Client,
}

impl AnthropicProvider {
    pub fn from_env() -> XycliResult<Self> {
        let api_key = env::var("ANTHROPIC_API_KEY").map_err(|_| {
            XycliError::provider("ANTHROPIC_API_KEY 未设置。请先设置环境变量。", false)
        })?;
        let base_url = env::var("ANTHROPIC_BASE_URL")
            .unwrap_or_else(|_| "https://api.anthropic.com".to_owned());
        Self::new(api_key, base_url)
    }

    pub fn new(api_key: impl Into<String>, base_url: impl Into<String>) -> XycliResult<Self> {
        Self::with_timeout(api_key, base_url, Duration::from_secs(180))
    }

    pub fn with_timeout(
        api_key: impl Into<String>,
        base_url: impl Into<String>,
        timeout: Duration,
    ) -> XycliResult<Self> {
        Ok(Self {
            api_key: api_key.into(),
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            client: http_client(timeout)?,
        })
    }

    fn request_body(request: &ProviderRequest) -> Value {
        let messages: Vec<Value> = request
            .messages
            .iter()
            .filter(|message| message.role != MessageRole::System)
            .map(|message| json!({ "role": message.role, "content": message.content }))
            .collect();
        json!({
            "model": request.model,
            "max_tokens": request.max_output_tokens,
            "temperature": request.temperature,
            "system": request.system,
            "messages": messages,
            "tools": request.tools,
        })
    }

    fn parse_response(value: Value) -> XycliResult<ProviderResponse> {
        let blocks = value
            .get("content")
            .cloned()
            .ok_or_else(|| XycliError::provider("Anthropic 响应缺少 content。", false))?;
        let content: Vec<ContentBlock> = serde_json::from_value(blocks).map_err(|error| {
            XycliError::provider(format!("Anthropic content 格式无效：{error}"), false)
        })?;
        let tool_calls = content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolUse { id, name, input } => Some(ToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                }),
                _ => None,
            })
            .collect::<Vec<_>>();
        let finish_reason = match value.get("stop_reason").and_then(Value::as_str) {
            Some("tool_use") => FinishReason::ToolCalls,
            Some("max_tokens") => FinishReason::Length,
            _ => FinishReason::Stop,
        };
        let usage = TokenUsage {
            input_tokens: value
                .pointer("/usage/input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            output_tokens: value
                .pointer("/usage/output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            cache_read_tokens: value
                .pointer("/usage/cache_read_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            cache_write_tokens: value
                .pointer("/usage/cache_creation_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        };
        Ok(ProviderResponse {
            message: ProviderMessage {
                role: MessageRole::Assistant,
                content: MessageContent::Blocks(content),
            },
            tool_calls,
            usage,
            finish_reason,
        })
    }
}

#[async_trait]
impl Provider for AnthropicProvider {
    fn name(&self) -> &'static str {
        "anthropic"
    }

    async fn chat(&self, request: ProviderRequest) -> XycliResult<ProviderResponse> {
        let send = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&Self::request_body(&request))
            .send();
        let response = tokio::select! {
            _ = request.cancellation.cancelled() => return Err(XycliError::provider("Anthropic 请求已中断。", false)),
            response = send => response.map_err(|error| XycliError::provider(format!("Anthropic 请求失败：{error}"), error.is_timeout() || error.is_connect()))?,
        };
        Self::parse_response(parse_http_response(response, "Anthropic").await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析工具调用() {
        let response = AnthropicProvider::parse_response(json!({
            "content": [
                {"type": "text", "text": "先读取文件"},
                {"type": "tool_use", "id": "call-1", "name": "file_read", "input": {"path": "README.md"}}
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 10, "output_tokens": 20}
        }))
        .unwrap();
        assert_eq!(response.finish_reason, FinishReason::ToolCalls);
        assert_eq!(response.tool_calls[0].name, "file_read");
        assert_eq!(response.usage.input_tokens, 10);
    }
}
