//! 本地媒体源工具：路径校验、内容签名与流时长探测。
//!
//! 语音合成、AI 媒体分离与视频预备共用同一套本地文件身份判定：输入必须是
//! 存在的本地文件；内容签名用于确认素材在任务期间未被替换；流时长用于校验
//! 音轨/视频轨的实际长度。

use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::error::{BackendError, BackendResult};

fn invalid(message: &str) -> BackendError {
    BackendError::validation(message, Value::Null)
}

/// 校验来源是存在的本地文件，返回其路径。
pub(crate) fn local_file(source: &str) -> BackendResult<PathBuf> {
    let path = Path::new(source);
    if !path.is_absolute() || !path.is_file() {
        return Err(invalid("媒体必须是存在的本地文件，请重新选择。"));
    }
    Ok(path.to_path_buf())
}

/// 本地文件内容签名（SHA-256）；文件被替换后签名随之改变。
pub(crate) async fn source_signature(source: &str) -> BackendResult<String> {
    let path = local_file(source)?;
    tokio::task::spawn_blocking(move || -> BackendResult<String> {
        let mut file = std::fs::File::open(path)?;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        Ok(hex::encode(digest.finalize()))
    })
    .await
    .map_err(|error| {
        BackendError::protocol("媒体签名读取失败", json!({"detail": error.to_string()}))
    })?
}

fn hidden_command(binary: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(binary);
    command.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
}

async fn run_output(binary: &Path, args: &[String]) -> BackendResult<std::process::Output> {
    let mut command = hidden_command(binary);
    command.args(args);
    let result = tokio::time::timeout(Duration::from_secs(180), command.output())
        .await
        .map_err(|_| invalid("媒体处理超时，请检查本地文件。"))??;
    if !result.status.success() {
        return Err(BackendError::protocol(
            "媒体处理失败",
            json!({"detail": String::from_utf8_lossy(&result.stderr).chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>()}),
        ));
    }
    Ok(result)
}

/// 探测指定流（音频或视频）的时长；ffprobe 不可用时回退到实际解码时长。
pub(crate) async fn stream_duration(
    ffmpeg: &Path,
    source: &str,
    audio: bool,
) -> BackendResult<f64> {
    local_file(source)?;
    let ffprobe = ffmpeg.with_file_name(if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    });
    if ffprobe.is_file() {
        let result = run_output(
            &ffprobe,
            &[
                "-v".into(),
                "error".into(),
                "-select_streams".into(),
                if audio { "a:0".into() } else { "v:0".into() },
                "-show_entries".into(),
                "stream=duration,duration_ts,time_base".into(),
                "-of".into(),
                "json".into(),
                source.into(),
            ],
        )
        .await?;
        let parsed: Value = serde_json::from_slice(&result.stdout)?;
        let stream = parsed["streams"]
            .as_array()
            .and_then(|streams| streams.first())
            .ok_or_else(|| {
                invalid(if audio {
                    "文件没有可读取的音轨。"
                } else {
                    "文件没有可读取的视频轨。"
                })
            })?;
        if let Some(duration) = stream["duration"]
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value > 0.0)
        {
            return Ok(duration);
        }
    }
    decoded_stream_duration(ffmpeg, source, audio).await
}

async fn decoded_stream_duration(ffmpeg: &Path, source: &str, audio: bool) -> BackendResult<f64> {
    let result = run_output(
        ffmpeg,
        &[
            "-hide_banner".into(),
            "-nostdin".into(),
            "-v".into(),
            "error".into(),
            "-i".into(),
            source.into(),
            "-map".into(),
            if audio {
                "0:a:0".into()
            } else {
                "0:v:0".into()
            },
            if audio { "-af".into() } else { "-vf".into() },
            if audio {
                "asetpts=PTS-STARTPTS".into()
            } else {
                "setpts=PTS-STARTPTS".into()
            },
            "-progress".into(),
            "pipe:1".into(),
            "-f".into(),
            "null".into(),
            "-".into(),
        ],
    )
    .await?;
    String::from_utf8_lossy(&result.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix("out_time_us=")?.parse::<f64>().ok())
        .rfind(|value| value.is_finite() && *value > 0.0)
        .map(|value| value / 1_000_000.0)
        .ok_or_else(|| invalid("无法确定实际媒体时长。"))
}
