//! 根据已解析配置创建具体 Provider，避免 CLI 依赖厂商实现细节。

use std::time::Duration;

use super::{AnthropicProvider, DeepSeekProvider, Provider};
use crate::{
    config::ProviderConfig,
    credentials::SecretString,
    error::{ErrorKind, XycliError, XycliResult},
};

pub trait ProviderFactory {
    fn create(
        &self,
        config: &ProviderConfig,
        secret: SecretString,
    ) -> XycliResult<Box<dyn Provider>>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct DefaultProviderFactory;

impl ProviderFactory for DefaultProviderFactory {
    fn create(
        &self,
        config: &ProviderConfig,
        secret: SecretString,
    ) -> XycliResult<Box<dyn Provider>> {
        let timeout = Duration::from_secs(config.timeout_seconds);
        let api_key = secret.into_exposed();
        match config.name.as_str() {
            "anthropic" => Ok(Box::new(AnthropicProvider::with_timeout(
                api_key,
                config
                    .base_url
                    .as_deref()
                    .unwrap_or("https://api.anthropic.com"),
                timeout,
            )?)),
            "deepseek" => Ok(Box::new(DeepSeekProvider::with_timeout(
                api_key,
                config
                    .base_url
                    .as_deref()
                    .unwrap_or("https://api.deepseek.com"),
                timeout,
            )?)),
            other => Err(XycliError::new(
                ErrorKind::ConfigError,
                format!("不支持的 Provider：{other}"),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 工厂创建配置指定的_provider() {
        let config = ProviderConfig {
            name: "deepseek".into(),
            model: "deepseek-chat".into(),
            base_url: Some("http://127.0.0.1:1234".into()),
            timeout_seconds: 30,
        };
        let provider = DefaultProviderFactory
            .create(&config, SecretString::new("test-key").unwrap())
            .unwrap();
        assert_eq!(provider.name(), "deepseek");
    }
}
