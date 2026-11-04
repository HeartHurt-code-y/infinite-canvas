//! Anonymous, read-only access to Liblib's public model gallery. No account or token.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::error::{BackendError, BackendResult};

const API: &str = "https://api2.liblib.art";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageStyleReference {
    pub id: String,
    pub name: String,
    pub image_url: String,
    pub author: String,
    pub model_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleMarketQuery {
    pub page: u32,
    pub request_id: String,
    #[serde(default)]
    pub keyword: String,
    #[serde(default)]
    pub tag_ids: Vec<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleMarketPage {
    pub items: Vec<ImageStyleReference>,
    pub has_more: bool,
}

async fn public_post(client: &reqwest::Client, path: &str, body: Value) -> BackendResult<Value> {
    let response = client.post(format!("{API}{path}"))
        .timeout(std::time::Duration::from_secs(25)).json(&body).send().await?;
    let status = response.status();
    let value: Value = response.json().await?;
    if !status.is_success() || value.get("code").and_then(Value::as_i64) != Some(0) {
        let message = value.get("msg").and_then(Value::as_str).unwrap_or("公开风格服务暂不可用");
        return Err(BackendError::protocol(format!("风格广场：{message}"), json!({"status":status.as_u16(),"code":value.get("code")})));
    }
    value.get("data").cloned().ok_or_else(|| BackendError::protocol("风格广场响应缺少数据", Value::Null))
}

pub async fn categories(client: &reqwest::Client) -> BackendResult<Value> {
    public_post(client, "/api/www/public/tag/v3", json!({"categoryCode":"model"})).await
}

pub fn validate_reference(style: &ImageStyleReference) -> BackendResult<()> {
    let url = url::Url::parse(&style.image_url)?;
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
        || !(host.ends_with(".liblib.cloud") || host.ends_with(".liblib.art"))
        || style.id.trim().is_empty() || style.name.trim().is_empty() {
        return Err(BackendError::validation("风格参考无效，请从风格广场重新选择", Value::Null));
    }
    Ok(())
}

pub async fn browse(client: &reqwest::Client, query: StyleMarketQuery) -> BackendResult<StyleMarketPage> {
    let mut body = json!({"platform":"libtv","page":query.page.max(1),"pageSize":32,
        "cid":"infinite-canvas-public-gallery","requestId":query.request_id,
        "types":[],"models":[5],"sort":0});
    let path = if query.keyword.trim().is_empty() {
        if !query.tag_ids.is_empty() { body["tagIds"] = json!(query.tag_ids); }
        "/api/www/model/feed/stream"
    } else {
        body["keyword"] = json!(query.keyword.trim());
        body["scene"] = json!("ImgGenerator");
        "/api/www/model/search"
    };
    let data = public_post(client, path, body).await?;
    let rows = data.get("data").or_else(|| data.get("list")).and_then(Value::as_array)
        .ok_or_else(|| BackendError::protocol("风格广场响应格式已变化", Value::Null))?;
    let items = rows.iter().filter_map(|row| {
        let id = row.get("uuid")?.as_str()?;
        let style = ImageStyleReference {
            id: id.into(), name: row.get("name").or_else(|| row.get("modelName"))?.as_str()?.into(),
            image_url: row.get("imageUrl").or_else(|| row.get("webpUrl"))?.as_str()?.into(),
            author: row.get("nickname").and_then(Value::as_str).unwrap_or("").into(),
            model_url: format!("https://www.liblib.art/modelinfo/{id}"),
        };
        validate_reference(&style).ok().map(|_| style)
    }).collect();
    Ok(StyleMarketPage { items, has_more: data.get("hasMore").and_then(Value::as_bool).unwrap_or(rows.len() >= 32) })
}
