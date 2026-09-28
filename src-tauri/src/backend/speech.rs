//! Provider-backed speech synthesis and deterministic local dubbing.
//! Doubao Voice uses a dedicated connection/key, separate from Volcengine Ark.

use std::{path::Path, process::Stdio, sync::LazyLock, time::Duration};

use base64::Engine as _;
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::{
    composer::VideoCompositionService,
    error::{BackendError, BackendResult},
    mv_media,
    provider::{ProviderRuntime, ResolvedProviderContext},
    provider_adapter::DOUBAO_VOICE_ADAPTER_ID,
    storage::Storage,
    types::GenerationOperation,
};

static SPEECH_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
const SYNTHESIS_ENGINE: &str = "doubao-voice-tts-v3-sse";
const DOUBAO_RESOURCE_ID: &str = "seed-tts-2.0";
const DOUBAO_TTS_PATH: &str = "/api/v3/tts/unidirectional/sse";
const DUB_ENGINE: &str = "ffmpeg-dub-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechVoice {
    pub id: String,
    pub name: String,
    pub language: String,
    pub engine: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeSpeechCommand {
    pub request_id: String,
    pub provider_connection_id: String,
    pub model_definition_id: String,
    pub text: String,
    pub voice_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSpeechVoicesCommand {
    pub provider_connection_id: String,
    pub model_definition_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSpeechRequestStatusCommand {
    pub request_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRequestStatus {
    pub status: &'static str,
    pub request_signature: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizedSpeech {
    pub path: String,
    pub mime_type: &'static str,
    pub duration_seconds: f64,
    pub voice_id: String,
    pub request_signature: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DubSegment {
    pub audio_path: String,
    pub start_seconds: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeDubbedVideoCommand {
    pub request_id: String,
    pub source_path: String,
    pub segments: Vec<DubSegment>,
    pub output_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DubbedVideo {
    pub path: String,
    pub duration_seconds: f64,
    pub request_signature: String,
    pub video_signature: String,
}

fn invalid(message: &str) -> BackendError {
    BackendError::validation(message, Value::Null)
}

fn sha256(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn request_key(request_id: &str) -> BackendResult<String> {
    if request_id.trim().is_empty() || request_id.len() > 512 {
        return Err(invalid("配音请求 ID 必须为非空且不超过 512 字符。"));
    }
    Ok(sha256(request_id.as_bytes()))
}

fn signature(value: Value) -> BackendResult<String> {
    Ok(sha256(&serde_json::to_vec(&value)?))
}

async fn reserve_request(directory: &Path, key: &str, signature: &str) -> BackendResult<()> {
    tokio::fs::create_dir_all(directory).await?;
    let manifest = directory.join(format!("{key}.json"));
    if manifest.is_file() {
        let previous: Value = serde_json::from_slice(&tokio::fs::read(&manifest).await?)?;
        if previous["requestSignature"].as_str() != Some(signature) {
            return Err(BackendError::Conflict(
                "同一配音请求 ID 的输入或音色已改变，请新建工作流运行。".into(),
            ));
        }
        return Ok(());
    }
    let temporary = directory.join(format!("{}.json", Uuid::new_v4()));
    tokio::fs::write(
        &temporary,
        serde_json::to_vec(&json!({"requestSignature":signature}))?,
    )
    .await?;
    if let Err(error) = tokio::fs::rename(&temporary, &manifest).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error.into());
    }
    Ok(())
}

/// A manifest is created before the paid POST. An interrupted request has unknown
/// remote outcome and must not be silently submitted again.
async fn reserve_paid_request(
    directory: &Path,
    key: &str,
    signature: &str,
) -> BackendResult<(bool, String)> {
    tokio::fs::create_dir_all(directory).await?;
    let manifest = directory.join(format!("{key}.json"));
    let api_request_id = Uuid::new_v4().to_string();
    let initial = json!({
        "requestSignature": signature,
        "state": "submitted",
        "apiRequestId": api_request_id,
        "engine": SYNTHESIS_ENGINE,
    });
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&manifest)
        .await
    {
        Ok(mut file) => {
            file.write_all(&serde_json::to_vec(&initial)?).await?;
            file.sync_all().await?;
            Ok((true, api_request_id))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let previous: Value = serde_json::from_slice(&tokio::fs::read(&manifest).await?)?;
            if previous["requestSignature"].as_str() != Some(signature) {
                return Err(BackendError::Conflict(
                    "同一配音请求 ID 的模型、台词或音色已改变，请新建工作流运行。".into(),
                ));
            }
            let saved_id = previous["apiRequestId"].as_str().unwrap_or_default();
            Ok((false, saved_id.to_string()))
        }
        Err(error) => Err(error.into()),
    }
}

async fn mark_paid_ready(
    directory: &Path,
    key: &str,
    signature: &str,
    api_request_id: &str,
    audio_signature: &str,
) -> BackendResult<()> {
    tokio::fs::write(
        directory.join(format!("{key}.json")),
        serde_json::to_vec(&json!({
            "requestSignature": signature,
            "state": "ready",
            "apiRequestId": api_request_id,
            "audioSignature": audio_signature,
            "engine": SYNTHESIS_ENGINE,
        }))?,
    )
    .await?;
    Ok(())
}

fn hidden_command(binary: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(binary);
    command.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
}

async fn run(
    binary: &str,
    args: &[String],
    timeout_seconds: u64,
) -> BackendResult<std::process::Output> {
    let mut command = hidden_command(binary);
    command.args(args);
    let result = tokio::time::timeout(Duration::from_secs(timeout_seconds), command.output())
        .await
        .map_err(|_| invalid("本地 FFmpeg 音频处理超时。"))??;
    if !result.status.success() {
        return Err(BackendError::protocol(
            "本地 FFmpeg 音频处理失败。",
            json!({ "exitCode": result.status.code() }),
        ));
    }
    Ok(result)
}

fn resolve_speech_binding(
    storage: &Storage,
    providers: &ProviderRuntime,
    provider_connection_id: &str,
    model_definition_id: &str,
) -> BackendResult<ResolvedProviderContext> {
    let binding = storage
        .list_bindings(Some(provider_connection_id))?
        .into_iter()
        .find(|binding| binding.model_definition_id == model_definition_id)
        .ok_or_else(|| invalid("请先在豆包语音连接的模型目录中绑定并启用 Seed-TTS 2.0。"))?;
    if !binding.enabled
        || !binding
            .enabled_operations
            .contains(&GenerationOperation::SpeechGeneration)
        || binding.remote_model_id.as_deref() != Some(DOUBAO_RESOURCE_ID)
    {
        return Err(invalid(
            "所选模型绑定未启用豆包语音合成，或资源 ID 不是 seed-tts-2.0。",
        ));
    }
    let definition = storage
        .list_model_definitions()?
        .into_iter()
        .find(|model| model.id == model_definition_id)
        .ok_or_else(|| invalid("语音模型定义不存在，请重新保存模型绑定。"))?;
    if definition.remote_model_id.as_deref() != Some(DOUBAO_RESOURCE_ID)
        || definition
            .operations
            .get(GenerationOperation::SpeechGeneration.as_str())
            .is_none()
    {
        return Err(invalid(
            "语音模型定义与 Seed-TTS 2.0 操作不匹配，请重新保存绑定。",
        ));
    }
    let context =
        providers.resolve_token_group(provider_connection_id, binding.token_group.as_deref())?;
    if context.adapter_id != DOUBAO_VOICE_ADAPTER_ID {
        return Err(invalid(
            "语音模型必须绑定到独立的火山豆包语音连接，不能使用方舟或其他接口密钥。",
        ));
    }
    if context.api_key.trim().is_empty() {
        return Err(invalid(
            "豆包语音 API Key 未配置。请在独立的豆包语音连接填写新版控制台 API Key。",
        ));
    }
    Ok(context)
}

/// The OpenSpeech API has no public read-only per-account voice catalog. This
/// example ID is published by Volcengine; other speaker IDs come from the user's
/// Voice Library and are accepted by synthesize after provider-side validation.
pub fn list_voices(
    storage: &Storage,
    providers: &ProviderRuntime,
    command: ListSpeechVoicesCommand,
) -> BackendResult<Vec<SpeechVoice>> {
    resolve_speech_binding(
        storage,
        providers,
        &command.provider_connection_id,
        &command.model_definition_id,
    )?;
    Ok(vec![SpeechVoice {
        id: "zh_female_vv_uranus_bigtts".into(),
        name: "Vivi 2.0（官方示例；其他音色请填控制台 ID）".into(),
        language: "zh-CN".into(),
        engine: SYNTHESIS_ENGINE.into(),
    }])
}

pub async fn get_request_status(
    composer: &VideoCompositionService,
    downloads_dir: &Path,
    command: GetSpeechRequestStatusCommand,
) -> BackendResult<SpeechRequestStatus> {
    let key = request_key(&command.request_id)?;
    let directory = downloads_dir.join("无限画布").join("配音").join("tts");
    let manifest = directory.join(format!("{key}.json"));
    if !manifest.is_file() {
        return Ok(SpeechRequestStatus {
            status: "missing",
            request_signature: None,
            path: None,
        });
    }
    let record: Value = serde_json::from_slice(&tokio::fs::read(&manifest).await?)?;
    let request_signature = record["requestSignature"].as_str().map(ToOwned::to_owned);
    let output = directory.join(format!("{key}.wav"));
    let valid_output = if output.is_file() && is_wave(&output).await? {
        let ffmpeg = composer.ensure_ffmpeg().await?;
        mv_media::stream_duration(&ffmpeg, &output.to_string_lossy(), true)
            .await
            .is_ok()
    } else {
        false
    };
    let status = if valid_output {
        let observed = mv_media::source_signature(&output.to_string_lossy()).await?;
        match record["audioSignature"].as_str() {
            Some(saved) if saved == observed => "ready",
            None => "recoverable",
            Some(_) => "invalid_output",
        }
    } else {
        if output.is_file() {
            "invalid_output"
        } else {
            "outcome_unknown"
        }
    };
    Ok(SpeechRequestStatus {
        status,
        request_signature,
        path: matches!(status, "ready" | "recoverable")
            .then(|| output.to_string_lossy().into_owned()),
    })
}

fn decode_sse_audio(body: &[u8]) -> BackendResult<Vec<u8>> {
    let text =
        std::str::from_utf8(body).map_err(|_| invalid("豆包语音 SSE 响应不是有效 UTF-8。"))?;
    let mut audio = Vec::new();
    let mut events = 0_u32;
    for line in text.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let event: Value = serde_json::from_str(data.trim())
            .map_err(|_| invalid("豆包语音 SSE 数据格式无效。"))?;
        events += 1;
        let code = event.get("code").and_then(Value::as_i64).unwrap_or(0);
        if code != 0 && code != 20_000_000 {
            return Err(BackendError::protocol(
                "豆包语音合成失败。",
                json!({
                    "code": code,
                    "message": event.get("message").and_then(Value::as_str).unwrap_or_default(),
                }),
            ));
        }
        if let Some(chunk) = event
            .get("data")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(chunk)
                .map_err(|_| invalid("豆包语音返回无效的音频数据。"))?;
            if audio.len().saturating_add(decoded.len()) > 64 * 1024 * 1024 {
                return Err(invalid("豆包语音音频超过单句 64 MiB 限额。"));
            }
            audio.extend(decoded);
        }
    }
    if events == 0 || audio.is_empty() {
        return Err(invalid("豆包语音未返回任何合成音频。"));
    }
    Ok(audio)
}

pub async fn synthesize(
    storage: &Storage,
    providers: &ProviderRuntime,
    composer: &VideoCompositionService,
    downloads_dir: &Path,
    command: SynthesizeSpeechCommand,
) -> BackendResult<SynthesizedSpeech> {
    let _guard = SPEECH_LOCK.lock().await;
    let key = request_key(&command.request_id)?;
    let text = command.text.trim();
    if text.is_empty() || text.chars().count() > 10_000 {
        return Err(invalid("配音台词必须非空且不超过 10000 字。"));
    }
    let voice = command.voice_id.trim();
    if voice.is_empty()
        || voice.len() > 128
        || !voice
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        return Err(invalid("音色 ID 无效，请填写豆包语音控制台音色库中的 ID。"));
    }
    let context = resolve_speech_binding(
        storage,
        providers,
        &command.provider_connection_id,
        &command.model_definition_id,
    )?;
    let ffmpeg = composer.ensure_ffmpeg().await?;
    let request_signature = signature(json!({
        "engine": SYNTHESIS_ENGINE,
        "providerConnectionId": command.provider_connection_id,
        "modelDefinitionId": command.model_definition_id,
        "resourceId": DOUBAO_RESOURCE_ID,
        "voiceId": voice,
        "text": text,
    }))?;
    let directory = downloads_dir.join("无限画布").join("配音").join("tts");
    let (fresh, api_request_id) =
        reserve_paid_request(&directory, &key, &request_signature).await?;
    let output = directory.join(format!("{key}.wav"));
    if !fresh {
        let manifest: Value =
            serde_json::from_slice(&tokio::fs::read(directory.join(format!("{key}.json"))).await?)?;
        if output.is_file() && is_wave(&output).await? {
            mv_media::stream_duration(&ffmpeg, &output.to_string_lossy(), true).await?;
            let observed_signature = mv_media::source_signature(&output.to_string_lossy()).await?;
            let stored_signature = manifest["audioSignature"].as_str();
            if stored_signature.is_none() || stored_signature == Some(observed_signature.as_str()) {
                if manifest["state"].as_str() != Some("ready") {
                    mark_paid_ready(
                        &directory,
                        &key,
                        &request_signature,
                        &api_request_id,
                        &observed_signature,
                    )
                    .await?;
                }
            } else {
                return Err(invalid(
                    "已缓存配音文件的内容与请求记录不一致，请人工检查。",
                ));
            }
        } else {
            return Err(BackendError::Conflict("该配音请求已提交过豆包语音，远端结果未知；为避免重复计费，不能自动重试。请人工核对后新建运行。".into()));
        }
    } else {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(180))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let response = client.post(format!("{}{DOUBAO_TTS_PATH}", context.base_url))
            .header("X-Api-Key", context.api_key)
            .header("X-Api-Resource-Id", DOUBAO_RESOURCE_ID)
            .header("X-Api-Request-Id", &api_request_id)
            .json(&json!({
                "user": {"uid": "infinite-canvas"},
                "req_params": {
                    "text": text,
                    "speaker": voice,
                    "audio_params": {"format": "mp3", "sample_rate": 24000, "speech_rate": 0, "loudness_rate": 0},
                },
            }))
            .send().await?;
        if !response.status().is_success() {
            return Err(BackendError::protocol(
                "豆包语音接口拒绝配音请求，请检查独立语音 API Key、资源开通与音色权限。",
                json!({"httpStatus": response.status().as_u16()}),
            ));
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if body.len().saturating_add(chunk.len()) > 96 * 1024 * 1024 {
                return Err(invalid("豆包语音响应超过单句大小限制。"));
            }
            body.extend_from_slice(&chunk);
        }
        let audio = decode_sse_audio(&body)?;
        let mp3 = directory.join(format!("{}.mp3", Uuid::new_v4()));
        let temporary = directory.join(format!("{}.wav", Uuid::new_v4()));
        tokio::fs::write(&mp3, audio).await?;
        let args = vec![
            "-hide_banner".into(),
            "-nostdin".into(),
            "-y".into(),
            "-i".into(),
            mp3.to_string_lossy().into_owned(),
            "-vn".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            "-ar".into(),
            "48000".into(),
            temporary.to_string_lossy().into_owned(),
        ];
        let result = run(&ffmpeg.to_string_lossy(), &args, 180).await;
        let _ = tokio::fs::remove_file(&mp3).await;
        if let Err(error) = result {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        if !is_wave(&temporary).await? {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(invalid("豆包语音输出无法转换为有效 WAV。"));
        }
        if let Err(error) =
            mv_media::stream_duration(&ffmpeg, &temporary.to_string_lossy(), true).await
        {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        tokio::fs::rename(&temporary, &output).await?;
        let audio_signature = mv_media::source_signature(&output.to_string_lossy()).await?;
        mark_paid_ready(
            &directory,
            &key,
            &request_signature,
            &api_request_id,
            &audio_signature,
        )
        .await?;
    }
    let duration_seconds =
        mv_media::stream_duration(&ffmpeg, &output.to_string_lossy(), true).await?;
    Ok(SynthesizedSpeech {
        path: output.to_string_lossy().into_owned(),
        mime_type: "audio/wav",
        duration_seconds,
        voice_id: voice.to_string(),
        request_signature,
    })
}

async fn is_wave(path: &Path) -> BackendResult<bool> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut header = [0_u8; 12];
    let count = file.read(&mut header).await?;
    Ok(count == header.len() && &header[..4] == b"RIFF" && &header[8..12] == b"WAVE")
}

pub async fn compose_dubbed_video(
    composer: &VideoCompositionService,
    downloads_dir: &Path,
    command: ComposeDubbedVideoCommand,
) -> BackendResult<DubbedVideo> {
    let _guard = SPEECH_LOCK.lock().await;
    let key = request_key(&command.request_id)?;
    if command.segments.is_empty() || command.segments.len() > 120 {
        return Err(invalid("配音合成必须有 1～120 句真实音频。"));
    }
    let ffmpeg = composer.ensure_ffmpeg().await?;
    mv_media::local_file(&command.source_path)?;
    let video_duration = mv_media::stream_duration(&ffmpeg, &command.source_path, false).await?;
    let source_signature = mv_media::source_signature(&command.source_path).await?;
    let mut previous_end = 0.0;
    let mut signed_segments = Vec::with_capacity(command.segments.len());
    for segment in &command.segments {
        mv_media::local_file(&segment.audio_path)?;
        if !is_wave(Path::new(&segment.audio_path)).await? {
            return Err(invalid("配音合成只接受已生成的本地 WAV 音频。"));
        }
        let duration = mv_media::stream_duration(&ffmpeg, &segment.audio_path, true).await?;
        if !segment.start_seconds.is_finite()
            || segment.start_seconds < 0.0
            || segment.start_seconds + duration > video_duration + 0.02
            || segment.start_seconds + 0.001 < previous_end
        {
            return Err(invalid("配音时序重叠或超过镜头时长，请调整台词和镜头。"));
        }
        previous_end = segment.start_seconds + duration;
        signed_segments.push(json!({
            "startSeconds": segment.start_seconds,
            "durationSeconds": duration,
            "audioSignature": mv_media::source_signature(&segment.audio_path).await?,
        }));
    }
    let request_signature = signature(json!({
        "engine": DUB_ENGINE,
        "sourceSignature": source_signature,
        "segments": signed_segments,
        "outputName": command.output_name,
    }))?;
    let directory = downloads_dir.join("无限画布").join("配音");
    reserve_request(&directory, &key, &request_signature).await?;
    let output = directory.join(format!("{key}.mp4"));
    if !output.is_file() {
        let temporary = directory.join(format!("{}.mp4", Uuid::new_v4()));
        let mut args = vec![
            "-hide_banner".into(),
            "-nostdin".into(),
            "-y".into(),
            "-i".into(),
            command.source_path.clone(),
        ];
        for segment in &command.segments {
            args.extend(["-i".into(), segment.audio_path.clone()]);
        }
        let mut chains = Vec::new();
        for (index, segment) in command.segments.iter().enumerate() {
            let delay = (segment.start_seconds * 1000.0).round() as u64;
            chains.push(format!("[{}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay={delay}|{delay}[d{}]", index + 1, index));
        }
        let labels = (0..command.segments.len())
            .map(|index| format!("[d{index}]"))
            .collect::<String>();
        chains.push(format!("{labels}amix=inputs={}:duration=longest:dropout_transition=0,apad,atrim=duration={video_duration:.9}[aout]", command.segments.len()));
        args.extend([
            "-filter_complex".into(),
            chains.join(";"),
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "[aout]".into(),
            "-c:v".into(),
            "copy".into(),
            "-c:a".into(),
            "aac".into(),
            "-t".into(),
            format!("{video_duration:.9}"),
            "-movflags".into(),
            "+faststart".into(),
            temporary.to_string_lossy().into_owned(),
        ]);
        let binary = ffmpeg.to_string_lossy().into_owned();
        let result = run(&binary, &args, 300).await;
        if let Err(error) = result {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        if mv_media::source_signature(&command.source_path).await? != source_signature {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(invalid("合成期间原视频已改变，请重新制作配音。"));
        }
        tokio::fs::rename(&temporary, &output).await?;
    }
    let duration_seconds =
        mv_media::stream_duration(&ffmpeg, &output.to_string_lossy(), false).await?;
    let audio_duration =
        mv_media::stream_duration(&ffmpeg, &output.to_string_lossy(), true).await?;
    if (duration_seconds - video_duration).abs() > 0.08
        || (audio_duration - video_duration).abs() > 0.08
    {
        return Err(invalid("配音成片的实际音画时长不一致。"));
    }
    Ok(DubbedVideo {
        path: output.to_string_lossy().into_owned(),
        duration_seconds,
        request_signature,
        video_signature: mv_media::source_signature(&output.to_string_lossy()).await?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_identity_is_stable_and_input_signature_changes() {
        assert_eq!(
            request_key("run:shot:0").unwrap(),
            request_key("run:shot:0").unwrap()
        );
        assert_ne!(
            request_key("run:shot:0").unwrap(),
            request_key("run:shot:1").unwrap()
        );
        let first = signature(json!({"voice":"A","text":"你好"})).unwrap();
        let changed = signature(json!({"voice":"A","text":"再见"})).unwrap();
        assert_ne!(first, changed);
    }

    #[test]
    fn doubao_sse_chunks_decode_and_error_event_blocks_output() {
        // The official Bytedance SSE sample reads data: JSON events, accepts
        // 0/20000000, and concatenates base64 audio data in event order.
        let body = b"data: {\"code\":0,\"data\":\"SUQz\"}\n\ndata: {\"code\":20000000,\"data\":\"AQID\"}\n\n";
        assert_eq!(decode_sse_audio(body).unwrap(), b"ID3\x01\x02\x03");
        assert!(decode_sse_audio(b"data: {\"code\":45000001,\"message\":\"invalid\"}\n").is_err());
        assert!(decode_sse_audio(b"data: {\"code\":0}\n").is_err());
    }

    #[tokio::test]
    async fn paid_request_reservation_blocks_duplicate_post_and_changed_input() {
        let directory = tempfile::tempdir().unwrap();
        let key = request_key("run:shot:line").unwrap();
        let (first, api_id) = reserve_paid_request(directory.path(), &key, "sig-a")
            .await
            .unwrap();
        assert!(first);
        assert!(uuid::Uuid::parse_str(&api_id).is_ok());
        let (second, same_api_id) = reserve_paid_request(directory.path(), &key, "sig-a")
            .await
            .unwrap();
        assert!(!second);
        assert_eq!(same_api_id, api_id);
        assert!(
            reserve_paid_request(directory.path(), &key, "sig-b")
                .await
                .is_err()
        );
    }
}
