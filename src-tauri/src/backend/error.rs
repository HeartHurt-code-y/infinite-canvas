use std::backtrace::Backtrace;

use serde_json::{Value, json};
use thiserror::Error;

use super::types::BackendErrorPayload;

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
    #[error("{message}")]
    Forbidden { message: String, details: Value },
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

    pub fn forbidden(message: impl Into<String>, details: Value) -> Self {
        Self::Forbidden {
            message: message.into(),
            details,
        }
    }

    pub fn payload(&self) -> BackendErrorPayload {
        let (kind, details) = match self {
            Self::Validation { details, .. } => ("validation", details.clone()),
            Self::Database(error) => ("database", json!({ "source": error.to_string() })),
            Self::Credential(error) => ("credential", json!({ "source": error })),
            Self::Transport(error) => (
                "transport",
                json!({
                    "source": error.to_string(),
                    "isTimeout": error.is_timeout(),
                    "isConnect": error.is_connect(),
                    "url": error.url().map(|url| url.origin().ascii_serialization()),
                }),
            ),
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
            Self::Protocol { details, .. } => ("protocol", details.clone()),
            Self::NotFound(value) => ("not_found", json!({ "source": value })),
            Self::Conflict(value) => ("conflict", json!({ "source": value })),
            Self::Forbidden { details, .. } => ("forbidden", details.clone()),
        };

        BackendErrorPayload {
            kind: kind.to_string(),
            message: self.to_string(),
            details,
        }
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
