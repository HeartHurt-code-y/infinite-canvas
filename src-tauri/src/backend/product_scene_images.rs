//! Local product-scene media: approved cutouts for composite mode, and complete
//! reference-conditioned images for AI multi-angle mode. The latter does not lock pixels.

use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{BufRead, BufWriter, Cursor, Read as _, Seek, Write as _},
    path::{Path, PathBuf},
};

use image::{
    DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits, Rgba, RgbaImage, imageops,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::error::{BackendError, BackendResult};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareProductViewCommand {
    pub source_path: String,
    #[serde(default)]
    pub preserve_photo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedProductView {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub content_hash: String,
    pub photo_preserved: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductViewIdentity {
    pub path: String,
    pub content_hash: String,
    #[serde(default)]
    pub region: Option<ProductProtectionRegion>,
    #[serde(default)]
    pub feather: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ValidateProductViewsCommand {
    pub views: Vec<ProductViewIdentity>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductProtectionRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProtectedProductSceneCommand {
    pub background_path: String,
    pub product_path: String,
    pub product_hash: String,
    pub output_id: String,
    pub aspect_ratio: String,
    pub placement: ProductPlacement,
    pub region: ProductProtectionRegion,
    pub feather: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductSceneProtectionReceipt {
    pub region: ProductProtectionRegion,
    pub feather: f64,
    pub source_width: u32,
    pub source_height: u32,
    pub core_pixel_count: u64,
    pub output_hash: String,
    #[serde(default)]
    pub warnings: Vec<String>,
    /// The saved PNG's protected core equals the resized master. This does not
    /// certify physical dimensions, unseen structure, or refraction in a new scene.
    pub verified: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductSceneProtectedComposite {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub background_hash: String,
    pub foreground_hash: String,
    pub protection: ProductSceneProtectionReceipt,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtectedSceneReceiptFile {
    schema_version: String,
    original_path: String,
    placement: ProductPlacement,
    composite: ProductSceneProtectedComposite,
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
        "1:1" => Ok(2048),
        "3:4" => Ok(1536),
        "9:16" => Ok(1152),
        _ => Err(invalid("产品场景图仅支持 1:1、3:4 或 9:16。")),
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
    decode_oriented(
        ImageReader::open(path)?.with_guessed_format()?,
        Limits::default(),
    )
}

fn decode_oriented<R: BufRead + Seek>(
    mut reader: ImageReader<R>,
    mut limits: Limits,
) -> BackendResult<DynamicImage> {
    // `into_decoder` does not reserve the output buffer like `ImageReader::decode`.
    // Keep that reservation as well as the decoder's own format-specific limits.
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder().map_err(image_error)?;
    limits.reserve(decoder.total_bytes()).map_err(image_error)?;
    decoder.set_limits(limits).map_err(image_error)?;
    let orientation = decoder.orientation().map_err(image_error)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(image_error)?;
    // Normalize the working pixels before measuring, cropping, or choosing a
    // protected region. Source bytes remain unchanged; PNG masters need no EXIF.
    image.apply_orientation(orientation);
    Ok(image)
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
        let photo = decode(&source)?.into_rgba8();
        let cutout = if command.preserve_photo {
            if !photo.pixels().any(|pixel| pixel[3] > 0) {
                return Err(invalid("原片完全透明，请导入真实商品或佩戴照片。"));
            }
            photo
        } else {
            prepare_cutout(photo)?
        };
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
            photo_preserved: command.preserve_photo,
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
        let logo = prepare_logo_pixels(decode_oriented(reader, Limits::default())?.into_rgba8())?;
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
            photo_preserved: false,
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
        if ![2048, 1536, 1152].contains(&width) || height != 2048 {
            return Err(invalid("请先完成 1:1、3:4 或 9:16 场景图尺寸处理。"));
        }
        let bytes = self.verified_logo_bytes(&ProductViewIdentity {
            path: command.logo_path,
            content_hash: command.logo_hash.clone(),
            region: None,
            feather: None,
        })?;
        let logo = decode_oriented(
            ImageReader::new(Cursor::new(bytes)).with_guessed_format()?,
            Limits::default(),
        )?
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

    fn current_protected_photo(
        &self,
        path: &str,
        expected_hash: &str,
    ) -> BackendResult<(PathBuf, Vec<u8>, String, Vec<String>)> {
        let path = source_path(path)?;
        if !path.starts_with(self.directory("产品母版")?) {
            return Err(invalid("请先导入产品原片，再进行本地保护合成。"));
        }
        let bytes = fs::read(&path)?;
        let current_hash = hex::encode(Sha256::digest(&bytes));
        let warnings = if current_hash != expected_hash {
            vec!["产品母版内容已变化，已使用当前文件；原确认与旧审核记录仅作历史参考。".into()]
        } else {
            Vec::new()
        };
        Ok((path, bytes, current_hash, warnings))
    }

    pub fn validate_views(&self, command: ValidateProductViewsCommand) -> BackendResult<bool> {
        if command.views.is_empty() {
            return Err(invalid("请先导入并确认产品视图。"));
        }
        let mut protected_validated = false;
        for view in command.views {
            if let Some(region) = &view.region {
                let feather = view.feather.unwrap_or(0.0);
                if !feather.is_finite() || !(0.0..=0.1).contains(&feather) {
                    return Err(invalid("保护范围外的羽化必须在 0～0.1 之间。"));
                }
                let (_, bytes, _, warnings) =
                    self.current_protected_photo(&view.path, &view.content_hash)?;
                for warning in warnings {
                    tauri_plugin_log::log::warn!("[原片保护检查] {warning}");
                }
                let photo = decode_oriented(
                    ImageReader::new(Cursor::new(bytes)).with_guessed_format()?,
                    Limits::default(),
                )?
                .into_rgba8();
                require_opaque_core(
                    &photo,
                    protection_rect(region, photo.width(), photo.height())?,
                )?;
                // Lanczos support reaches beyond the selected region. Without
                // placement at preflight, require a fully opaque photographed
                // master so no future downscale can introduce transparent core pixels.
                if photo.pixels().any(|pixel| pixel[3] != 255) {
                    return Err(invalid(
                        "原片保护需要不透明实拍母版，请导入 JPG 或不透明 PNG，避免透明边缘影响缩放后的核心。",
                    ));
                }
                protected_validated = true;
            } else if view.feather.is_some() {
                return Err(invalid("请同时确认原片保护范围，不能单独设置羽化。"));
            } else {
                self.validate_view(&view.path, &view.content_hash)?;
            }
        }
        Ok(protected_validated)
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
        let foreground = decode_oriented(
            ImageReader::new(Cursor::new(product_bytes)).with_guessed_format()?,
            Limits::default(),
        )?
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

    /// Preserve a photographed product (and, if selected, its wrist/occlusion)
    /// using one uniform placement. The model only supplies the outer scene.
    pub fn compose_protected(
        &self,
        command: ComposeProtectedProductSceneCommand,
    ) -> BackendResult<ProductSceneProtectedComposite> {
        let width = output_width(&command.output_id, &command.aspect_ratio)?;
        let (product, product_bytes, product_hash, warnings) =
            self.current_protected_photo(&command.product_path, &command.product_hash)?;
        // Decode the same current byte snapshot used for the returned identity.
        let foreground = decode_oriented(
            ImageReader::new(Cursor::new(product_bytes)).with_guessed_format()?,
            Limits::default(),
        )?
        .into_rgba8();
        let background = decode(&source_path(&command.background_path)?)?;
        let background_hash = difference_hash(&background);
        let composition = composite_protected_image(
            background,
            &foreground,
            width,
            2048,
            &command.placement,
            &command.region,
            command.feather,
        )?;
        let path = self.directory("成图")?.join(format!(
            "{}-protected-{}.png",
            command.output_id,
            Uuid::new_v4()
        ));
        write_png(&path, composition.image)?;
        // Check the persisted lossless pixels, not just the in-memory overlay.
        let saved = decode(&path)?.into_rgba8();
        let (saved_width, saved_height) = saved.dimensions();
        let verified = (saved_width, saved_height) == (width, 2048)
            && core_hash(&saved, composition.output_core) == composition.expected_core_hash;
        let mut protection = composition.receipt;
        protection.verified = verified;
        protection.output_hash = hash_file(&path)?;
        protection.warnings = warnings;
        if !verified {
            protection.warnings.push(
                "保存成图的保护核心与缩放原片存在差异；已保留当前可读取成图，核验记录未通过。"
                    .into(),
            );
        }
        let result = ProductSceneProtectedComposite {
            path: path.to_string_lossy().into_owned(),
            width: saved_width,
            height: saved_height,
            background_hash,
            foreground_hash: product_hash,
            protection,
        };
        let receipt_path = path.with_extension("protection.json");
        let receipt = serde_json::to_vec_pretty(&ProtectedSceneReceiptFile {
            schema_version: "product-scene-protection.v1".into(),
            original_path: product.to_string_lossy().into_owned(),
            placement: command.placement,
            composite: result.clone(),
        })?;
        let mut receipt_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(receipt_path)?;
        receipt_file.write_all(&receipt)?;
        receipt_file.sync_all()?;
        Ok(result)
    }

    fn export_has_protection(path: &Path, manifest: &Value) -> bool {
        manifest.get("generationMode").and_then(Value::as_str) == Some("protected")
            || path.with_extension("protection.json").exists()
            || path
                .file_stem()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains("-protected-"))
    }

    /// Delivery preserves readable current files. Approval and composition
    /// evidence are advisory historical records, never export prerequisites.
    fn protection_diagnostics_for_export(
        &self,
        path: &Path,
        manifest: &Value,
        current_output_hash: &str,
    ) -> Option<Value> {
        if !Self::export_has_protection(path, manifest) {
            return None;
        }
        let mut warnings: Vec<String> = Vec::new();
        let historical = match fs::read(path.with_extension("protection.json")) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => Some(value),
                Err(_) => {
                    warnings.push(
                        "原片保护回执损坏；导出当前可读取图片，旧回执无法作为当前核验证据。".into(),
                    );
                    None
                }
            },
            Err(_) => {
                warnings.push("原片保护回执缺失或无法读取；导出当前图片并记录实际摘要。".into());
                None
            }
        };
        let mut current_match = false;
        if let Some(history) = &historical {
            match serde_json::from_value::<ProtectedSceneReceiptFile>(history.clone()) {
                Ok(receipt) => {
                    let native = &receipt.composite;
                    current_match = receipt.schema_version == "product-scene-protection.v1"
                        && native.protection.verified
                        && native.protection.core_pixel_count > 0
                        && native.protection.output_hash == current_output_hash;
                    warnings.extend(native.protection.warnings.clone());
                    if native.protection.output_hash != current_output_hash {
                        warnings.push(
                            "成图内容已变化；保护回执对应历史成图，当前导出使用实际图片摘要。"
                                .into(),
                        );
                    }
                    if source_path(&native.path).ok().as_deref() != Some(path) {
                        warnings.push("保护回执引用旧成图路径，仅保留历史证据。".into());
                        current_match = false;
                    }
                    match source_path(&receipt.original_path).and_then(|source| hash_file(&source))
                    {
                        Ok(hash) if hash == native.foreground_hash => {}
                        Ok(_) => {
                            warnings.push(
                                "源片内容已变化；已有成图仍可导出，回执中的源片摘要属于历史记录。"
                                    .into(),
                            );
                            current_match = false;
                        }
                        Err(_) => {
                            warnings.push(
                                "历史源片缺失或无法读取；已有成图仍可导出，无法复核当前源片。"
                                    .into(),
                            );
                            current_match = false;
                        }
                    }
                    if !current_match && warnings.is_empty() {
                        warnings
                            .push("保护回执未形成有效的当前内容对应记录，仅保留历史证据。".into());
                    }
                }
                Err(_) => warnings.push("保护回执格式属于旧版本或不完整，仅保留历史资料。".into()),
            }
        }
        let row = manifest
            .get("rows")
            .and_then(Value::as_array)
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row.get("outputPath")
                        .and_then(Value::as_str)
                        .and_then(|value| source_path(value).ok())
                        .as_deref()
                        == Some(path)
                })
            });
        if let Some(row) = row {
            if row.get("status").and_then(Value::as_str) != Some("accepted") {
                warnings.push("此图尚未标记选用，按用户选择导出。".into());
            }
            let review = row.get("jewelryReview");
            let review_path = review
                .and_then(|r| r.get("outputPath"))
                .and_then(Value::as_str)
                .and_then(|value| source_path(value).ok());
            if review_path.as_deref() != Some(path) {
                warnings.push("人工审核缺失或引用旧成图，审核记录仅作历史参考。".into());
            }
            if [
                "connections",
                "shape",
                "details",
                "texture",
                "scale",
                "style",
            ]
            .iter()
            .any(|key| {
                review
                    .and_then(|r| r.get("checks"))
                    .and_then(|checks| checks.get(key))
                    .and_then(Value::as_str)
                    != Some("pass")
            }) {
                warnings.push("六项人工核对尚未全部通过，按用户选择导出并保留原记录。".into());
            }
            if row
                .get("protection")
                .and_then(|proof| proof.get("outputHash"))
                .and_then(Value::as_str)
                != Some(current_output_hash)
            {
                warnings
                    .push("工作流中的成图摘要缺失或已旧，导出记录采用当前文件实际摘要。".into());
            }
            if let Some(record) = &historical {
                let old_proof = &record["composite"]["protection"];
                let row_proof = &row["protection"];
                if row_proof["region"] != old_proof["region"]
                    || row_proof["feather"] != old_proof["feather"]
                {
                    warnings.push("工作流保护范围与历史回执不同，两份记录保留供人工查看。".into());
                }
            }
        } else {
            warnings.push("工作流未提供此图对应的审核记录，按用户选择导出。".into());
        }
        Some(json!({
            "historicalEvidence": historical,
            "verificationState": if current_match { "current" } else if historical.is_some() { "historical" } else { "unavailable" },
            "verificationScope": "composition record and current file hashes only; human review remains advisory",
            "currentOutputHash": current_output_hash,
            "warnings": warnings,
        }))
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
            return Err(invalid("请选择 1～500 张产品场景成图。"));
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
        // A readable image is required for protected delivery. Historical
        // approvals and hashes only produce diagnostics in the manifest.
        for path in &paths {
            if Self::export_has_protection(path, &manifest) {
                decode(path)?;
            }
        }
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
                let copied_hash = hash_file(&target)?;
                if Self::export_has_protection(source, &manifest) {
                    decode(&target)?;
                }
                let protection =
                    self.protection_diagnostics_for_export(source, &manifest, &copied_hash);
                let warnings = protection
                    .as_ref()
                    .and_then(|proof| proof.get("warnings"))
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                files.push(json!({
                    "file": filename,
                    "sourcePath": source,
                    "sha256": copied_hash,
                    "warnings": warnings,
                    "protection": protection,
                }));
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

#[derive(Debug, Clone, Copy)]
struct PixelRect {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
}

impl PixelRect {
    fn count(self) -> u64 {
        u64::from(self.right - self.left) * u64::from(self.bottom - self.top)
    }

    fn translated(self, x: u32, y: u32) -> Self {
        Self {
            left: self.left + x,
            top: self.top + y,
            right: self.right + x,
            bottom: self.bottom + y,
        }
    }
}

fn protection_rect(
    region: &ProductProtectionRegion,
    width: u32,
    height: u32,
) -> BackendResult<PixelRect> {
    if width == 0
        || height == 0
        || ![region.x, region.y, region.width, region.height]
            .iter()
            .all(|value| value.is_finite())
        || region.x < 0.0
        || region.y < 0.0
        || region.width <= 0.0
        || region.height <= 0.0
        || region.x + region.width > 1.0
        || region.y + region.height > 1.0
    {
        return Err(invalid("保护范围必须是原片内有效的矩形，请重新确认。"));
    }
    // Outward rounding gives a deterministic, nonempty core at either resolution.
    let rect = PixelRect {
        left: (region.x * f64::from(width)).floor() as u32,
        top: (region.y * f64::from(height)).floor() as u32,
        right: ((region.x + region.width) * f64::from(width)).ceil() as u32,
        bottom: ((region.y + region.height) * f64::from(height)).ceil() as u32,
    };
    if rect.right > width || rect.bottom > height || rect.count() == 0 {
        return Err(invalid("保护范围没有可验证的核心像素。"));
    }
    Ok(rect)
}

fn require_opaque_core(source: &RgbaImage, core: PixelRect) -> BackendResult<()> {
    for y in core.top..core.bottom {
        for x in core.left..core.right {
            if source.get_pixel(x, y)[3] != 255 {
                return Err(invalid(
                    "保护核心含透明像素，无法保持原片完整内容。请使用不透明实拍母版或调整保护范围。",
                ));
            }
        }
    }
    Ok(())
}

fn core_hash(source: &RgbaImage, core: PixelRect) -> String {
    let mut hash = Sha256::new();
    for y in core.top..core.bottom {
        for x in core.left..core.right {
            hash.update(source.get_pixel(x, y).0);
        }
    }
    hex::encode(hash.finalize())
}

struct ProtectedComposition {
    image: RgbaImage,
    receipt: ProductSceneProtectionReceipt,
    output_core: PixelRect,
    expected_core_hash: String,
}

fn protected_photo_geometry(
    source: &RgbaImage,
    width: u32,
    height: u32,
    placement: &ProductPlacement,
) -> BackendResult<(u32, u32, u32, u32)> {
    if source.width() == 0
        || source.height() == 0
        || width == 0
        || height == 0
        || !placement.center_x.is_finite()
        || !(0.2..=0.8).contains(&placement.center_x)
        || !placement.baseline_y.is_finite()
        || !(0.35..=0.92).contains(&placement.baseline_y)
        || !placement.width_fraction.is_finite()
        || !(0.2..=0.8).contains(&placement.width_fraction)
    {
        return Err(invalid("原片保护构图参数无效。"));
    }
    let center = f64::from(width) * placement.center_x;
    let baseline = (f64::from(height) * placement.baseline_y).round() as u32;
    let ratio = f64::from(source.height()) / f64::from(source.width());
    let requested_width = (f64::from(width) * placement.width_fraction).round();
    let mut photo_width = requested_width
        .min(center * 2.0)
        .min((f64::from(width) - center) * 2.0)
        .min(f64::from(baseline) / ratio)
        .floor() as u32;
    // Preserve the chosen center and baseline. Shrink the whole photo together,
    // including wrist and occlusion, until all four photo edges fit the output.
    while photo_width > 0 {
        let photo_height = (f64::from(photo_width) * ratio).round() as u32;
        let x = (center - f64::from(photo_width) / 2.0).round() as i64;
        if photo_height > 0
            && photo_height <= baseline
            && x >= 0
            && x + i64::from(photo_width) <= i64::from(width)
            && baseline <= height
        {
            return Ok((photo_width, photo_height, x as u32, baseline - photo_height));
        }
        photo_width -= 1;
    }
    Err(invalid("原片无法完整放入当前画幅，请调整构图。"))
}

fn composite_protected_image(
    background: DynamicImage,
    source: &RgbaImage,
    width: u32,
    height: u32,
    placement: &ProductPlacement,
    region: &ProductProtectionRegion,
    feather: f64,
) -> BackendResult<ProtectedComposition> {
    if !feather.is_finite() || !(0.0..=0.1).contains(&feather) {
        return Err(invalid("保护范围外的羽化必须在 0～0.1 之间。"));
    }
    let source_core = protection_rect(region, source.width(), source.height())?;
    require_opaque_core(source, source_core)?;
    let (photo_width, photo_height, x, y) =
        protected_photo_geometry(source, width, height, placement)?;
    let photo = resize_foreground(source, photo_width, photo_height);
    let core = protection_rect(region, photo_width, photo_height)?;
    require_opaque_core(&photo, core)?;
    let expected_core_hash = core_hash(&photo, core);
    let mut canvas = background
        .resize_to_fill(width, height, imageops::FilterType::Lanczos3)
        .into_rgba8();
    let mut masked = photo.clone();
    let feather_pixels = feather * f64::from(photo_width.min(photo_height));
    for (px, py, pixel) in masked.enumerate_pixels_mut() {
        if (core.left..core.right).contains(&px) && (core.top..core.bottom).contains(&py) {
            continue;
        }
        let dx = if px < core.left {
            core.left - px
        } else {
            px.saturating_sub(core.right - 1)
        };
        let dy = if py < core.top {
            core.top - py
        } else {
            py.saturating_sub(core.bottom - 1)
        };
        let distance = f64::from(dx.max(dy));
        let weight = if feather_pixels > 0.0 {
            (1.0 - distance / feather_pixels).clamp(0.0, 1.0)
        } else {
            0.0
        };
        pixel[3] = (f64::from(pixel[3]) * weight).round() as u8;
    }
    imageops::overlay(&mut canvas, &masked, i64::from(x), i64::from(y));
    // Copy opaque core bytes exactly; blending and feather never enter the core.
    for py in core.top..core.bottom {
        for px in core.left..core.right {
            canvas.put_pixel(px + x, py + y, *photo.get_pixel(px, py));
        }
    }
    let output_core = core.translated(x, y);
    let verified = core_hash(&canvas, output_core) == expected_core_hash;
    if !verified {
        return Err(invalid("原片保护核心像素合成校验失败。"));
    }
    Ok(ProtectedComposition {
        image: canvas,
        receipt: ProductSceneProtectionReceipt {
            region: region.clone(),
            feather,
            source_width: source.width(),
            source_height: source.height(),
            core_pixel_count: core.count(),
            output_hash: String::new(),
            warnings: Vec::new(),
            verified,
        },
        output_core,
        expected_core_hash,
    })
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

    fn jpeg_with_exif_orientation(orientation: u16) -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_fn(32, 16, |x, y| {
            image::Rgb([(x * 7) as u8, (y * 13) as u8, ((x + y) * 5) as u8])
        }));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
            .encode_image(&image)
            .unwrap();
        // A real APP1 Exif segment containing a little-endian TIFF IFD with
        // one SHORT Orientation tag. Insert after SOI; leave JPEG pixels intact.
        let mut exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
        exif.extend_from_slice(&orientation.to_le_bytes());
        exif.extend_from_slice(&[0; 6]);
        let mut tagged = jpeg[..2].to_vec();
        tagged.extend_from_slice(&[0xff, 0xe1]);
        tagged.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        tagged.extend_from_slice(&exif);
        tagged.extend_from_slice(&jpeg[2..]);
        tagged
    }

    #[test]
    fn preserved_jpeg_photo_applies_exif_rotation_without_modifying_source() {
        let temp = tempfile::tempdir().unwrap();
        let service = ProductSceneImageService::new(temp.path().to_owned());
        for orientation in [6, 8] {
            let source = temp.path().join(format!("orientation-{orientation}.jpg"));
            let bytes = jpeg_with_exif_orientation(orientation);
            fs::write(&source, &bytes).unwrap();
            let source_hash = hash_file(&source).unwrap();
            // Decode unrotated JPEG pixels as the reference so JPEG compression
            // does not weaken the exact pixel mapping assertion.
            let raw = ImageReader::open(&source)
                .unwrap()
                .decode()
                .unwrap()
                .into_rgba8();
            assert_eq!(raw.dimensions(), (32, 16));
            let prepared = service
                .prepare(PrepareProductViewCommand {
                    source_path: source.to_string_lossy().into_owned(),
                    preserve_photo: true,
                })
                .unwrap();
            assert!(prepared.photo_preserved);
            assert_eq!((prepared.width, prepared.height), (16, 32));
            let master = decode(Path::new(&prepared.path)).unwrap().into_rgba8();
            for (x, y, pixel) in master.enumerate_pixels() {
                let (source_x, source_y) = if orientation == 6 {
                    (y, 15 - x)
                } else {
                    (31 - y, x)
                };
                assert_eq!(pixel, raw.get_pixel(source_x, source_y));
            }
            assert_ne!(prepared.path, source.to_string_lossy());
            assert_eq!(fs::read(&source).unwrap(), bytes);
            assert_eq!(hash_file(&source).unwrap(), source_hash);
            assert_eq!(
                hash_file(Path::new(&prepared.path)).unwrap(),
                prepared.content_hash
            );
        }
    }

    #[test]
    fn oriented_decode_retains_output_allocation_guard() {
        let bytes = jpeg_with_exif_orientation(6);
        let reader = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .unwrap();
        let mut limits = Limits::default();
        limits.max_alloc = Some(1);
        assert!(decode_oriented(reader, limits).is_err());
    }

    /// Opt-in real-photo check; source files are read only and masters are temporary.
    #[test]
    #[ignore = "set PRODUCT_SCENE_PHOTO_SMOKE_INPUT to a local JPEG directory"]
    fn real_product_photo_orientation_smoke() {
        let root = PathBuf::from(std::env::var("PRODUCT_SCENE_PHOTO_SMOKE_INPUT").unwrap());
        let temp = tempfile::tempdir().unwrap();
        let service = ProductSceneImageService::new(temp.path().to_owned());
        let mut paths: Vec<_> = fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension().is_some_and(|ext| {
                    ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg")
                })
            })
            .collect();
        paths.sort();
        assert!(!paths.is_empty());
        for source in paths {
            let source_hash = hash_file(&source).unwrap();
            let raw = ImageReader::open(&source).unwrap().decode().unwrap();
            let mut decoder = ImageReader::open(&source).unwrap().into_decoder().unwrap();
            let orientation = decoder.orientation().unwrap();
            let mut expected = raw.clone();
            expected.apply_orientation(orientation);
            let prepared = service
                .prepare(PrepareProductViewCommand {
                    source_path: source.to_string_lossy().into_owned(),
                    preserve_photo: true,
                })
                .unwrap();
            assert_eq!(
                (prepared.width, prepared.height),
                (expected.width(), expected.height())
            );
            assert_eq!(
                decode(Path::new(&prepared.path)).unwrap().into_rgba8(),
                expected.into_rgba8()
            );
            assert_eq!(hash_file(&source).unwrap(), source_hash);
            println!(
                "{}: {}x{} -> {}x{}, source unchanged",
                source.display(),
                raw.width(),
                raw.height(),
                prepared.width,
                prepared.height
            );
        }
    }

    fn protected_test_region() -> ProductProtectionRegion {
        ProductProtectionRegion {
            x: 0.1,
            y: 0.1,
            width: 0.8,
            height: 0.8,
        }
    }

    #[test]
    fn preserved_photo_keeps_white_crystal_thin_chain_and_full_dimensions() {
        let temp = tempfile::tempdir().unwrap();
        let service = ProductSceneImageService::new(temp.path().to_owned());
        let source = temp.path().join("crystal-photo.png");
        let mut photo = RgbaImage::from_pixel(40, 32, Rgba([255, 255, 255, 255]));
        // Pale crystal is connected to the white background; the fine chain is
        // only one pixel wide. Neither should enter the old white flood/crop path.
        for y in 0..24 {
            for x in 10..30 {
                photo.put_pixel(x, y, Rgba([248, 250, 252, 255]));
            }
        }
        for x in 6..34 {
            photo.put_pixel(x, 25, Rgba([100, 105, 110, 255]));
        }
        photo.put_pixel(20, 13, Rgba([235, 237, 240, 255]));
        write_png(&source, photo.clone()).unwrap();
        let command: PrepareProductViewCommand = serde_json::from_value(json!({
            "sourcePath": source.to_string_lossy(),
        }))
        .unwrap();
        assert!(!command.preserve_photo);
        let prepared = service
            .prepare(PrepareProductViewCommand {
                preserve_photo: true,
                ..command.clone()
            })
            .unwrap();
        assert_eq!((prepared.width, prepared.height), (40, 32));
        assert_eq!(
            decode(Path::new(&prepared.path)).unwrap().into_rgba8(),
            photo
        );
        assert_eq!(
            hash_file(Path::new(&prepared.path)).unwrap(),
            prepared.content_hash
        );
        assert_ne!(prepared.path, command.source_path);
        let legacy = service.prepare(command).unwrap();
        assert_ne!((legacy.width, legacy.height), (40, 32));
    }

    #[test]
    fn protected_core_is_identical_on_different_backgrounds_and_feather_stays_outside() {
        let photo = RgbaImage::from_fn(40, 20, |x, y| {
            Rgba([(x * 4) as u8, (y * 9) as u8, 120, 255])
        });
        let placement = ProductPlacement {
            center_x: 0.5,
            baseline_y: 0.75,
            width_fraction: 0.5,
        };
        let compose = |color| {
            composite_protected_image(
                DynamicImage::ImageRgba8(RgbaImage::from_pixel(80, 100, color)),
                &photo,
                80,
                100,
                &placement,
                &protected_test_region(),
                0.1,
            )
            .unwrap()
        };
        let first = compose(Rgba([230, 230, 230, 255]));
        let second = compose(Rgba([10, 20, 30, 255]));
        assert!(first.receipt.verified && second.receipt.verified);
        assert_eq!(first.receipt.core_pixel_count, 32 * 16);
        for y in 2..18 {
            for x in 4..36 {
                assert_eq!(first.image.get_pixel(x + 20, y + 55), photo.get_pixel(x, y));
                assert_eq!(
                    second.image.get_pixel(x + 20, y + 55),
                    photo.get_pixel(x, y)
                );
            }
        }
        assert_eq!(*first.image.get_pixel(15, 65), Rgba([230, 230, 230, 255]));
        assert_ne!(
            first.image.get_pixel(23, 65),
            second.image.get_pixel(23, 65)
        );
        assert_eq!(first.expected_core_hash, second.expected_core_hash);
    }

    #[test]
    fn protected_wearing_photo_uses_one_uniform_scale_and_keeps_all_edges_in_canvas() {
        let photo = RgbaImage::from_fn(60, 120, |x, y| {
            // Wrist and bracelet use the same source grid; they cannot be scaled separately.
            Rgba([
                (x * 3) as u8,
                (y * 2) as u8,
                if y > 50 { 220 } else { 80 },
                255,
            ])
        });
        let placement = ProductPlacement {
            center_x: 0.8,
            baseline_y: 0.35,
            width_fraction: 0.8,
        };
        let (pw, ph, x, y) = protected_photo_geometry(&photo, 120, 200, &placement).unwrap();
        assert_eq!((pw, ph), (35, 70));
        assert_eq!(ph, pw * 2);
        assert!(x + pw <= 120 && y + ph <= 200);
        let result = composite_protected_image(
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(120, 200, Rgba([0, 0, 0, 255]))),
            &photo,
            120,
            200,
            &placement,
            &ProductProtectionRegion {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            0.0,
        )
        .unwrap();
        let expected = resize_foreground(&photo, pw, ph);
        for py in 0..ph {
            for px in 0..pw {
                assert_eq!(
                    result.image.get_pixel(px + x, py + y),
                    expected.get_pixel(px, py)
                );
            }
        }
        assert_eq!(result.receipt.core_pixel_count, u64::from(pw * ph));
    }

    #[test]
    fn protected_composition_rejects_invalid_region_feather_and_transparent_core() {
        let photo = RgbaImage::from_pixel(40, 20, Rgba([235, 235, 240, 255]));
        let placement = ProductPlacement {
            center_x: 0.5,
            baseline_y: 0.75,
            width_fraction: 0.5,
        };
        let compose = |source: &RgbaImage, region: &ProductProtectionRegion, feather| {
            composite_protected_image(
                DynamicImage::ImageRgba8(RgbaImage::from_pixel(80, 100, Rgba([0, 0, 0, 255]))),
                source,
                80,
                100,
                &placement,
                region,
                feather,
            )
        };
        for region in [
            ProductProtectionRegion {
                x: f64::NAN,
                ..protected_test_region()
            },
            ProductProtectionRegion {
                y: f64::INFINITY,
                ..protected_test_region()
            },
            ProductProtectionRegion {
                x: -0.1,
                ..protected_test_region()
            },
            ProductProtectionRegion {
                width: 0.0,
                ..protected_test_region()
            },
            ProductProtectionRegion {
                width: 1.0,
                ..protected_test_region()
            },
            ProductProtectionRegion {
                height: -0.2,
                ..protected_test_region()
            },
        ] {
            assert!(compose(&photo, &region, 0.0).is_err());
        }
        for feather in [f64::NAN, f64::INFINITY, -0.01, 0.11] {
            assert!(compose(&photo, &protected_test_region(), feather).is_err());
        }
        let mut transparent = photo;
        transparent.put_pixel(20, 10, Rgba([235, 235, 240, 254]));
        assert!(compose(&transparent, &protected_test_region(), 0.0).is_err());
    }

    #[test]
    fn protected_preflight_rejects_transparency_and_invalid_scope_before_generation() {
        let temp = tempfile::tempdir().unwrap();
        let service = ProductSceneImageService::new(temp.path().to_owned());
        let source = temp.path().join("preflight-photo.png");
        let mut photo = RgbaImage::from_pixel(40, 30, Rgba([245, 249, 252, 255]));
        // Transparency outside the core can enter it through a later resize filter.
        photo.put_pixel(0, 0, Rgba([245, 249, 252, 0]));
        write_png(&source, photo).unwrap();
        let prepared = service
            .prepare(PrepareProductViewCommand {
                source_path: source.to_string_lossy().into_owned(),
                preserve_photo: true,
            })
            .unwrap();
        let legacy: ValidateProductViewsCommand = serde_json::from_value(json!({
            "views": [{ "path": prepared.path, "contentHash": prepared.content_hash }],
        }))
        .unwrap();
        service.validate_views(legacy).unwrap();
        let protected: ValidateProductViewsCommand = serde_json::from_value(json!({
            "views": [{ "path": prepared.path, "contentHash": prepared.content_hash,
                        "region": protected_test_region(), "feather": 0.05 }],
        }))
        .unwrap();
        assert!(service.validate_views(protected).is_err());
        let invalid_scope: ValidateProductViewsCommand = serde_json::from_value(json!({
            "views": [{ "path": prepared.path, "contentHash": prepared.content_hash,
                        "region": { "x": 0, "y": 0, "width": 2, "height": 1 } }],
        }))
        .unwrap();
        assert!(service.validate_views(invalid_scope).is_err());
        let transparent = temp.path().join("all-transparent.png");
        write_png(
            &transparent,
            RgbaImage::from_pixel(20, 20, Rgba([0, 0, 0, 0])),
        )
        .unwrap();
        assert!(
            service
                .prepare(PrepareProductViewCommand {
                    source_path: transparent.to_string_lossy().into_owned(),
                    preserve_photo: true,
                })
                .is_err()
        );
    }

    #[test]
    fn protected_delivery_keeps_current_files_and_records_advisory_history() {
        let temp = tempfile::tempdir().unwrap();
        let service = ProductSceneImageService::new(temp.path().to_owned());
        let source = temp.path().join("real-photo.png");
        write_png(
            &source,
            RgbaImage::from_pixel(40, 30, Rgba([245, 249, 252, 255])),
        )
        .unwrap();
        let background = temp.path().join("background.png");
        write_png(
            &background,
            RgbaImage::from_pixel(40, 50, Rgba([30, 35, 40, 255])),
        )
        .unwrap();
        let prepared = service
            .prepare(PrepareProductViewCommand {
                source_path: source.to_string_lossy().into_owned(),
                preserve_photo: true,
            })
            .unwrap();
        let command = ComposeProtectedProductSceneCommand {
            background_path: background.to_string_lossy().into_owned(),
            product_path: prepared.path.clone(),
            product_hash: prepared.content_hash.clone(),
            output_id: "protected-receipt-test".into(),
            aspect_ratio: "3:4".into(),
            placement: ProductPlacement {
                center_x: 0.5,
                baseline_y: 0.75,
                width_fraction: 0.2,
            },
            region: protected_test_region(),
            feather: 0.05,
        };
        let result = service.compose_protected(command.clone()).unwrap();
        let output = Path::new(&result.path);
        let receipt_path = output.with_extension("protection.json");
        assert!(receipt_path.is_file());
        assert!(result.protection.verified && result.protection.core_pixel_count > 0);
        assert_eq!(hash_file(output).unwrap(), result.protection.output_hash);
        assert_eq!(result.foreground_hash, prepared.content_hash);
        let manifest = json!({
            "generationMode": "protected",
            "rows": [{ "outputPath": result.path, "status": "accepted", "foregroundHash": result.foreground_hash,
                       "jewelryReview": { "outputPath": result.path, "checks": {
                         "connections": "pass", "shape": "pass", "details": "pass",
                         "texture": "pass", "scale": "pass", "style": "pass"
                       }},
                       "protection": result.protection }],
        });
        let export = |manifest: &Value| {
            service.export(ExportProductScenesCommand {
                paths: vec![result.path.clone()],
                manifest: manifest.to_string(),
                directory: temp.path().to_string_lossy().into_owned(),
            })
        };
        let first_file = |delivery: ProductSceneExport| -> Value {
            let manifest: Value = serde_json::from_slice(
                &fs::read(Path::new(&delivery.directory).join("manifest.json")).unwrap(),
            )
            .unwrap();
            manifest["files"][0].clone()
        };
        let baseline = first_file(export(&manifest).unwrap());
        assert_eq!(baseline["sha256"], json!(result.protection.output_hash));
        assert_eq!(baseline["protection"]["verificationState"], "current");
        assert_eq!(baseline["warnings"], json!([]));
        assert_eq!(
            baseline["protection"]["historicalEvidence"]["composite"]["protection"]["outputHash"],
            json!(result.protection.output_hash)
        );

        let mut unreviewed = manifest.clone();
        unreviewed["rows"][0]["status"] = json!("needs_review");
        unreviewed["rows"][0]["jewelryReview"] = Value::Null;
        assert!(
            !first_file(export(&unreviewed).unwrap())["warnings"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let mut old_review = manifest.clone();
        old_review["rows"][0]["jewelryReview"]["outputPath"] = json!(prepared.path);
        old_review["rows"][0]["jewelryReview"]["checks"]["shape"] = json!("fail");
        assert!(
            !first_file(export(&old_review).unwrap())["warnings"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let mut old_region = manifest.clone();
        old_region["rows"][0]["protection"]["region"]["width"] = json!(0.5);
        assert!(
            !first_file(export(&old_region).unwrap())["warnings"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(export(&json!({"generationMode": "protected"})).is_ok());

        let replace_png = |path: &Path, pixels| {
            let mut bytes = Cursor::new(Vec::new());
            DynamicImage::ImageRgba8(pixels)
                .write_to(&mut bytes, ImageFormat::Png)
                .unwrap();
            fs::write(path, bytes.into_inner()).unwrap();
        };
        let original_output = fs::read(output).unwrap();
        replace_png(
            output,
            RgbaImage::from_pixel(80, 60, Rgba([18, 30, 45, 255])),
        );
        let changed_output_hash = hash_file(output).unwrap();
        let changed_output = first_file(export(&manifest).unwrap());
        assert_eq!(changed_output["sha256"], json!(changed_output_hash));
        assert_eq!(
            changed_output["protection"]["currentOutputHash"],
            json!(changed_output_hash)
        );
        assert_eq!(
            changed_output["protection"]["verificationState"],
            "historical"
        );
        assert!(!changed_output["warnings"].as_array().unwrap().is_empty());
        fs::write(output, b"unreadable image").unwrap();
        assert!(export(&manifest).is_err());
        fs::write(output, original_output).unwrap();

        let original_master = fs::read(&prepared.path).unwrap();
        replace_png(
            Path::new(&prepared.path),
            RgbaImage::from_pixel(40, 30, Rgba([225, 235, 240, 255])),
        );
        let actual_master_hash = hash_file(Path::new(&prepared.path)).unwrap();
        let preflight: ValidateProductViewsCommand = serde_json::from_value(json!({
            "views": [{ "path": prepared.path, "contentHash": prepared.content_hash,
                        "region": protected_test_region(), "feather": 0.05 }],
        }))
        .unwrap();
        assert!(service.validate_views(preflight).unwrap());
        let changed_source = service.compose_protected(command.clone()).unwrap();
        assert_eq!(changed_source.foreground_hash, actual_master_hash);
        assert_ne!(changed_source.foreground_hash, prepared.content_hash);
        assert!(!changed_source.protection.warnings.is_empty());
        assert_eq!(
            first_file(export(&manifest).unwrap())["protection"]["verificationState"],
            "historical"
        );
        fs::remove_file(&prepared.path).unwrap();
        assert!(
            !first_file(export(&manifest).unwrap())["warnings"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(service.compose_protected(command).is_err());
        fs::write(&prepared.path, original_master).unwrap();

        let original_receipt = fs::read(&receipt_path).unwrap();
        fs::write(&receipt_path, b"corrupt historical receipt").unwrap();
        let corrupt = first_file(export(&manifest).unwrap());
        assert_eq!(corrupt["protection"]["verificationState"], "unavailable");
        assert!(!corrupt["warnings"].as_array().unwrap().is_empty());
        fs::write(
            &receipt_path,
            br#"{"schemaVersion":"old-version","history":"keep"}"#,
        )
        .unwrap();
        let old = first_file(export(&manifest).unwrap());
        assert_eq!(old["protection"]["verificationState"], "historical");
        assert_eq!(old["protection"]["historicalEvidence"]["history"], "keep");
        fs::remove_file(&receipt_path).unwrap();
        assert_eq!(
            first_file(export(&manifest).unwrap())["protection"]["verificationState"],
            "unavailable"
        );
        fs::write(&receipt_path, original_receipt).unwrap();
    }

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
                preserve_photo: false,
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
        assert_eq!(output_width("valid", "1:1").unwrap(), 2048);
        assert!(output_width("valid", "4:3").is_err());
    }

    #[test]
    fn square_scene_supports_normalization_composition_protection_and_logo() {
        let temp = tempfile::tempdir().unwrap();
        let service = ProductSceneImageService::new(temp.path().to_owned());
        let photo_path = temp.path().join("photo.png");
        let photo = RgbaImage::from_pixel(40, 20, Rgba([58, 79, 119, 255]));
        write_png(&photo_path, photo).unwrap();
        let prepared = service
            .prepare(PrepareProductViewCommand {
                source_path: photo_path.to_string_lossy().into_owned(),
                preserve_photo: true,
            })
            .unwrap();
        let background_path = temp.path().join("background.png");
        write_png(
            &background_path,
            RgbaImage::from_pixel(80, 60, Rgba([220, 220, 220, 255])),
        )
        .unwrap();
        let normalized = service
            .normalize_generated(NormalizeProductSceneImageCommand {
                source_path: background_path.to_string_lossy().into_owned(),
                output_id: "square-normalize".into(),
                aspect_ratio: "1:1".into(),
            })
            .unwrap();
        assert_eq!((normalized.width, normalized.height), (2048, 2048));
        let placement = ProductPlacement {
            center_x: 0.5,
            baseline_y: 0.75,
            width_fraction: 0.5,
        };
        let composite = service
            .compose(ComposeProductSceneCommand {
                background_path: background_path.to_string_lossy().into_owned(),
                product_path: prepared.path.clone(),
                product_hash: prepared.content_hash.clone(),
                output_id: "square-compose".into(),
                aspect_ratio: "1:1".into(),
                placement: placement.clone(),
                depth_strength: 0.0,
            })
            .unwrap();
        assert_eq!((composite.width, composite.height), (2048, 2048));
        let protected = service
            .compose_protected(ComposeProtectedProductSceneCommand {
                background_path: background_path.to_string_lossy().into_owned(),
                product_path: prepared.path,
                product_hash: prepared.content_hash,
                output_id: "square-protected".into(),
                aspect_ratio: "1:1".into(),
                placement,
                region: protected_test_region(),
                feather: 0.05,
            })
            .unwrap();
        assert_eq!((protected.width, protected.height), (2048, 2048));
        assert!(protected.protection.verified);
        for path in [&normalized.path, &composite.path, &protected.path] {
            assert_eq!(image::image_dimensions(path).unwrap(), (2048, 2048));
        }
        let source_logo = temp.path().join("logo.png");
        let mut logo = RgbaImage::from_pixel(32, 16, Rgba([0, 0, 0, 0]));
        for y in 2..14 {
            for x in 2..30 {
                logo.put_pixel(x, y, Rgba([20, 30, 40, 255]));
            }
        }
        write_png(&source_logo, logo).unwrap();
        let logo = service
            .prepare_logo(PrepareProductViewCommand {
                source_path: source_logo.to_string_lossy().into_owned(),
                preserve_photo: false,
            })
            .unwrap();
        let with_logo = service
            .apply_logo(ApplyProductSceneLogoCommand {
                source_path: normalized.path,
                logo_path: logo.path,
                logo_hash: logo.content_hash,
                output_id: "square-logo".into(),
                quad: test_logo_quad(),
            })
            .unwrap();
        assert_eq!((with_logo.width, with_logo.height), (2048, 2048));
        assert_eq!(
            image::image_dimensions(with_logo.path).unwrap(),
            (2048, 2048)
        );
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
            .prepare(PrepareProductViewCommand {
                source_path: input,
                preserve_photo: false,
            })
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
        for ratio in ["1:1", "3:4", "9:16"] {
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
                preserve_photo: false,
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
