use super::*;
use crate::backend::{process_tree::ProcessTree, video_preparation::probe_path};

/// 删掉工作目录里所有符合「前缀 + 后缀」的中间文件（如 shot-*.mp4 / tail-*.png）。
///
/// 按目录实际内容删，而不是按本次合成的片段数删：上一次更长的失败合成会留下
/// 高位编号的残留，只删本次用到的那些会漏掉它们，磁盘上会一直攒着。
async fn remove_intermediates(directory: &Path, prefix: &str, suffix: &str) {
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(prefix) && name.ends_with(suffix) {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}
use sha2::{Digest, Sha256};
use std::{
    io::Read as _,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::io::AsyncReadExt as _;

impl LongVideoService {
    pub(super) fn work_directory(&self, record: &LongVideoRecord) -> PathBuf {
        self.inner.directory.join(&record.job.id)
    }

    pub(super) async fn last_frame(
        &self,
        record: &LongVideoRecord,
        path: &str,
        index: usize,
    ) -> BackendResult<String> {
        let directory = self.work_directory(record);
        tokio::fs::create_dir_all(&directory).await?;
        let output = directory.join(format!("tail-{index}.png"));
        if !output.is_file() {
            let ffmpeg = self.inner.composer.ensure_ffmpeg().await?;
            self.ffmpeg(
                &record.job.id,
                &ffmpeg,
                &[
                    "-y".into(),
                    "-sseof".into(),
                    "-0.15".into(),
                    "-i".into(),
                    path.into(),
                    "-frames:v".into(),
                    "1".into(),
                    "-update".into(),
                    "1".into(),
                    output.to_string_lossy().into_owned(),
                ],
                LongVideoStatus::Generating,
                &directory,
            )
            .await?;
        }
        Ok(output.to_string_lossy().into_owned())
    }

    pub(super) async fn compose(&self, record: &LongVideoRecord) -> BackendResult<()> {
        // 「部分成片」按当前实际拥有的片段判定，不沿用上一次合成留下的标记：
        // 上次只合成了一部分、后来补齐了片段，这一轮合出来的就是完整成片。
        let partial = record
            .job
            .shots
            .iter()
            .any(|shot| shot.final_path.is_none());
        let shots = record
            .job
            .shots
            .iter()
            .filter(|shot| shot.final_path.is_some())
            .collect::<Vec<_>>();
        if shots.is_empty() || (!partial && shots.len() != record.job.shots.len()) {
            return Err(invalid("没有完整片段可合成，请先恢复片段任务。"));
        }
        let directory = self.work_directory(record);
        tokio::fs::create_dir_all(&directory).await?;
        let ffmpeg = self.inner.composer.ensure_ffmpeg().await?;
        let first = probe_path(&ffmpeg, shots[0].final_path.as_deref().unwrap_or_default()).await?;
        if first.width == 0 || first.height == 0 {
            return Err(invalid("首个片段没有有效视频轨道。"));
        }
        let height = if record
            .command
            .generation
            .parameters
            .get("resolution")
            .and_then(Value::as_str)
            .is_some_and(|value| value.contains("1080"))
        {
            1080
        } else {
            720
        };
        let ratio = record
            .command
            .generation
            .parameters
            .get("ratio")
            .or_else(|| record.command.generation.parameters.get("aspect_ratio"))
            .and_then(Value::as_str)
            .unwrap_or("adaptive");
        let aspect = ratio
            .split_once(':')
            .and_then(|(w, h)| Some(w.parse::<f64>().ok()? / h.parse::<f64>().ok()?))
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(first.width as f64 / first.height as f64);
        // 画幅宽高按 2 取偶（编码器要求）。比例来自用户填的 ratio，
        // 极端值下 `as u32` 会饱和到 u32::MAX，再乘 2 就溢出了（debug 下直接 panic），
        // 所以这里用饱和乘法兜底。
        let width = ((height as f64 * aspect / 2.0).round() as u32)
            .saturating_mul(2)
            .max(2);
        let mut file_list = String::new();
        let mut actual_seconds = 0.0;
        for (index, shot) in shots.iter().enumerate() {
            let input = shot.final_path.as_deref().unwrap_or_default();
            let probe = probe_path(&ffmpeg, input).await?;
            if probe.width == 0
                || probe.height == 0
                || !probe.duration_seconds.is_finite()
                || probe.duration_seconds <= 0.0
            {
                return Err(invalid(
                    "片段没有可合成的视频轨道，请在生成历史恢复原产物。",
                ));
            }
            // Do not loop or stretch short generations to pretend they reached the requested duration.
            let seconds = probe.duration_seconds.min(shot.duration_seconds as f64);
            actual_seconds += seconds;
            let output = directory.join(format!("shot-{index}.mp4"));
            let mut args = vec!["-y".into(), "-i".into(), input.into()];
            if probe.audio_streams.is_empty() {
                args.extend([
                    "-f".into(),
                    "lavfi".into(),
                    "-i".into(),
                    "anullsrc=r=48000:cl=stereo".into(),
                ]);
            }
            args.extend(["-map".into(),"0:v:0".into(),"-map".into(),if probe.audio_streams.is_empty(){"1:a:0".into()}else{"0:a:0".into()},
                "-vf".into(),format!("scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30"),
                "-af".into(),"aresample=48000,apad".into(),"-t".into(),format!("{seconds:.6}"),
                "-c:v".into(),"libx264".into(),"-preset".into(),"veryfast".into(),"-crf".into(),"20".into(),"-pix_fmt".into(),"yuv420p".into(),
                "-c:a".into(),"aac".into(),"-ar".into(),"48000".into(),"-ac".into(),"2".into(),"-map_metadata".into(),"-1".into(),output.to_string_lossy().into_owned()]);
            self.ffmpeg(
                &record.job.id,
                &ffmpeg,
                &args,
                LongVideoStatus::Composing,
                &directory,
            )
            .await?;
            file_list.push_str(&format!("file 'shot-{index}.mp4'\n"));
            let updated = self
                .inner
                .storage
                .observe_long_video(&record.job.id, |record| {
                    if record.job.status == LongVideoStatus::Composing {
                        record.job.composition_progress =
                            (index + 1) as f64 / shots.len() as f64 * 90.0;
                    }
                    Ok(())
                })?;
            self.changed(&updated.job);
        }
        let list = directory.join("concat.txt");
        tokio::fs::write(&list, file_list).await?;
        let temp = directory.join("movie.partial.mp4");
        self.ffmpeg(
            &record.job.id,
            &ffmpeg,
            &[
                "-y".into(),
                "-f".into(),
                "concat".into(),
                "-safe".into(),
                "1".into(),
                "-i".into(),
                list.to_string_lossy().into_owned(),
                "-c".into(),
                "copy".into(),
                "-movflags".into(),
                "+faststart".into(),
                "-map_metadata".into(),
                "-1".into(),
                temp.to_string_lossy().into_owned(),
            ],
            LongVideoStatus::Composing,
            &directory,
        )
        .await?;
        let measured = probe_path(&ffmpeg, &temp.to_string_lossy()).await?;
        if measured.width == 0
            || measured.height == 0
            || measured.duration_seconds <= 0.0
            || (measured.duration_seconds - actual_seconds).abs() > 1.0
        {
            return Err(invalid(
                "合成输出的时长或视频轨道异常，请保留片段后重新合成。",
            ));
        }
        let final_path = self.inner.directory.join(format!("{}.mp4", record.job.id));
        tokio::fs::rename(&temp, &final_path).await?;
        // 成片已落盘：逐镜头的中间文件只是合成缓存，重合成时会重新生成。
        // 不清掉的话，一条 5 分钟视频会在磁盘上留下两份体积。
        // 按**目录里实际存在的文件**清，而不是按本次的片段数——上一次更长的失败合成
        // 会留下高位编号的残留（shot-7.mp4），只删 0..shots.len() 会漏掉它们。
        remove_intermediates(&directory, "shot-", ".mp4").await;
        remove_intermediates(&directory, "tail-", ".png").await;
        let _ = tokio::fs::remove_file(directory.join("concat.txt")).await;
        let hash_path = final_path.clone();
        let (byte_size, sha256) =
            tauri::async_runtime::spawn_blocking(move || -> BackendResult<(u64, String)> {
                let mut file = std::fs::File::open(hash_path)?;
                let size = file.metadata()?.len();
                let mut hasher = Sha256::new();
                let mut buffer = [0u8; 65536];
                loop {
                    let length = file.read(&mut buffer)?;
                    if length == 0 {
                        break;
                    }
                    hasher.update(&buffer[..length]);
                }
                Ok((size, format!("{:x}", hasher.finalize())))
            })
            .await
            .map_err(|error| {
                BackendError::protocol(
                    "成片保存信息读取失败。",
                    json!({"source":error.to_string()}),
                )
            })??;
        let updated = self
            .inner
            .storage
            .observe_long_video(&record.job.id, |current| {
                /*
                 * 成片已经写到磁盘上了：**即使这时任务被取消**，也要把成片登记进去。
                 * 否则文件留在磁盘上、记录里没有任何指针，界面也没有入口去回收它——
                 * 用户既看不到也拿不走这段视频。任务状态维持原样（不复活成已完成），
                 * 但产物要留痕。
                 */
                current.job.output = Some(LongVideoOutput {
                    path: final_path.to_string_lossy().into_owned(),
                    name: format!(
                        "{}{}",
                        current.job.title,
                        if partial { "（部分成片）" } else { "" }
                    ),
                    duration_seconds: measured.duration_seconds,
                    width: measured.width,
                    height: measured.height,
                    byte_size,
                    sha256,
                    partial,
                });
                current.job.composition_progress = 100.0;
                if current.job.status == LongVideoStatus::Composing {
                    current.job.status = LongVideoStatus::Completed;
                    current.job.yield_reason = None;
                    current.job.error = None;
                }
                event(
                    current,
                    format!(
                        "{}已保存，实际时长 {:.2} 秒。",
                        if partial { "部分成片" } else { "成片" },
                        measured.duration_seconds
                    ),
                );
                Ok(())
            })?;
        self.changed(&updated.job);
        Ok(())
    }

    async fn ffmpeg(
        &self,
        id: &str,
        binary: &Path,
        args: &[String],
        expected: LongVideoStatus,
        directory: &Path,
    ) -> BackendResult<()> {
        if self.get(id)?.status != expected {
            return Err(BackendError::Conflict("长视频处理已暂停或结束。".into()));
        }
        let mut command = tokio::process::Command::new(binary);
        command
            .args(["-nostdin", "-hide_banner", "-loglevel", "error"])
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // 工作目录固定在本次任务的中间产物目录：concat 清单里写的是相对文件名，
        // 让 ffmpeg 在这里运行就不会因为进程工作目录不同而找不到分片。
        command.current_dir(directory);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        ProcessTree::configure(&mut command);
        let mut child = command.spawn()?;
        let _tree = ProcessTree::attach(&child)?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| invalid("无法读取视频合成日志。"))?;
        let reader = tauri::async_runtime::spawn(async move {
            let mut stderr = stderr;
            let mut tail = Vec::new();
            let mut buffer = [0u8; 4096];
            while let Ok(count) = stderr.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
                tail.extend_from_slice(&buffer[..count]);
                if tail.len() > 16384 {
                    tail.drain(..tail.len() - 16384);
                }
            }
            tail
        });
        loop {
            if let Some(status) = child.try_wait()? {
                let tail = reader.await.unwrap_or_default();
                if !status.success() {
                    return Err(BackendError::protocol(
                        "视频合成失败，请查看完整报错后重新合成。",
                        json!({"exitCode":status.code(),"stderr":String::from_utf8_lossy(&tail)}),
                    ));
                }
                return Ok(());
            }
            if self.get(id)?.status != expected {
                let _ = child.kill().await;
                let _ = child.wait().await;
                let _ = reader.await;
                return Err(BackendError::Conflict(
                    "长视频处理已暂停或结束，已保存片段可继续使用。".into(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    }
}
