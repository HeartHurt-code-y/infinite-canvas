use serde_json::{Map, Value, json};

use super::{BackendError, BackendResult, ResolvedGeneration};

/// Native Images fields only. Old aspect_ratio/resolution settings are migrated,
/// never forwarded to Konjac, which returns inline image data for both models.
pub(super) fn parameters(resolved: &ResolvedGeneration) -> BackendResult<Map<String, Value>> {
    if resolved.images.len() > 16 || !resolved.videos.is_empty() || !resolved.audios.is_empty() {
        return Err(BackendError::validation("GPT Image 2.5 最多支持 16 张参考图片，不能直接输入视频或音频。", json!({"images": resolved.images.len()})));
    }
    let values = resolved.parameters.as_object().ok_or_else(|| BackendError::validation("图片参数必须为对象。", json!({})))?;
    let mut result = Map::new();
    let mut size = string_value(values, "size", "auto")?.to_string();
    if size == "auto" && let Some(ratio) = values.get("aspect_ratio").and_then(Value::as_str) {
        let sizes = match ratio {
            "1:1" => ["1024x1024", "2048x2048", "2880x2880"],
            "16:9" => ["1536x864", "2560x1440", "3840x2160"],
            "9:16" => ["864x1536", "1440x2560", "2160x3840"],
            "4:3" => ["1536x1152", "2048x1536", "3264x2448"],
            "3:4" => ["1152x1536", "1536x2048", "2448x3264"],
            "3:2" => ["1536x1024", "2304x1536", "3456x2304"],
            "2:3" => ["1024x1536", "1536x2304", "2304x3456"],
            "21:9" => ["1792x768", "2800x1200", "3808x1632"],
            _ => return Err(BackendError::validation("历史画幅无效，请重新选择图片尺寸。", json!({"aspect_ratio": ratio}))),
        };
        let tier = string_value(values, "resolution", "2k")?.to_ascii_lowercase();
        size = sizes[match tier.as_str() { "1k" => 0, "4k" => 2, _ => 1 }].to_string();
    }
    if size != "auto" {
        let dimensions = size.split_once('x').and_then(|(w, h)| Some((w.parse::<u64>().ok()?, h.parse::<u64>().ok()?)));
        let valid = dimensions.is_some_and(|(w, h)| w >= 16 && h >= 16 && w <= 3840 && h <= 3840 && w % 16 == 0 && h % 16 == 0 && w <= h * 3 && h <= w * 3 && (655_360..=8_294_400).contains(&(w * h)));
        if !valid {
            return Err(BackendError::validation("尺寸须为宽x高：宽高为 16 的倍数、单边不超过 3840 px、宽高比 1:3～3:1、总像素 655,360～8,294,400。", json!({"size": size})));
        }
    }
    result.insert("size".into(), json!(size));
    for (key, default, choices) in [
        ("quality", "auto", &["auto", "low", "medium", "high", "xhigh", "max"][..]),
        ("background", "auto", &["auto", "opaque", "transparent"][..]),
        ("output_format", "png", &["png", "jpeg"][..]),
        ("moderation", "auto", &["auto", "low"][..]),
    ] {
        let value = string_value(values, key, default)?;
        if !choices.contains(&value) {
            return Err(BackendError::validation("图片参数选项无效。", json!({"parameter": key, "value": value, "allowed": choices})));
        }
        result.insert(key.into(), json!(value));
    }
    if result["background"] == "transparent" && result["output_format"] != "png" {
        return Err(BackendError::validation("透明背景请使用 PNG 输出。", json!({})));
    }
    let count = integer_value(values, "n", 1, 1, 10)?;
    result.insert("n".into(), json!(count));
    if result["output_format"] == "jpeg" {
        result.insert("output_compression".into(), json!(integer_value(values, "output_compression", 100, 0, 100)?));
    }
    Ok(result)
}

fn string_value<'a>(values: &'a Map<String, Value>, key: &str, default: &'a str) -> BackendResult<&'a str> {
    match values.get(key) {
        None => Ok(default),
        Some(value) => value.as_str().ok_or_else(|| BackendError::validation("图片参数须为文本。", json!({"parameter": key}))),
    }
}

fn integer_value(values: &Map<String, Value>, key: &str, default: u64, min: u64, max: u64) -> BackendResult<u64> {
    let value = values.get(key).map_or(Some(default), Value::as_u64);
    value.filter(|value| (min..=max).contains(value)).ok_or_else(|| BackendError::validation("图片数量或压缩质量超出范围。", json!({"parameter": key, "minimum": min, "maximum": max})))
}
