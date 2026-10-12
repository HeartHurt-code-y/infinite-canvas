//! Cross-canvas brand identities, using the application's existing SQLite file.

use super::*;
use crate::backend::brand_models::{
    BrandModelProfile, BrandModelReference, BrandModelVersion, BrandModelVersionStatus,
    version_signature,
};

pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS brand_model_profiles (
  id TEXT PRIMARY KEY,
  brand_name TEXT NOT NULL,
  name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  current_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS brand_model_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES brand_model_profiles(id),
  version INTEGER NOT NULL CHECK(version > 0),
  base_version_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft','approved')),
  signature TEXT NOT NULL,
  record_json TEXT NOT NULL,
  UNIQUE(profile_id,version)
);
CREATE INDEX IF NOT EXISTS idx_brand_models_updated ON brand_model_profiles(updated_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_brand_model_versions ON brand_model_versions(profile_id,version DESC);
"#;

fn profile_in(connection: &Connection, id: &str) -> BackendResult<BrandModelProfile> {
    let mut profile = connection.query_row(
        "SELECT id,brand_name,name,archived,current_version_id,created_at,updated_at FROM brand_model_profiles WHERE id=?1",
        params![id], |row| Ok(BrandModelProfile {
            id: row.get(0)?, brand_name: row.get(1)?, name: row.get(2)?, archived: row.get(3)?,
            current_version_id: row.get(4)?, created_at: row.get(5)?, updated_at: row.get(6)?, versions: Vec::new(),
        }),
    ).optional()?.ok_or_else(|| BackendError::NotFound("找不到数字模特，请刷新模特库".into()))?;
    let mut statement = connection.prepare("SELECT record_json,status,signature FROM brand_model_versions WHERE profile_id=?1 ORDER BY version DESC")?;
    let rows = statement.query_map(params![id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (record, status, signature) = row?;
        let mut version: BrandModelVersion = serde_json::from_str(&record)?;
        if version.signature != signature {
            return Err(BackendError::Conflict(
                "数字模特版本记录不一致，请恢复数据库备份".into(),
            ));
        }
        version.status = match status.as_str() {
            "draft" => BrandModelVersionStatus::Draft,
            "approved" => BrandModelVersionStatus::Approved,
            _ => {
                return Err(BackendError::Conflict(
                    "数字模特版本状态无效，请恢复数据库备份".into(),
                ));
            }
        };
        profile.versions.push(version);
    }
    Ok(profile)
}

impl Storage {
    pub fn list_brand_models(&self) -> BackendResult<Vec<BrandModelProfile>> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT id FROM brand_model_profiles ORDER BY updated_at DESC,id")?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| profile_in(&connection, &id))
            .collect()
    }

    pub fn get_brand_model(&self, id: &str) -> BackendResult<BrandModelProfile> {
        let connection = self.lock()?;
        profile_in(&connection, id)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn append_brand_model_version(
        &self,
        id: &str,
        version_id: &str,
        existing: bool,
        expected_current_version_id: Option<&str>,
        brand_name: &str,
        name: &str,
        description: &str,
        invariants: &str,
        references: Vec<BrandModelReference>,
    ) -> BackendResult<BrandModelProfile> {
        let mut connection = self.lock()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let created_at = now_ms();
        let version = if existing {
            let profile = profile_in(&transaction, id)?;
            if profile.archived {
                return Err(BackendError::Conflict(
                    "该模特已归档，请恢复后重新保存".into(),
                ));
            }
            if profile.current_version_id.as_deref() != expected_current_version_id {
                return Err(BackendError::Conflict(
                    "模特批准版本已改变，请刷新后重新保存".into(),
                ));
            }
            profile
                .versions
                .iter()
                .map(|v| v.version)
                .max()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| BackendError::Conflict("模特版本数量异常，请新建模特".into()))?
        } else {
            if expected_current_version_id.is_some() {
                return Err(BackendError::Conflict(
                    "新模特不能引用旧身份版本，请重新新建".into(),
                ));
            }
            transaction.execute("INSERT INTO brand_model_profiles(id,brand_name,name,archived,current_version_id,created_at,updated_at) VALUES(?1,?2,?3,0,NULL,?4,?4)", params![id,brand_name,name,created_at])?;
            1
        };
        let mut record = BrandModelVersion {
            id: version_id.into(),
            version,
            created_at,
            status: BrandModelVersionStatus::Draft,
            description: description.into(),
            invariants: invariants.into(),
            references,
            signature: String::new(),
        };
        record.signature = version_signature(id, &record)?;
        transaction.execute("INSERT INTO brand_model_versions(id,profile_id,version,base_version_id,status,signature,record_json) VALUES(?1,?2,?3,?4,'draft',?5,?6)", params![record.id,id,version,expected_current_version_id,record.signature,serde_json::to_string(&record)?])?;
        transaction.execute(
            "UPDATE brand_model_profiles SET brand_name=?2,name=?3,updated_at=?4 WHERE id=?1",
            params![id, brand_name, name, created_at],
        )?;
        let profile = profile_in(&transaction, id)?;
        transaction.commit()?;
        Ok(profile)
    }

    pub(crate) fn approve_brand_model_version(
        &self,
        profile_id: &str,
        version_id: &str,
        signature: &str,
    ) -> BackendResult<BrandModelProfile> {
        let mut connection = self.lock()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let profile = profile_in(&transaction, profile_id)?;
        if profile.archived {
            return Err(BackendError::Conflict(
                "该模特已归档，请恢复后再批准".into(),
            ));
        }
        let version = profile
            .versions
            .iter()
            .find(|v| v.id == version_id)
            .ok_or_else(|| BackendError::NotFound("找不到待批准的模特版本".into()))?;
        if version.signature != signature || version_signature(profile_id, version)? != signature {
            return Err(BackendError::Conflict(
                "模特版本内容已改变，请刷新并重新确认".into(),
            ));
        }
        if version.status == BrandModelVersionStatus::Draft {
            let base: Option<String> = transaction.query_row(
                "SELECT base_version_id FROM brand_model_versions WHERE id=?1 AND profile_id=?2",
                params![version_id, profile_id],
                |row| row.get(0),
            )?;
            if profile.current_version_id != base {
                return Err(BackendError::Conflict(
                    "该草稿基于较旧身份，请以当前批准版本另存新稿后再批准".into(),
                ));
            }
            transaction.execute("UPDATE brand_model_versions SET status='approved' WHERE id=?1 AND profile_id=?2 AND signature=?3", params![version_id,profile_id,signature])?;
            transaction.execute(
                "UPDATE brand_model_profiles SET current_version_id=?2,updated_at=?3 WHERE id=?1",
                params![profile_id, version_id, now_ms()],
            )?;
        }
        let profile = profile_in(&transaction, profile_id)?;
        transaction.commit()?;
        Ok(profile)
    }

    pub(crate) fn archive_brand_model(
        &self,
        id: &str,
        archived: bool,
    ) -> BackendResult<BrandModelProfile> {
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE brand_model_profiles SET archived=?2,updated_at=?3 WHERE id=?1",
            params![id, archived, now_ms()],
        )?;
        if changed == 0 {
            return Err(BackendError::NotFound(
                "找不到数字模特，请刷新模特库".into(),
            ));
        }
        profile_in(&connection, id)
    }
}
