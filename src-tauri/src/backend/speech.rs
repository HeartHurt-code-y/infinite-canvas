//! Provider-backed speech synthesis and deterministic local dubbing.
//!
//! 两种可执行的合成协议：豆包语音 OpenSpeech 的 SSE 接口（独立语音连接、专用
//! `X-Api-Key`），以及 OpenAI 兼容网关的 `POST /v1/tts/create`（魔芋 `seed-audio`
//! 系，Bearer 鉴权、成功响应体直接是音频二进制）。两者只在「打哪、带什么头、响应
//! 怎么解」上不同；付费幂等、格式归一化到 48 kHz WAV、时长校验与配入音轨的规则
//! 共用一条实现，避免同一句台词在两条链路上得出不同结果。

use std::{path::Path, process::Stdio, sync::LazyLock, time::Duration};

use base64::Engine as _;
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::{
    composer::VideoCompositionService,
    error::{BackendError, BackendResult},
    model_schema::{
        DOUBAO_TTS_PATH, GATEWAY_TTS_PATH, GATEWAY_TTS_REQUEST_PROFILE, is_gateway_tts_model,
    },
    mv_media,
    provider::{ProviderRuntime, ResolvedProviderContext, request_path},
    provider_adapter::{DOUBAO_VOICE_ADAPTER_ID, ProviderAdapterKind},
    storage::Storage,
    types::GenerationOperation,
};

static SPEECH_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
const SYNTHESIS_ENGINE: &str = "doubao-voice-tts-v3-sse";
const GATEWAY_SYNTHESIS_ENGINE: &str = "gateway-tts-create-v1";
const DOUBAO_RESOURCE_ID: &str = "seed-tts-2.0";
const DUB_ENGINE: &str = "ffmpeg-dub-v1";
/// 单句合成响应字节上限；两条协议共用，防止异常大包直写磁盘。
const MAX_SPEECH_RESPONSE_BYTES: usize = 96 * 1024 * 1024;
/// 参考音频（音色复刻）以 Base64 内联进请求体，原始文件上限。
const MAX_REFERENCE_AUDIO_BYTES: usize = 20 * 1024 * 1024;
/// 网关错误响应体的读取上限；错误信封远小于音频，多余部分不保留。
const MAX_GATEWAY_ERROR_BYTES: usize = 1024 * 1024;
/// 文档声明的语速/音量区间 `[-50, 100]` 与音调区间 `[-12, 12]`。
const SPEECH_RATE_RANGE: (i32, i32) = (-50, 100);
const PITCH_RATE_RANGE: (i32, i32) = (-12, 12);
const GATEWAY_TTS_FORMATS: [&str; 5] = ["mp3", "wav", "pcm", "ogg_opus", "flac"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechVoice {
    pub id: String,
    pub name: String,
    pub language: String,
    pub engine: String,
}

/// 网关 `audio_config` 的可选输出配置。字段名与上游一致，未填的键不发送，
/// 交给上游按格式默认（`sample_rate` 默认值随格式而定）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechAudioConfig {
    pub format: Option<String>,
    pub sample_rate: Option<u32>,
    pub speech_rate: Option<i32>,
    pub loudness_rate: Option<i32>,
    pub pitch_rate: Option<i32>,
    pub enable_subtitle: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeSpeechCommand {
    pub request_id: String,
    pub provider_connection_id: String,
    pub model_definition_id: String,
    pub text: String,
    pub voice_id: String,
    #[serde(default)]
    pub audio_config: Option<SpeechAudioConfig>,
    /// 音色复刻参考音频的本地文件；读作 Base64 进 `audio_data`。
    #[serde(default)]
    pub reference_audio_path: Option<String>,
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
    /// 网关 `X-Subtitle` 解码后落盘的字幕文件；豆包链路或未返回字幕时为空。
    pub subtitle_path: Option<String>,
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
    engine: &str,
) -> BackendResult<(bool, String)> {
    tokio::fs::create_dir_all(directory).await?;
    let manifest = directory.join(format!("{key}.json"));
    let api_request_id = Uuid::new_v4().to_string();
    let initial = json!({
        "requestSignature": signature,
        "state": "submitted",
        "apiRequestId": api_request_id,
        "engine": engine,
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
    engine: &str,
) -> BackendResult<()> {
    tokio::fs::write(
        directory.join(format!("{key}.json")),
        serde_json::to_vec(&json!({
            "requestSignature": signature,
            "state": "ready",
            "apiRequestId": api_request_id,
            "audioSignature": audio_signature,
            "engine": engine,
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

/// 一条连接可执行的语音合成协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpeechWire {
    /// 豆包语音 OpenSpeech：`X-Api-Key` 鉴权，SSE 事件里逐块 Base64 音频。
    DoubaoSse,
    /// OpenAI 兼容网关（魔芋 `seed-audio` 系）：Bearer 鉴权，成功响应体是音频二进制。
    Gateway,
}

/// 绑定、模型定义与凭据解析后的语音模型快照；`synthesize` 只依赖这份结果。
struct ResolvedSpeechModel {
    context: ResolvedProviderContext,
    wire: SpeechWire,
    engine: &'static str,
    /// 请求端点：优先取模型 Schema 的 `request.path`，缺省用该协议的规范值。
    path: String,
    remote_model_id: String,
}

/// 端点是连接的属性：适配器决定走哪条合成协议，模型名只用来核对家族。
fn speech_wire_for_adapter(adapter_id: &str) -> BackendResult<SpeechWire> {
    if adapter_id == DOUBAO_VOICE_ADAPTER_ID {
        return Ok(SpeechWire::DoubaoSse);
    }
    match ProviderAdapterKind::parse(adapter_id) {
        Some(ProviderAdapterKind::Moyu) => Ok(SpeechWire::Gateway),
        _ => Err(invalid(
            "该供应商连接类型没有语音合成接口，请使用豆包语音连接或 OpenAI 兼容网关连接。",
        )),
    }
}

fn resolve_speech_binding(
    storage: &Storage,
    providers: &ProviderRuntime,
    provider_connection_id: &str,
    model_definition_id: &str,
) -> BackendResult<ResolvedSpeechModel> {
    let binding = storage
        .list_bindings(Some(provider_connection_id))?
        .into_iter()
        .find(|binding| binding.model_definition_id == model_definition_id)
        .ok_or_else(|| invalid("请先在该供应商连接的模型目录中绑定并启用语音合成模型。"))?;
    if !binding.enabled
        || !binding
            .enabled_operations
            .contains(&GenerationOperation::SpeechGeneration)
    {
        return Err(invalid(
            "所选模型绑定未启用语音生成，请在供应商连接中启用后重试。",
        ));
    }
    let definition = storage
        .list_model_definitions()?
        .into_iter()
        .find(|model| model.id == model_definition_id)
        .ok_or_else(|| invalid("语音模型定义不存在，请重新保存模型绑定。"))?;
    let speech_operation = definition
        .operations
        .get(GenerationOperation::SpeechGeneration.as_str())
        .ok_or_else(|| invalid("语音模型定义缺少语音生成操作，请重新拉取模型目录并保存绑定。"))?;
    let context =
        providers.resolve_token_group(provider_connection_id, binding.token_group.as_deref())?;
    let remote_model_id = definition
        .remote_model_id
        .clone()
        .or_else(|| binding.remote_model_id.clone())
        .unwrap_or_default()
        .trim()
        .to_string();
    let wire = speech_wire_for_adapter(&context.adapter_id)?;
    if context.api_key.trim().is_empty() {
        return Err(invalid(if wire == SpeechWire::DoubaoSse {
            "豆包语音 API Key 未配置。请在独立的豆包语音连接填写新版控制台 API Key。"
        } else {
            "该网关连接的 API Key 未配置，语音合成需要使用 Bearer 令牌鉴权。"
        }));
    }
    let (engine, path) = match wire {
        SpeechWire::DoubaoSse => {
            // 豆包语音连接是独立密钥域，只承载 OpenSpeech 上的 Seed-TTS 2.0。
            if binding.remote_model_id.as_deref() != Some(DOUBAO_RESOURCE_ID) {
                return Err(invalid(
                    "所选模型绑定未启用豆包语音合成，或资源 ID 不是 seed-tts-2.0。",
                ));
            }
            if definition.remote_model_id.as_deref() != Some(DOUBAO_RESOURCE_ID) {
                return Err(invalid(
                    "语音模型定义与 Seed-TTS 2.0 操作不匹配，请重新保存绑定。",
                ));
            }
            (SYNTHESIS_ENGINE, DOUBAO_TTS_PATH.to_string())
        }
        SpeechWire::Gateway => {
            if !is_gateway_tts_model(&remote_model_id) {
                return Err(invalid(
                    "网关语音合成当前只接入 seed-audio 系模型，请选用供应商目录发布的 seed-audio 型号。",
                ));
            }
            if speech_operation
                .get("requestProfileId")
                .and_then(Value::as_str)
                != Some(GATEWAY_TTS_REQUEST_PROFILE)
            {
                return Err(invalid(
                    "该语音模型的请求档案不是网关 /v1/tts/create 契约，请重新拉取模型目录并保存绑定。",
                ));
            }
            (
                GATEWAY_SYNTHESIS_ENGINE,
                request_path(speech_operation, GATEWAY_TTS_PATH)?,
            )
        }
    };
    Ok(ResolvedSpeechModel {
        context,
        wire,
        engine,
        path,
        remote_model_id,
    })
}

/// The OpenSpeech API has no public read-only per-account voice catalog. This
/// example ID is published by Volcengine; other speaker IDs come from the user's
/// Voice Library and are accepted by synthesize after provider-side validation.
/// 网关侧文档只声明 `speaker` 是音色名称，没有发布可按令牌查询的音色清单，
/// 因此不返回猜测出来的候选，由用户填写控制台/文档给出的音色名。
pub fn list_voices(
    storage: &Storage,
    providers: &ProviderRuntime,
    command: ListSpeechVoicesCommand,
) -> BackendResult<Vec<SpeechVoice>> {
    let model = resolve_speech_binding(
        storage,
        providers,
        &command.provider_connection_id,
        &command.model_definition_id,
    )?;
    if model.wire != SpeechWire::DoubaoSse {
        return Ok(Vec::new());
    }
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

/// 校验并编译网关的 `audio_config`。
#[derive(Debug)]
struct GatewayAudioPlan {
    /// 要发送的配置对象；为空时整个 `audio_config` 键省略，由上游取默认值。
    config: Map<String, Value>,
    /// 临时文件扩展名，让 FFmpeg 按容器探测解码器。
    container_extension: &'static str,
    subtitle_requested: bool,
}

/// 文档给出语速/音量 `[-50, 100]`、音调 `[-12, 12]` 的硬区间，越界值在本地先拒绝，
/// 不消耗一次按分钟计费的往返；`sample_rate` 没有声明区间，只做 sane 范围检查，
/// 其余取值交给上游，返回 400 时原样展示网关错误。
fn gateway_audio_plan(config: Option<&SpeechAudioConfig>) -> BackendResult<GatewayAudioPlan> {
    let default = SpeechAudioConfig::default();
    let source = config.unwrap_or(&default);
    let format = source.format.as_deref().map(str::trim).unwrap_or("");
    if !format.is_empty() && !GATEWAY_TTS_FORMATS.contains(&format) {
        return Err(invalid(
            "语音输出格式无效，只能是 mp3、wav、pcm、ogg_opus 或 flac。",
        ));
    }
    if format == "pcm" {
        return Err(invalid(
            "pcm 是无头裸流，应用无法校验时长也不能安全配入音轨，请改用 mp3、wav、ogg_opus 或 flac。",
        ));
    }
    let mut body = Map::new();
    if !format.is_empty() {
        body.insert("format".to_string(), json!(format));
    }
    if let Some(sample_rate) = source.sample_rate {
        if !(8_000..=192_000).contains(&sample_rate) {
            return Err(invalid("语音采样率必须在 8000～192000 Hz 之间。"));
        }
        body.insert("sample_rate".to_string(), json!(sample_rate));
    }
    for (key, value, range) in [
        ("speech_rate", source.speech_rate, SPEECH_RATE_RANGE),
        ("loudness_rate", source.loudness_rate, SPEECH_RATE_RANGE),
        ("pitch_rate", source.pitch_rate, PITCH_RATE_RANGE),
    ] {
        let Some(value) = value else { continue };
        if !(range.0..=range.1).contains(&value) {
            return Err(BackendError::validation(
                "语音参数超出文档声明的可调区间。",
                json!({ "parameter": key, "value": value, "allowed": [range.0, range.1] }),
            ));
        }
        body.insert(key.to_string(), json!(value));
    }
    let subtitle_requested = source.enable_subtitle.unwrap_or(false);
    if subtitle_requested {
        body.insert("enable_subtitle".to_string(), json!(true));
    }
    let container_extension = match format {
        "wav" => "wav",
        "ogg_opus" => "ogg",
        "flac" => "flac",
        // 文档：不传 `audio_config` 时默认返回 mp3。
        _ => "mp3",
    };
    Ok(GatewayAudioPlan {
        config: body,
        container_extension,
        subtitle_requested,
    })
}

/// 网关语音请求体。只发送文档声明的字段，空的可选键一律省略；音色与参考音频
/// 同时提交时由上游按优先级决定，因此这里保持单一参考来源。
fn gateway_request_body(
    model: &str,
    text: &str,
    speaker: Option<&str>,
    audio_data: Option<&str>,
    plan: &GatewayAudioPlan,
) -> Value {
    let mut body = Map::new();
    body.insert("model".to_string(), json!(model));
    body.insert("text_prompt".to_string(), json!(text));
    if let Some(speaker) = speaker.filter(|value| !value.is_empty()) {
        body.insert("speaker".to_string(), json!(speaker));
    }
    if let Some(audio_data) = audio_data {
        body.insert("audio_data".to_string(), json!(audio_data));
    }
    if !plan.config.is_empty() {
        body.insert(
            "audio_config".to_string(),
            Value::Object(plan.config.clone()),
        );
    }
    Value::Object(body)
}

/// 网关音色名：空串表示使用上游默认音色，因此不能当成非法值拦下。
fn validate_gateway_speaker(voice: &str) -> BackendResult<()> {
    if voice.is_empty() {
        return Ok(());
    }
    if voice.chars().count() > 128 {
        return Err(invalid("音色名称不能超过 128 个字符。"));
    }
    if voice
        .chars()
        .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(invalid("音色名称不能包含空格或控制字符。"));
    }
    Ok(())
}

/// 参考音频读取为 Base64，并返回内容哈希用于请求签名（换素材必须算作新的付费请求）。
async fn gateway_reference_audio(path: &str) -> BackendResult<(String, String)> {
    mv_media::local_file(path)?;
    let bytes = tokio::fs::read(Path::new(path)).await?;
    if bytes.is_empty() {
        return Err(invalid("音色复刻的参考音频是空文件。"));
    }
    if bytes.len() > MAX_REFERENCE_AUDIO_BYTES {
        return Err(invalid("音色复刻的参考音频不能超过 20 MiB。"));
    }
    let is_audio = match infer::get(&bytes) {
        Some(kind) => kind.mime_type().starts_with("audio/"),
        // 裸 MPEG 帧没有文件头，`infer` 认不出来；这时接受常见音频扩展名，
        // 内容是否可用交给上游与随后的解码校验。
        None => {
            let extension = Path::new(path)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            matches!(
                extension.as_str(),
                "mp3" | "wav" | "ogg" | "oga" | "opus" | "flac" | "m4a" | "aac"
            )
        }
    };
    if !is_audio {
        return Err(invalid("音色复刻的参考文件不是可识别的音频。"));
    }
    Ok((
        base64::engine::general_purpose::STANDARD.encode(&bytes),
        sha256(&bytes),
    ))
}

/// `X-Subtitle` 是字幕 JSON 的 Base64；账号未开通字幕权限时该响应头不出现。
fn decode_gateway_subtitle(raw: &str) -> BackendResult<Value> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|_| invalid("语音网关返回的字幕数据不是有效 Base64。"))?;
    let value: Value = serde_json::from_slice(&decoded)
        .map_err(|_| invalid("语音网关返回的字幕数据不是有效 JSON。"))?;
    if value.is_null() {
        return Err(invalid("语音网关返回的字幕数据为空。"));
    }
    Ok(value)
}

/// 把网关的非音频响应转成后端错误。上游错误信封是
/// `{"error":{"message","type","code"}}`，其中 `message` 是中文原文，必须原样进
/// 入诊断信息；无法解析为 JSON 时保留截断预览，不编造替代说明。
fn gateway_response_error(status: u16, body: &[u8]) -> BackendError {
    let envelope: Option<Value> = serde_json::from_slice(body).ok();
    let message = envelope
        .as_ref()
        .and_then(|value| value.pointer("/error/message"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let code = envelope
        .as_ref()
        .and_then(|value| value.pointer("/error/code"))
        .and_then(Value::as_str);
    let hint = if code == Some("model_not_found") {
        "语音合成不可用：模型名称不存在，或当前令牌分组没有可用渠道。"
    } else {
        match status {
            400 => "语音合成请求被网关拒绝：缺少必填字段或参数无效。",
            401 => "语音合成被网关拒绝：API 令牌无效或未提供。",
            503 => "语音合成暂时不可用：上游没有可用渠道。",
            200..=299 => "语音网关返回的不是音频数据。",
            _ => "语音合成请求失败。",
        }
    };
    BackendError::protocol(
        hint,
        json!({
            "httpStatus": status,
            "code": code,
            "upstreamMessage": message,
            "rawPreview": String::from_utf8_lossy(&body[..body.len().min(512)]),
        }),
    )
}

#[derive(Debug)]
struct GatewayTtsReply {
    audio: Vec<u8>,
    subtitle: Option<Value>,
}

/// 只有 2xx 且响应类型不是 JSON/文本时才当音频处理；这个判断同时决定读取上限
/// （音频 96 MiB，错误信封 1 MiB），两处必须共用，避免分类与限流各自漂移。
fn response_holds_audio(status: u16, content_type: &str) -> bool {
    let normalized_type = content_type.to_ascii_lowercase();
    (200..=299).contains(&status)
        && !normalized_type.contains("json")
        && !normalized_type.starts_with("text/")
}

fn parse_gateway_tts_reply(
    status: u16,
    content_type: &str,
    subtitle_raw: Option<&str>,
    body: &[u8],
) -> BackendResult<GatewayTtsReply> {
    if !response_holds_audio(status, content_type) {
        return Err(gateway_response_error(status, body));
    }
    if body.is_empty() {
        return Err(invalid("语音网关返回了空的音频响应。"));
    }
    // 字幕只在响应头出现时解；解失败说明这一句的返回已被污染，宁可整句失败，
    // 也不要把缺少字幕的音频写成「带字幕」的缓存结果。
    let subtitle = subtitle_raw
        .filter(|value| !value.trim().is_empty())
        .map(decode_gateway_subtitle)
        .transpose()?;
    Ok(GatewayTtsReply {
        audio: body.to_vec(),
        subtitle,
    })
}

async fn collect_capped(
    response: reqwest::Response,
    limit: usize,
    oversize: &str,
) -> BackendResult<Vec<u8>> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(invalid(oversize));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// 网关合成：一次同步 POST，成功响应体直接是音频二进制。
async fn fetch_gateway_audio(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &Value,
) -> BackendResult<GatewayTtsReply> {
    let response = client
        .post(url)
        .bearer_auth(api_key)
        .json(body)
        .send()
        .await?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let subtitle_raw = response
        .headers()
        .get(reqwest::header::HeaderName::from_static("x-subtitle"))
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let expects_audio = response_holds_audio(status, &content_type);
    let bytes = collect_capped(
        response,
        if expects_audio {
            MAX_SPEECH_RESPONSE_BYTES
        } else {
            MAX_GATEWAY_ERROR_BYTES
        },
        "语音响应超过单句大小限制。",
    )
    .await?;
    parse_gateway_tts_reply(status, &content_type, subtitle_raw.as_deref(), &bytes)
}

/// 通过本地校验后的单次合成请求，按协议各自冻结要发送的内容。
enum SpeechExecution {
    Doubao {
        voice: String,
        text: String,
    },
    Gateway {
        body: Value,
        container_extension: &'static str,
    },
}

/// 网关是非流式同步响应（文档 p50 约 12 秒，长文本更久，单次最长 120 秒音频），
/// 总超时给到 10 分钟；豆包 SSE 是流式，180 秒足够。两条协议都禁止跟随重定向：
/// Bearer 令牌和 `X-Api-Key` 都不能被 3xx 带到另一台主机。
fn speech_client(wire: SpeechWire) -> BackendResult<reqwest::Client> {
    let total_seconds = match wire {
        SpeechWire::DoubaoSse => 180,
        SpeechWire::Gateway => 600,
    };
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(total_seconds))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}

async fn fetch_doubao_audio(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    api_request_id: &str,
    voice: &str,
    text: &str,
) -> BackendResult<Vec<u8>> {
    let response = client
        .post(url)
        .header("X-Api-Key", api_key)
        .header("X-Api-Resource-Id", DOUBAO_RESOURCE_ID)
        .header("X-Api-Request-Id", api_request_id)
        .json(&json!({
            "user": {"uid": "infinite-canvas"},
            "req_params": {
                "text": text,
                "speaker": voice,
                "audio_params": {"format": "mp3", "sample_rate": 24000, "speech_rate": 0, "loudness_rate": 0},
            },
        }))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(BackendError::protocol(
            "豆包语音接口拒绝配音请求，请检查独立语音 API Key、资源开通与音色权限。",
            json!({"httpStatus": response.status().as_u16()}),
        ));
    }
    let body = collect_capped(
        response,
        MAX_SPEECH_RESPONSE_BYTES,
        "豆包语音响应超过单句大小限制。",
    )
    .await?;
    decode_sse_audio(&body)
}

/// 归一化落盘：写临时容器 → FFmpeg 转 48 kHz `pcm_s16le` WAV → 校验 → 原子改名。
/// 配音时序依赖可验证的 WAV 头与时长，所以两条协议的成功响应都收敛到同一形态；
/// 转换失败时不留半成品，也不会把已扣费的请求写成可复用结果。
async fn commit_synthesized_audio(
    directory: &Path,
    ffmpeg: &Path,
    audio: &[u8],
    container_extension: &str,
    output: &Path,
) -> BackendResult<()> {
    let source = directory.join(format!("{}.{}", Uuid::new_v4(), container_extension));
    let temporary = directory.join(format!("{}.wav", Uuid::new_v4()));
    tokio::fs::write(&source, audio).await?;
    let args = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-i".into(),
        source.to_string_lossy().into_owned(),
        "-vn".into(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-ar".into(),
        "48000".into(),
        temporary.to_string_lossy().into_owned(),
    ];
    let result = run(&ffmpeg.to_string_lossy(), &args, 180).await;
    let _ = tokio::fs::remove_file(&source).await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    if !is_wave(&temporary).await? {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(invalid("语音合成输出无法转换为有效 WAV。"));
    }
    if let Err(error) = mv_media::stream_duration(ffmpeg, &temporary.to_string_lossy(), true).await
    {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    tokio::fs::rename(&temporary, output).await?;
    Ok(())
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
    let model = resolve_speech_binding(
        storage,
        providers,
        &command.provider_connection_id,
        &command.model_definition_id,
    )?;
    let voice = command.voice_id.trim();
    let reference_path = command
        .reference_audio_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    // 付费前的本地校验必须全部在 `reserve_paid_request` 之前完成：清单一旦落盘，
    // 同一请求 ID 就不再允许自动重发，参数错误也会留下永远无法完成的记录。
    let (request_signature, execution) = match model.wire {
        SpeechWire::DoubaoSse => {
            if voice.is_empty()
                || voice.len() > 128
                || !voice
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
            {
                return Err(invalid("音色 ID 无效，请填写豆包语音控制台音色库中的 ID。"));
            }
            if reference_path.is_some() || command.audio_config.is_some() {
                return Err(invalid(
                    "音色复刻与音频输出参数目前只在 OpenAI 兼容网关的语音合成连接上可用。",
                ));
            }
            (
                signature(json!({
                    "engine": model.engine,
                    "providerConnectionId": command.provider_connection_id,
                    "modelDefinitionId": command.model_definition_id,
                    "resourceId": DOUBAO_RESOURCE_ID,
                    "voiceId": voice,
                    "text": text,
                }))?,
                SpeechExecution::Doubao {
                    voice: voice.to_string(),
                    text: text.to_string(),
                },
            )
        }
        SpeechWire::Gateway => {
            // 豆包只接受控制台 ASCII 说话人 ID；网关音色名可以是中文名称，留空
            // 表示使用上游默认音色，因此不能按同一条规则拦下。
            validate_gateway_speaker(voice)?;
            let plan = gateway_audio_plan(command.audio_config.as_ref())?;
            let reference = match reference_path {
                Some(path) => Some(gateway_reference_audio(path).await?),
                None => None,
            };
            let body = gateway_request_body(
                &model.remote_model_id,
                text,
                (!voice.is_empty()).then_some(voice),
                reference.as_ref().map(|(encoded, _)| encoded.as_str()),
                &plan,
            );
            (
                signature(json!({
                    "engine": model.engine,
                    "providerConnectionId": command.provider_connection_id,
                    "modelDefinitionId": command.model_definition_id,
                    "remoteModelId": model.remote_model_id,
                    "voiceId": voice,
                    "text": text,
                    "audioConfig": Value::Object(plan.config.clone()),
                    "referenceAudioSignature": reference.as_ref().map(|(_, hash)| json!(hash)),
                }))?,
                SpeechExecution::Gateway {
                    body,
                    container_extension: plan.container_extension,
                },
            )
        }
    };
    let ffmpeg = composer.ensure_ffmpeg().await?;
    let directory = downloads_dir.join("无限画布").join("配音").join("tts");
    let (fresh, api_request_id) =
        reserve_paid_request(&directory, &key, &request_signature, model.engine).await?;
    let output = directory.join(format!("{key}.wav"));
    let subtitle_output = directory.join(format!("{key}.subtitle.json"));
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
                        model.engine,
                    )
                    .await?;
                }
            } else {
                return Err(invalid(
                    "已缓存配音文件的内容与请求记录不一致，请人工检查。",
                ));
            }
        } else {
            let submitted_to = if model.wire == SpeechWire::DoubaoSse {
                "豆包语音"
            } else {
                "语音网关"
            };
            return Err(BackendError::Conflict(format!(
                "该配音请求已提交过{submitted_to}，远端结果未知；为避免重复计费，不能自动重试。请人工核对后新建运行。"
            )));
        }
    } else {
        let client = speech_client(model.wire)?;
        let url = format!("{}{}", model.context.base_url, model.path);
        let (audio, container_extension, subtitle) = match execution {
            SpeechExecution::Doubao { voice, text } => {
                let audio = fetch_doubao_audio(
                    &client,
                    &url,
                    &model.context.api_key,
                    &api_request_id,
                    &voice,
                    &text,
                )
                .await?;
                (audio, "mp3", None)
            }
            SpeechExecution::Gateway {
                body,
                container_extension,
            } => {
                let reply =
                    fetch_gateway_audio(&client, &url, &model.context.api_key, &body).await?;
                (reply.audio, container_extension, reply.subtitle)
            }
        };
        commit_synthesized_audio(&directory, &ffmpeg, &audio, container_extension, &output).await?;
        // 字幕跟随同一请求 ID 落盘；账号没有开通字幕权限时该响应头不出现，
        // 音频仍然可用，不能因此判定这一句合成失败。
        if let Some(subtitle) = subtitle {
            tokio::fs::write(&subtitle_output, serde_json::to_vec(&subtitle)?).await?;
        }
        let audio_signature = mv_media::source_signature(&output.to_string_lossy()).await?;
        mark_paid_ready(
            &directory,
            &key,
            &request_signature,
            &api_request_id,
            &audio_signature,
            model.engine,
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
        subtitle_path: subtitle_output
            .is_file()
            .then(|| subtitle_output.to_string_lossy().into_owned()),
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
        let (first, api_id) =
            reserve_paid_request(directory.path(), &key, "sig-a", SYNTHESIS_ENGINE)
                .await
                .unwrap();
        assert!(first);
        assert!(uuid::Uuid::parse_str(&api_id).is_ok());
        let (second, same_api_id) =
            reserve_paid_request(directory.path(), &key, "sig-a", SYNTHESIS_ENGINE)
                .await
                .unwrap();
        assert!(!second);
        assert_eq!(same_api_id, api_id);
        assert!(
            reserve_paid_request(directory.path(), &key, "sig-b", SYNTHESIS_ENGINE)
                .await
                .is_err()
        );
    }

    #[test]
    fn gateway_body_carries_only_documented_fields() {
        let plan = gateway_audio_plan(Some(&SpeechAudioConfig {
            format: Some("wav".into()),
            sample_rate: Some(24000),
            speech_rate: Some(30),
            loudness_rate: None,
            pitch_rate: Some(-3),
            enable_subtitle: Some(true),
        }))
        .unwrap();
        let body = gateway_request_body(
            "seed-audio-1.0",
            "你好，欢迎使用语音合成服务。",
            Some("zh_female_1"),
            None,
            &plan,
        );
        assert_eq!(body["model"], json!("seed-audio-1.0"));
        assert_eq!(body["text_prompt"], json!("你好，欢迎使用语音合成服务。"));
        assert_eq!(body["speaker"], json!("zh_female_1"));
        assert_eq!(body["audio_config"]["format"], json!("wav"));
        assert_eq!(body["audio_config"]["sample_rate"], json!(24000));
        assert_eq!(body["audio_config"]["speech_rate"], json!(30));
        assert_eq!(body["audio_config"]["pitch_rate"], json!(-3));
        assert_eq!(body["audio_config"]["enable_subtitle"], json!(true));
        // 未填写的键不发送，避免把上游默认值改写成客户端猜测。
        assert!(body.get("audio_data").is_none());
        assert!(body["audio_config"].get("loudness_rate").is_none());
        assert_eq!(plan.container_extension, "wav");

        let bare = gateway_audio_plan(None).unwrap();
        let minimal = gateway_request_body("seed-audio-1.0", "第一段台词", None, None, &bare);
        assert_eq!(minimal.as_object().unwrap().len(), 2);
        // 文档：不传 `audio_config` 时默认返回 mp3。
        assert_eq!(bare.container_extension, "mp3");
        assert!(!bare.subtitle_requested);
    }

    #[test]
    fn gateway_audio_config_rejects_out_of_range_and_headerless_pcm() {
        // 文档区间：语速/音量 [-50, 100]，音调 [-12, 12]。
        assert!(
            gateway_audio_plan(Some(&SpeechAudioConfig {
                pitch_rate: Some(13),
                ..Default::default()
            }))
            .is_err()
        );
        assert!(
            gateway_audio_plan(Some(&SpeechAudioConfig {
                speech_rate: Some(101),
                ..Default::default()
            }))
            .is_err()
        );
        assert!(
            gateway_audio_plan(Some(&SpeechAudioConfig {
                format: Some("aac".into()),
                ..Default::default()
            }))
            .is_err()
        );
        // pcm 没有文件头：无法校验时长，也不能安全配入音轨，本地先拦住。
        let pcm = gateway_audio_plan(Some(&SpeechAudioConfig {
            format: Some("pcm".into()),
            ..Default::default()
        }))
        .expect_err("pcm must be refused");
        assert!(pcm.to_string().contains("pcm"));
        assert!(
            gateway_audio_plan(Some(&SpeechAudioConfig {
                format: Some("ogg_opus".into()),
                pitch_rate: Some(-12),
                ..Default::default()
            }))
            .unwrap()
            .container_extension
                == "ogg"
        );
    }

    #[test]
    fn gateway_speaker_accepts_names_and_leaves_default_voice_unset() {
        assert!(validate_gateway_speaker("zh_female_vv_uranus_bigtts").is_ok());
        assert!(validate_gateway_speaker("温柔女声").is_ok());
        // 空串 = 使用上游默认音色，因此不能当非法值拦下。
        assert!(validate_gateway_speaker("").is_ok());
        // 从控制台复制时夹带的空格/换行必须拒绝：无效音色名不会报错，
        // 而是静默回退默认音色并照常计费。
        assert!(validate_gateway_speaker("Vivi 中文").is_err());
        assert!(validate_gateway_speaker("\tzh_female").is_err());
        assert!(validate_gateway_speaker("  ").is_err());
        assert!(validate_gateway_speaker(&"音".repeat(129)).is_err());
    }

    #[test]
    fn gateway_reply_decodes_audio_and_base64_subtitle() {
        let audio = b"ID3\x01\x02\x03fake-audio".to_vec();
        let subtitle = base64::engine::general_purpose::STANDARD
            .encode(json!({"audio_segment": [{"text": "你好"}]}).to_string());
        let reply = parse_gateway_tts_reply(200, "audio/mpeg", Some(&subtitle), &audio).unwrap();
        assert_eq!(reply.audio, audio);
        assert_eq!(
            reply.subtitle.unwrap()["audio_segment"][0]["text"],
            json!("你好")
        );
        // 账号未开通字幕权限时响应头不出现，音频仍然可用。
        let plain = parse_gateway_tts_reply(200, "audio/wav", None, &audio).unwrap();
        assert!(plain.subtitle.is_none());
        assert!(parse_gateway_tts_reply(200, "audio/mpeg", None, &[]).is_err());
        assert!(parse_gateway_tts_reply(200, "audio/mpeg", Some("not-base64!"), &audio).is_err());
    }

    #[test]
    fn gateway_reply_keeps_the_upstream_error_envelope() {
        let unauthorized =
            r#"{"error":{"message":"令牌无效","type":"moyu_api_error","code":""}}"#.as_bytes();
        let error = parse_gateway_tts_reply(401, "application/json", None, unauthorized)
            .expect_err("401 must fail");
        let BackendError::Protocol { message, details } = &error else {
            panic!("expected protocol error, got {error:?}");
        };
        assert!(message.contains("API 令牌无效"));
        assert_eq!(details["httpStatus"], json!(401));
        assert_eq!(details["upstreamMessage"], json!("令牌无效"));

        let missing_channel =
            r#"{"error":{"message":"No available channels","code":"model_not_found"}}"#.as_bytes();
        let error = parse_gateway_tts_reply(503, "application/json", None, missing_channel)
            .expect_err("503 must fail");
        assert!(error.to_string().contains("模型名称不存在"));

        // 200 却返回 JSON：不是音频，不能当合成结果落盘。
        let error = parse_gateway_tts_reply(200, "application/json", None, missing_channel)
            .expect_err("json success body is not audio");
        assert!(error.to_string().contains("模型名称不存在"));
        // 登录页/网关自家错误页以 HTML 返回时也按非音频处理，并保留原文预览。
        let error = parse_gateway_tts_reply(200, "text/html", None, b"<html>login</html>")
            .expect_err("html is not audio");
        assert!(error.to_string().contains("不是音频数据"));
    }

    /// 起一个只应答一次的假网关，返回 (base_url, 收到请求原文的接收端)。
    fn fake_gateway(
        response_head: String,
        response_body: Vec<u8>,
    ) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake gateway");
        let port = listener.local_addr().expect("fake gateway address").port();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("fake gateway connection");
            // 读超时让假网关自己失败，而不是让客户端等到合成总超时。
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("fake gateway read timeout");
            let mut received = Vec::new();
            let mut chunk = [0_u8; 4096];
            let header_end = loop {
                let read = stream.read(&mut chunk).expect("read request");
                assert!(read > 0, "request closed before headers");
                received.extend_from_slice(&chunk[..read]);
                if let Some(index) = received.windows(4).position(|part| part == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8_lossy(&received[..header_end]).to_string();
            let content_length = headers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                .expect("json body length");
            // 请求头与 JSON 体常常在同一次 read 里到达：已收到的尾部字节必须计入
            //  body 长度，否则会一直等已经读过的数据。
            while received.len() - header_end < content_length {
                let read = stream.read(&mut chunk).expect("read request body");
                assert!(read > 0, "request closed before body");
                received.extend_from_slice(&chunk[..read]);
            }
            let body = &received[header_end..header_end + content_length];
            sender
                .send(format!("{headers}{}", String::from_utf8_lossy(body)))
                .expect("capture request");
            stream
                .write_all(response_head.as_bytes())
                .expect("write head");
            stream.write_all(&response_body).expect("write body");
            stream.flush().expect("flush");
        });
        (format!("http://127.0.0.1:{port}"), receiver)
    }

    #[tokio::test]
    async fn gateway_synthesis_posts_bearer_json_and_returns_binary_audio() {
        let audio = b"ID3\x01\x02\x03fake-audio".to_vec();
        let subtitle = base64::engine::general_purpose::STANDARD
            .encode(json!({"audio_segment": [{"text": "你好"}]}).to_string());
        let head = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: audio/mpeg\r\nx-subtitle: {subtitle}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            audio.len()
        );
        let (base_url, received) = fake_gateway(head, audio.clone());
        let plan = gateway_audio_plan(Some(&SpeechAudioConfig {
            format: Some("mp3".into()),
            enable_subtitle: Some(true),
            ..Default::default()
        }))
        .unwrap();
        let body =
            gateway_request_body("seed-audio-1.0", "你好。", Some("zh_female_1"), None, &plan);
        let client = speech_client(SpeechWire::Gateway).expect("client");
        let reply = fetch_gateway_audio(
            &client,
            &format!("{base_url}{GATEWAY_TTS_PATH}"),
            "sk-test-token",
            &body,
        )
        .await
        .expect("audio");
        assert_eq!(reply.audio, audio);
        assert_eq!(
            reply.subtitle.unwrap()["audio_segment"][0]["text"],
            json!("你好")
        );

        let request = received.recv().expect("captured request").to_lowercase();
        assert!(request.starts_with("post /v1/tts/create http/1.1"));
        assert!(request.contains("authorization: bearer sk-test-token"));
        assert!(request.contains("\"text_prompt\":\"你好。\""));
        assert!(request.contains("\"speaker\":\"zh_female_1\""));
        assert!(request.contains("\"enable_subtitle\":true"));
    }

    #[tokio::test]
    async fn gateway_rejection_keeps_the_http_status_and_chinese_message() {
        let payload = r#"{"error":{"message":"令牌无效","type":"moyu_api_error","code":""}}"#
            .as_bytes()
            .to_vec();
        let head = format!(
            "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            payload.len()
        );
        let (base_url, _received) = fake_gateway(head, payload);
        let client = speech_client(SpeechWire::Gateway).expect("client");
        let error = fetch_gateway_audio(
            &client,
            &format!("{base_url}{GATEWAY_TTS_PATH}"),
            "sk-invalid",
            &gateway_request_body(
                "seed-audio-1.0",
                "你好。",
                None,
                None,
                &gateway_audio_plan(None).unwrap(),
            ),
        )
        .await
        .expect_err("401 must fail");
        assert!(error.to_string().contains("API 令牌无效或未提供"));
    }
}
