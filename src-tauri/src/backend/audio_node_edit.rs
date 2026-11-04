use std::{path::Path, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager as _, State};

use super::{
    BackendState,
    error::{BackendError, BackendResult, CommandResult, IntoCommandResult as _},
    types::{ImportLocalBase64AssetCommand, LocalBase64AssetRecord},
    video_preparation::{command, probe_path},
};

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AudioNodeEdit {
    Trim { start: f64, end: f64 },
    Speed { rate: f64 },
}

#[derive(Clone, Copy, Deserialize)]
pub struct AudioRange {
    start: f64,
    end: f64,
}

fn invalid(message: &str) -> BackendError {
    BackendError::validation(message, Value::Null)
}

pub(super) fn validate_audio_path(path: &str) -> BackendResult<()> {
    if !Path::new(path).is_absolute() || !Path::new(path).is_file() {
        return Err(invalid("音频原件不存在，请重新打开工具。"));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct CanvasAudioWaveform {
    peaks: Vec<f64>,
    onsets: Vec<f64>,
}

async fn waveform(state: &BackendState, path: &str) -> BackendResult<CanvasAudioWaveform> {
    static WAVE_DECODERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    validate_audio_path(path)?;
    let _permit = WAVE_DECODERS.acquire().await.map_err(|_| invalid("暂时无法读取音频波形。"))?;
    let ffmpeg = state.composer.ensure_ffmpeg().await?;
    let probe = probe_path(&ffmpeg, path).await?;
    if probe.audio_streams.is_empty() || probe.duration_seconds > 7200.0 {
        return Err(invalid("波形支持最长两小时的音频文件。"));
    }
    // 低采样率用于显示振幅和检测起音，成品始终从原始音轨导出。
    let decoded = tokio::time::timeout(Duration::from_secs(90), command(&ffmpeg)
        .args(["-hide_banner", "-nostdin", "-v", "error", "-i", path, "-t", "7200",
            "-map", "0:a:0", "-ac", "2", "-ar", "2000", "-f", "s16le", "pipe:1"]).output())
        .await.map_err(|_| invalid("读取音频波形超时。"))??;
    if !decoded.status.success() || decoded.stdout.len() < 4 {
        return Err(invalid("无法读取这段音频的波形。"));
    }
    let mut peaks = vec![0.0_f64; 46];
    let mut onsets = Vec::new();
    let mut previous_energy = 0.0;
    let mut noise_floor = 0.0;
    let total_samples = decoded.stdout.len() / 4;
    for (index, window) in decoded.stdout.chunks(160).enumerate() {
        let mut energy = 0.0;
        for (offset, sample) in window.chunks_exact(4).enumerate() {
            let left = f64::from(i16::from_le_bytes([sample[0], sample[1]])).abs();
            let right = f64::from(i16::from_le_bytes([sample[2], sample[3]])).abs();
            let magnitude = left.max(right) / 32768.0;
            let bin = (index * 40 + offset) * peaks.len() / total_samples;
            peaks[bin] = peaks[bin].max(magnitude);
            energy += magnitude * magnitude;
        }
        let rms = (energy / 40.0).sqrt();
        let time = index as f64 * 0.02;
        if time > 0.08 && rms > 0.015 && rms > 1.35 * previous_energy
            && rms > 1.25 * noise_floor && onsets.last().is_none_or(|last| time - last >= 0.12) {
            onsets.push(time);
        }
        previous_energy = rms;
        noise_floor = 0.93 * noise_floor + 0.07 * rms;
    }
    let peak = peaks.iter().copied().fold(0.0_f64, f64::max).max(0.01);
    peaks.iter_mut().for_each(|value| *value = (*value / peak).sqrt());
    Ok(CanvasAudioWaveform { peaks, onsets })
}

#[tauri::command]
pub async fn read_canvas_audio_waveform(state: State<'_, BackendState>, path: String) -> CommandResult<CanvasAudioWaveform> {
    waveform(&state, &path).await.command()
}

async fn edit(
    app: &AppHandle, state: &BackendState, path: String, name: String, edit: AudioNodeEdit,
) -> BackendResult<LocalBase64AssetRecord> {
    validate_audio_path(&path)?;
    let ffmpeg = state.composer.ensure_ffmpeg().await?;
    let probe = probe_path(&ffmpeg, &path).await?;
    let audio = probe.audio_streams.first().ok_or_else(||
        BackendError::validation("文件中没有可编辑的音轨。", Value::Null))?;
    let args = match edit {
        AudioNodeEdit::Trim { start, end } => {
            let duration = probe.duration_seconds;
            let trimmed_end = end.min(duration);
            if !start.is_finite() || !end.is_finite() || start < 0.0 || end > duration + 0.02 ||
                trimmed_end - start < duration.min(0.5) - 0.001 {
                return Err(BackendError::validation("请选择有效的裁剪区间，至少保留 0.5 秒。", Value::Null));
            }
            vec!["-ss".to_string(), start.to_string(), "-t".to_string(), (trimmed_end - start).to_string()]
        }
        AudioNodeEdit::Speed { mut rate } => {
            if !rate.is_finite() || !(0.1..=4.0).contains(&rate) {
                return Err(BackendError::validation("音频变速范围是 0.1–4 倍。", Value::Null));
            }
            let mut filters = Vec::new();
            while rate < 0.5 {
                filters.push("atempo=0.5".to_string());
                rate *= 2.0;
            }
            if rate > 2.0 {
                filters.push("atempo=2".to_string());
                rate /= 2.0;
            }
            filters.push(format!("atempo={rate}"));
            vec!["-af".to_string(), filters.join(",")]
        }
    };
    let temporary = tempfile::tempdir_in(app.path().app_local_data_dir()?)?;
    let output = temporary.path().join("edited.wav");
    let rendered = tokio::time::timeout(Duration::from_secs(120), command(&ffmpeg)
        .args(["-hide_banner", "-nostdin", "-v", "error", "-i", &path, "-map"])
        .arg(format!("0:{}", audio.index)).args(args)
        .args(["-vn", "-c:a", "pcm_s16le"]).arg(&output).output())
        .await.map_err(|_| BackendError::validation("处理音频超时。", Value::Null))??;
    if !rendered.status.success() {
        return Err(BackendError::protocol("音频处理失败。", json!({
            "detail": String::from_utf8_lossy(&rendered.stderr)
        })));
    }
    let library = state.local_base64_assets.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _temporary = temporary;
        library.import(ImportLocalBase64AssetCommand {
            local_path: output.to_string_lossy().into_owned(), name: Some(name), group_id: None,
        })
    }).await.map_err(|error| BackendError::Conflict(error.to_string()))?
}

async fn split(
    app: &AppHandle, state: &BackendState, path: String, name: String, clips: Vec<Vec<AudioRange>>,
) -> BackendResult<Vec<LocalBase64AssetRecord>> {
    validate_audio_path(&path)?;
    if clips.is_empty() || clips.iter().any(Vec::is_empty) || clips.iter().map(Vec::len).sum::<usize>() > 64 {
        return Err(invalid("每次最多导出 64 个音频区间。"));
    }
    let ffmpeg = state.composer.ensure_ffmpeg().await?;
    let probe = probe_path(&ffmpeg, &path).await?;
    let audio = probe.audio_streams.first().ok_or_else(|| invalid("文件中没有可编辑的音轨。"))?;
    if clips.iter().flatten().any(|range| !range.start.is_finite() || !range.end.is_finite()
        || range.start < 0.0 || range.end > probe.duration_seconds + 0.02
        || range.end.min(probe.duration_seconds) - range.start < 0.049) {
        return Err(invalid("切分区间须位于音频内，每段至少 0.05 秒。"));
    }
    let temporary = tempfile::tempdir_in(app.path().app_local_data_dir()?)?;
    let mut process = command(&ffmpeg);
    process.args(["-hide_banner", "-nostdin", "-v", "error", "-i", &path]);
    let mut graph = String::new();
    let mut files = Vec::new();
    for (index, ranges) in clips.iter().enumerate() {
        let mut inputs = String::new();
        for (part, range) in ranges.iter().enumerate() {
            let end = range.end.min(probe.duration_seconds);
            let label = format!("[clip{index}part{part}]");
            graph.push_str(&format!("[0:{}]atrim=start={}:end={end},asetpts=PTS-STARTPTS{label};", audio.index, range.start));
            inputs.push_str(&label);
        }
        graph.push_str(&format!("{inputs}concat=n={}:v=0:a=1[clip{index}];", ranges.len()));
        files.push(temporary.path().join(format!("clip-{index}.wav")));
    }
    process.args(["-filter_complex", graph.trim_end_matches(';')]);
    for (index, file) in files.iter().enumerate() {
        process.args(["-map", &format!("[clip{index}]"), "-c:a", "pcm_s16le"]).arg(file);
    }
    let rendered = tokio::time::timeout(Duration::from_secs(180), process.output())
        .await.map_err(|_| invalid("导出音频片段超时。"))??;
    if !rendered.status.success() {
        return Err(BackendError::protocol("导出音频片段失败。", json!({
            "detail": String::from_utf8_lossy(&rendered.stderr)
        })));
    }
    let library = state.local_base64_assets.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _temporary = temporary;
        files.into_iter().enumerate().map(|(index, file)| library.import(ImportLocalBase64AssetCommand {
            local_path: file.to_string_lossy().into_owned(),
            name: Some(format!("{name}_{:02}.wav", index + 1)),
            group_id: None,
        })).collect()
    }).await.map_err(|error| BackendError::Conflict(error.to_string()))?
}

#[tauri::command]
pub async fn split_canvas_audio(
    app: AppHandle, state: State<'_, BackendState>, path: String, name: String, clips: Vec<Vec<AudioRange>>,
) -> CommandResult<Vec<LocalBase64AssetRecord>> {
    split(&app, &state, path, name, clips).await.command()
}

#[tauri::command]
pub async fn edit_canvas_audio(
    app: AppHandle, state: State<'_, BackendState>, path: String, name: String, operation: AudioNodeEdit,
) -> CommandResult<LocalBase64AssetRecord> {
    edit(&app, &state, path, name, operation).await.command()
}
