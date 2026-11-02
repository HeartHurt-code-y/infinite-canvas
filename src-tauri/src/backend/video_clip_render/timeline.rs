//! Local timeline rendering. All strings in ASS are escaped data; no user filter expressions.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipTransition { pub kind: String, pub seconds: f64 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipOverlay {
    pub id: String, pub kind: String, pub text: String, pub start: f64, pub end: f64,
    pub x: f64, pub y: f64, pub size: f64, pub color: String, pub background: bool, pub bold: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipTimelineSettings {
    pub format: String, pub subtitles: String, pub overlays: Vec<ClipOverlay>,
    #[serde(default)] pub muted: bool,
    #[serde(default)] pub instructions: String,
}
impl Default for ClipTimelineSettings {
    fn default() -> Self { Self { format: "mp4".into(), subtitles: "soft".into(), overlays: Vec::new(), muted: false, instructions: String::new() } }
}
impl ClipTimelineSettings {
    pub(super) fn validate(&self) -> BackendResult<()> {
        if !matches!(self.format.as_str(), "mp4" | "webm") || !matches!(self.subtitles.as_str(), "soft" | "burn" | "hidden") || self.overlays.len() > 200 || self.instructions.chars().count() > 20000 {
            return Err(invalid("剪辑导出格式或字幕设置无效"));
        }
        let mut ids = std::collections::HashSet::new();
        for item in &self.overlays {
            if item.id.is_empty() || !ids.insert(&item.id) || !matches!(item.kind.as_str(), "text" | "subtitle")
                || item.text.chars().count() > 2000 || !item.start.is_finite() || !item.end.is_finite()
                || item.start < 0.0 || item.end - item.start < 0.04 || item.end > 300.1
                || !item.x.is_finite() || !item.y.is_finite() || !item.size.is_finite()
                || !(0.0..=100.0).contains(&item.x) || !(0.0..=100.0).contains(&item.y) || !(1.0..=20.0).contains(&item.size)
                || item.color.len() != 7 || !item.color.starts_with('#') || !item.color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit) {
                return Err(invalid("文字或字幕轨无效：时间须在0至300秒内，位置为0至100%，字号为画面高度的1至20%"));
            }
        }
        Ok(())
    }
}

pub(super) fn overlap(left: &ClipEdit, right: &ClipEdit) -> f64 {
    left.transition.as_ref().map(|t| t.seconds.min((left.end - left.start) / 2.0).min((right.end - right.start) / 2.0)).unwrap_or(0.0)
}

impl ClipRenderService {
    pub(super) async fn finish_timeline(&self, id: &str, command: &StartClipRender, clips: Vec<ClipEdit>, ffmpeg: &Path, directory: &Path, cancel: &AtomicBool) -> BackendResult<()> {
        if clips.is_empty() { return Err(invalid("没有可导出的片段")); }
        let (width, height) = dimensions(&command.params);
        let mut elapsed = 0.0;
        let mut captions: Vec<(f64, f64, String)> = Vec::new();
        for (index, clip) in clips.iter().enumerate() {
            if index > 0 { elapsed -= overlap(&clips[index - 1], clip); }
            let end = elapsed + clip.end - clip.start;
            if !clip.caption.trim().is_empty() { captions.push((elapsed, end, clip.caption.clone())); }
            elapsed = end;
        }
        if command.params.duration_seconds > 0 { elapsed = elapsed.min(command.params.duration_seconds as f64); }
        for overlay in &command.settings.overlays {
            if overlay.kind == "subtitle" && !overlay.text.trim().is_empty() && overlay.start < elapsed {
                captions.push((overlay.start, overlay.end.min(elapsed), overlay.text.clone()));
            }
        }
        captions.sort_by(|a,b| a.0.total_cmp(&b.0));
        let srt = captions.iter().filter(|(start,end,_)| start < &elapsed && end - start >= 0.04).enumerate().map(|(index,(start,end,text))| {
            format!("{}\n{} --> {}\n{}\n\n", index + 1, srt_time(*start), srt_time(end.min(elapsed)), text.replace('\r', ""))
        }).collect::<String>();
        tokio::fs::write(directory.join("captions.srt"), &srt).await?;
        if clips.iter().take(clips.len() - 1).all(|clip| clip.transition.is_none()) {
            let list = (0..clips.len()).map(|i| format!("file 'clip-{i}.mp4'\n")).collect::<String>();
            tokio::fs::write(directory.join("concat.txt"), list).await?;
            self.ffmpeg(ffmpeg, directory, vec!["-f".into(), "concat".into(), "-safe".into(), "1".into(), "-i".into(), "concat.txt".into(), "-c".into(), "copy".into(), "joined.mp4".into()], cancel).await?;
        } else {
            let mut args = vec!["-filter_complex_threads".into(), "1".into()];
            for index in 0..clips.len() { args.extend(["-i".into(), format!("clip-{index}.mp4")]); }
            let mut graph = String::new();
            for index in 0..clips.len() {
                graph.push_str(&format!("[{index}:v]settb=AVTB,setpts=PTS-STARTPTS[v{index}];[{index}:a]asetpts=PTS-STARTPTS[a{index}];"));
            }
            let mut video = "v0".to_owned(); let mut audio = "a0".to_owned();
            let mut duration = clips[0].end - clips[0].start;
            for index in 1..clips.len() {
                let seconds = overlap(&clips[index - 1], &clips[index]);
                if seconds > 0.0 {
                    let kind = match clips[index - 1].transition.as_ref().map(|t| t.kind.as_str()) { Some("black") => "fadeblack", Some("white") => "fadewhite", _ => "fade" };
                    graph.push_str(&format!("[{video}][v{index}]xfade=transition={kind}:duration={seconds}:offset={}[xv{index}];[{audio}][a{index}]acrossfade=d={seconds}:c1=tri:c2=tri[xa{index}];", duration - seconds));
                } else {
                    graph.push_str(&format!("[{video}][v{index}]concat=n=2:v=1:a=0[xv{index}];[{audio}][a{index}]concat=n=2:v=0:a=1[xa{index}];"));
                }
                video = format!("xv{index}"); audio = format!("xa{index}"); duration += clips[index].end - clips[index].start - seconds;
            }
            args.extend(["-filter_complex".into(), graph.trim_end_matches(';').into(), "-map".into(), format!("[{video}]"), "-map".into(), format!("[{audio}]"), "-t".into(), elapsed.to_string(),
                "-c:v".into(), "libx264".into(), "-preset".into(), "fast".into(), "-crf".into(), "20".into(), "-pix_fmt".into(), "yuv420p".into(), "-c:a".into(), "aac".into(), "joined.mp4".into()]);
            self.ffmpeg(ffmpeg, directory, args, cancel).await?;
        }
        let burn = command.settings.subtitles == "burn";
        let mut ass = ass_header(width, height);
        let mut ass_count = 0;
        for overlay in &command.settings.overlays {
            if (overlay.kind == "text" || burn) && overlay.start < elapsed && !overlay.text.trim().is_empty() {
                ass.push_str(&ass_event(overlay, width, height, elapsed)); ass_count += 1;
            }
        }
        if burn {
            let mut cursor = 0.0;
            for (index, clip) in clips.iter().enumerate() {
                if index > 0 { cursor -= overlap(&clips[index - 1], clip); }
                if !clip.caption.trim().is_empty() && cursor < elapsed {
                    let overlay = ClipOverlay { id: String::new(), kind: "subtitle".into(), text: clip.caption.clone(), start: cursor, end: cursor + clip.end - clip.start,
                        x: 50.0, y: 88.0, size: 4.5, color: "#ffffff".into(), background: false, bold: false };
                    ass.push_str(&ass_event(&overlay, width, height, elapsed)); ass_count += 1;
                }
                cursor += clip.end - clip.start;
            }
        }
        tokio::fs::write(directory.join("overlays.ass"), ass).await?;
        let soft = command.settings.subtitles == "soft" && !srt.is_empty();
        let webm = command.settings.format == "webm";
        let filename = if webm { "output.webm" } else { "output.mp4" };
        let mut args = vec!["-i".into(), "joined.mp4".into()];
        if soft { args.extend(["-i".into(), "captions.srt".into()]); }
        args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "0:a:0".into()]);
        if ass_count > 0 { args.extend(["-vf".into(), "ass=overlays.ass".into()]); }
        if webm {
            args.extend(["-c:v".into(), "libvpx-vp9".into(), "-deadline".into(), "realtime".into(), "-cpu-used".into(), "5".into(), "-crf".into(), "32".into(), "-b:v".into(), "0".into(), "-c:a".into(), "libopus".into()]);
        } else if ass_count > 0 {
            args.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "fast".into(), "-crf".into(), "20".into(), "-c:a".into(), "copy".into()]);
        } else { args.extend(["-c".into(), "copy".into()]); }
        if soft { args.extend(["-map".into(), "1:0".into(), "-c:s".into(), if webm { "webvtt" } else { "mov_text" }.into(), "-metadata:s:s:0".into(), "language=zho".into()]); }
        args.extend(["-t".into(), elapsed.to_string()]);
        if !webm { args.extend(["-movflags".into(), "+faststart".into()]); }
        args.push(filename.into());
        self.ffmpeg(ffmpeg, directory, args, cancel).await?;
        let probe = probe_path(ffmpeg, &directory.join(filename).to_string_lossy()).await?;
        if probe.width != width || probe.height != height || (probe.duration_seconds - elapsed).abs() > 0.5 || probe.audio_streams.is_empty() { return Err(invalid("成片轨道或时长校验失败，未登记异常文件")); }
        check_cancel(cancel)?;
        let output = self.inner.directory.join(format!("{id}.{}", command.settings.format));
        let project = self.inner.directory.join(format!("{id}.timeline.json"));
        let subtitles = self.inner.directory.join(format!("{id}.srt"));
        tokio::fs::write(&project, serde_json::to_vec_pretty(&json!({"version":1,"name":command.name,"params":command.params,"clips":clips,"settings":command.settings}))?).await?;
        tokio::fs::write(&subtitles, srt).await?;
        tokio::fs::rename(directory.join(filename), &output).await?;
        self.update(id, |record| {
            record.job.status = "completed".into(); record.job.progress = 100.0; record.job.clips = clips;
            record.job.output_path = Some(output.to_string_lossy().into_owned()); record.job.project_path = Some(project.to_string_lossy().into_owned());
            record.job.subtitle_path = Some(subtitles.to_string_lossy().into_owned()); record.job.error = None; record.job.duration_seconds = Some(probe.duration_seconds);
        })?;
        Ok(())
    }
}

fn ass_header(width: u32, height: u32) -> String {
    let font = if cfg!(windows) { "Microsoft YaHei" } else if cfg!(target_os="macos") { "PingFang SC" } else { "Noto Sans CJK SC" };
    format!("[Script Info]\nScriptType: v4.00+\nPlayResX: {width}\nPlayResY: {height}\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,{font},32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,2,30,30,0,1\nStyle: Box,{font},32,&H00FFFFFF,&H00FFFFFF,&H60000000,&H60000000,0,0,0,0,100,100,0,0,3,8,0,2,30,30,0,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
}
fn ass_time(seconds: f64) -> String {
    let ticks = (seconds.max(0.0) * 100.0).round() as u64;
    format!("{}:{:02}:{:02}.{:02}", ticks / 360000, ticks / 6000 % 60, ticks / 100 % 60, ticks % 100)
}
fn ass_event(overlay: &ClipOverlay, width: u32, height: u32, duration: f64) -> String {
    let style = if overlay.background { "Box" } else { "Default" };
    let color = format!("{}{}{}", &overlay.color[5..7], &overlay.color[3..5], &overlay.color[1..3]);
    let text = overlay.text.replace('\\', "＼").replace('{', "｛").replace('}', "｝").replace('\r', "").replace('\n', "\\N");
    let background = if overlay.background { "\\bord8\\3c&H000000&\\3a&H60&\\shad0" } else { "\\bord1\\3c&H000000&\\3a&H40&\\shad0" };
    format!("Dialogue: {},{},{},{style},,0,0,0,,{{\\an2\\pos({:.1},{:.1})\\fs{:.1}\\c&H{color}&\\b{}{background}}}{text}\n", if overlay.kind == "text" { 1 } else { 0 }, ass_time(overlay.start), ass_time(overlay.end.min(duration)), overlay.x / 100.0 * width as f64, overlay.y / 100.0 * height as f64, overlay.size / 100.0 * height as f64, if overlay.bold { 1 } else { 0 })
}
