//! 云端素材库图片尺寸归一化。
//!
//! 上游素材库对图片素材的边长有硬性窗口：越界图片要等本地把整个对象传完、平台开始
//! 预处理时才判负（`[FormatUnsupported] Width must be between 300px and 6000px.`），
//! 而失败发生在平台侧，本地重试同一个暂存对象也不会通过——用户看到的只是一次
//! 完整上传换来一条报错。因此把调整前移到上传对象存储之前：已经在窗口内的图片
//! 原样上传，越界的先调整进窗口再上传。
//!
//! 调整策略按「尽量不丢内容」排序：
//! 1. 等比缩放（默认）：长边超上限就整体缩小，短边低于下限就整体放大，画面完整；
//! 2. 居中裁剪（兜底）：长宽比超过窗口允许的极值（6000/300 = 20:1）时，等比缩放
//!    已经无解（放大到短边合规会让长边越界，缩小到长边合规会让短边越界），只能把
//!    长边居中裁到窗口比例再缩放。这是唯一会丢画面的路径，且只对超长条图生效。

use std::{
    io::{BufWriter, Write as _},
    path::{Path, PathBuf},
};

use image::{DynamicImage, GenericImageView as _, ImageFormat, ImageReader, Limits};
use tauri_plugin_log::log::{info, warn};
use uuid::Uuid;

/// 平台允许的图片边长下限（px）。
pub const MIN_ASSET_EDGE_PX: u32 = 300;

/// 平台允许的图片边长上限（px）。
pub const MAX_ASSET_EDGE_PX: u32 = 6000;

/// 窗口允许的最大长宽比：长边 ≤ 上限且短边 ≥ 下限时，长宽比不可能超过 6000/300 = 20:1。
const MAX_ASSET_ASPECT_RATIO: u32 = MAX_ASSET_EDGE_PX / MIN_ASSET_EDGE_PX;

/// JPEG 重编码质量：缩放本身已有损，这里取高值避免二次损失叠加。
const JPEG_REENCODE_QUALITY: u8 = 92;

/// 解码防御上限：约 1 亿像素（RGBA 约 400MB）。
///
/// 归一化只是上传前的兜底，不值得为一张异常巨大的图片把内存吃满；超限时跳过调整、
/// 按原文件上传，让上游给出它自己的明确报错。
const MAX_DECODE_PIXELS: u64 = 100_000_000;

/// 可以直接解码 / 重编码的图片扩展名。
///
/// `gif` 可能带动画，本模块只能取首帧，缩放会把动图静默变成静帧，因此保持原样上传；
/// `avif` / `heic` 本 crate 无解码器（`avif` 仍走既有 FFmpeg 转码路径）。
const NORMALIZABLE_IMAGE_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];

/// 尺寸调整方案：已在窗口内时不存在方案。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFit {
    /// 等比缩放，画面完整（长边超上限则缩小，短边低于下限则放大）。
    Scale { width: u32, height: u32 },
    /// 长宽比超出窗口允许范围：先把长边居中裁到窗口比例，再缩放到窗口边界。
    CropAndScale {
        crop_width: u32,
        crop_height: u32,
        offset_x: u32,
        offset_y: u32,
        width: u32,
        height: u32,
    },
}

/// 计算把 `width × height` 放进平台窗口所需的调整方案；已经在窗口内返回 `None`。
pub fn plan_image_fit(width: u32, height: u32) -> Option<ImageFit> {
    // 解码失败/尺寸异常（0 像素）时不猜，交给上游报错。
    if width == 0 || height == 0 {
        return None;
    }
    if (MIN_ASSET_EDGE_PX..=MAX_ASSET_EDGE_PX).contains(&width)
        && (MIN_ASSET_EDGE_PX..=MAX_ASSET_EDGE_PX).contains(&height)
    {
        return None;
    }
    let (long, short) = if width >= height {
        (width, height)
    } else {
        (height, width)
    };
    // 等比缩放的可行条件：存在缩放系数 k 使 短边·k ≥ 下限 且 长边·k ≤ 上限，
    // 即 长边/短边 ≤ 上限/下限。用整数比较避免浮点误差在边界上做错误决策。
    let scalable = u64::from(long) * u64::from(MIN_ASSET_EDGE_PX)
        <= u64::from(short) * u64::from(MAX_ASSET_EDGE_PX);
    if scalable {
        // 长边越界（图太大）→ 缩到上限；否则短边越界（图太小）→ 放大到下限。
        let scale = if long > MAX_ASSET_EDGE_PX {
            f64::from(MAX_ASSET_EDGE_PX) / f64::from(long)
        } else {
            f64::from(MIN_ASSET_EDGE_PX) / f64::from(short)
        };
        let (width, height) = scaled_edges(width, height, scale);
        return Some(ImageFit::Scale { width, height });
    }
    // 长宽比超窗口：长边裁到「短边 × 20」即可满足窗口比例，且是丢内容最少的裁法。
    let cropped_long = u64::from(short)
        .saturating_mul(u64::from(MAX_ASSET_ASPECT_RATIO))
        .min(u64::from(long));
    let cropped_long = u32::try_from(cropped_long).unwrap_or(long);
    let (crop_width, crop_height) = if width >= height {
        (cropped_long, height)
    } else {
        (width, cropped_long)
    };
    // 裁到 20:1 后，窗口内唯一解就是长边 6000、短边 300。
    let (final_width, final_height) = if width >= height {
        (MAX_ASSET_EDGE_PX, MIN_ASSET_EDGE_PX)
    } else {
        (MIN_ASSET_EDGE_PX, MAX_ASSET_EDGE_PX)
    };
    Some(ImageFit::CropAndScale {
        crop_width,
        crop_height,
        offset_x: (width - crop_width) / 2,
        offset_y: (height - crop_height) / 2,
        width: final_width,
        height: final_height,
    })
}

/// 按缩放系数换算两边像素；四舍五入后再夹进窗口，抵消取整带来的 ±1px 越界。
fn scaled_edges(width: u32, height: u32, scale: f64) -> (u32, u32) {
    let edge = |value: u32| -> u32 {
        let scaled = (f64::from(value) * scale).round().max(1.0);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let scaled = scaled as u32;
        scaled.clamp(MIN_ASSET_EDGE_PX, MAX_ASSET_EDGE_PX)
    };
    (edge(width), edge(height))
}

/// 归一化产物：上传应改用 `path`，并以 `extension` / `mime` 记录对象键与类型。
pub struct NormalizedAssetImage {
    pub path: PathBuf,
    pub extension: String,
    pub mime: String,
    /// 面向用户的调整说明，写入暂存任务后在素材面板的上传行展示。
    pub note: String,
}

/// 把越界图片调整进平台窗口，返回可上传的临时文件；无需调整或无法调整时返回 `None`。
///
/// 全程尽力而为：解码失败、尺寸过大、写盘失败都只记日志并退回原文件上传，
/// 不因为「顺手做的归一化」把一次本来可能成功的上传变成失败。
pub fn normalize_image_for_asset_window(
    source: &Path,
    extension: &str,
    job_id: &str,
) -> Option<NormalizedAssetImage> {
    let normalized_extension = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if !NORMALIZABLE_IMAGE_EXTENSIONS.contains(&normalized_extension.as_str()) {
        return None;
    }
    let image = match decode_image(source) {
        Ok(image) => image,
        Err(reason) => {
            warn!(
                "[staging] 图片尺寸归一化跳过（解码失败，按原文件上传）: jobId={}, path={}, 原因={reason}",
                job_id,
                source.display()
            );
            return None;
        }
    };
    let (source_width, source_height) = image.dimensions();
    let fit = plan_image_fit(source_width, source_height)?;
    let (prepared, target_width, target_height) = match fit {
        ImageFit::Scale { width, height } => (image, width, height),
        ImageFit::CropAndScale {
            crop_width,
            crop_height,
            offset_x,
            offset_y,
            width,
            height,
        } => (
            image.crop_imm(offset_x, offset_y, crop_width, crop_height),
            width,
            height,
        ),
    };
    let resized = prepared.resize_exact(
        target_width,
        target_height,
        image::imageops::FilterType::Lanczos3,
    );
    let output_extension = output_extension_for(&normalized_extension);
    let output = std::env::temp_dir().join(format!(
        "infinite-canvas-asset-{}-{}.{}",
        job_id,
        Uuid::new_v4(),
        output_extension
    ));
    if let Err(reason) = write_image(&resized, &output, output_extension) {
        let _ = std::fs::remove_file(&output);
        warn!(
            "[staging] 图片尺寸归一化跳过（写盘失败，按原文件上传）: jobId={}, path={}, 原因={reason}",
            job_id,
            source.display()
        );
        return None;
    }
    let note = describe_fit(
        fit,
        (source_width, source_height),
        (target_width, target_height),
    );
    info!(
        "[staging] 图片尺寸已归一化到平台窗口: jobId={}, {}×{} → {}×{}, 输出={}",
        job_id,
        source_width,
        source_height,
        target_width,
        target_height,
        output.display()
    );
    Some(NormalizedAssetImage {
        path: output,
        extension: output_extension.to_string(),
        mime: output_mime(output_extension).to_string(),
        note,
    })
}

/// 解码图片，并施加像素总量上限避免异常大图吃满内存。
fn decode_image(source: &Path) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::open(source)
        .map_err(|error| format!("打开文件失败：{error}"))?
        .with_guessed_format()
        .map_err(|error| format!("识别格式失败：{error}"))?;
    reader.limits(decode_limits());
    reader.decode().map_err(|error| error.to_string())
}

/// 解码上限按「边长 × 边长 ≤ 1 亿像素」放宽到单边 10 万像素：
/// 真正的约束是总像素数（`max_alloc`），单边上限只用于挡住畸形的超大声明值。
fn decode_limits() -> Limits {
    let mut limits = Limits::no_limits();
    limits.max_image_width = Some(100_000);
    limits.max_image_height = Some(100_000);
    limits.max_alloc = Some(MAX_DECODE_PIXELS * 4);
    limits
}

/// 输出格式：沿用源格式能避免「改尺寸顺带换格式」的意外；bmp/tiff 等不支持编码的
/// 源格式统一落到无损 PNG。
fn output_extension_for(source_extension: &str) -> &'static str {
    match source_extension {
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        _ => "png",
    }
}

fn output_mime(extension: &str) -> &'static str {
    match extension {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

fn write_image(image: &DynamicImage, output: &Path, extension: &str) -> Result<(), String> {
    let file =
        std::fs::File::create(output).map_err(|error| format!("创建临时文件失败：{error}"))?;
    let mut writer = BufWriter::new(file);
    match extension {
        "jpg" | "jpeg" => image
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut writer,
                JPEG_REENCODE_QUALITY,
            ))
            .map_err(|error| format!("JPEG 编码失败：{error}"))?,
        // 无损 WebP 编码器只接受 Rgb8 / Rgba8，先按源图是否带 alpha 归一化像素格式。
        "webp" => {
            let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut writer);
            if image.color().has_alpha() {
                image
                    .to_rgba8()
                    .write_with_encoder(encoder)
                    .map_err(|error| format!("WebP 编码失败：{error}"))?
            } else {
                image
                    .to_rgb8()
                    .write_with_encoder(encoder)
                    .map_err(|error| format!("WebP 编码失败：{error}"))?
            }
        }
        _ => image
            .write_to(&mut writer, ImageFormat::Png)
            .map_err(|error| format!("PNG 编码失败：{error}"))?,
    }
    writer
        .flush()
        .map_err(|error| format!("写入临时文件失败：{error}"))
}

/// 面向用户的调整说明：点明原始尺寸、平台限制与实际结果。
fn describe_fit(fit: ImageFit, source: (u32, u32), target: (u32, u32)) -> String {
    let (source_width, source_height) = source;
    let (target_width, target_height) = target;
    let window = format!("{MIN_ASSET_EDGE_PX}–{MAX_ASSET_EDGE_PX}px");
    match fit {
        ImageFit::Scale { .. } if target_width > source_width || target_height > source_height => {
            format!(
                "原图 {source_width}×{source_height} 小于平台最小边长，已自动等比放大为 {target_width}×{target_height}（平台要求边长 {window}）。"
            )
        }
        ImageFit::Scale { .. } => format!(
            "原图 {source_width}×{source_height} 超出平台边长限制，已自动等比缩放为 {target_width}×{target_height}（平台要求边长 {window}）。"
        ),
        ImageFit::CropAndScale { .. } => format!(
            "原图 {source_width}×{source_height} 的长宽比超过平台允许范围，已自动居中裁剪并缩放为 {target_width}×{target_height}（平台要求边长 {window}）。"
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    use super::*;

    #[test]
    fn images_inside_the_platform_window_are_left_untouched() {
        assert_eq!(plan_image_fit(MIN_ASSET_EDGE_PX, MIN_ASSET_EDGE_PX), None);
        assert_eq!(plan_image_fit(MAX_ASSET_EDGE_PX, MAX_ASSET_EDGE_PX), None);
        assert_eq!(plan_image_fit(1920, 1080), None);
        // 边界内的极端长条图：20:1 正好是窗口允许的极限比例。
        assert_eq!(plan_image_fit(6000, 300), None);
    }

    #[test]
    fn oversized_images_scale_down_without_changing_aspect_ratio() {
        // 报错现场：超宽截图按长边缩到 6000，比例不变。
        let fit = plan_image_fit(8000, 400).expect("oversized width needs a fit");
        assert_eq!(
            fit,
            ImageFit::Scale {
                width: 6000,
                height: 300
            }
        );

        let fit = plan_image_fit(12000, 9000).expect("oversized image needs a fit");
        assert_eq!(
            fit,
            ImageFit::Scale {
                width: 6000,
                height: 4500
            }
        );

        let fit = plan_image_fit(4000, 8000).expect("oversized height needs a fit");
        assert_eq!(
            fit,
            ImageFit::Scale {
                width: 3000,
                height: 6000
            }
        );
    }

    #[test]
    fn undersized_images_scale_up_to_reach_the_minimum_edge() {
        let fit = plan_image_fit(200, 100).expect("undersized image needs a fit");
        assert_eq!(
            fit,
            ImageFit::Scale {
                width: 600,
                height: 300
            }
        );

        // 12.5:1 仍在窗口允许比例内：放大到短边 300 即可，不必裁剪。
        let fit = plan_image_fit(3000, 200).expect("undersized height needs a fit");
        assert_eq!(
            fit,
            ImageFit::Scale {
                width: 4500,
                height: 300
            }
        );
        let ImageFit::Scale { width, height } = fit else {
            panic!("expected a uniform scale");
        };
        assert!((MIN_ASSET_EDGE_PX..=MAX_ASSET_EDGE_PX).contains(&width));
        assert!((MIN_ASSET_EDGE_PX..=MAX_ASSET_EDGE_PX).contains(&height));

        // 25:1 已超窗口比例：放大到短边 300 会让长边变成 7500，只能裁剪后缩放。
        let fit = plan_image_fit(3000, 120).expect("extreme sliver needs a fit");
        assert_eq!(
            fit,
            ImageFit::CropAndScale {
                crop_width: 2400,
                crop_height: 120,
                offset_x: 300,
                offset_y: 0,
                width: MAX_ASSET_EDGE_PX,
                height: MIN_ASSET_EDGE_PX,
            }
        );
    }

    #[test]
    fn extreme_panoramas_are_center_cropped_before_scaling() {
        // 1:27.8 的拼接长图：等比缩放无解，长边居中裁到 20:1 再缩放。
        let fit = plan_image_fit(1080, 30_000).expect("extreme panorama needs a fit");
        assert_eq!(
            fit,
            ImageFit::CropAndScale {
                crop_width: 1080,
                crop_height: 21_600,
                offset_x: 0,
                offset_y: 4_200,
                width: MIN_ASSET_EDGE_PX,
                height: MAX_ASSET_EDGE_PX,
            }
        );

        // 超宽全景：同上，但裁剪发生在水平方向。
        let fit = plan_image_fit(30_000, 1080).expect("extreme panorama needs a fit");
        assert_eq!(
            fit,
            ImageFit::CropAndScale {
                crop_width: 21_600,
                crop_height: 1080,
                offset_x: 4_200,
                offset_y: 0,
                width: MAX_ASSET_EDGE_PX,
                height: MIN_ASSET_EDGE_PX,
            }
        );
    }

    #[test]
    fn every_plan_lands_inside_the_window_for_arbitrary_sizes() {
        let samples = [
            (1_u32, 1_u32),
            (299, 299),
            (301, 299),
            (6001, 6000),
            (6000, 6001),
            (100_000, 300),
            (300, 100_000),
            (7000, 350),
            (12_345, 6_789),
        ];
        for (width, height) in samples {
            let Some(fit) = plan_image_fit(width, height) else {
                assert!(
                    (MIN_ASSET_EDGE_PX..=MAX_ASSET_EDGE_PX).contains(&width)
                        && (MIN_ASSET_EDGE_PX..=MAX_ASSET_EDGE_PX).contains(&height),
                    "{width}×{height} should have been adjusted"
                );
                continue;
            };
            let (final_width, final_height) = match fit {
                ImageFit::Scale { width, height } => (width, height),
                ImageFit::CropAndScale { width, height, .. } => (width, height),
            };
            assert!(
                (MIN_ASSET_EDGE_PX..=MAX_ASSET_EDGE_PX).contains(&final_width)
                    && (MIN_ASSET_EDGE_PX..=MAX_ASSET_EDGE_PX).contains(&final_height),
                "{width}×{height} planned {final_width}×{final_height} outside the window"
            );
        }
    }

    #[test]
    fn normalizing_an_oversized_png_writes_a_window_sized_file() {
        let directory = tempfile::tempdir().expect("temp dir");
        let source = directory.path().join("screenshot.png");
        write_solid_png(&source, 8000, 400);

        let normalized = normalize_image_for_asset_window(&source, "png", "job-1")
            .expect("oversized png should be normalized");
        let (width, height) = ImageReader::open(&normalized.path)
            .expect("open")
            .with_guessed_format()
            .expect("guess")
            .into_dimensions()
            .expect("dimensions");
        assert_eq!((width, height), (6000, 300));
        assert_eq!(normalized.extension, "png");
        assert_eq!(normalized.mime, "image/png");
        assert!(
            normalized.note.contains("8000×400"),
            "note: {}",
            normalized.note
        );
        assert!(
            normalized.note.contains("6000×300"),
            "note: {}",
            normalized.note
        );
        let _ = std::fs::remove_file(&normalized.path);
    }

    #[test]
    fn normalizing_keeps_in_window_images_and_unsupported_formats_untouched() {
        let directory = tempfile::tempdir().expect("temp dir");
        let source = directory.path().join("logo.png");
        write_solid_png(&source, 1920, 1080);
        assert!(normalize_image_for_asset_window(&source, "png", "job-2").is_none());

        let oversized = directory.path().join("huge.png");
        write_solid_png(&oversized, 9000, 900);
        // 动图/无解码器的格式保持原样上传，不做任何静默改写。
        assert!(normalize_image_for_asset_window(&oversized, "gif", "job-3").is_none());
        assert!(normalize_image_for_asset_window(&oversized, "avif", "job-4").is_none());
    }

    #[test]
    fn oversized_webp_sources_are_rewritten_as_readable_webp() {
        let directory = tempfile::tempdir().expect("temp dir");
        let source = directory.path().join("panorama.webp");
        // 带 alpha 的样例覆盖 WebP 编码器只接受 Rgb8 / Rgba8 的分支。
        let fixture =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(9000, 500, Rgba([1, 2, 3, 4])));
        let file = std::fs::File::create(&source).expect("create");
        fixture
            .write_with_encoder(image::codecs::webp::WebPEncoder::new_lossless(
                BufWriter::new(file),
            ))
            .expect("write fixture webp");

        let normalized =
            normalize_image_for_asset_window(&source, "webp", "job-6").expect("normalized webp");
        assert_eq!(normalized.extension, "webp");
        assert_eq!(normalized.mime, "image/webp");
        // 产物必须仍是可解码的 WebP，而不只是后缀对得上。
        let (width, height) = ImageReader::open(&normalized.path)
            .expect("open")
            .with_guessed_format()
            .expect("guess")
            .into_dimensions()
            .expect("dimensions");
        assert_eq!((width, height), (6000, 333));
        let _ = std::fs::remove_file(&normalized.path);
    }

    #[test]
    fn undecodable_files_fall_back_to_the_original_upload() {
        let directory = tempfile::tempdir().expect("temp dir");
        let source = directory.path().join("broken.png");
        std::fs::File::create(&source)
            .expect("create")
            .write_all(b"not really a png")
            .expect("write");
        // 尽力而为：解码失败不报错，让上游按原文件处理。
        assert!(normalize_image_for_asset_window(&source, "png", "job-5").is_none());
    }

    fn write_solid_png(path: &Path, width: u32, height: u32) {
        let image = RgbImage::from_pixel(width, height, Rgb([12, 34, 56]));
        image.save(path).expect("write fixture png");
    }
}
