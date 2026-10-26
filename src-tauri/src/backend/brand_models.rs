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
