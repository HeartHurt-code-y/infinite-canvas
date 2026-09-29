use rusqlite::{OptionalExtension, Row, params};

use super::{Storage, nonnegative_integer, parse_media_type};
use crate::backend::{
    error::{BackendError, BackendResult},
    types::{
        LocalAssetKindTotals, LocalAssetListQuery, LocalBase64AssetGroupRecord,
        LocalBase64AssetRecord, MediaType,
    },
};

/// 单一 SQL 谓词，配合一个可空绑定参数覆盖三种分组口径：
/// NULL = 全部素材、`ungrouped` = 未分组、其余值 = 指定分组。
/// 编号占位符由调用方按各自语句的参数位置传入，同一占位符可重复出现。
fn group_predicate(group_index: usize) -> String {
    format!(
        "(?{group_index} IS NULL OR (?{group_index} = 'ungrouped' AND group_id IS NULL) OR group_id = ?{group_index})"
    )
}

fn row_to_record(row: &Row<'_>) -> rusqlite::Result<LocalBase64AssetRecord> {
    Ok(LocalBase64AssetRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        media_type: parse_media_type(row.get(2)?)?,
        mime_type: row.get(3)?,
        preview_url: String::new(),
        byte_size: nonnegative_integer(row, 4)?,
        created_at: row.get(5)?,
        group_id: row.get(6)?,
    })
}

fn row_to_group(row: &Row<'_>) -> rusqlite::Result<LocalBase64AssetGroupRecord> {
    Ok(LocalBase64AssetGroupRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        asset_count: row.get::<_, Option<i64>>(3)?.unwrap_or(0) as u64,
    })
}

impl Storage {
    pub fn insert_local_base64_asset(
        &self,
        record: &LocalBase64AssetRecord,
        sha256: &str,
    ) -> BackendResult<()> {
        let byte_size = i64::try_from(record.byte_size).map_err(|_| {
            BackendError::validation(
                "local asset is too large for SQLite metadata",
                serde_json::json!({ "byteSize": record.byte_size }),
            )
        })?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO local_base64_assets (id, name, media_type, mime_type, byte_size, created_at, group_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                record.id,
                record.name,
                record.media_type.as_str(),
                record.mime_type,
                byte_size,
                record.created_at,
                record.group_id
            ],
        )?;
        transaction.execute(
            "INSERT INTO local_base64_content_hashes (asset_id, media_type, byte_size, sha256)
             VALUES (?1, ?2, ?3, ?4)",
            params![record.id, record.media_type.as_str(), byte_size, sha256],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn find_local_base64_asset_by_hash(
        &self,
        media_type: MediaType,
        byte_size: u64,
        sha256: &str,
    ) -> BackendResult<Option<LocalBase64AssetRecord>> {
        let byte_size = i64::try_from(byte_size).map_err(|_| {
            BackendError::validation(
                "local asset is too large for SQLite metadata",
                serde_json::json!({ "byteSize": byte_size }),
            )
        })?;
        self.lock()?
            .query_row(
                "SELECT a.id, a.name, a.media_type, a.mime_type, a.byte_size, a.created_at, a.group_id
                 FROM local_base64_assets a
                 JOIN local_base64_content_hashes h ON h.asset_id = a.id
                 WHERE h.media_type = ?1 AND h.byte_size = ?2 AND h.sha256 = ?3",
                params![media_type.as_str(), byte_size, sha256],
                row_to_record,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_unhashed_local_base64_assets(
        &self,
        media_type: MediaType,
        byte_size: u64,
    ) -> BackendResult<Vec<LocalBase64AssetRecord>> {
        let byte_size = i64::try_from(byte_size).map_err(|_| {
            BackendError::validation(
                "local asset is too large for SQLite metadata",
                serde_json::json!({ "byteSize": byte_size }),
            )
        })?;
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT a.id, a.name, a.media_type, a.mime_type, a.byte_size, a.created_at, a.group_id
             FROM local_base64_assets a
             LEFT JOIN local_base64_content_hashes h ON h.asset_id = a.id
             WHERE a.media_type = ?1 AND a.byte_size = ?2 AND h.asset_id IS NULL
             ORDER BY a.created_at, a.id",
        )?;
        statement
            .query_map(params![media_type.as_str(), byte_size], row_to_record)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn remember_local_base64_asset_hash(
        &self,
        record: &LocalBase64AssetRecord,
        sha256: &str,
    ) -> BackendResult<()> {
        let byte_size = i64::try_from(record.byte_size).map_err(|_| {
            BackendError::validation(
                "local asset is too large for SQLite metadata",
                serde_json::json!({ "byteSize": record.byte_size }),
            )
        })?;
        self.lock()?.execute(
            "INSERT OR IGNORE INTO local_base64_content_hashes (asset_id, media_type, byte_size, sha256)
             VALUES (?1, ?2, ?3, ?4)",
            params![record.id, record.media_type.as_str(), byte_size, sha256],
        )?;
        Ok(())
    }

    pub fn forget_local_base64_asset_hash(&self, asset_id: &str) -> BackendResult<()> {
        self.lock()?.execute(
            "DELETE FROM local_base64_content_hashes WHERE asset_id = ?1",
            params![asset_id],
        )?;
        Ok(())
    }

    pub fn get_local_base64_asset(&self, id: &str) -> BackendResult<LocalBase64AssetRecord> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT id, name, media_type, mime_type, byte_size, created_at, group_id
                 FROM local_base64_assets WHERE id = ?1",
                params![id],
                row_to_record,
            )
            .optional()?
            .ok_or_else(|| BackendError::NotFound(format!("local Base64 asset {id}")))
    }

    pub fn list_local_base64_asset_records(
        &self,
        query: Option<&LocalAssetListQuery>,
    ) -> BackendResult<(
        Vec<LocalBase64AssetRecord>,
        u64,
        u32,
        u32,
        LocalAssetKindTotals,
    )> {
        let connection = self.lock()?;
        let media_type = query
            .and_then(|value| value.media_type)
            .map(MediaType::as_str);
        let name = query
            .and_then(|value| value.name.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_lowercase);
        let group = query
            .and_then(|value| value.group_id.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        // 类型计数跟随分组口径（与云端「按供应商+分组扫描」一致），
        // 但不受名称搜索影响：搜索时 Tab 计数保持稳定。
        let counts = connection.query_row(
            &format!(
                "SELECT
                   SUM(CASE WHEN media_type = 'image' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN media_type = 'audio' THEN 1 ELSE 0 END)
                 FROM local_base64_assets WHERE {}",
                group_predicate(1)
            ),
            params![group],
            |row| {
                Ok(LocalAssetKindTotals {
                    image: row.get::<_, Option<i64>>(0)?.unwrap_or(0) as u64,
                    video: row.get::<_, Option<i64>>(1)?.unwrap_or(0) as u64,
                    audio: row.get::<_, Option<i64>>(2)?.unwrap_or(0) as u64,
                })
            },
        )?;
        let total: i64 = connection.query_row(
            &format!(
                "SELECT COUNT(*) FROM local_base64_assets
                 WHERE (?1 IS NULL OR media_type = ?1)
                   AND (?2 IS NULL OR instr(lower(name), ?2) > 0)
                   AND {}",
                group_predicate(3)
            ),
            params![media_type, name, group],
            |row| row.get(0),
        )?;
        let total = total as u64;
        let page = query.and_then(|value| value.page).unwrap_or(1).max(1);
        let page_size = match query {
            None => u32::try_from(total).unwrap_or(u32::MAX).max(1),
            Some(value) => value.page_size.unwrap_or(40).clamp(1, 200),
        };
        let offset = (u64::from(page) - 1)
            .saturating_mul(u64::from(page_size))
            .min(i64::MAX as u64) as i64;
        let mut statement = connection.prepare(&format!(
            "SELECT id, name, media_type, mime_type, byte_size, created_at, group_id
             FROM local_base64_assets
             WHERE (?1 IS NULL OR media_type = ?1)
               AND (?2 IS NULL OR instr(lower(name), ?2) > 0)
               AND {}
             ORDER BY created_at DESC, id DESC LIMIT ?4 OFFSET ?5",
            group_predicate(3)
        ))?;
        let items = statement
            .query_map(
                params![media_type, name, group, page_size, offset],
                row_to_record,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((items, total, page, page_size, counts))
    }

    pub fn list_local_base64_asset_groups(
        &self,
    ) -> BackendResult<Vec<LocalBase64AssetGroupRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT g.id, g.name, g.created_at,
                    (SELECT COUNT(*) FROM local_base64_assets a WHERE a.group_id = g.id)
             FROM local_base64_asset_groups g
             ORDER BY g.created_at, g.id",
        )?;
        let groups = statement
            .query_map([], row_to_group)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(groups)
    }

    pub fn find_local_base64_asset_group_by_name(
        &self,
        name: &str,
    ) -> BackendResult<Option<LocalBase64AssetGroupRecord>> {
        self.lock()?
            .query_row(
                "SELECT g.id, g.name, g.created_at,
                        (SELECT COUNT(*) FROM local_base64_assets a WHERE a.group_id = g.id)
                 FROM local_base64_asset_groups g WHERE g.name = ?1",
                params![name],
                row_to_group,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn get_local_base64_asset_group(
        &self,
        id: &str,
    ) -> BackendResult<LocalBase64AssetGroupRecord> {
        self.lock()?
            .query_row(
                "SELECT g.id, g.name, g.created_at,
                        (SELECT COUNT(*) FROM local_base64_assets a WHERE a.group_id = g.id)
                 FROM local_base64_asset_groups g WHERE g.id = ?1",
                params![id],
                row_to_group,
            )
            .optional()?
            .ok_or_else(|| BackendError::NotFound(format!("local Base64 asset group {id}")))
    }

    pub fn insert_local_base64_asset_group(
        &self,
        record: &LocalBase64AssetGroupRecord,
    ) -> BackendResult<()> {
        self.lock()?.execute(
            "INSERT INTO local_base64_asset_groups (id, name, created_at) VALUES (?1, ?2, ?3)",
            params![record.id, record.name, record.created_at],
        )?;
        Ok(())
    }

    /// 删除分组：成员置回未分组（group_id = NULL），素材正文与行都保留。
    pub fn delete_local_base64_asset_group(&self, id: &str) -> BackendResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE local_base64_assets SET group_id = NULL WHERE group_id = ?1",
            params![id],
        )?;
        let removed = transaction.execute(
            "DELETE FROM local_base64_asset_groups WHERE id = ?1",
            params![id],
        )?;
        transaction.commit()?;
        if removed == 0 {
            return Err(BackendError::NotFound(format!(
                "local Base64 asset group {id}"
            )));
        }
        Ok(())
    }

    /// 逐个更新成员分组（单事务）。返回实际命中的素材数；不存在的 ID 被忽略。
    pub fn move_local_base64_assets(
        &self,
        asset_ids: &[String],
        group_id: Option<&str>,
    ) -> BackendResult<u64> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let mut moved = 0_u64;
        for asset_id in asset_ids {
            moved += transaction.execute(
                "UPDATE local_base64_assets SET group_id = ?1 WHERE id = ?2",
                params![group_id, asset_id],
            )? as u64;
        }
        transaction.commit()?;
        Ok(moved)
    }

    /// 删除素材行与内容哈希索引（单事务）。正文文件由库层负责清理。
    pub fn delete_local_base64_asset(&self, id: &str) -> BackendResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM local_base64_content_hashes WHERE asset_id = ?1",
            params![id],
        )?;
        let removed =
            transaction.execute("DELETE FROM local_base64_assets WHERE id = ?1", params![id])?;
        transaction.commit()?;
        if removed == 0 {
            return Err(BackendError::NotFound(format!("local Base64 asset {id}")));
        }
        Ok(())
    }
}
