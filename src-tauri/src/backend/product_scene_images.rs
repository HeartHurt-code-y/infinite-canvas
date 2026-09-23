//! Local product-scene media: approved cutouts for composite mode, and complete
//! reference-conditioned images for AI multi-angle mode. The latter does not lock pixels.

use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{BufWriter, Cursor, Read as _, Write as _},
    path::{Path, PathBuf},
};

use image::{DynamicImage, ImageFormat, ImageReader, Rgba, RgbaImage, imageops};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::error::{BackendError, BackendResult};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareProductViewCommand {
    pub source_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedProductView {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub content_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductViewIdentity {
    pub path: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ValidateProductViewsCommand {
    pub views: Vec<ProductViewIdentity>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductPlacement {
    pub center_x: f64,
    pub baseline_y: f64,
    pub width_fraction: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProductSceneCommand {
    pub background_path: String,
    pub product_path: String,
    pub product_hash: String,
    pub output_id: String,
    pub aspect_ratio: String,
    pub placement: ProductPlacement,
    pub depth_strength: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductSceneComposite {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub background_hash: String,
    pub foreground_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeProductSceneImageCommand {
    pub source_path: String,
    pub output_id: String,
    pub aspect_ratio: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductSceneGeneratedImage {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub image_hash: String,
    pub source_width: u32,
    pub source_height: u32,
    pub padded: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LogoPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProductSceneLogoCommand {
    pub source_path: String,
    pub logo_path: String,
    pub logo_hash: String,
    pub output_id: String,
    pub quad: Vec<LogoPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductSceneLogoComposite {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub image_hash: String,
    pub logo_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportProductScenesCommand {
    pub paths: Vec<String>,
    pub manifest: String,
    pub directory: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProductSceneExport {
    pub directory: String,
    pub count: usize,
}

#[derive(Clone)]
pub struct ProductSceneImageService {
    downloads_directory: PathBuf,
}

fn invalid(message: impl Into<String>) -> BackendError {
    BackendError::validation(message, Value::Null)
}

fn image_error(error: image::ImageError) -> BackendError {
    invalid(format!("产品场景图片处理失败：{error}"))
}

fn output_width(output_id: &str, aspect_ratio: &str) -> BackendResult<u32> {
    if output_id.is_empty()
        || output_id.len() > 100
        || !output_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(invalid("产品场景图输出标识无效。"));
    }
    match aspect_ratio {
        "3:4" => Ok(1536),
        "9:16" => Ok(1152),
        _ => Err(invalid("产品场景图仅支持 3:4 或 9:16。")),
    }
}

fn source_path(source: &str) -> BackendResult<PathBuf> {
    let path = Path::new(source);
    if !path.is_absolute() || !path.is_file() {
        return Err(invalid("请选择已保存的本地图片文件。"));
    }
    Ok(path.canonicalize()?)
}

fn hash_file(path: &Path) -> BackendResult<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn decode(path: &Path) -> BackendResult<DynamicImage> {
    // No file byte-size restriction. Retain the image crate's decoder allocation guard.
    ImageReader::open(path)?
        .with_guessed_format()?
        .decode()
        .map_err(image_error)
}

fn write_png(path: &Path, image: RgbaImage) -> BackendResult<()> {
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let mut writer = BufWriter::new(file);
    DynamicImage::ImageRgba8(image)
        .write_to(&mut writer, ImageFormat::Png)
        .map_err(image_error)?;
    writer.flush()?;
    writer.get_ref().sync_all()?;
    Ok(())
}

impl ProductSceneImageService {
    pub fn new(downloads_directory: PathBuf) -> Self {
        Self {
            downloads_directory,
        }
    }

    fn directory(&self, leaf: &str) -> BackendResult<PathBuf> {
        let downloads = self.downloads_directory.canonicalize()?;
        let directory = downloads.join("无限画布").join("产品场景图").join(leaf);
        fs::create_dir_all(&directory)?;
        let directory = directory.canonicalize()?;
        if !directory.starts_with(downloads) {
            return Err(invalid("产品场景图目录必须位于下载目录内。"));
        }
        Ok(directory)
    }

    pub fn prepare(
        &self,
        command: PrepareProductViewCommand,
    ) -> BackendResult<PreparedProductView> {
        let source = source_path(&command.source_path)?;
        let cutout = prepare_cutout(decode(&source)?.into_rgba8())?;
        let (width, height) = cutout.dimensions();
        let path = self
            .directory("产品母版")?
            .join(format!("{}.png", Uuid::new_v4()));
        write_png(&path, cutout)?;
        Ok(PreparedProductView {
            content_hash: hash_file(&path)?,
            path: path.to_string_lossy().into_owned(),
            width,
            height,
        })
    }

    pub fn prepare_logo(
        &self,
        command: PrepareProductViewCommand,
    ) -> BackendResult<PreparedProductView> {
        let source = source_path(&command.source_path)?;
        let reader = ImageReader::open(source)?.with_guessed_format()?;
        if reader.format() != Some(ImageFormat::Png) {
            return Err(invalid(
                "请提供原版透明 PNG Logo；不使用生成文字或产品截图代替。",
            ));
        }
        // Do not remove white pixels: they may be the actual white wordmark.
        let logo = prepare_logo_pixels(reader.decode().map_err(image_error)?.into_rgba8())?;
        let (width, height) = logo.dimensions();
        let path = self
            .directory("Logo母版")?
            .join(format!("{}.png", Uuid::new_v4()));
        write_png(&path, logo)?;
        Ok(PreparedProductView {
            content_hash: hash_file(&path)?,
            path: path.to_string_lossy().into_owned(),
            width,
            height,
        })
    }

    fn verified_logo_bytes(&self, command: &ProductViewIdentity) -> BackendResult<Vec<u8>> {
        let path = source_path(&command.path)?;
        if !path.starts_with(self.directory("Logo母版")?) || command.content_hash.len() != 64 {
            return Err(invalid("请先导入并确认原版 Logo。"));
        }
        let bytes = fs::read(path)?;
        if hex::encode(Sha256::digest(&bytes)) != command.content_hash {
            return Err(invalid(
                "Logo 母版已改变，请重新导入并确认，不能沿用旧审批。",
            ));
        }
        Ok(bytes)
    }

    pub fn validate_logo(&self, command: ProductViewIdentity) -> BackendResult<()> {
        self.verified_logo_bytes(&command)?;
        Ok(())
    }

    pub fn apply_logo(
        &self,
        command: ApplyProductSceneLogoCommand,
    ) -> BackendResult<ProductSceneLogoComposite> {
        output_width(&command.output_id, "3:4")?;
        let source = source_path(&command.source_path)?;
        if !source.starts_with(self.directory("成图")?) {
            return Err(invalid("Logo 只能贴回本工作流已保存的场景图。"));
        }
        let mut scene = decode(&source)?.into_rgba8();
        let (width, height) = scene.dimensions();
        if ![1536, 1152].contains(&width) || height != 2048 {
            return Err(invalid("请先完成 3:4 或 9:16 场景图尺寸处理。"));
        }
        let bytes = self.verified_logo_bytes(&ProductViewIdentity {
            path: command.logo_path,
            content_hash: command.logo_hash.clone(),
        })?;
        let logo = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()?
            .decode()
            .map_err(image_error)?
            .into_rgba8();
        warp_logo(&mut scene, &logo, &command.quad)?;
        let image_hash = difference_hash(&DynamicImage::ImageRgba8(scene.clone()));
        let path = self.directory("成图")?.join(format!(
            "{}-logo-{}.png",
            command.output_id,
            Uuid::new_v4()
        ));
        write_png(&path, scene)?;
        Ok(ProductSceneLogoComposite {
            path: path.to_string_lossy().into_owned(),
            width,
            height,
            image_hash,
            logo_hash: command.logo_hash,
        })
    }

    fn validate_view(&self, path: &str, expected_hash: &str) -> BackendResult<PathBuf> {
        let path = source_path(path)?;
        if !path.starts_with(self.directory("产品母版")?)
            || expected_hash.len() != 64
            || hash_file(&path)? != expected_hash
        {
            return Err(invalid(
                "产品母版已替换、损坏或未准备。请重新导入并确认，不能继续沿用旧审批。",
            ));
        }
        Ok(path)
    }

    pub fn validate_views(&self, command: ValidateProductViewsCommand) -> BackendResult<()> {
        if command.views.is_empty() {
            return Err(invalid("请先导入并确认产品视图。"));
        }
        for view in command.views {
            self.validate_view(&view.path, &view.content_hash)?;
        }
        Ok(())
    }

    pub fn compose(
        &self,
        command: ComposeProductSceneCommand,
    ) -> BackendResult<ProductSceneComposite> {
        let width = output_width(&command.output_id, &command.aspect_ratio)?;
        let product = self.validate_view(&command.product_path, &command.product_hash)?;
        // Decode and verify the same byte snapshot. A replaced path cannot race the identity check.
        let product_bytes = fs::read(&product)?;
        if hex::encode(Sha256::digest(&product_bytes)) != command.product_hash {
            return Err(invalid("产品母版内容已变化，请重新确认。"));
        }
        let foreground = ImageReader::new(Cursor::new(product_bytes))
            .with_guessed_format()?
            .decode()
            .map_err(image_error)?
            .into_rgba8();
        let background = decode(&source_path(&command.background_path)?)?;
        let background_hash = difference_hash(&background);
        let composite = composite_image(
            background,
            &foreground,
            width,
            2048,
            &command.placement,
            command.depth_strength,
        )?;
        let path =
            self.directory("成图")?
                .join(format!("{}-{}.png", command.output_id, Uuid::new_v4()));
        write_png(&path, composite)?;
        Ok(ProductSceneComposite {
            path: path.to_string_lossy().into_owned(),
            width,
            height: 2048,
            background_hash,
            foreground_hash: command.product_hash,
        })
    }

    /// Keep the new perspective produced by the model. Never paste an old product
    /// view over it, and never crop ports/edges to force a different aspect ratio.
    pub fn normalize_generated(
        &self,
        command: NormalizeProductSceneImageCommand,
    ) -> BackendResult<ProductSceneGeneratedImage> {
        let width = output_width(&command.output_id, &command.aspect_ratio)?;
        let source = decode(&source_path(&command.source_path)?)?;
        let (source_width, source_height) = (source.width(), source.height());
        let image_hash = difference_hash(&source);
        let (normalized, padded) = fit_generated_image(source, width, 2048);
        let path =
            self.directory("成图")?
                .join(format!("{}-{}.png", command.output_id, Uuid::new_v4()));
        write_png(&path, normalized)?;
        Ok(ProductSceneGeneratedImage {
            path: path.to_string_lossy().into_owned(),
            width,
            height: 2048,
            image_hash,
            source_width,
            source_height,
            padded,
        })
    }

    pub fn export(&self, command: ExportProductScenesCommand) -> BackendResult<ProductSceneExport> {
        if command.paths.is_empty() || command.paths.len() > 500 {
            return Err(invalid("请选择 1～500 张已审核的产品场景图。"));
        }
        let parent = Path::new(&command.directory);
        if !parent.is_absolute() || !parent.is_dir() {
            return Err(invalid("请选择有效的本地导出目录。"));
        }
        let parent = parent.canonicalize()?;
        let approved_directory = self.directory("成图")?;
        let paths = command
            .paths
            .iter()
            .map(|path| {
                let path = source_path(path)?;
                if !path.starts_with(&approved_directory)
                    || path.extension().and_then(|s| s.to_str()) != Some("png")
                {
                    return Err(invalid("只能导出本工作流保存的产品场景图片。"));
                }
                Ok(path)
            })
            .collect::<BackendResult<Vec<_>>>()?;
        let manifest: Value = serde_json::from_str(&command.manifest)?;
        let id = Uuid::new_v4();
        let temporary = parent.join(format!(".产品场景图-{id}.partial"));
        let destination = parent.join(format!("产品场景图-{id}"));
        if !temporary.starts_with(&parent) || !destination.starts_with(&parent) {
            return Err(invalid("导出目录无效。"));
        }
        fs::create_dir(&temporary)?;
        let mut created = Vec::new();
        let result = (|| -> BackendResult<()> {
            let mut files = Vec::new();
            for (index, source) in paths.iter().enumerate() {
                let filename = format!("{:03}.png", index + 1);
                let target = temporary.join(&filename);
                created.push(target.clone());
                fs::copy(source, &target)?;
                files.push(
                    json!({"file": filename, "sourcePath": source, "sha256": hash_file(&target)?}),
                );
            }
            let metadata = temporary.join("manifest.json");
            created.push(metadata.clone());
            fs::write(
                metadata,
                serde_json::to_vec_pretty(&json!({
                    "schemaVersion": "product-scenes-export.v1",
                "disclosure": "依据产品参考资料生成或合成的 AI 场景示意；具体模式见 workflowManifest。不是实际买家的开箱或购买证明。",
                    "files": files,
                    "workflowManifest": manifest,
                }))?,
            )?;
            fs::rename(&temporary, &destination)?;
            Ok(())
        })();
        if result.is_err() {
            // Only our newly created paths; never recursive removal or pre-existing user files.
            for path in created {
                let _ = fs::remove_file(path);
            }
            let _ = fs::remove_dir(&temporary);
        }
        result?;
        Ok(ProductSceneExport {
            directory: destination.to_string_lossy().into_owned(),
            count: paths.len(),
        })
    }
}

fn prepare_logo_pixels(source: RgbaImage) -> BackendResult<RgbaImage> {
    if source.width() < 8 || source.height() < 8 || !source.pixels().any(|p| p[3] == 0) {
        return Err(invalid("Logo 需要清晰的透明 PNG，不能是白底或机身截图。"));
    }
    let (mut left, mut top, mut right, mut bottom) = (source.width(), source.height(), 0, 0);
    let mut visible = 0;
    for (x, y, pixel) in source.enumerate_pixels() {
        if pixel[3] > 0 {
            left = left.min(x);
            top = top.min(y);
            right = right.max(x);
            bottom = bottom.max(y);
        }
        if pixel[3] > 8 {
            visible += 1;
        }
    }
    if visible < 16 || left >= right || top >= bottom {
        return Err(invalid("Logo 内容为空或过小，请提供清晰原版。"));
    }
    Ok(imageops::crop_imm(&source, left, top, right - left + 1, bottom - top + 1).to_image())
}

/// Solve the inverse homography in normalized coordinates. Refuse folds, reflections,
/// out-of-frame or near-degenerate quads instead of guessing where a brand belongs.
fn logo_homography(quad: &[LogoPoint]) -> BackendResult<[f64; 8]> {
    if quad.len() != 4
        || quad.iter().any(|p| {
            !p.x.is_finite()
                || !p.y.is_finite()
                || !(0.0..=1.0).contains(&p.x)
                || !(0.0..=1.0).contains(&p.y)
        })
    {
        return Err(invalid("Logo 定位需要画面内的四个有效角点。"));
    }
    let mut twice_area = 0.0;
    for index in 0..4 {
        let a = &quad[index];
        let b = &quad[(index + 1) % 4];
        let c = &quad[(index + 2) % 4];
        if (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 1e-8 {
            return Err(invalid("Logo 定位四边形交叉、翻转或过于倾斜，请重新检查。"));
        }
        twice_area += a.x * b.y - b.x * a.y;
    }
    if !(0.000002..=0.5).contains(&twice_area) {
        return Err(invalid("Logo 定位面积异常，已阻止贴回。"));
    }
    let corners = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
    let mut system = [[0.0; 9]; 8];
    for (index, (point, (u, v))) in quad.iter().zip(corners).enumerate() {
        let (x, y) = (point.x, point.y);
        system[index * 2] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
        system[index * 2 + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v];
    }
    for column in 0..8 {
        let pivot = (column..8)
            .max_by(|&a, &b| system[a][column].abs().total_cmp(&system[b][column].abs()))
            .unwrap();
        if system[pivot][column].abs() < 1e-10 {
            return Err(invalid("Logo 透视变换不稳定，请重新检查机位。"));
        }
        system.swap(column, pivot);
        let divisor = system[column][column];
        for value in &mut system[column][column..] {
            *value /= divisor;
        }
        let pivot_row = system[column];
        for (row_index, row) in system.iter_mut().enumerate() {
            if row_index == column {
                continue;
            }
            let factor = row[column];
            for cell in column..9 {
                row[cell] -= factor * pivot_row[cell];
            }
        }
    }
    let result = std::array::from_fn(|index| system[index][8]);
    if result.iter().any(|value| !value.is_finite()) {
        return Err(invalid("Logo 透视变换无效。"));
    }
    Ok(result)
}

fn project_logo(h: &[f64; 8], x: f64, y: f64) -> Option<(f64, f64)> {
    let denominator = h[6] * x + h[7] * y + 1.0;
    if !denominator.is_finite() || denominator.abs() < 1e-10 {
        return None;
    }
    let u = (h[0] * x + h[1] * y + h[2]) / denominator;
    let v = (h[3] * x + h[4] * y + h[5]) / denominator;
    if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&v) {
        return None;
    }
    Some((u, v))
}

fn logo_sample(logo: &RgbaImage, u: f64, v: f64) -> [f64; 4] {
    let x = u * f64::from(logo.width()) - 0.5;
    let y = v * f64::from(logo.height()) - 0.5;
    let (left, top) = (x.floor() as i64, y.floor() as i64);
    let (dx, dy) = (x - x.floor(), y - y.floor());
    let mut sample = [0.0; 4];
    for (ox, oy, weight) in [
        (0, 0, (1.0 - dx) * (1.0 - dy)),
        (1, 0, dx * (1.0 - dy)),
        (0, 1, (1.0 - dx) * dy),
        (1, 1, dx * dy),
    ] {
        let (sx, sy) = (left + ox, top + oy);
        if sx < 0 || sy < 0 || sx >= i64::from(logo.width()) || sy >= i64::from(logo.height()) {
            continue;
        }
        let pixel = logo.get_pixel(sx as u32, sy as u32);
        let alpha = f64::from(pixel[3]) / 255.0 * weight;
        for channel in 0..3 {
            sample[channel] += f64::from(pixel[channel]) / 255.0 * alpha;
        }
        sample[3] += alpha;
    }
    sample
}

fn warp_logo(scene: &mut RgbaImage, logo: &RgbaImage, quad: &[LogoPoint]) -> BackendResult<()> {
    let h = logo_homography(quad)?;
    let (width, height) = (f64::from(scene.width()), f64::from(scene.height()));
    for index in 0..4 {
        let a = &quad[index];
        let b = &quad[(index + 1) % 4];
        if ((a.x - b.x) * width).hypot((a.y - b.y) * height) < 2.0 {
            return Err(invalid("Logo 目标区域太小，无法可靠贴回。"));
        }
    }
    let left = (quad.iter().map(|p| p.x).fold(1.0, f64::min) * width).floor() as u32;
    let right =
        ((quad.iter().map(|p| p.x).fold(0.0, f64::max) * width).ceil() as u32).min(scene.width());
    let top = (quad.iter().map(|p| p.y).fold(1.0, f64::min) * height).floor() as u32;
    let bottom =
        ((quad.iter().map(|p| p.y).fold(0.0, f64::max) * height).ceil() as u32).min(scene.height());
    let mut changed = false;
    for y in top..bottom {
        for x in left..right {
            // Premultiplied bilinear filtering plus subpixel coverage preserves
            // transparent letters and edges; no white-background knockout.
            let mut foreground = [0.0; 4];
            for (ox, oy) in [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
                if let Some((u, v)) = project_logo(
                    &h,
                    (f64::from(x) + ox) / width,
                    (f64::from(y) + oy) / height,
                ) {
                    let sample = logo_sample(logo, u, v);
                    for c in 0..4 {
                        foreground[c] += sample[c] / 4.0;
                    }
                }
            }
            let alpha = foreground[3];
            if alpha <= 0.0 {
                continue;
            }
            let background = scene.get_pixel_mut(x, y);
            let base_alpha = f64::from(background[3]) / 255.0;
            let output_alpha = alpha + base_alpha * (1.0 - alpha);
            for c in 0..3 {
                background[c] = ((foreground[c]
                    + f64::from(background[c]) / 255.0 * base_alpha * (1.0 - alpha))
                    / output_alpha
                    * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
            background[3] = (output_alpha * 255.0).round().clamp(0.0, 255.0) as u8;
            changed = true;
        }
    }
    if !changed {
        return Err(invalid("Logo 未覆盖有效像素，请重新定位。"));
    }
    Ok(())
}

/// White-background removal is deliberately conservative, and always requires visual approval.
/// Flood fill only connected border white; internal white labels/highlights are retained.
fn prepare_cutout(mut source: RgbaImage) -> BackendResult<RgbaImage> {
    let (width, height) = source.dimensions();
    if width < 16 || height < 16 {
        return Err(invalid("产品图片太小，请提供清晰的产品原图。"));
    }
    if !source.pixels().any(|p| p[3] < 250) {
        let is_white = |p: &Rgba<u8>| {
            p[0].min(p[1]).min(p[2]) >= 238
                && p[0].max(p[1]).max(p[2]) - p[0].min(p[1]).min(p[2]) <= 12
        };
        let mut queue = VecDeque::new();
        let enqueue = |x: u32, y: u32, source: &mut RgbaImage, queue: &mut VecDeque<(u32, u32)>| {
            let pixel = source.get_pixel_mut(x, y);
            if pixel[3] != 0 && is_white(pixel) {
                *pixel = Rgba([0, 0, 0, 0]);
                queue.push_back((x, y));
            }
        };
        for x in 0..width {
            enqueue(x, 0, &mut source, &mut queue);
            enqueue(x, height - 1, &mut source, &mut queue);
        }
        for y in 0..height {
            enqueue(0, y, &mut source, &mut queue);
            enqueue(width - 1, y, &mut source, &mut queue);
        }
        if queue.is_empty() {
            return Err(invalid(
                "当前图片不是透明底或纯白底。请先提供透明 PNG，避免自动抠掉机身或接口。",
            ));
        }
        while let Some((x, y)) = queue.pop_front() {
            if x > 0 {
                enqueue(x - 1, y, &mut source, &mut queue);
            }
            if y > 0 {
                enqueue(x, y - 1, &mut source, &mut queue);
            }
            if x + 1 < width {
                enqueue(x + 1, y, &mut source, &mut queue);
            }
            if y + 1 < height {
                enqueue(x, y + 1, &mut source, &mut queue);
            }
        }
    }
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (width, height, 0, 0);
    for (x, y, pixel) in source.enumerate_pixels() {
        if pixel[3] > 8 {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }
    if min_x >= max_x || min_y >= max_y {
        return Err(invalid("没有识别到完整产品，请提供透明底或白底产品原图。"));
    }
    Ok(imageops::crop_imm(&source, min_x, min_y, max_x - min_x + 1, max_y - min_y + 1).to_image())
}

fn difference_hash(image: &DynamicImage) -> String {
    let small = image
        .resize_exact(9, 8, imageops::FilterType::Triangle)
        .into_luma8();
    let mut bits = 0_u64;
    for y in 0..8 {
        for x in 0..8 {
            bits = (bits << 1) | u64::from(small.get_pixel(x, y)[0] > small.get_pixel(x + 1, y)[0]);
        }
    }
    format!("{bits:016x}")
}

fn fit_generated_image(source: DynamicImage, width: u32, height: u32) -> (RgbaImage, bool) {
    let fitted = source
        .resize(width, height, imageops::FilterType::Lanczos3)
        .into_rgba8();
    let padded = fitted.width() != width || fitted.height() != height;
    if !padded {
        return (fitted, false);
    }
    // Preserve the complete generated frame. A blurred edge extension is only a
    // geometric fallback, reported to the reviewer rather than called native output.
    let background = source
        .resize_to_fill(width, height, imageops::FilterType::Lanczos3)
        .into_rgba8();
    let mut canvas = imageops::blur(&background, width as f32 / 32.0);
    let x = (width - fitted.width()) / 2;
    let y = (height - fitted.height()) / 2;
    imageops::overlay(&mut canvas, &fitted, i64::from(x), i64::from(y));
    (canvas, true)
}

fn resize_foreground(source: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    // Resample premultiplied colors, so transparent edges cannot introduce black/white fringes.
    let mut premultiplied = DynamicImage::ImageRgba8(source.clone()).into_rgba32f();
    for pixel in premultiplied.pixels_mut() {
        for c in 0..3 {
            pixel[c] *= pixel[3];
        }
    }
    let mut resized = imageops::resize(
        &premultiplied,
        width,
        height,
        imageops::FilterType::Lanczos3,
    );
    for pixel in resized.pixels_mut() {
        let alpha = pixel[3].clamp(0.0, 1.0);
        for c in 0..3 {
            pixel[c] = if alpha > 0.0001 {
                (pixel[c] / alpha).clamp(0.0, 1.0)
            } else {
                0.0
            };
        }
        pixel[3] = alpha;
    }
    DynamicImage::ImageRgba32F(resized).into_rgba8()
}

fn composite_image(
    background: DynamicImage,
    foreground: &RgbaImage,
    width: u32,
    height: u32,
    placement: &ProductPlacement,
    depth: f64,
) -> BackendResult<RgbaImage> {
    if !depth.is_finite()
        || !(0.0..=1.0).contains(&depth)
        || !placement.center_x.is_finite()
        || !(0.2..=0.8).contains(&placement.center_x)
        || !placement.baseline_y.is_finite()
        || !(0.35..=0.92).contains(&placement.baseline_y)
        || !placement.width_fraction.is_finite()
        || !(0.2..=0.8).contains(&placement.width_fraction)
    {
        return Err(invalid("产品构图或景深参数无效。"));
    }
    let product_width = (f64::from(width) * placement.width_fraction).round() as u32;
    let product_height = (f64::from(product_width) * f64::from(foreground.height())
        / f64::from(foreground.width()))
    .round() as u32;
    let x = (f64::from(width) * placement.center_x - f64::from(product_width) / 2.0).round() as i64;
    let baseline = (f64::from(height) * placement.baseline_y).round() as i64;
    let y = baseline - i64::from(product_height);
    if product_width == 0
        || product_height == 0
        || x < 0
        || y < 0
        || x + i64::from(product_width) > i64::from(width)
        || baseline > i64::from(height)
    {
        return Err(invalid(
            "当前视图无法完整放入构图，请缩小产品占比或更换视图。",
        ));
    }
    let mut canvas = background
        .resize_to_fill(width, height, imageops::FilterType::Lanczos3)
        .into_rgba8();
    if depth > 0.0 {
        let blurred = imageops::blur(&canvas, (depth * 3.0) as f32);
        for (px, py, pixel) in canvas.enumerate_pixels_mut() {
            // Conservative distance gradient: table/contact plane remains sharp.
            let weight = (1.0 - f64::from(py) / (f64::from(height) * 0.6)).clamp(0.0, 1.0) as f32;
            for c in 0..3 {
                pixel[c] = (f32::from(pixel[c]) * (1.0 - weight)
                    + f32::from(blurred.get_pixel(px, py)[c]) * weight)
                    .round() as u8;
            }
        }
    }
    let product = resize_foreground(foreground, product_width, product_height);
    // Follow the cutout's lower edges, rather than putting a detached ellipse under a
    // three-quarter-view box. This is contact shading, not an inferred 3D light solution.
    let padding = (product_width / 100).max(2);
    let mut shadow = RgbaImage::new(product_width + padding * 2, product_height + padding * 2);
    for (px, py, pixel) in product.enumerate_pixels() {
        shadow.put_pixel(
            px + padding,
            py + padding,
            Rgba([0, 0, 0, (f32::from(pixel[3]) * 0.28) as u8]),
        );
    }
    let shadow = imageops::blur(&shadow, (padding as f32 * 0.65).max(1.0));
    imageops::overlay(
        &mut canvas,
        &shadow,
        x - i64::from(padding),
        y - i64::from(padding) / 3,
    );
    imageops::overlay(&mut canvas, &product, x, y);
    Ok(canvas)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_logo_quad() -> Vec<LogoPoint> {
        vec![
            LogoPoint { x: 0.2, y: 0.2 },
            LogoPoint { x: 0.8, y: 0.3 },
            LogoPoint { x: 0.7, y: 0.6 },
            LogoPoint { x: 0.3, y: 0.6 },
        ]
    }

    #[test]
    fn logo_warp_preserves_white_ink_transparency_and_pixels_outside_target() {
        let mut logo = RgbaImage::from_pixel(40, 24, Rgba([255, 255, 255, 0]));
        for y in 3..21 {
            for x in 3..37 {
                logo.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        for y in 9..15 {
            for x in 15..25 {
                logo.put_pixel(x, y, Rgba([255, 0, 0, 0]));
            }
        }
        let logo = prepare_logo_pixels(logo).unwrap();
        assert_eq!(*logo.get_pixel(0, 0), Rgba([255, 255, 255, 255]));
        let color = Rgba([20, 30, 40, 255]);
        let mut scene = RgbaImage::from_pixel(200, 200, color);
        warp_logo(&mut scene, &logo, &test_logo_quad()).unwrap();
        assert_eq!(*scene.get_pixel(80, 70), Rgba([255, 255, 255, 255]));
        // The transparent hole retains the surface, not the hidden red RGB.
        assert_eq!(*scene.get_pixel(100, 90), color);
        for y in 0..200 {
            for x in 0..200 {
                if !(40..160).contains(&x) || !(40..120).contains(&y) {
                    assert_eq!(*scene.get_pixel(x, y), color);
                }
            }
        }
        assert!(
            prepare_logo_pixels(RgbaImage::from_pixel(24, 24, Rgba([255, 255, 255, 255]))).is_err()
        );
        assert!(prepare_logo_pixels(RgbaImage::from_pixel(24, 24, Rgba([0, 0, 0, 0]))).is_err());
    }

    #[test]
    fn logo_coordinates_reject_invalid_geometry_and_map_the_four_reference_corners() {
        let quad = test_logo_quad();
        let h = logo_homography(&quad).unwrap();
        for (p, (u, v)) in quad
            .iter()
            .zip([(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)])
        {
            let d = h[6] * p.x + h[7] * p.y + 1.0;
            assert!(((h[0] * p.x + h[1] * p.y + h[2]) / d - u).abs() < 1e-8);
            assert!(((h[3] * p.x + h[4] * p.y + h[5]) / d - v).abs() < 1e-8);
        }
        let mut invalid_quad = test_logo_quad();
        invalid_quad.swap(1, 2);
        assert!(logo_homography(&invalid_quad).is_err());
        invalid_quad = test_logo_quad();
        invalid_quad[0].x = -0.1;
        assert!(logo_homography(&invalid_quad).is_err());
        invalid_quad[0].x = f64::NAN;
        assert!(logo_homography(&invalid_quad).is_err());
        invalid_quad = test_logo_quad();
        invalid_quad[1] = invalid_quad[0].clone();
        assert!(logo_homography(&invalid_quad).is_err());
    }

    #[test]
    fn logo_service_saves_a_new_file_and_rejects_replaced_master() {
        let temp = tempfile::tempdir().unwrap();
        let service = ProductSceneImageService::new(temp.path().to_owned());
        let source_logo = temp.path().join("logo.png");
        let mut logo = RgbaImage::from_pixel(32, 16, Rgba([0, 0, 0, 0]));
        for y in 2..14 {
            for x in 2..30 {
                logo.put_pixel(x, y, Rgba([230, 235, 240, 255]));
            }
        }
        write_png(&source_logo, logo).unwrap();
        let prepared = service
            .prepare_logo(PrepareProductViewCommand {
                source_path: source_logo.to_string_lossy().into_owned(),
            })
            .unwrap();
        let source = service.directory("成图").unwrap().join("original.png");
        write_png(
            &source,
            RgbaImage::from_pixel(1152, 2048, Rgba([30, 35, 40, 255])),
        )
        .unwrap();
        let original_hash = hash_file(&source).unwrap();
        let command = ApplyProductSceneLogoCommand {
            source_path: source.to_string_lossy().into_owned(),
            logo_path: prepared.path.clone(),
            logo_hash: prepared.content_hash.clone(),
            output_id: "test-logo".into(),
            quad: test_logo_quad(),
        };
        let result = service.apply_logo(command.clone()).unwrap();
        assert_ne!(result.path, command.source_path);
        assert_eq!((result.width, result.height), (1152, 2048));
        assert_eq!(hash_file(&source).unwrap(), original_hash);
        assert_ne!(hash_file(Path::new(&result.path)).unwrap(), original_hash);
        assert_eq!(result.logo_hash, prepared.content_hash);
        fs::write(&prepared.path, b"changed").unwrap();
        assert!(service.apply_logo(command).is_err());
    }

    #[test]
    fn generated_image_retains_the_new_frame_and_all_corners_when_padding() {
        let mut pixels = RgbaImage::from_pixel(80, 40, Rgba([30, 40, 50, 255]));
        for (x, y, color) in [
            (0, 0, [220, 0, 0, 255]),
            (79, 0, [0, 220, 0, 255]),
            (0, 39, [0, 0, 220, 255]),
            (79, 39, [220, 220, 0, 255]),
        ] {
            pixels.put_pixel(x, y, Rgba(color));
        }
        let (fitted, padded) =
            fit_generated_image(DynamicImage::ImageRgba8(pixels.clone()), 80, 120);
        assert!(padded);
        assert_eq!(fitted.dimensions(), (80, 120));
        for y in 0..40 {
            for x in 0..80 {
                assert_eq!(fitted.get_pixel(x, y + 40), pixels.get_pixel(x, y));
            }
        }
        let (same_ratio, padded) =
            fit_generated_image(DynamicImage::ImageRgba8(pixels.clone()), 80, 40);
        assert!(!padded);
        assert_eq!(same_ratio, pixels);
        assert!(output_width("../escape", "3:4").is_err());
        assert!(output_width("valid", "1:1").is_err());
    }

    /// Opt-in local smoke with a real source; never calls an image provider.
    #[test]
    #[ignore = "set PRODUCT_SCENE_SMOKE_INPUT and PRODUCT_SCENE_SMOKE_OUTPUT to local paths"]
    fn real_product_local_smoke() {
        let input = std::env::var("PRODUCT_SCENE_SMOKE_INPUT").unwrap();
        let root = PathBuf::from(std::env::var("PRODUCT_SCENE_SMOKE_OUTPUT").unwrap());
        fs::create_dir_all(&root).unwrap();
        let service = ProductSceneImageService::new(root.clone());
        let prepared = service
            .prepare(PrepareProductViewCommand { source_path: input })
            .unwrap();
        // A plain procedural background solely for checking cutout edges, geometry and IPC output.
        let background = root.join(format!("smoke-background-{}.png", Uuid::new_v4()));
        let pixels = RgbaImage::from_fn(384, 512, |_, y| {
            if y < 230 {
                Rgba([173, 177, 182, 255])
            } else {
                Rgba([97, 80, 64, 255])
            }
        });
        write_png(&background, pixels).unwrap();
        let mut outputs = Vec::new();
        for ratio in ["3:4", "9:16"] {
            let result = service
                .compose(ComposeProductSceneCommand {
                    background_path: background.to_string_lossy().into_owned(),
                    product_path: prepared.path.clone(),
                    product_hash: prepared.content_hash.clone(),
                    output_id: "local-smoke".into(),
                    aspect_ratio: ratio.into(),
                    placement: ProductPlacement {
                        center_x: 0.5,
                        baseline_y: 0.8,
                        width_fraction: 0.6,
                    },
                    depth_strength: 0.2,
                })
                .unwrap();
            assert_eq!(
                image::image_dimensions(&result.path).unwrap(),
                (result.width, result.height)
            );
            assert_eq!(result.foreground_hash, prepared.content_hash);
            outputs.push(result);
        }
        let report = json!({ "sourceKind": "user-supplied-product", "backgroundKind": "procedural-test-only", "prepared": prepared, "outputs": outputs });
        fs::write(
            root.join("smoke-report.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        println!("{}", root.join("smoke-report.json").display());
    }

    #[test]
    fn white_cutout_preserves_enclosed_labels_and_dark_ports() {
        let mut source = RgbaImage::from_pixel(32, 24, Rgba([255, 255, 255, 255]));
        for y in 5..19 {
            for x in 6..26 {
                source.put_pixel(x, y, Rgba([35, 36, 37, 255]));
            }
        }
        source.put_pixel(12, 10, Rgba([255, 255, 255, 255]));
        source.put_pixel(13, 10, Rgba([0, 0, 0, 255]));
        let cutout = prepare_cutout(source).unwrap();
        assert_eq!(cutout.dimensions(), (20, 14));
        assert_eq!(*cutout.get_pixel(6, 5), Rgba([255, 255, 255, 255]));
        assert_eq!(*cutout.get_pixel(7, 5), Rgba([0, 0, 0, 255]));
        assert!(prepare_cutout(RgbaImage::from_pixel(32, 24, Rgba([25, 25, 25, 255]))).is_err());
    }

    #[test]
    fn composition_never_repaints_opaque_product_pixels() {
        let product = RgbaImage::from_pixel(40, 20, Rgba([58, 79, 119, 255]));
        let placement = ProductPlacement {
            center_x: 0.5,
            baseline_y: 0.75,
            width_fraction: 0.5,
        };
        let canvas = composite_image(
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(80, 100, Rgba([200, 210, 220, 255]))),
            &product,
            80,
            100,
            &placement,
            0.8,
        )
        .unwrap();
        for y in 55..75 {
            for x in 20..60 {
                assert_eq!(*canvas.get_pixel(x, y), Rgba([58, 79, 119, 255]));
            }
        }
        assert_eq!(canvas.dimensions(), (80, 100));
    }

    #[test]
    fn changed_master_is_rejected_and_export_does_not_overwrite_files() {
        let temp = tempfile::tempdir().unwrap();
        let service = ProductSceneImageService::new(temp.path().to_owned());
        let source = temp.path().join("source.png");
        let mut pixels = RgbaImage::from_pixel(32, 24, Rgba([0, 0, 0, 0]));
        for y in 4..20 {
            for x in 4..28 {
                pixels.put_pixel(x, y, Rgba([40, 45, 50, 255]));
            }
        }
        write_png(&source, pixels).unwrap();
        let prepared = service
            .prepare(PrepareProductViewCommand {
                source_path: source.to_string_lossy().into_owned(),
            })
            .unwrap();
        service
            .validate_view(&prepared.path, &prepared.content_hash)
            .unwrap();
        fs::write(&prepared.path, b"replaced").unwrap();
        assert!(
            service
                .validate_view(&prepared.path, &prepared.content_hash)
                .is_err()
        );
        let output = service.directory("成图").unwrap().join("test.png");
        write_png(
            &output,
            RgbaImage::from_pixel(16, 16, Rgba([30, 50, 70, 255])),
        )
        .unwrap();
        let export = || {
            service
                .export(ExportProductScenesCommand {
                    paths: vec![output.to_string_lossy().into_owned()],
                    manifest: "{}".into(),
                    directory: temp.path().to_string_lossy().into_owned(),
                })
                .unwrap()
        };
        let first = export();
        let second = export();
        assert_ne!(first.directory, second.directory);
        assert_eq!(
            fs::read(Path::new(&first.directory).join("001.png")).unwrap(),
            fs::read(output).unwrap()
        );
        assert!(Path::new(&first.directory).join("manifest.json").exists());
    }
}
