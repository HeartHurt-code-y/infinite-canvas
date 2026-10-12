//! Durable, local brand-model identities. Drafts append; approval freezes a
//! version and verifies the managed image bytes rather than a transient URL.

use std::{
    fs::{self, OpenOptions},
    io::{Cursor, Write as _},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use image::{DynamicImage, ImageDecoder as _, ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

use super::{
    error::{BackendError, BackendResult},
    storage::Storage,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrandModelReferenceRole {
    Front,
    Profile,
    ThreeQuarter,
    FullBody,
    Expression,
    Detail,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_library(directory: &Path) -> BrandModelLibrary {
        BrandModelLibrary::new(
            Arc::new(Storage::open(&directory.join("app.sqlite3")).unwrap()),
            directory,
        )
        .unwrap()
    }

    fn source(directory: &Path) -> PathBuf {
        let path = directory.join("source.png");
        image::RgbaImage::from_pixel(4, 3, image::Rgba([12, 30, 90, 255]))
            .save(&path)
            .unwrap();
        path
    }

    fn input(path: &Path, profile: Option<&BrandModelProfile>) -> SaveBrandModelVersionCommand {
        SaveBrandModelVersionCommand {
            profile_id: profile.map(|p| p.id.clone()),
            expected_current_version_id: profile.and_then(|p| p.current_version_id.clone()),
            brand_name: "品牌".into(),
            name: "模特 A".into(),
            description: "成年模特，短发，清晰五官".into(),
            invariants: "眼型、脸型和身材比例保持一致".into(),
            references: vec![BrandModelReferenceInput {
                source_path: path.to_string_lossy().into_owned(),
                label: "正面身份图".into(),
                role: BrandModelReferenceRole::Front,
                task_id: Some("saved-image-task".into()),
                result_index: Some(2),
                source_node_id: Some("source-node".into()),
            }],
        }
    }

    fn version_command(
        profile: &BrandModelProfile,
        version: &BrandModelVersion,
    ) -> BrandModelVersionCommand {
        BrandModelVersionCommand {
            profile_id: profile.id.clone(),
            version_id: version.id.clone(),
            expected_signature: version.signature.clone(),
        }
    }

    #[test]
    fn durable_images_and_approved_identity_survive_source_deletion_and_database_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let original = source(directory.path());
        let original_bytes = fs::read(&original).unwrap();
        let library = open_library(directory.path());
        let draft = library.save(input(&original, None)).unwrap();
        assert_eq!(draft.current_version_id, None);
        let version = &draft.versions[0];
        assert_eq!(version.version, 1);
        assert_eq!(version.status, BrandModelVersionStatus::Draft);
        assert!(library.validate(version_command(&draft, version)).is_err());
        let reference = &version.references[0];
        assert_ne!(Path::new(&reference.path), original);
        assert_eq!(
            reference.content_hash,
            hex::encode(Sha256::digest(fs::read(&reference.path).unwrap()))
        );
        assert_eq!(reference.task_id.as_deref(), Some("saved-image-task"));
        assert_eq!(reference.result_index, Some(2));
        assert_eq!(reference.source_node_id.as_deref(), Some("source-node"));
        assert_eq!(fs::read(&original).unwrap(), original_bytes);
        let approved = library.approve(version_command(&draft, version)).unwrap();
        assert_eq!(
            approved.current_version_id.as_deref(),
            Some(version.id.as_str())
        );
        fs::remove_file(&original).unwrap();
        drop(library);
        let reopened = open_library(directory.path());
        let profiles = reopened.list().unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].versions[0].signature, version.signature);
        let checked = reopened.validate(version_command(&draft, version)).unwrap();
        assert_eq!(checked.status, BrandModelVersionStatus::Approved);
        let serialized = serde_json::to_string(&profiles).unwrap();
        assert!(!serialized.contains("data:image"));
        assert!(!serialized.contains("Token"));
    }

    #[test]
    fn new_drafts_append_old_approvals_stay_frozen_and_stale_baselines_cannot_replace_latest() {
        let directory = tempfile::tempdir().unwrap();
        let original = source(directory.path());
        let library = open_library(directory.path());
        let first = library.save(input(&original, None)).unwrap();
        let first_version = first.versions[0].clone();
        let first = library
            .approve(version_command(&first, &first_version))
            .unwrap();
        let second = library
            .save(input(
                Path::new(&first_version.references[0].path),
                Some(&first),
            ))
            .unwrap();
        let second_version = second.versions[0].clone();
        assert_eq!(second_version.version, 2);
        assert_eq!(second.current_version_id, first.current_version_id);
        assert_ne!(
            second_version.references[0].path,
            first_version.references[0].path
        );
        let competing = library.save(input(&original, Some(&first))).unwrap();
        let latest = library
            .approve(version_command(&second, &second_version))
            .unwrap();
        assert!(
            library
                .approve(version_command(&competing, &competing.versions[0]))
                .is_err()
        );
        assert!(library.save(input(&original, Some(&first))).is_err());
        // Re-approving an old frozen identity is idempotent and cannot roll back
        // the latest pointer; old projects may keep using that exact identity.
        let same = library
            .approve(version_command(&first, &first_version))
            .unwrap();
        assert_eq!(same.current_version_id, latest.current_version_id);
        assert!(
            library
                .validate(version_command(&first, &first_version))
                .is_ok()
        );
        assert_eq!(fs::read_dir(&library.root).unwrap().count(), 3);
    }

    #[test]
    fn archive_is_reversible_and_keeps_old_approved_projects_reproducible() {
        let directory = tempfile::tempdir().unwrap();
        let original = source(directory.path());
        let library = open_library(directory.path());
        let draft = library.save(input(&original, None)).unwrap();
        let version = draft.versions[0].clone();
        let approved = library.approve(version_command(&draft, &version)).unwrap();
        let archived = library
            .archive(ArchiveBrandModelCommand {
                profile_id: approved.id.clone(),
                archived: true,
            })
            .unwrap();
        assert!(archived.archived);
        assert!(library.validate(version_command(&draft, &version)).is_ok());
        assert!(library.save(input(&original, Some(&archived))).is_err());
        assert!(library.approve(version_command(&draft, &version)).is_err());
        let restored = library
            .archive(ArchiveBrandModelCommand {
                profile_id: approved.id,
                archived: false,
            })
            .unwrap();
        assert!(!restored.archived);
        assert_eq!(restored.versions.len(), 1);
        assert!(Path::new(&version.references[0].path).is_file());
    }

    #[test]
    fn approval_and_execution_reject_modified_images_signatures_and_missing_files() {
        let directory = tempfile::tempdir().unwrap();
        let original = source(directory.path());
        let library = open_library(directory.path());
        let draft = library.save(input(&original, None)).unwrap();
        let version = draft.versions[0].clone();
        let path = &version.references[0].path;
        let bytes = fs::read(path).unwrap();
        fs::write(path, b"replaced").unwrap();
        assert!(library.approve(version_command(&draft, &version)).is_err());
        assert_eq!(library.list().unwrap()[0].current_version_id, None);
        fs::write(path, &bytes).unwrap();
        library.approve(version_command(&draft, &version)).unwrap();
        let mut wrong = version_command(&draft, &version);
        wrong.expected_signature = "a".repeat(64);
        assert!(library.validate(wrong).is_err());
        fs::write(path, b"changed after approval").unwrap();
        assert!(library.validate(version_command(&draft, &version)).is_err());
        fs::remove_file(path).unwrap();
        assert!(library.validate(version_command(&draft, &version)).is_err());
    }

    #[test]
    fn invalid_imports_leave_no_partial_profile_or_managed_directory() {
        let directory = tempfile::tempdir().unwrap();
        let original = source(directory.path());
        let library = open_library(directory.path());
        let mut request = input(&original, None);
        request.references.push(BrandModelReferenceInput {
            source_path: "https://temporary.example/model.png".into(),
            label: "侧面".into(),
            role: BrandModelReferenceRole::Profile,
            task_id: None,
            result_index: None,
            source_node_id: None,
        });
        assert!(library.save(request).is_err());
        assert!(library.list().unwrap().is_empty());
        assert_eq!(fs::read_dir(&library.root).unwrap().count(), 0);
        let mut request = input(&original, None);
        request.profile_id = Some("../../other".into());
        assert!(library.save(request).is_err());
        assert!(original.is_file());
    }

    #[test]
    fn exif_is_normalized_in_durable_png_without_altering_original() {
        let directory = tempfile::tempdir().unwrap();
        let library = open_library(directory.path());
        for orientation in [6_u16, 8_u16] {
            let rgb = image::RgbImage::from_fn(32, 16, |x, y| {
                image::Rgb([
                    u8::try_from(x * 7).unwrap(),
                    u8::try_from(y * 13).unwrap(),
                    90,
                ])
            });
            let mut jpeg = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
                .encode_image(&rgb)
                .unwrap();
            let mut exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
            exif.extend_from_slice(&orientation.to_le_bytes());
            exif.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
            let mut source_bytes = vec![0xff, 0xd8, 0xff, 0xe1];
            source_bytes.extend_from_slice(&u16::try_from(exif.len() + 2).unwrap().to_be_bytes());
            source_bytes.extend_from_slice(&exif);
            source_bytes.extend_from_slice(&jpeg[2..]);
            let source = directory
                .path()
                .join(format!("orientation-{orientation}.jpg"));
            fs::write(&source, &source_bytes).unwrap();
            let raw = image::load_from_memory(&jpeg).unwrap().into_rgb8();
            let profile = library.save(input(&source, None)).unwrap();
            let reference = &profile.versions[0].references[0];
            assert_eq!((reference.width, reference.height), (16, 32));
            assert_eq!(fs::read(&source).unwrap(), source_bytes);
            let normalized = image::open(&reference.path).unwrap().into_rgb8();
            for (x, y, pixel) in normalized.enumerate_pixels() {
                let (source_x, source_y) = if orientation == 6 {
                    (y, 15 - x)
                } else {
                    (31 - y, x)
                };
                assert_eq!(pixel, raw.get_pixel(source_x, source_y));
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrandModelReference {
    pub id: String,
    pub label: String,
    pub role: BrandModelReferenceRole,
    pub path: String,
    pub content_hash: String,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_node_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrandModelVersionStatus {
    Draft,
    Approved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrandModelVersion {
    pub id: String,
    pub version: u32,
    pub created_at: i64,
    pub status: BrandModelVersionStatus,
    pub description: String,
    pub invariants: String,
    pub references: Vec<BrandModelReference>,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrandModelProfile {
    pub id: String,
    pub brand_name: String,
    pub name: String,
    pub archived: bool,
    pub current_version_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub versions: Vec<BrandModelVersion>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrandModelReferenceInput {
    pub source_path: String,
    pub label: String,
    pub role: BrandModelReferenceRole,
    pub task_id: Option<String>,
    pub result_index: Option<u32>,
    pub source_node_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveBrandModelVersionCommand {
    pub profile_id: Option<String>,
    pub expected_current_version_id: Option<String>,
    pub brand_name: String,
    pub name: String,
    pub description: String,
    pub invariants: String,
    pub references: Vec<BrandModelReferenceInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrandModelVersionCommand {
    pub profile_id: String,
    pub version_id: String,
    pub expected_signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveBrandModelCommand {
    pub profile_id: String,
    pub archived: bool,
}

#[derive(Clone)]
pub struct BrandModelLibrary {
    storage: Arc<Storage>,
    root: PathBuf,
    mutation_lock: Arc<Mutex<()>>,
}

fn invalid(message: impl Into<String>) -> BackendError {
    BackendError::validation(message, Value::Null)
}

fn validate_id(id: &str, prefix: &str) -> BackendResult<()> {
    id.strip_prefix(prefix)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| invalid("数字模特身份无效，请重新从模特库选择"))?;
    Ok(())
}

fn required_text(value: &str, message: &str) -> BackendResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(invalid(message));
    }
    Ok(value.to_string())
}

pub(crate) fn version_signature(
    profile_id: &str,
    version: &BrandModelVersion,
) -> BackendResult<String> {
    // Approval status is lifecycle metadata. The exact immutable identity, its
    // source provenance, and captured images remain the signed content.
    let payload = json!({
        "profileId": profile_id, "id": version.id, "version": version.version,
        "createdAt": version.created_at, "description": version.description,
        "invariants": version.invariants, "references": version.references,
    });
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&payload)?)))
}

fn normalized_png(bytes: &[u8]) -> BackendResult<(Vec<u8>, u32, u32)> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = Limits::default();
    reader.limits(limits.clone());
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| invalid("参考图无法解码，请换成完整的 PNG、JPG 或 WebP 图片"))?;
    limits
        .reserve(decoder.total_bytes())
        .map_err(|_| invalid("参考图解码需要过多内存，请缩小图片后重试"))?;
    decoder
        .set_limits(limits)
        .map_err(|_| invalid("参考图无法解码，请重新导出图片后重试"))?;
    let orientation = decoder
        .orientation()
        .map_err(|_| invalid("参考图方向信息无效，请重新导出图片后重试"))?;
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|_| invalid("参考图像素不完整，请更换图片后重试"))?;
    image.apply_orientation(orientation);
    let (width, height) = (image.width(), image.height());
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|_| invalid("参考图转换失败，请重新导出图片后重试"))?;
    Ok((png.into_inner(), width, height))
}

impl BrandModelLibrary {
    pub fn new(storage: Arc<Storage>, data_directory: &Path) -> BackendResult<Self> {
        let root = data_directory.join("brand-models");
        fs::create_dir_all(&root)?;
        Ok(Self {
            storage,
            root: fs::canonicalize(root)?,
            mutation_lock: Arc::new(Mutex::new(())),
        })
    }

    pub fn list(&self) -> BackendResult<Vec<BrandModelProfile>> {
        self.storage.list_brand_models()
    }

    pub fn save(&self, command: SaveBrandModelVersionCommand) -> BackendResult<BrandModelProfile> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| BackendError::Conflict("模特库正忙，请重试保存".into()))?;
        let brand_name = required_text(&command.brand_name, "请填写模特所属品牌")?;
        let name = required_text(&command.name, "请填写数字模特名称")?;
        let description = required_text(&command.description, "请填写数字模特的外观说明")?;
        let invariants = required_text(
            &command.invariants,
            "请填写跨图片和视频应保持不变的身份特征",
        )?;
        if command.references.is_empty() {
            return Err(invalid("请至少添加一张清晰的数字模特参考图"));
        }
        let profile_id = command
            .profile_id
            .clone()
            .unwrap_or_else(|| format!("brand-model-{}", Uuid::new_v4()));
        validate_id(&profile_id, "brand-model-")?;
        let old = if command.profile_id.is_some() {
            Some(self.storage.get_brand_model(&profile_id)?)
        } else {
            None
        };
        if old.as_ref().is_some_and(|profile| profile.archived) {
            return Err(invalid("该数字模特已归档，请先恢复再保存新版本"));
        }
        if old
            .as_ref()
            .and_then(|profile| profile.current_version_id.as_ref())
            != command.expected_current_version_id.as_ref()
        {
            return Err(BackendError::Conflict(
                "模特的批准版本已改变，请刷新模特库后重新保存".into(),
            ));
        }
        let version_id = format!("brand-model-version-{}", Uuid::new_v4());
        let temporary = self.root.join(format!(".import-{version_id}"));
        let final_directory = self.root.join(&version_id);
        fs::create_dir(&temporary)?;
        let result = (|| {
            let mut references = Vec::new();
            for input in &command.references {
                let source = Path::new(&input.source_path);
                if !source.is_absolute() || !source.is_file() {
                    return Err(invalid("参考图不存在，请重新选择已保存到本机的图片"));
                }
                let source_bytes = fs::read(source)
                    .map_err(|_| invalid("参考图读取失败，请确认文件仍在本机且可以打开"))?;
                let (png, width, height) = normalized_png(&source_bytes)?;
                let id = format!("brand-model-ref-{}", Uuid::new_v4());
                let file_name = format!("{id}.png");
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(temporary.join(&file_name))?;
                file.write_all(&png)?;
                file.sync_all()?;
                references.push(BrandModelReference {
                    id,
                    label: required_text(&input.label, "请为每张参考图填写用途名称")?,
                    role: input.role.clone(),
                    path: final_directory
                        .join(file_name)
                        .to_string_lossy()
                        .into_owned(),
                    content_hash: hex::encode(Sha256::digest(&png)),
                    width,
                    height,
                    task_id: input.task_id.clone(),
                    result_index: input.result_index,
                    source_node_id: input.source_node_id.clone(),
                });
            }
            fs::rename(&temporary, &final_directory)?;
            self.storage.append_brand_model_version(
                &profile_id,
                &version_id,
                old.is_some(),
                command.expected_current_version_id.as_deref(),
                &brand_name,
                &name,
                &description,
                &invariants,
                references,
            )
        })();
        if result.is_err() {
            // Both paths were created exclusively by this operation beneath the
            // canonical managed root; no user-selected directory is removed.
            if temporary.exists() {
                let _ = fs::remove_dir_all(&temporary);
            }
            if final_directory.exists() {
                let _ = fs::remove_dir_all(&final_directory);
            }
        }
        result
    }

    fn checked_version(
        &self,
        command: &BrandModelVersionCommand,
        require_approved: bool,
    ) -> BackendResult<BrandModelVersion> {
        validate_id(&command.profile_id, "brand-model-")?;
        validate_id(&command.version_id, "brand-model-version-")?;
        let profile = self.storage.get_brand_model(&command.profile_id)?;
        if profile.archived && !require_approved {
            return Err(invalid("该数字模特已归档，请恢复后再批准新身份"));
        }
        let version = profile
            .versions
            .into_iter()
            .find(|version| version.id == command.version_id)
            .ok_or_else(|| invalid("找不到选定模特版本，请重新从模特库选择"))?;
        if require_approved && version.status != BrandModelVersionStatus::Approved {
            return Err(invalid("该模特版本尚未批准，请先检查参考图并批准身份"));
        }
        if version.signature != command.expected_signature
            || version_signature(&profile.id, &version)? != version.signature
        {
            return Err(invalid("模特身份内容已改变，请刷新并重新确认选定版本"));
        }
        for reference in &version.references {
            validate_id(&reference.id, "brand-model-ref-")?;
            let expected = self
                .root
                .join(&version.id)
                .join(format!("{}.png", reference.id));
            if Path::new(&reference.path) != expected || !expected.is_file() {
                return Err(invalid("模特库参考图缺失，请恢复备份或创建新身份版本"));
            }
            let resolved = fs::canonicalize(&expected)?;
            if !resolved.starts_with(&self.root) {
                return Err(invalid("模特库参考图路径异常，请重新导入参考图创建新版本"));
            }
            let bytes = fs::read(&expected)
                .map_err(|_| invalid("模特库参考图无法读取，请恢复备份后重试"))?;
            if hex::encode(Sha256::digest(&bytes)) != reference.content_hash {
                return Err(invalid(
                    "模特参考图被替换或修改，请恢复原文件或创建新身份版本后重新确认",
                ));
            }
            let dimensions = image::load_from_memory_with_format(&bytes, ImageFormat::Png)
                .map_err(|_| invalid("模特参考图已损坏，请恢复原文件或创建新身份版本"))?;
            if dimensions.width() != reference.width || dimensions.height() != reference.height {
                return Err(invalid(
                    "模特参考图尺寸与批准身份不一致，请重新导入创建新版本",
                ));
            }
        }
        Ok(version)
    }

    pub fn approve(&self, command: BrandModelVersionCommand) -> BackendResult<BrandModelProfile> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| BackendError::Conflict("模特库正忙，请重试批准".into()))?;
        let version = self.checked_version(&command, false)?;
        self.storage.approve_brand_model_version(
            &command.profile_id,
            &version.id,
            &command.expected_signature,
        )
    }

    pub fn validate(&self, command: BrandModelVersionCommand) -> BackendResult<BrandModelVersion> {
        self.checked_version(&command, true)
    }

    pub fn archive(&self, command: ArchiveBrandModelCommand) -> BackendResult<BrandModelProfile> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| BackendError::Conflict("模特库正忙，请重试归档".into()))?;
        validate_id(&command.profile_id, "brand-model-")?;
        self.storage
            .archive_brand_model(&command.profile_id, command.archived)
    }
}
