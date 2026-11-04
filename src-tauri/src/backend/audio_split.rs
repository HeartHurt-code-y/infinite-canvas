//! Atlas Cloud provides timed words. The canvas chooses and exports the cuts locally.
use std::{fs, io::Write, path::{Path, PathBuf}, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager as _, State};

use super::{
    BackendState,
    audio_node_edit::validate_audio_path,
    error::{BackendError, BackendResult, CommandResult, IntoCommandResult as _},
    provider::endpoint,
    provider_adapter::ATLASCLOUD_ADAPTER_ID,
    video_preparation::{command, probe_path},
};

#[derive(Deserialize, Serialize)]
pub struct TimedWord {
    text: String,
    start: f64,
    end: f64,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AudioSplitReceipt {
    Idle,
    Unknown,
    Pending { id: String, base_url: String },
    Ready { words: Vec<TimedWord> },
    Failed { message: String },
}

fn receipt_path(app: &AppHandle, path: &str, provider_id: &str) -> BackendResult<PathBuf> {
    validate_audio_path(path)?;
    let canonical = fs::canonicalize(path)?;
    let metadata = fs::metadata(&canonical)?;
    let key = Sha256::digest(format!("{canonical:?}:{:?}:{}:{provider_id}", metadata.modified()?, metadata.len()));
    let directory = app.path().app_local_data_dir()?.join("canvas-audio-timing");
    fs::create_dir_all(&directory)?;
    Ok(directory.join(format!("{key:x}.json")))
}

fn read_receipt(path: &Path) -> BackendResult<AudioSplitReceipt> {
    match fs::read(path) {
        Ok(bytes) if bytes.is_empty() => Ok(AudioSplitReceipt::Unknown),
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AudioSplitReceipt::Idle),
        Err(error) => Err(error.into()),
    }
}

fn save_receipt(path: &Path, receipt: &AudioSplitReceipt) -> BackendResult<()> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().expect("receipt has a directory"))?;
    serde_json::to_writer(&mut file, receipt)?;
    file.flush()?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn validate_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn data(value: &Value) -> &Value {
    value.get("data").filter(|value| value.is_object()).unwrap_or(value)
}

async fn start(app: &AppHandle, state: &BackendState, path: &str, provider_id: &str) -> BackendResult<AudioSplitReceipt> {
    let receipt_file = receipt_path(app, path, provider_id)?;
    let existing = read_receipt(&receipt_file)?;
    if !matches!(existing, AudioSplitReceipt::Idle) {
        return Ok(existing);
    }
    let context = state.providers.resolve_token_group(provider_id, None)?;
    if context.adapter_id != ATLASCLOUD_ADAPTER_ID {
        return Err(BackendError::validation("智能切分需要已启用的 Atlas Cloud 连接。", Value::Null));
    }
    let url = endpoint(&context.base_url, "/api/v1/model/generateAudio")?;
    let ffmpeg = state.composer.ensure_ffmpeg().await?;
    let probe = probe_path(&ffmpeg, path).await?;
    if probe.audio_streams.is_empty() || !(0.5..=1800.0).contains(&probe.duration_seconds) {
        return Err(BackendError::validation("智能切分支持 0.5 秒至 30 分钟的音频。", Value::Null));
    }
    let encoded = tokio::time::timeout(Duration::from_secs(120), command(&ffmpeg)
        .args(["-hide_banner", "-nostdin", "-v", "error", "-i", path, "-t", "1800",
            "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", "pipe:1"]).output())
        .await.map_err(|_| BackendError::validation("准备识别音频超时。", Value::Null))??;
    if !encoded.status.success() || encoded.stdout.is_empty() {
        return Err(BackendError::validation("无法准备识别音频。", Value::Null));
    }
    if receipt_file != receipt_path(app, path, provider_id)? {
        return Err(BackendError::validation("音频原件已变化，请重新打开工具。", Value::Null));
    }
    // Reserve the source before the paid POST. A lost response or interrupted process cannot resubmit it.
    match fs::OpenOptions::new().write(true).create_new(true).open(&receipt_file) {
        Ok(file) => file.sync_all()?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return read_receipt(&receipt_file),
        Err(error) => return Err(error.into()),
    }
    let response = state.providers.client().post(url).bearer_auth(&context.api_key)
        .timeout(Duration::from_secs(120))
        .json(&json!({
            "model": "bytedance/seed-asr-2.0",
            "audio_url": format!("data:audio/mpeg;base64,{}", STANDARD.encode(encoded.stdout)),
            "format": "mp3", "enable_punc": true, "enable_itn": false, "show_utterances": true,
        })).send().await;
    let Ok(response) = response else { return Ok(AudioSplitReceipt::Unknown) };
    let status = response.status();
    if matches!(status.as_u16(), 400 | 401 | 402 | 403 | 404 | 413 | 422 | 429) {
        fs::remove_file(receipt_file)?;
        return Err(BackendError::protocol("Atlas Cloud 拒绝了音频识别请求，请检查连接、余额或音频。", json!({"status": status.as_u16()})));
    }
    if !status.is_success() {
        return Ok(AudioSplitReceipt::Unknown);
    }
    let Ok(value) = response.json::<Value>().await else { return Ok(AudioSplitReceipt::Unknown) };
    let Some(id) = data(&value).get("id").and_then(Value::as_str).filter(|id| validate_id(id)) else {
        return Ok(AudioSplitReceipt::Unknown);
    };
    let receipt = AudioSplitReceipt::Pending { id: id.into(), base_url: context.base_url };
    save_receipt(&receipt_file, &receipt)?;
    Ok(receipt)
}

async fn observe(app: &AppHandle, state: &BackendState, path: &str, provider_id: &str) -> BackendResult<AudioSplitReceipt> {
    let receipt_file = receipt_path(app, path, provider_id)?;
    let receipt = read_receipt(&receipt_file)?;
    let AudioSplitReceipt::Pending { id, base_url } = &receipt else { return Ok(receipt) };
    let context = state.providers.resolve_token_group(provider_id, None)?;
    if context.adapter_id != ATLASCLOUD_ADAPTER_ID || &context.base_url != base_url || !validate_id(id) {
        return Err(BackendError::validation("请恢复提交识别时使用的 Atlas Cloud 连接。", Value::Null));
    }
    let response = state.providers.client()
        .get(endpoint(base_url, &format!("/api/v1/model/prediction/{id}"))?)
        .bearer_auth(&context.api_key).timeout(Duration::from_secs(20)).send().await?;
    if !response.status().is_success() {
        return Err(BackendError::protocol("无法查询 Atlas Cloud 识别进度。", json!({"status": response.status().as_u16()})));
    }
    let value = response.json::<Value>().await?;
    let payload = data(&value);
    let observed = match payload.get("status").and_then(Value::as_str) {
        Some("completed" | "succeeded") => {
            let words = payload.pointer("/stt_result/words").and_then(Value::as_array)
                .into_iter().flatten()
                .filter(|item| !matches!(item.get("type").and_then(Value::as_str), Some("spacing" | "audio_event")))
                .filter_map(|item| Some(TimedWord {
                    text: item.get("text")?.as_str()?.trim().to_owned(),
                    start: item.get("start")?.as_f64()?,
                    end: item.get("end")?.as_f64()?,
                }))
                .filter(|word| !word.text.is_empty() && word.start >= 0.0 && word.end >= word.start)
                .collect::<Vec<_>>();
            if words.is_empty() {
                AudioSplitReceipt::Failed { message: "Atlas Cloud 未返回可用的歌词或语句时间戳。".into() }
            } else {
                AudioSplitReceipt::Ready { words }
            }
        }
        Some("failed" | "timeout" | "canceled" | "cancelled") =>
            AudioSplitReceipt::Failed { message: format!("音频识别未完成，请在 Atlas Cloud 查询任务 {id}。") },
        _ => return Ok(receipt),
    };
    save_receipt(&receipt_file, &observed)?;
    Ok(observed)
}

#[tauri::command]
pub async fn start_canvas_audio_timing(
    app: AppHandle, state: State<'_, BackendState>, path: String, provider_id: String,
) -> CommandResult<AudioSplitReceipt> {
    start(&app, &state, &path, &provider_id).await.command()
}

#[tauri::command]
pub async fn read_canvas_audio_timing(
    app: AppHandle, state: State<'_, BackendState>, path: String, provider_id: String,
) -> CommandResult<AudioSplitReceipt> {
    observe(&app, &state, &path, &provider_id).await.command()
}
