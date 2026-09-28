use rusqlite::{OptionalExtension, Row, params};

use super::{Storage, nonnegative_integer, parse_media_type};
use crate::backend::{
    error::{BackendError, BackendResult},
    types::{LocalAssetKindTotals, LocalAssetListQuery, LocalBase64AssetRecord, MediaType},
};

fn row_to_record(row: &Row<'_>) -> rusqlite::Result<LocalBase64AssetRecord> {
    Ok(LocalBase64AssetRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        media_type: parse_media_type(row.get(2)?)?,
        mime_type: row.get(3)?,
        preview_url: String::new(),
        byte_size: nonnegative_integer(row, 4)?,
        created_at: row.get(5)?,
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
            "INSERT INTO local_base64_assets (id, name, media_type, mime_type, byte_size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                record.id,
                record.name,
                record.media_type.as_str(),
                record.mime_type,
                byte_size,
                record.created_at
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
                "SELECT a.id, a.name, a.media_type, a.mime_type, a.byte_size, a.created_at
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
            "SELECT a.id, a.name, a.media_type, a.mime_type, a.byte_size, a.created_at
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
                "SELECT id, name, media_type, mime_type, byte_size, created_at
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
        let counts = connection.query_row(
            "SELECT
               SUM(CASE WHEN media_type = 'image' THEN 1 ELSE 0 END),
               SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END),
               SUM(CASE WHEN media_type = 'audio' THEN 1 ELSE 0 END)
             FROM local_base64_assets",
            [],
            |row| {
                Ok(LocalAssetKindTotals {
                    image: row.get::<_, Option<i64>>(0)?.unwrap_or(0) as u64,
                    video: row.get::<_, Option<i64>>(1)?.unwrap_or(0) as u64,
                    audio: row.get::<_, Option<i64>>(2)?.unwrap_or(0) as u64,
                })
            },
        )?;
        let media_type = query
            .and_then(|value| value.media_type)
            .map(MediaType::as_str);
        let name = query
            .and_then(|value| value.name.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_lowercase);
        let total: i64 = connection.query_row(
            "SELECT COUNT(*) FROM local_base64_assets
             WHERE (?1 IS NULL OR media_type = ?1)
               AND (?2 IS NULL OR instr(lower(name), ?2) > 0)",
            params![media_type, name],
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
        let mut statement = connection.prepare(
            "SELECT id, name, media_type, mime_type, byte_size, created_at
             FROM local_base64_assets
             WHERE (?1 IS NULL OR media_type = ?1)
               AND (?2 IS NULL OR instr(lower(name), ?2) > 0)
             ORDER BY created_at DESC, id DESC LIMIT ?3 OFFSET ?4",
        )?;
        let items = statement
            .query_map(params![media_type, name, page_size, offset], row_to_record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((items, total, page, page_size, counts))
    }
}
