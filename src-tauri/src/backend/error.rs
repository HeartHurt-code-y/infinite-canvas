use std::backtrace::Backtrace;
use std::error::Error as _;

use serde_json::{Value, json};
use thiserror::Error;

use super::types::BackendErrorPayload;

/**
 * 错误详情的统一脱敏。
 *
 * Validation / Protocol 的 details 由各调用方自由构造，其中常见
 * `{"url": "带签名的 CDN 直链"}` 这种形态 —— 直链是**短期有效的凭据**，
 * 会随 `runtime_record()` 落进 SQLite，再经前端的「展开完整报错 / 复制报错」
 * 进剪贴板。逐个调用方自己脱敏容易漏（本次审查就发现 `local_results.rs`
 * 的一处漏网），所以在这里做一层兜底：所有字符串值都过一遍 URL 脱敏。
 */
fn redact_details(details: &Value) -> Value {
    super::provider::redact_request_value(details)
}

#[derive(Debug, Error)]
pub enum BackendError {
    #[error("validation error: {message}")]
    Validation { message: String, details: Value },
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("credential store error: {0}")]
    Credential(String),
    #[error("HTTP transport error: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("URL error: {0}")]
    Url(#[from] url::ParseError),
    #[error("desktop runtime error: {0}")]
    Desktop(#[from] tauri::Error),
    #[error("protocol error: {message}")]
    Protocol { message: String, details: Value },
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
}

impl BackendError {
    pub fn validation(message: impl Into<String>, details: Value) -> Self {
        Self::Validation {
            message: message.into(),
            details,
        }
    }
    pub fn protocol(message: impl Into<String>, details: Value) -> Self {
        Self::Protocol {
            message: message.into(),
            details,
        }
    }

    pub fn payload(&self) -> BackendErrorPayload {
        let (kind, details) = match self {
            Self::Validation { details, .. } => ("validation", redact_details(details)),
            Self::Database(error) => ("database", json!({ "source": error.to_string() })),
            Self::Credential(error) => ("credential", json!({ "source": error })),
            Self::Transport(error) => {
                let mut causes = Vec::new();
                let mut current = error.source();
                while let Some(cause) = current {
                    causes.push(cause.to_string());
                    current = cause.source();
                }
                /*
                 * reqwest 的 Display 与 Debug 都会带上**完整 URL（含 query）**。
                 * 生成结果的直链是带签名的 CDN 地址（?X-Amz-Signature=… / ?token=…），
                 * 这些是短期有效的凭据：明文写进 SQLite、再经「展开完整报错」复制进
                 * 剪贴板，等于把凭据长期留在本机磁盘上。这里统一按 origin 脱敏。
                 *
                 * 脱敏必须覆盖**两处**而不只是 details.source：
                 *   - causes：逐条 cause.to_string() 同样可能带 URL；
                 *   - details.source / rawDebug。
                 * payload.message 那条路由 `redacted_message()` 单独处理。
                 */
                let mut source = error.to_string();
                let mut raw_debug = format!("{error:#?}");
                if let Some(url) = error.url() {
                    let full = url.as_str().to_string();
                    let safe = url.origin().ascii_serialization();
                    source = source.replace(&full, &safe);
                    raw_debug = raw_debug.replace(&full, &safe);
                    for cause in causes.iter_mut() {
                        *cause = cause.replace(&full, &safe);
                    }
                }
                (
                    "transport",
                    json!({
                        "source": source,
                        "rawDebug": raw_debug,
                        "causes": causes,
                        "isTimeout": error.is_timeout(),
                        "isConnect": error.is_connect(),
                        "url": error.url().map(|url| url.origin().ascii_serialization()),
                    }),
                )
            }
            Self::Io(error) => (
                "io",
                json!({ "source": error.to_string(), "osError": error.raw_os_error() }),
            ),
            Self::Json(error) => (
                "json",
                json!({ "source": error.to_string(), "line": error.line(), "column": error.column() }),
            ),
            Self::Url(error) => ("url", json!({ "source": error.to_string() })),
            Self::Desktop(error) => ("desktop", json!({ "source": error.to_string() })),
            Self::Protocol { details, .. } => ("protocol", redact_details(details)),
            Self::NotFound(value) => ("not_found", json!({ "source": value })),
            Self::Conflict(value) => ("conflict", json!({ "source": value })),
        };

        BackendErrorPayload {
            kind: kind.to_string(),
            message: self.redacted_message(),
            details,
        }
    }

    /// 用户可见 / 落库的报错文案。
    ///
    /// Transport 的 reqwest Display 里带完整 URL（含签名参数），直接用
    /// `self.to_string()` 会让签名凭据明文进 SQLite 与剪贴板，因此这里按
    /// URL 的 origin 脱敏后再给出文案。
    fn redacted_message(&self) -> String {
        let raw = self.to_string();
        let Self::Transport(error) = self else {
            return raw;
        };
        let Some(url) = error.url() else {
            return raw;
        };
        raw.replace(url.as_str(), &url.origin().ascii_serialization())
    }

    pub fn runtime_record(&self) -> Value {
        let payload = self.payload();
        json!({
            "kind": payload.kind,
            "message": payload.message,
            "details": payload.details,
            "backtrace": Backtrace::force_capture().to_string(),
        })
    }
}

pub type BackendResult<T> = Result<T, BackendError>;
pub type CommandResult<T> = Result<T, BackendErrorPayload>;

pub trait IntoCommandResult<T> {
    fn command(self) -> CommandResult<T>;
}

impl<T> IntoCommandResult<T> for BackendResult<T> {
    fn command(self) -> CommandResult<T> {
        self.map_err(|error| error.payload())
    }
}
