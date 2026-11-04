//! Deterministic timed typography. A frame seek and an export sample use the same clock.
use super::{*, timeline::ClipOverlay};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipWord { pub text: String, pub start: f64, pub end: f64 }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordHighlight { pub enabled: bool, pub text_color: String, pub background_color: String, pub words: Vec<ClipWord> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextAnimation { pub r#type: String, pub duration_ms: f64, pub delay_ms: f64, pub iterations: u16, pub amplitude_px: f64 }
pub(super) fn validate(overlay: &ClipOverlay) -> BackendResult<()> {
    if overlay.weight.is_some_and(|weight| !(100..=900).contains(&weight)) { return Err(invalid("字体字重须在100至900之间")); }
    if overlay.font.as_ref().is_some_and(|font| font.id.len() != 64 || !font.id.as_bytes().iter().all(u8::is_ascii_hexdigit)) { return Err(invalid("字体身份无效，请重新选择字体")); }
    if overlay.font.as_ref().is_some_and(|font| font.variable || overlay.weight.is_some_and(|weight| weight != font.weight)) { return Err(invalid("字体文件与所选字重不一致，请在字体库重新选择字体和字重，或导入对应字重的静态字体")); }
    if let Some(highlight) = &overlay.highlight {
        if !color_valid(&highlight.text_color) || !color_valid(&highlight.background_color) || highlight.words.len() > 1000 { return Err(invalid("逐词高亮颜色或词数无效，每条最多1000个词")); }
        let mut end = 0.0;
        for word in &highlight.words {
            if word.text.is_empty() || !word.start.is_finite() || !word.end.is_finite() || word.start < end - 0.001 || word.end <= word.start || word.end > overlay.end - overlay.start + 0.001 { return Err(invalid("逐词时间须按顺序排列、互不重叠，并在这条文字的持续时间内；可点击「重新均分时间」修复")); }
            end = word.end;
        }
        if highlight.enabled && highlight.words.iter().map(|word| word.text.as_str()).collect::<String>() != overlay.text { return Err(invalid("逐词文本与正文不一致，请重新分词并调整时间")); }
    }
    if let Some(animation) = &overlay.animation {
        if !matches!(animation.r#type.as_str(), "none" | "fade" | "spring-up" | "blur-in" | "zoom-in" | "slide-left" | "slide-right" | "wipe-in" | "pulse" | "wave")
            || !animation.duration_ms.is_finite() || !(100.0..=10000.0).contains(&animation.duration_ms)
            || !animation.delay_ms.is_finite() || !(0.0..=30000.0).contains(&animation.delay_ms)
            || !(1..=10).contains(&animation.iterations) || !animation.amplitude_px.is_finite() || !(0.0..=100.0).contains(&animation.amplitude_px) { return Err(invalid("文字动画参数无效：时长100至10000毫秒、延迟0至30000毫秒、重复1至10次")); }
    }
    Ok(())
}
fn color_valid(value: &str) -> bool { matches!(value.len(), 7 | 9) && value.starts_with('#') && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit) }
fn bezier(progress: f64, x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    fn curve(t: f64, a: f64, b: f64) -> f64 { 3.0 * (1.0-t).powi(2) * t * a + 3.0 * (1.0-t) * t.powi(2) * b + t.powi(3) }
    let (mut low, mut high) = (0.0, 1.0);
    for _ in 0..16 { let middle = (low + high) / 2.0; if curve(middle, x1, x2) < progress { low = middle; } else { high = middle; } }
    curve((low + high) / 2.0, y1, y2)
}
#[derive(Default)]
struct Motion { opacity: f64, x: f64, y: f64, scale: f64, blur: f64, reveal: f64 }
fn sample(animation: Option<&TextAnimation>, seconds: f64) -> Motion {
    let mut m = Motion { opacity: 1.0, scale: 1.0, reveal: 1.0, ..Motion::default() };
    let Some(a) = animation.filter(|a| a.r#type != "none") else { return m; };
    let elapsed = seconds * 1000.0 - a.delay_ms;
    let p = if elapsed >= a.duration_ms * a.iterations as f64 { 1.0 } else { (elapsed % a.duration_ms / a.duration_ms).max(0.0) };
    let ease = bezier(p, 0.0, 0.0, 0.58, 1.0);
    match a.r#type.as_str() {
        "fade" => m.opacity = ease,
        "spring-up" => { let spring = bezier(p, 0.18, 0.89, 0.32, 1.28); m.opacity = spring.min(1.0); m.y = 28.0 * (1.0-spring); },
        "blur-in" => { m.opacity = ease; m.blur = 14.0 * (1.0-ease); m.scale = 1.0 + 0.06 * (1.0-ease); },
        "zoom-in" => { m.opacity = ease; m.scale = 1.0 + 0.12 * (1.0-ease); },
        "slide-left" => { m.opacity = ease; m.x = 64.0 * (1.0-ease); },
        "slide-right" => { m.opacity = ease; m.x = -64.0 * (1.0-ease); },
        "wipe-in" => m.reveal = bezier(p, 0.42, 0.0, 0.58, 1.0),
        "pulse" => { m.opacity = (p / 0.7).min(1.0); m.scale = if p < 0.7 { 0.92 + 0.14 * bezier(p/0.7, 0.0, 0.0, 0.58, 1.0) } else { 1.06 - 0.06 * bezier((p-0.7)/0.3, 0.0, 0.0, 0.58, 1.0) }; },
        "wave" => m.y = -a.amplitude_px * (std::f64::consts::PI * p).sin().powi(2),
        _ => {},
    }
    m
}
fn escape(text: &str) -> String { text.replace('\\', "＼").replace('{', "｛").replace('}', "｝").replace('\r', "").replace('\n', "\\N") }
fn color(value: &str, channel: u8, opacity: f64) -> String {
    let alpha = if value.len() == 9 { u8::from_str_radix(&value[7..9], 16).unwrap_or(255) as f64 / 255.0 } else { 1.0 };
    let transparency = (255.0 * (1.0-alpha * opacity)).round().clamp(0.0,255.0) as u8;
    format!("\\{channel}c&H{}{}{}&\\{channel}a&H{transparency:02X}&", &value[5..7], &value[3..5], &value[1..3])
}
fn styled_text(overlay: &ClipOverlay, seconds: f64, opacity: f64, boxed: bool) -> String {
    let bg = if overlay.background { "#000000A6" } else { "#00000000" };
    let normal = format!("{}{}", color(&overlay.color,1,opacity),color(if boxed { bg } else { "#00000099" },3,opacity));
    let Some(highlight) = overlay.highlight.as_ref().filter(|h| h.enabled) else { return format!("{{{normal}}}{}", escape(&overlay.text)); };
    highlight.words.iter().map(|word| {
        let active = seconds >= word.start && seconds < word.end && !word.text.trim().is_empty();
        let style = if active { format!("{}{}",color(&highlight.text_color,1,opacity),color(&highlight.background_color,3,opacity)) } else { normal.clone() };
        format!("{{{style}}}{}", escape(&word.text))
    }).collect()
}
/// Use the font's actual advances for wipe clipping; positioning itself stays in libass.
fn text_width(overlay: &ClipOverlay, pixels: f64, font_path: Option<&Path>) -> f64 {
    let data = font_path.and_then(|path| std::fs::read(path).ok());
    let face = data.as_deref().and_then(|data| ttf_parser::Face::parse(data,0).ok());
    overlay.text.lines().map(|line| line.chars().map(|ch| face.as_ref().and_then(|face| face.glyph_index(ch).and_then(|id| face.glyph_hor_advance(id)).map(|advance| advance as f64 / face.units_per_em() as f64)).unwrap_or(if ch.is_ascii() { 0.6 } else { 1.0 }) * pixels).sum::<f64>()).fold(0.0, f64::max)
}
pub(super) fn events(overlay: &ClipOverlay, width: u32, height: u32, duration: f64, font: Option<&fonts::PreparedFont>) -> String {
    let end = overlay.end.min(duration);
    let mut boundaries = vec![overlay.start, end];
    if let Some(h) = &overlay.highlight && h.enabled { for word in &h.words { boundaries.extend([overlay.start+word.start, overlay.start+word.end]); } }
    if let Some(a) = &overlay.animation && a.r#type != "none" {
        let start = overlay.start+a.delay_ms/1000.0;
        let animated_end = (start+a.duration_ms*a.iterations as f64/1000.0).min(end);
        let mut frame = 0;
        while start + frame as f64/30.0 < animated_end { boundaries.push(start+frame as f64/30.0); frame += 1; }
        boundaries.push(animated_end);
    }
    boundaries.retain(|time| *time >= overlay.start && *time <= end);
    // ASS has centisecond resolution. Deduplicate after rounding to prevent overlapping events.
    let mut ticks: Vec<u32> = boundaries.into_iter().map(|seconds| (seconds*100.0).round() as u32).collect(); ticks.sort_unstable(); ticks.dedup();
    let boxed = overlay.background || overlay.highlight.as_ref().is_some_and(|h| h.enabled && (h.background_color.len() == 7 || &h.background_color[7..9] != "00"));
    let style = if boxed { "Box" } else { "Default" };
    let font_tag = font.map(|font| format!("\\fn{}",font.font.family)).unwrap_or_default();
    let em_size = overlay.size / 100.0 * height as f64;
    // libass normalizes to ascender-descender while CSS sizes an em. Convert once
    // so that the same font's advances and glyph sizes match the preview.
    let metrics = font.and_then(|font| std::fs::read(&font.path).ok()).and_then(|data| ttf_parser::Face::parse(&data,0).ok().map(|face| (face.ascender() as f64-face.descender() as f64)/face.units_per_em() as f64)).unwrap_or(1.0);
    let size = em_size * metrics;
    let text_width = text_width(overlay,em_size,font.map(|font| Path::new(&font.path))).min(width as f64*0.86);
    let mut ass = String::new();
    for pair in ticks.windows(2) {
        let seconds = pair[0] as f64/100.0-overlay.start;
        let m = sample(overlay.animation.as_ref(),seconds);
        let x = overlay.x/100.0*width as f64+m.x; let y=overlay.y/100.0*height as f64+m.y;
        let clip = if m.reveal < 0.9999 { format!("\\clip({:.0},0,{:.0},{height})",(x-text_width/2.0-4.0).max(0.0), (x-text_width/2.0-4.0+(text_width+8.0)*m.reveal).max(0.0)) } else { String::new() };
        let weight = overlay.weight.unwrap_or(if overlay.bold { 700 } else { 400 });
        let outline = if boxed { 4 } else { 1 };
        let tags = format!("\\an2\\pos({x:.2},{y:.2}){font_tag}\\fs{size:.2}\\b{weight}\\bord{outline}\\shad0\\fscx{:.3}\\fscy{:.3}\\blur{:.2}{clip}",m.scale*100.0,m.scale*100.0,m.blur);
        ass.push_str(&format!("Dialogue: {},{},{},{style},,0,0,0,,{{{tags}}}{}\n",if overlay.kind=="text" {1} else {0}, super::timeline::ass_time(pair[0] as f64/100.0), super::timeline::ass_time(pair[1] as f64/100.0),styled_text(overlay,seconds,m.opacity,boxed)));
    }
    ass
}
