//! Local, self-contained brand design sources and atomic deliverable bundles.
//! Inputs remain unchanged; exported SVG accepts only the static design subset.

use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Cursor, Write as _},
    path::{Component, Path},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{DynamicImage, ImageDecoder as _, ImageFormat, ImageReader, Limits};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

use super::error::{BackendError, BackendResult};

const RECEIPT_NAME: &str = "bundle-manifest.json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadBrandDesignImageCommand {
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandDesignImage {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub content_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrandDesignExportFile {
    pub name: String,
    pub base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportBrandDesignBundleCommand {
    pub directory: String,
    pub files: Vec<BrandDesignExportFile>,
    pub manifest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandDesignExportResult {
    pub directory: String,
    pub count: usize,
}

fn invalid(message: &str) -> BackendError {
    BackendError::validation(message, Value::Null)
}

fn image_error(error: image::ImageError) -> BackendError {
    invalid(&format!("无法读取有效的设计图片：{error}"))
}

fn decode_image(bytes: &[u8], format: Option<ImageFormat>) -> BackendResult<DynamicImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes));
    if let Some(format) = format {
        reader.set_format(format);
    } else {
        reader = reader.with_guessed_format()?;
    }
    // Match product_scene_images: reserve the decoded output in addition to
    // format-specific allocation limits. Do not introduce a file-size limit.
    let mut limits = Limits::default();
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder().map_err(image_error)?;
    limits.reserve(decoder.total_bytes()).map_err(image_error)?;
    decoder.set_limits(limits).map_err(image_error)?;
    let orientation = decoder.orientation().map_err(image_error)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(image_error)?;
    image.apply_orientation(orientation);
    Ok(image)
}

pub fn read_image(command: ReadBrandDesignImageCommand) -> BackendResult<BrandDesignImage> {
    let path = Path::new(&command.path);
    if command.path.trim().is_empty() || !path.is_absolute() || !path.is_file() {
        return Err(invalid("请选择已保存到本机的图片文件"));
    }
    // Hash and decode the same captured bytes, including when a source changes
    // on disk while loading. PNG working pixels are EXIF-normalized.
    let bytes = fs::read(path)?;
    let image = decode_image(&bytes, None)?;
    let (width, height) = (image.width(), image.height());
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, ImageFormat::Png)
        .map_err(image_error)?;
    Ok(BrandDesignImage {
        data_url: format!(
            "data:image/png;base64,{}",
            STANDARD.encode(png.into_inner())
        ),
        width,
        height,
        content_hash: hex::encode(Sha256::digest(&bytes)),
    })
}

fn validate_name(name: &str) -> BackendResult<&str> {
    let mut components = Path::new(name).components();
    if name.is_empty()
        || name.trim() != name
        || name.starts_with('.')
        || name.ends_with('.')
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || name.eq_ignore_ascii_case(RECEIPT_NAME)
    {
        return Err(invalid("设计交付文件必须使用安全的文件名，不能包含路径"));
    }
    let (stem, extension) = name
        .rsplit_once('.')
        .ok_or_else(|| invalid("交付文件缺少格式"))?;
    let device = stem
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && device.as_bytes()[3].is_ascii_digit())
    {
        return Err(invalid("设计交付文件名不能使用系统保留名称"));
    }
    if !matches!(extension, "png" | "svg" | "json") {
        return Err(invalid("设计交付只支持 PNG、SVG 和 JSON"));
    }
    Ok(extension)
}

fn validate_png(bytes: &[u8]) -> BackendResult<(u32, u32)> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(invalid("PNG 交付内容与文件格式不符"));
    }
    let image = decode_image(bytes, Some(ImageFormat::Png))?;
    Ok((image.width(), image.height()))
}

fn xml_value(value: &str) -> BackendResult<String> {
    let mut decoded = String::new();
    let mut remaining = value;
    while let Some(position) = remaining.find('&') {
        decoded.push_str(&remaining[..position]);
        let entity = &remaining[position + 1..];
        let end = entity
            .find(';')
            .ok_or_else(|| invalid("SVG XML 转义不完整"))?;
        let entity = &entity[..end];
        let ch = match entity {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ if entity.starts_with("#x") => u32::from_str_radix(&entity[2..], 16)
                .ok()
                .and_then(char::from_u32)
                .ok_or_else(|| invalid("SVG XML 转义无效"))?,
            _ if entity.starts_with('#') => entity[1..]
                .parse::<u32>()
                .ok()
                .and_then(char::from_u32)
                .ok_or_else(|| invalid("SVG XML 转义无效"))?,
            _ => return Err(invalid("SVG 不支持实体声明")),
        };
        if ch.is_control() && !matches!(ch, '\n' | '\r' | '\t') {
            return Err(invalid("SVG 包含无效控制字符"));
        }
        decoded.push(ch);
        remaining = &remaining[position + end + 2..];
    }
    decoded.push_str(remaining);
    Ok(decoded)
}

fn local_reference(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(|id| {
        !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_-.:".contains(c))
    })
}

fn validate_svg_attribute(name: &str, raw: &str) -> BackendResult<()> {
    let value = xml_value(raw)?;
    if !matches!(
        name,
        "xmlns"
            | "xmlns:xlink"
            | "version"
            | "width"
            | "height"
            | "viewBox"
            | "id"
            | "x"
            | "y"
            | "x1"
            | "x2"
            | "y1"
            | "y2"
            | "dx"
            | "dy"
            | "cx"
            | "cy"
            | "r"
            | "rx"
            | "ry"
            | "d"
            | "points"
            | "fill"
            | "stroke"
            | "stroke-width"
            | "stroke-linecap"
            | "stroke-linejoin"
            | "opacity"
            | "fill-opacity"
            | "stroke-opacity"
            | "transform"
            | "clip-path"
            | "clipPathUnits"
            | "text-anchor"
            | "dominant-baseline"
            | "font-family"
            | "font-size"
            | "font-weight"
            | "font-style"
            | "letter-spacing"
            | "textLength"
            | "lengthAdjust"
            | "preserveAspectRatio"
            | "href"
            | "xlink:href"
            | "offset"
            | "stop-color"
            | "stop-opacity"
            | "gradientUnits"
            | "gradientTransform"
            | "role"
            | "aria-label"
            | "data-layer-id"
            | "data-layer-type"
    ) {
        return Err(invalid("SVG 仅允许静态设计属性，不能包含事件或可执行内容"));
    }
    match name {
        "xmlns" if value == "http://www.w3.org/2000/svg" => return Ok(()),
        "xmlns:xlink" if value == "http://www.w3.org/1999/xlink" => return Ok(()),
        "xmlns" | "xmlns:xlink" => return Err(invalid("SVG 命名空间无效")),
        "href" | "xlink:href" => {
            if local_reference(&value) {
                return Ok(());
            }
            let encoded = value
                .strip_prefix("data:image/png;base64,")
                .ok_or_else(|| invalid("SVG 图片必须为内嵌 PNG，不能引用外部文件或网址"))?;
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| invalid("SVG 内嵌图片编码无效"))?;
            validate_png(&bytes)?;
            return Ok(());
        }
        _ => {}
    }
    let lowered = value.to_ascii_lowercase();
    if lowered.contains("url(") {
        if !value.starts_with("url(")
            || !value.ends_with(')')
            || !local_reference(&value[4..value.len() - 1])
        {
            return Err(invalid("SVG 样式不能引用外部资源"));
        }
    } else if lowered.contains("://")
        || lowered.contains("javascript:")
        || lowered.contains("data:")
        || value.contains(['<', '>', '\\'])
    {
        return Err(invalid("SVG 属性包含外部资源或可执行内容"));
    }
    Ok(())
}

fn validate_svg(bytes: &[u8]) -> BackendResult<()> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid("SVG 必须使用 UTF-8"))?;
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(invalid("SVG 包含无效控制字符"));
    }
    // The app generates a deliberately small XML subset. Reject declarations,
    // comments, styles and unknown markup instead of sanitizing arbitrary SVG.
    let attribute = Regex::new(r#"^([A-Za-z][A-Za-z0-9:._-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
        .expect("constant SVG attribute pattern");
    let mut remaining = text.trim();
    if remaining.starts_with("<?xml") {
        let end = remaining
            .find("?>")
            .ok_or_else(|| invalid("SVG XML 声明不完整"))?;
        let declaration = Regex::new(
            r#"^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?\s*\?>$"#,
        )
        .expect("constant XML declaration pattern");
        if !declaration.is_match(&remaining[..end + 2]) {
            return Err(invalid("SVG 只支持 UTF-8 XML 1.0 文档"));
        }
        remaining = remaining[end + 2..].trim_start();
    }
    let mut stack: Vec<&str> = Vec::new();
    let mut root_seen = false;
    while !remaining.is_empty() {
        if !remaining.starts_with('<') {
            let end = remaining.find('<').unwrap_or(remaining.len());
            let content = &remaining[..end];
            if content.contains('>') || (stack.is_empty() && !content.trim().is_empty()) {
                return Err(invalid("SVG 文档结构无效"));
            }
            xml_value(content)?;
            remaining = &remaining[end..];
            continue;
        }
        let end = remaining
            .find('>')
            .ok_or_else(|| invalid("SVG 标签不完整"))?;
        let token = &remaining[1..end];
        if token.contains('<') || token.starts_with(['!', '?']) {
            return Err(invalid("SVG 不能包含声明、脚本或额外 XML 内容"));
        }
        remaining = &remaining[end + 1..];
        if let Some(closing) = token.strip_prefix('/') {
            if stack.pop() != Some(closing.trim()) {
                return Err(invalid("SVG 标签未正确闭合"));
            }
            continue;
        }
        let self_closing = token.ends_with('/');
        let token = if self_closing {
            &token[..token.len() - 1]
        } else {
            token
        };
        let split = token.find(char::is_whitespace).unwrap_or(token.len());
        let name = &token[..split];
        if !matches!(
            name,
            "svg"
                | "g"
                | "defs"
                | "clipPath"
                | "rect"
                | "image"
                | "text"
                | "tspan"
                | "path"
                | "circle"
                | "ellipse"
                | "line"
                | "polyline"
                | "polygon"
                | "title"
                | "desc"
                | "linearGradient"
                | "radialGradient"
                | "stop"
        ) {
            return Err(invalid("SVG 仅允许静态设计图层"));
        }
        if stack.is_empty() {
            if root_seen || name != "svg" {
                return Err(invalid("SVG 必须只有一个根节点"));
            }
            root_seen = true;
        } else if name == "svg" {
            return Err(invalid("SVG 不支持嵌套文档"));
        }
        let mut attributes = &token[split..];
        let mut names = HashSet::new();
        while !attributes.trim().is_empty() {
            if !attributes.starts_with(char::is_whitespace) {
                return Err(invalid("SVG 属性必须使用空格分隔"));
            }
            attributes = attributes.trim_start();
            let captures = attribute
                .captures(attributes)
                .ok_or_else(|| invalid("SVG 属性格式无效"))?;
            let key = captures.get(1).unwrap().as_str();
            let value = captures
                .get(2)
                .or_else(|| captures.get(3))
                .unwrap()
                .as_str();
            if !names.insert(key) {
                return Err(invalid("SVG 属性重复"));
            }
            validate_svg_attribute(key, value)?;
            attributes = &attributes[captures.get(0).unwrap().end()..];
        }
        if !self_closing {
            stack.push(name);
        }
    }
    if !root_seen || !stack.is_empty() {
        return Err(invalid("SVG 文档不完整"));
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> BackendResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub fn export_bundle(
    command: ExportBrandDesignBundleCommand,
) -> BackendResult<BrandDesignExportResult> {
    let directory = Path::new(&command.directory);
    if command.directory.trim().is_empty() || !directory.is_absolute() || !directory.is_dir() {
        return Err(invalid("请选择有效的设计交付目录"));
    }
    if command.files.is_empty() {
        return Err(invalid("没有可导出的设计文件"));
    }
    let manifest: Value = serde_json::from_str(&command.manifest)?;
    let parent = directory.canonicalize()?;
    // TempDir owns only this freshly created child. Any failure removes just
    // that child; the destination appears only after every file validates.
    let staging = tempfile::Builder::new()
        .prefix(".brand-design-")
        .tempdir_in(&parent)?;
    let mut names = HashSet::new();
    let mut receipts = Vec::new();
    for file in &command.files {
        let format = validate_name(&file.name)?;
        if !names.insert(file.name.to_lowercase()) {
            return Err(invalid("设计交付文件名重复"));
        }
        let bytes = STANDARD
            .decode(&file.base64)
            .map_err(|_| invalid("设计交付文件编码无效"))?;
        let size = if format == "png" {
            let (width, height) = validate_png(&bytes)?;
            json!({"width": width, "height": height})
        } else {
            match format {
                "svg" => validate_svg(&bytes)?,
                "json" => {
                    serde_json::from_slice::<Value>(&bytes)?;
                }
                _ => unreachable!(),
            }
            Value::Null
        };
        write_new(&staging.path().join(&file.name), &bytes)?;
        receipts.push(json!({
            "name": file.name, "format": format, "byteSize": bytes.len(),
            "sha256": hex::encode(Sha256::digest(&bytes)), "dimensions": size,
        }));
    }
    let receipt = serde_json::to_vec_pretty(&json!({
        "schemaVersion": 1, "manifest": manifest, "files": receipts,
    }))?;
    write_new(&staging.path().join(RECEIPT_NAME), &receipt)?;
    let output = parent.join(format!("品牌设计-{}", Uuid::new_v4()));
    if output.exists() {
        return Err(invalid("设计交付目录已存在，请重试"));
    }
    fs::rename(staging.path(), &output)?;
    Ok(BrandDesignExportResult {
        directory: output.to_string_lossy().into_owned(),
        count: command.files.len(),
    })
}
