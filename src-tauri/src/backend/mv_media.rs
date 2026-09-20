//! MV timing is anchored to the original song. These operations never generate music or lip sync.
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{LazyLock, Mutex},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    composer::VideoCompositionService,
    error::{BackendError, BackendResult},
};

pub(crate) const WINDOW_TOLERANCE: f64 = 0.002;
pub(crate) const ALIGNMENT_TOLERANCE: f64 = 1.0 / 30.0 + 0.025;
static SONG_DURATIONS: LazyLock<Mutex<HashMap<String, f64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
type EngineIdentity = (PathBuf, u64, Option<SystemTime>);
static FILTER_FILE_OPTIONS: LazyLock<Mutex<HashMap<EngineIdentity, &'static str>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMusicWindow {
    pub id: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvCompositionWindow {
    #[serde(flatten)]
    pub window: MvMusicWindow,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMvCompositionCommand {
    pub song_path: String,
    pub source_signature: String,
    pub windows: Vec<MvCompositionWindow>,
    pub output_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeMvSongCommand {
    pub source_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareMvAudioWindowCommand {
    pub source_path: String,
    pub source_signature: String,
    pub window: MvMusicWindow,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckMvAlignmentCommand {
    pub final_path: String,
    pub expected_duration_seconds: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvSongProbe {
    pub source_path: String,
    pub source_signature: String,
    pub duration_seconds: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvAudioWindow {
    pub path: String,
    pub mime_type: &'static str,
    pub duration_seconds: f64,
    pub source_signature: String,
    pub window: MvMusicWindow,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMediaAlignment {
    pub audio_duration_seconds: f64,
    pub video_duration_seconds: f64,
    pub difference_seconds: f64,
    pub tolerance_seconds: f64,
    pub aligned: bool,
}

fn invalid(message: &str) -> BackendError {
    BackendError::validation(message, Value::Null)
}

pub(crate) fn local_file(source: &str) -> BackendResult<PathBuf> {
    let path = Path::new(source);
    if !path.is_absolute() || !path.is_file() {
        return Err(invalid("MV 媒体必须是存在的本地文件，请重新选择。"));
    }
    Ok(path.to_path_buf())
}

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
        BackendError::protocol("歌曲签名读取失败", json!({"detail": error.to_string()}))
    })?
}

pub(crate) async fn verify_source(source: &str, expected: &str) -> BackendResult<()> {
    if expected.len() != 64 || source_signature(source).await? != expected {
        return Err(invalid("歌曲文件内容已改变，请重新探测歌曲并确认时窗。"));
    }
    Ok(())
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
        .map_err(|_| invalid("MV 媒体处理超时，请检查本地文件。"))??;
    if !result.status.success() {
        return Err(BackendError::protocol(
            "MV 媒体处理失败",
            json!({"detail": String::from_utf8_lossy(&result.stderr).chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>()}),
        ));
    }
    Ok(result)
}

fn filter_file_option_from_help(help: &str) -> &'static str {
    // Cached older downloads expose the legacy option. New FFmpeg removes it in favor of
    // the generic "read this option's value from a file" syntax.
    if help
        .lines()
        .any(|line| line.split_whitespace().next() == Some("-filter_complex_script"))
    {
        "-filter_complex_script"
    } else {
        "-/filter_complex"
    }
}

pub(crate) async fn filter_file_option(ffmpeg: &Path) -> BackendResult<&'static str> {
    let metadata = std::fs::metadata(ffmpeg)?;
    let identity = (
        ffmpeg.to_path_buf(),
        metadata.len(),
        metadata.modified().ok(),
    );
    let cached = FILTER_FILE_OPTIONS
        .lock()
        .expect("MV FFmpeg option cache poisoned")
        .get(&identity)
        .copied();
    if let Some(option) = cached {
        return Ok(option);
    }
    let help = run_output(ffmpeg, &["-hide_banner".into(), "-h".into(), "full".into()]).await?;
    let option = filter_file_option_from_help(&format!(
        "{}\n{}",
        String::from_utf8_lossy(&help.stdout),
        String::from_utf8_lossy(&help.stderr)
    ));
    let mut cache = FILTER_FILE_OPTIONS
        .lock()
        .expect("MV FFmpeg option cache poisoned");
    if cache.len() >= 16 {
        cache.clear();
    }
    cache.insert(identity, option);
    Ok(option)
}

/// Probe the selected stream, with actual decoded stream duration as the ffprobe-free fallback.
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
        .filter(|value| value.is_finite() && *value > 0.0)
        .last()
        .map(|value| value / 1_000_000.0)
        .ok_or_else(|| invalid("无法确定实际媒体时长。"))
}

pub async fn probe_song(
    composer: &VideoCompositionService,
    source: &str,
) -> BackendResult<MvSongProbe> {
    let signature = source_signature(source).await?;
    let cached = SONG_DURATIONS
        .lock()
        .expect("MV duration cache poisoned")
        .get(&signature)
        .copied();
    // MP3 stream/container duration can include encoder padding. Use the actual decoded song.
    let duration = if let Some(duration) = cached {
        duration
    } else {
        decoded_stream_duration(&composer.ensure_ffmpeg().await?, source, true).await?
    };
    verify_source(source, &signature).await?;
    if cached.is_none() {
        let mut cache = SONG_DURATIONS.lock().expect("MV duration cache poisoned");
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(signature.clone(), duration);
    }
    Ok(MvSongProbe {
        source_path: source.into(),
        source_signature: signature,
        duration_seconds: duration,
    })
}

pub(crate) fn validate_window(window: &MvMusicWindow, duration: f64) -> BackendResult<()> {
    if window.id.trim().is_empty()
        || !window.start_seconds.is_finite()
        || !window.end_seconds.is_finite()
        || window.start_seconds < 0.0
        || window.end_seconds <= window.start_seconds
        || window.end_seconds > duration + WINDOW_TOLERANCE
    {
        return Err(invalid("MV 音乐时窗必须位于原曲范围内且起止时间有效。"));
    }
    Ok(())
}

pub(crate) fn validate_windows(
    windows: &[MvCompositionWindow],
    duration: f64,
) -> BackendResult<()> {
    if windows.is_empty() {
        return Err(invalid("MV 至少需要一个已确认的镜头时窗。"));
    }
    let mut previous_end = 0.0;
    let mut ids = HashSet::new();
    for item in windows {
        validate_window(&item.window, duration)?;
        local_file(&item.source)?;
        if !ids.insert(&item.window.id)
            || (item.window.start_seconds - previous_end).abs() > WINDOW_TOLERANCE
        {
            return Err(invalid(
                "MV 时窗不能重复、重叠或留空，必须从原曲 0 秒连续覆盖。",
            ));
        }
        if (item.window.end_seconds * 30.0).round() <= (item.window.start_seconds * 30.0).round() {
            return Err(invalid("MV 镜头时窗短于一个输出视频帧。"));
        }
        previous_end = item.window.end_seconds;
    }
    if (previous_end - duration).abs() > WINDOW_TOLERANCE {
        return Err(invalid("MV 镜头时窗总长必须等于原曲时长。"));
    }
    Ok(())
}

pub async fn prepare_audio_window(
    composer: &VideoCompositionService,
    directory: &Path,
    command: PrepareMvAudioWindowCommand,
) -> BackendResult<MvAudioWindow> {
    let probe = probe_song(composer, &command.source_path).await?;
    if probe.source_signature != command.source_signature {
        return Err(invalid("歌曲已改变，请重新确认音乐时窗。"));
    }
    validate_window(&command.window, probe.duration_seconds)?;
    let duration = command.window.end_seconds - command.window.start_seconds;
    tokio::fs::create_dir_all(directory).await?;
    let file_name = format!(
        "{}-{}-{}.wav",
        probe.source_signature,
        (command.window.start_seconds * 48000.0).round() as u64,
        (command.window.end_seconds * 48000.0).round() as u64
    );
    let output = directory.join(file_name);
    let ffmpeg = composer.ensure_ffmpeg().await?;
    if !output.is_file() {
        let temporary = directory.join(format!("{}.wav", Uuid::new_v4()));
        let args = vec![
            "-hide_banner".into(),
            "-nostdin".into(),
            "-y".into(),
            "-i".into(),
            command.source_path.clone(),
            "-map".into(),
            "0:a:0".into(),
            "-vn".into(),
            "-af".into(),
            format!(
                "asetpts=PTS-STARTPTS,atrim=start={:.9}:end={:.9},asetpts=PTS-STARTPTS,aresample=48000,apad=whole_dur={duration:.9},atrim=duration={duration:.9}",
                command.window.start_seconds, command.window.end_seconds
            ),
            "-c:a".into(),
            "pcm_s16le".into(),
            "-ar".into(),
            "48000".into(),
            temporary.to_string_lossy().into_owned(),
        ];
        let result = run_output(&ffmpeg, &args).await;
        if let Err(error) = result {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        if let Err(error) = verify_source(&command.source_path, &command.source_signature).await {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        if output.is_file() {
            let _ = tokio::fs::remove_file(&temporary).await;
        } else {
            tokio::fs::rename(&temporary, &output).await?;
        }
    }
    let actual = stream_duration(&ffmpeg, &output.to_string_lossy(), true).await?;
    if (actual - duration).abs() > WINDOW_TOLERANCE {
        return Err(invalid("音乐切片时长与已确认时窗不一致，请重新生成切片。"));
    }
    Ok(MvAudioWindow {
        path: output.to_string_lossy().into_owned(),
        mime_type: "audio/wav",
        duration_seconds: actual,
        source_signature: command.source_signature,
        window: command.window,
    })
}

pub async fn check_alignment(
    composer: &VideoCompositionService,
    command: CheckMvAlignmentCommand,
) -> BackendResult<MvMediaAlignment> {
    if command
        .expected_duration_seconds
        .is_some_and(|duration| !duration.is_finite() || duration <= 0.0)
    {
        return Err(invalid("预期曲长无效。"));
    }
    let ffmpeg = composer.ensure_ffmpeg().await?;
    let audio = stream_duration(&ffmpeg, &command.final_path, true).await?;
    let video = stream_duration(&ffmpeg, &command.final_path, false).await?;
    Ok(MvMediaAlignment {
        audio_duration_seconds: audio,
        video_duration_seconds: video,
        difference_seconds: (audio - video).abs(),
        tolerance_seconds: ALIGNMENT_TOLERANCE,
        aligned: (audio - video).abs() <= ALIGNMENT_TOLERANCE
            && command.expected_duration_seconds.is_none_or(|duration| {
                (audio - duration).abs() <= ALIGNMENT_TOLERANCE
                    && (video - duration).abs() <= ALIGNMENT_TOLERANCE
            }),
    })
}

pub(crate) fn composition_filter(
    windows: &[MvCompositionWindow],
    width: i64,
    height: i64,
    duration: f64,
) -> String {
    let mut chains = Vec::new();
    for (index, item) in windows.iter().enumerate() {
        let frames = (item.window.end_seconds * 30.0).round() as i64
            - (item.window.start_seconds * 30.0).round() as i64;
        chains.push(format!("[{index}:v]setpts=PTS-STARTPTS,fps=30,scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,tpad=stop_mode=clone:stop_duration={duration:.9},trim=end_frame={frames},setpts=N/(30*TB)[v{index}]"));
    }
    let labels = (0..windows.len())
        .map(|index| format!("[v{index}]"))
        .collect::<String>();
    chains.push(format!("{labels}concat=n={}:v=1:a=0[vout]", windows.len()));
    chains.push(format!(
        "[{}:a:0]asetpts=PTS-STARTPTS,atrim=duration={duration:.9},aresample=48000[aout]",
        windows.len()
    ));
    chains.join(";")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(id: &str, start: f64, end: f64, source: &Path) -> MvCompositionWindow {
        MvCompositionWindow {
            window: MvMusicWindow {
                id: id.into(),
                start_seconds: start,
                end_seconds: end,
            },
            source: source.to_string_lossy().into_owned(),
        }
    }

    #[test]
    fn mv_windows_require_contiguous_unique_full_song_coverage() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let valid = vec![
            window("one", 0.0, 0.777, file.path()),
            window("two", 0.777, 2.1, file.path()),
        ];
        validate_windows(&valid, 2.1).unwrap();
        let contract: StartMvCompositionCommand = serde_json::from_value(json!({
            "songPath": "C:/song.mp3", "sourceSignature": "abc", "outputName": "MV",
            "windows": [{"id": "one", "source": "C:/clip.mp4", "startSeconds": 0.0, "endSeconds": 2.1}]
        })).unwrap();
        assert_eq!(contract.windows[0].window.end_seconds, 2.1);
        for invalid in [
            vec![window("one", 0.1, 2.1, file.path())],
            vec![
                window("one", 0.0, 0.8, file.path()),
                window("two", 0.7, 2.1, file.path()),
            ],
            vec![
                window("one", 0.0, 0.8, file.path()),
                window("two", 0.9, 2.1, file.path()),
            ],
            vec![
                window("one", 0.0, 0.8, file.path()),
                window("one", 0.8, 2.1, file.path()),
            ],
            vec![window("one", 0.0, 2.0, file.path())],
            vec![window("one", 0.0, f64::NAN, file.path())],
        ] {
            assert!(validate_windows(&invalid, 2.1).is_err());
        }
        let filter = composition_filter(&valid, 320, 180, 2.1);
        assert!(filter.contains("trim=end_frame=23"));
        assert!(filter.contains("trim=end_frame=40"));
        assert!(filter.contains("concat=n=2:v=1:a=0"));
        assert!(filter.contains("[2:a:0]"));
        assert!(!filter.contains("[0:a"));
        assert_eq!(
            filter_file_option_from_help(
                "-filter_complex_script filename read complex filtergraph"
            ),
            "-filter_complex_script"
        );
        assert_eq!(
            filter_file_option_from_help(
                "-filter_complex <graph_description> create complex filtergraph"
            ),
            "-/filter_complex"
        );
    }

    #[tokio::test]
    async fn mv_source_signature_rejects_replaced_song_at_same_path() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), "original song").unwrap();
        let source = file.path().to_string_lossy().into_owned();
        let signature = source_signature(&source).await.unwrap();
        verify_source(&source, &signature).await.unwrap();
        std::fs::write(file.path(), "replaced song").unwrap();
        assert!(verify_source(&source, &signature).await.is_err());
    }

    async fn wait_job(service: &VideoCompositionService, id: &str) -> String {
        for _ in 0..200 {
            let job = service.get_job(id).unwrap();
            match job.status {
                super::super::composer::VideoCompositionStatus::Completed => {
                    return job.final_path.unwrap();
                }
                super::super::composer::VideoCompositionStatus::Failed => {
                    panic!("{}", job.error.unwrap_or_default())
                }
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
        panic!("MV smoke composition did not finish");
    }

    #[tokio::test]
    #[ignore = "requires packaged FFmpeg; invoke explicitly for local MV media validation"]
    async fn mv_local_media_smoke_cuts_pads_trims_and_masters_original_song() {
        let directory = tempfile::tempdir().unwrap();
        let resource = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        assert!(
            resource
                .join("ffmpeg")
                .join(if cfg!(windows) {
                    "ffmpeg.exe"
                } else {
                    "ffmpeg"
                })
                .is_file()
        );
        let service = VideoCompositionService::new(
            directory.path().join("downloads"),
            directory.path().join("engine"),
            resource,
        )
        .unwrap();
        let ffmpeg = service.ensure_ffmpeg().await.unwrap();
        let song = directory.path().join("song.mp3");
        run_output(
            &ffmpeg,
            &[
                "-v".into(),
                "error".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=440:sample_rate=48000:duration=2.1".into(),
                "-c:a".into(),
                "libmp3lame".into(),
                song.to_string_lossy().into_owned(),
            ],
        )
        .await
        .unwrap();
        let probe = probe_song(&service, &song.to_string_lossy()).await.unwrap();
        assert!(
            (probe.duration_seconds - 2.1).abs() < WINDOW_TOLERANCE,
            "decoded MP3 duration: {}",
            probe.duration_seconds
        );
        let short = directory.path().join("short.mp4");
        let long = directory.path().join("long.mp4");
        for (path, length, color) in [(&short, "0.3", "blue"), (&long, "1.8", "green")] {
            run_output(
                &ffmpeg,
                &[
                    "-v".into(),
                    "error".into(),
                    "-f".into(),
                    "lavfi".into(),
                    "-i".into(),
                    format!("color=c={color}:s=320x180:r=30"),
                    "-f".into(),
                    "lavfi".into(),
                    "-i".into(),
                    "sine=frequency=880:sample_rate=48000".into(),
                    "-t".into(),
                    length.into(),
                    "-c:v".into(),
                    "libx264".into(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                    "-c:a".into(),
                    "aac".into(),
                    path.to_string_lossy().into_owned(),
                ],
            )
            .await
            .unwrap();
        }
        let windows = vec![
            window("one", 0.0, 0.8, &short),
            window("two", 0.8, probe.duration_seconds, &long),
        ];
        let slice = service
            .prepare_mv_audio_window(PrepareMvAudioWindowCommand {
                source_path: probe.source_path.clone(),
                source_signature: probe.source_signature.clone(),
                window: windows[0].window.clone(),
            })
            .await
            .unwrap();
        assert!((slice.duration_seconds - 0.8).abs() < WINDOW_TOLERANCE);
        let job = service
            .start_mv_composition(StartMvCompositionCommand {
                song_path: probe.source_path.clone(),
                source_signature: probe.source_signature.clone(),
                windows,
                output_name: "MV smoke multi".into(),
            })
            .await
            .unwrap();
        let final_path = wait_job(&service, &job.job_id).await;
        let alignment = check_alignment(
            &service,
            CheckMvAlignmentCommand {
                final_path: final_path.clone(),
                expected_duration_seconds: Some(probe.duration_seconds),
            },
        )
        .await
        .unwrap();
        assert!(alignment.aligned, "{alignment:?}");
        let audio = run_output(
            &ffmpeg,
            &[
                "-v".into(),
                "error".into(),
                "-i".into(),
                final_path,
                "-map".into(),
                "0:a:0".into(),
                "-t".into(),
                "0.5".into(),
                "-ac".into(),
                "1".into(),
                "-ar".into(),
                "48000".into(),
                "-f".into(),
                "f32le".into(),
                "pipe:1".into(),
            ],
        )
        .await
        .unwrap();
        let samples: Vec<f32> = audio
            .stdout
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect();
        let crossings = samples
            .windows(2)
            .filter(|pair| pair[0].is_sign_negative() != pair[1].is_sign_negative())
            .count();
        let frequency = crossings as f64 / (2.0 * samples.len() as f64 / 48000.0);
        assert!(
            (400.0..480.0).contains(&frequency),
            "master is original 440Hz, not clip's 880Hz: {frequency}"
        );
        let single = service
            .start_mv_composition(StartMvCompositionCommand {
                song_path: probe.source_path,
                source_signature: probe.source_signature,
                windows: vec![window("single", 0.0, probe.duration_seconds, &short)],
                output_name: "MV smoke single".into(),
            })
            .await
            .unwrap();
        let single_path = wait_job(&service, &single.job_id).await;
        assert!(
            check_alignment(
                &service,
                CheckMvAlignmentCommand {
                    final_path: single_path,
                    expected_duration_seconds: Some(2.1)
                }
            )
            .await
            .unwrap()
            .aligned
        );
    }
}
