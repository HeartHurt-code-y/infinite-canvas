//! MV speech evidence from the configured Doubao Voice connection and Volcengine SAMI.
//! Neither text-model guesses nor stream duration are treated as acoustic alignment.

use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    composer::VideoCompositionService,
    credentials::CredentialStore,
    error::{BackendError, BackendResult},
    mv_media,
    provider::ProviderRuntime,
    provider_adapter::DOUBAO_VOICE_ADAPTER_ID,
};

const DOUBAO_ASR_URL: &str = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
const DOUBAO_ASR_RESOURCE: &str = "volc.bigasr.auc_turbo";
const MAX_AUDIO_BYTES: u64 = 100_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeMvSongCommand {
    pub source_path: String,
    pub source_signature: String,
    pub provider_connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignMvLyricsCommand {
    pub source_path: String,
    pub source_signature: String,
    pub lyrics: String,
    pub provider_connection_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvAsrSegment {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvAsrTranscript {
    pub source_signature: String,
    pub engine: &'static str,
    pub model_version: &'static str,
    pub transcript: String,
    pub segments: Vec<MvAsrSegment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvAlignedLine {
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvLyricsAlignment {
    pub source_signature: String,
    pub engine: &'static str,
    pub model_version: &'static str,
    pub lyrics: String,
    pub lines: Vec<MvAlignedLine>,
    pub unmatched_lyrics: Vec<String>,
}

fn invalid(message: &str) -> BackendError {
    BackendError::validation(message, Value::Null)
}

fn protocol(message: &str, detail: impl Into<String>) -> BackendError {
    BackendError::protocol(message, json!({ "detail": detail.into() }))
}

fn voice_connection(
    providers: &ProviderRuntime,
    id: &str,
) -> BackendResult<super::provider::ResolvedProviderContext> {
    if id.trim().is_empty() {
        return Err(invalid("请先在项目供应商设置中选择豆包语音连接。"));
    }
    let context = providers.resolve_current(id)?;
    if context.adapter_id != DOUBAO_VOICE_ADAPTER_ID {
        return Err(invalid(
            "MV 专用语音处理只接受已启用的豆包语音连接，不能复用方舟或视频模型令牌。",
        ));
    }
    if context.api_key.trim().is_empty() {
        return Err(invalid("豆包语音连接尚未配置 X-Api-Key。"));
    }
    Ok(context)
}

async fn checked_song(
    composer: &VideoCompositionService,
    source_path: &str,
    source_signature: &str,
    maximum_duration: f64,
) -> BackendResult<()> {
    let metadata = std::fs::metadata(mv_media::local_file(source_path)?)?;
    if metadata.len() >= MAX_AUDIO_BYTES {
        return Err(invalid(
            "原曲超过火山语音服务单文件 100 MB 限制，请使用较小的原曲文件。",
        ));
    }
    let probe = mv_media::probe_song(composer, source_path).await?;
    if probe.source_signature != source_signature {
        return Err(invalid("原曲正文已改变，请重新探测并审核歌曲时间线。"));
    }
    if probe.duration_seconds >= maximum_duration {
        return Err(invalid(if maximum_duration <= 600.0 {
            "火山 LyricsAlignment 要求原曲短于 10 分钟；当前歌曲不能调用该对齐接口。"
        } else {
            "豆包语音识别极速版要求原曲不超过 2 小时。"
        }));
    }
    Ok(())
}

/// Work from a byte-identical copy of the probed song. FFmpeg then normalizes
/// every accepted input codec to an API-supported MP3 without changing source identity.
async fn encoded_song(
    composer: &VideoCompositionService,
    source_path: &str,
    source_signature: &str,
    maximum_duration: f64,
) -> BackendResult<Vec<u8>> {
    checked_song(composer, source_path, source_signature, maximum_duration).await?;
    let original = tokio::fs::read(source_path).await?;
    if hex::encode(Sha256::digest(&original)) != source_signature {
        return Err(invalid(
            "原曲在读取过程中已改变，请重新探测歌曲并审核时间线。",
        ));
    }
    let temporary = tempfile::tempdir()?;
    let input = temporary.path().join("source.input");
    let output = temporary.path().join("normalized.mp3");
    tokio::fs::write(&input, original).await?;
    let ffmpeg = composer.ensure_ffmpeg().await?;
    let mut command = tokio::process::Command::new(ffmpeg);
    command
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let result = tokio::time::timeout(
        Duration::from_secs(180),
        command
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-i",
                &input.to_string_lossy(),
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "96k",
                "-ar",
                "44100",
                "-ac",
                "2",
                &output.to_string_lossy(),
            ])
            .output(),
    )
    .await
    .map_err(|_| invalid("原曲转码超时，请检查音频文件。"))??;
    if !result.status.success() {
        return Err(protocol(
            "无法将原曲转为语音服务支持的 MP3",
            "请确认原曲包含可解码的音轨",
        ));
    }
    mv_media::verify_source(source_path, source_signature).await?;
    let bytes = tokio::fs::read(&output).await?;
    if bytes.is_empty() || bytes.len() as u64 >= MAX_AUDIO_BYTES {
        return Err(invalid("转码后的原曲为空或超过火山语音服务 100 MB 限制。"));
    }
    Ok(bytes)
}

pub async fn transcribe_mv_song(
    composer: &VideoCompositionService,
    providers: &ProviderRuntime,
    command: TranscribeMvSongCommand,
) -> BackendResult<MvAsrTranscript> {
    let context = voice_connection(providers, &command.provider_connection_id)?;
    let audio = encoded_song(
        composer,
        &command.source_path,
        &command.source_signature,
        7200.0,
    )
    .await?;
    let result = async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| invalid("无法创建豆包语音请求客户端。"))?;
        let response = client
            .post(DOUBAO_ASR_URL)
            .header("X-Api-Key", &context.api_key)
            .header("X-Api-Resource-Id", DOUBAO_ASR_RESOURCE)
            .header("X-Api-Request-Id", uuid::Uuid::new_v4().to_string())
            .header("X-Api-Sequence", "-1")
            .json(&json!({
                "user": { "uid": "infinite-canvas-mv" },
                "audio": { "data": STANDARD.encode(audio), "format": "mp3" },
                "request": { "model_name": "bigmodel", "show_utterances": true },
            }))
            .send()
            .await
            .map_err(|_| protocol("豆包语音识别请求失败", "请检查网络与豆包语音服务开通状态"))?;
        let status = response.status();
        let api_status = response
            .headers()
            .get("X-Api-Status-Code")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        if !status.is_success() || api_status != "20000000" {
            return Err(protocol(
                "豆包语音识别未成功",
                format!(
                    "HTTP {}，服务状态 {}；请核对资源 {} 的开通与余额",
                    status.as_u16(),
                    api_status,
                    DOUBAO_ASR_RESOURCE
                ),
            ));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|_| protocol("豆包语音识别响应无效", "非 JSON 响应"))?;
        let transcript = body["result"]["text"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        let segments: Vec<MvAsrSegment> = body["result"]["utterances"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        let start = row["start_time"].as_f64()? / 1000.0;
                        let end = row["end_time"].as_f64()? / 1000.0;
                        let text = row["text"].as_str()?.trim();
                        (start.is_finite()
                            && end.is_finite()
                            && start >= 0.0
                            && end > start
                            && !text.is_empty())
                        .then(|| MvAsrSegment {
                            start_seconds: start,
                            end_seconds: end,
                            text: text.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if transcript.is_empty() && segments.is_empty() {
            return Err(protocol(
                "豆包语音识别响应缺少正文",
                "未返回 result.text 或有效 utterances",
            ));
        }
        let transcript = if transcript.is_empty() {
            segments
                .iter()
                .map(|segment| segment.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            transcript
        };
        Ok(MvAsrTranscript {
            source_signature: command.source_signature.clone(),
            engine: "doubao_voice_asr",
            model_version: DOUBAO_ASR_RESOURCE,
            transcript,
            segments,
        })
    }
    .await;
    if result.is_ok() {
        mv_media::verify_source(&command.source_path, &command.source_signature).await?;
    }
    result
}

fn normalized_lyrics(value: &str) -> String {
    value.chars().filter(|ch| ch.is_alphanumeric()).collect()
}

fn sami_krc(body: &Value) -> BackendResult<String> {
    // The SAMI HTTP protocol uses the business success code 20000000.
    if body["status_code"].as_i64() != Some(20_000_000) {
        return Err(protocol(
            "火山歌词对齐未成功",
            format!("服务状态 {}", body["status_code"]),
        ));
    }
    let payload = body["payload"]
        .as_str()
        .ok_or_else(|| protocol("火山歌词对齐响应无效", "缺少 payload"))?;
    let payload: Value = serde_json::from_str(payload)
        .map_err(|_| protocol("火山歌词对齐响应无效", "payload 非 JSON"))?;
    let krc = payload["lyrics"]
        .as_str()
        .ok_or_else(|| protocol("火山歌词对齐响应无效", "缺少 KRC lyrics"))?;
    Ok(krc.to_string())
}

/// SAMI returns KRC: [line_start_ms,line_duration_ms]<offset_ms,duration_ms,0>字...
/// Only tagged characters provide acoustic boundaries; an untagged line is not a measurement.
fn parse_krc_lines(krc: &str) -> BackendResult<Vec<MvAlignedLine>> {
    let line_pattern = Regex::new(r"^\[(\d+),(\d+)\](.*)$").expect("valid KRC line pattern");
    let word_pattern = Regex::new(r"<(\d+),(\d+),[^>]*>([^<]*)").expect("valid KRC word pattern");
    let mut lines = Vec::new();
    for raw in krc.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Some(line) = line_pattern.captures(raw) else {
            return Err(protocol("火山歌词对齐结果格式无效", "缺少 KRC 行时间标记"));
        };
        let line_start: u64 = line[1].parse().map_err(|_| invalid("KRC 行起点无效。"))?;
        let mut text = String::new();
        let mut first = None::<u64>;
        let mut last = None::<u64>;
        for word in word_pattern.captures_iter(&line[3]) {
            let offset: u64 = word[1].parse().map_err(|_| invalid("KRC 字起点无效。"))?;
            let duration: u64 = word[2].parse().map_err(|_| invalid("KRC 字时长无效。"))?;
            let token = word[3].trim();
            if token.is_empty() || duration == 0 {
                continue;
            }
            first = Some(first.map_or(offset, |value| value.min(offset)));
            last = Some(last.map_or(offset + duration, |value| value.max(offset + duration)));
            text.push_str(token);
        }
        let (Some(first), Some(last)) = (first, last) else {
            return Err(protocol(
                "火山歌词对齐缺少字级时间戳",
                "不能把 KRC 行容器时长当作字级声学证据",
            ));
        };
        lines.push(MvAlignedLine {
            text,
            start_seconds: (line_start + first) as f64 / 1000.0,
            end_seconds: (line_start + last) as f64 / 1000.0,
        });
    }
    if lines.is_empty() {
        return Err(protocol("火山歌词对齐结果为空", "没有可用 KRC 字级时间戳"));
    }
    Ok(lines)
}

pub async fn align_mv_lyrics(
    composer: &VideoCompositionService,
    credentials: &CredentialStore,
    providers: &ProviderRuntime,
    command: AlignMvLyricsCommand,
) -> BackendResult<MvLyricsAlignment> {
    let context = voice_connection(providers, &command.provider_connection_id)?;
    let lyrics = command.lyrics.trim();
    if lyrics.is_empty() {
        return Err(invalid("歌词强制对齐需要非空的准确歌词。"));
    }
    if lyrics.chars().count() > 20_000 {
        return Err(invalid("歌词过长，请只提交当前歌曲的准确歌词。"));
    }
    let appkey_ref = format!("provider:{}:sami_appkey", context.provider_connection_id);
    let token_ref = format!("provider:{}:sami_token", context.provider_connection_id);
    if !credentials.status(&appkey_ref)?.configured || !credentials.status(&token_ref)?.configured {
        return Err(invalid(
            "该豆包语音连接还需配置独立的火山音频技术 SAMI appkey 和正式 token，方舟与豆包语音 API Key 不能代替。",
        ));
    }
    let appkey = credentials.get(&appkey_ref)?;
    let token = credentials.get(&token_ref)?;
    let bytes = encoded_song(
        composer,
        &command.source_path,
        &command.source_signature,
        600.0,
    )
    .await?;
    let mut endpoint = url::Url::parse("https://sami.bytedance.com/api/v1/invoke")?;
    endpoint
        .query_pairs_mut()
        .append_pair("version", "v4")
        .append_pair("token", &token)
        .append_pair("appkey", &appkey)
        .append_pair("namespace", "LyricsAlignment");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| invalid("无法创建火山歌词对齐请求客户端。"))?;
    let payload = json!({ "language": "chinese", "lyrics": lyrics }).to_string();
    let response = client
        .post(endpoint)
        .json(&json!({ "data": STANDARD.encode(bytes), "payload": payload }))
        .send()
        .await
        .map_err(|_| {
            protocol(
                "火山歌词对齐请求失败",
                "请检查网络、SAMI 凭据有效期和服务开通状态",
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(protocol(
            "火山歌词对齐未成功",
            format!("HTTP {}；请检查 SAMI 服务权限与凭据", status.as_u16()),
        ));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| protocol("火山歌词对齐响应无效", "非 JSON 响应"))?;
    let lines = parse_krc_lines(&sami_krc(&body)?)?;
    let expected: Vec<&str> = lyrics
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let unmatched_lyrics = expected
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            (lines
                .get(index)
                .is_none_or(|aligned| normalized_lyrics(&aligned.text) != normalized_lyrics(line)))
            .then(|| (*line).to_string())
        })
        .collect();
    mv_media::verify_source(&command.source_path, &command.source_signature).await?;
    Ok(MvLyricsAlignment {
        source_signature: command.source_signature,
        engine: "volc_sami_lyrics_alignment",
        model_version: "LyricsAlignment.v4",
        lyrics: lyrics.to_string(),
        lines,
        unmatched_lyrics,
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_krc_lines, sami_krc};
    use serde_json::json;

    #[test]
    fn accepts_sami_business_success_code() {
        let payload = json!({ "lyrics": "[1000,500]<0,200,0>你<200,300,0>好" }).to_string();
        let result = json!({ "status_code": 20_000_000, "payload": payload });
        assert_eq!(
            parse_krc_lines(&sami_krc(&result).unwrap()).unwrap()[0].text,
            "你好"
        );
        assert!(sami_krc(&json!({ "status_code": 0, "payload": payload })).is_err());
    }

    #[test]
    fn parses_character_offsets_instead_of_container_duration() {
        let rows = parse_krc_lines(
            "[22080,4290]<0,210,0>早<210,330,0>上\n[26400,4020]<0,270,0>回<270,300,0>家",
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].text, "早上");
        assert!((rows[0].start_seconds - 22.08).abs() < 0.0001);
        assert!((rows[0].end_seconds - 22.62).abs() < 0.0001);
        assert!((rows[1].end_seconds - 26.97).abs() < 0.0001);
    }

    #[test]
    fn refuses_untagged_krc_as_measurement() {
        assert!(parse_krc_lines("[1000,2000]整句没有字级时间").is_err());
    }
}
