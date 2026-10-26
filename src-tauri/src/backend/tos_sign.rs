//! 火山引擎 TOS 预签名 URL（签名版本 4）本地实现。
//!
//! 依据官方文档《签名机制》：
//! - URL 中包含签名（预签名）：https://www.volcengine.com/docs/6349/129226
//! - 单分块上传的签名机制（CanonicalRequest / StringToSign / SigningKey）：
//!   https://www.volcengine.com/docs/6349/74839
//!
//! 桌面端持有长期 AK/SK（仅存于系统凭据管理器），本地派生签名，
//! 不再依赖公司预签名 Broker 服务。

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use super::error::{BackendError, BackendResult};

type HmacSha256 = Hmac<Sha256>;

/// 预签名 URL 中允许的最大有效期（30 天），来自官方文档限制。
const MAX_EXPIRES_SECS: i64 = 2_592_000;

/// 桌面端持有的 TOS 长期访问凭据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TosCredentials {
    pub access_key: String,
    pub secret_key: String,
}

#[derive(serde::Deserialize)]
struct CredentialSecretJson {
    #[serde(rename = "accessKey")]
    access_key: String,
    #[serde(rename = "secretKey")]
    secret_key: String,
}

impl TosCredentials {
    /// 解析凭据管理器中保存的 JSON 形态密钥：`{"accessKey":"...","secretKey":"..."}`。
    pub fn parse(secret: &str) -> BackendResult<Self> {
        let parsed: CredentialSecretJson = serde_json::from_str(secret).map_err(|error| {
            BackendError::validation(
                "TOS credential secret must be JSON with accessKey and secretKey",
                serde_json::json!({ "source": error.to_string() }),
            )
        })?;
        // 归一化：火山引擎控制台复制的 AK/SK 常带首尾空白（尤其结尾换行），
        // 未清理会让 HMAC 用错误密钥计算 → SignatureDoesNotMatch（AK 可正常回显、
        // 但签名永远对不上）。与官方 SDK 行为一致，对两端都 trim。
        let access_key = parsed.access_key.trim().to_string();
        let secret_key = parsed.secret_key.trim().to_string();
        if access_key.is_empty() || secret_key.is_empty() {
            return Err(BackendError::validation(
                "TOS accessKey and secretKey must both be non-empty",
                serde_json::json!({}),
            ));
        }
        Ok(Self {
            access_key,
            secret_key,
        })
    }
}

/// 官方 UriEncode 规则：
/// - 仅 `A~Z a~z 0~9 - . _ ~` 不编码；
/// - 空格编码为 `%20`（不支持 `+`）；
/// - 十六进制必须大写；
/// - 除对象名（CanonicalURI）中的 `/` 不编码外，其余情况 `/` 都需要编码。
pub(crate) fn uri_encode(value: &str, encode_slash: bool) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*byte as char);
            }
            b'/' if !encode_slash => encoded.push('/'),
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

/// 生成 TOS 预签名 URL 的输入参数。
pub struct PresignParams<'a> {
    /// HTTP 方法，如 `GET`、`PUT`、`DELETE`。
    pub method: &'a str,
    /// 请求主机：`{bucket}.{endpoint}`，例如 `examplebucket.tos-cn-beijing.volces.com`。
    pub host: &'a str,
    /// 对象键（原始未编码形态）。
    pub object_key: &'a str,
    /// 地域，例如 `cn-beijing`。
    pub region: &'a str,
    pub credentials: &'a TosCredentials,
    /// URL 有效期（秒），1 到 2592000。
    pub expires_secs: i64,
    /// 参与签名的请求时间。
    pub now: DateTime<Utc>,
}

/// 生成 TOS V4 预签名 URL（UNSIGNED-PAYLOAD，仅签名 host 头域）。
///
/// 返回的 URL 形如：
/// `https://{host}/{objectKey}?X-Tos-Algorithm=TOS4-HMAC-SHA256&...&X-Tos-Signature={signature}`
pub fn presign_url(params: &PresignParams<'_>) -> BackendResult<String> {
    presign_url_with_query(params, &[])
}

/// 生成携带额外业务查询参数的 TOS V4 预签名 URL。
///
/// 桶级操作（如 ListObjectsV2 列举对象，`GET /?list-type=2`）的 `object_key`
/// 传空字符串（CanonicalURI 为 `/`）。额外查询参数与 `X-Tos-*` 签名参数合并后
/// 统一按 key 的 ASCII 序排列并参与签名，请求时必须原样携带，否则签名不匹配。
pub fn presign_url_with_query(
    params: &PresignParams<'_>,
    extra_query: &[(String, String)],
) -> BackendResult<String> {
    if params.method.is_empty() || !params.method.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(BackendError::validation(
            "TOS presign method must be a non-empty uppercase HTTP method",
            serde_json::json!({ "method": params.method }),
        ));
    }
    if !(1..=MAX_EXPIRES_SECS).contains(&params.expires_secs) {
        return Err(BackendError::validation(
            "TOS presign expiry must be between 1 and 2592000 seconds",
            serde_json::json!({ "expiresSecs": params.expires_secs }),
        ));
    }
    if params.host.trim().is_empty() {
        return Err(BackendError::validation(
            "TOS presign host must be non-empty",
            serde_json::json!({ "host": params.host }),
        ));
    }

    let date = params.now.format("%Y%m%d").to_string();
    let request_date = params.now.format("%Y%m%dT%H%M%SZ").to_string();
    let credential_scope = format!("{}/{}/tos/request", date, params.region);
    let credential = format!("{}/{}", params.credentials.access_key, credential_scope);

    // CanonicalURI：对象键整体编码，仅保留路径分隔符 `/`；桶级操作（键为空）即 `/`。
    let canonical_uri = format!("/{}", uri_encode(params.object_key, false));

    // CanonicalQueryString：签名参数与业务参数合并后按 key 的 ASCII 序排列；
    // 值全部 UriEncode（`/` 编码为 %2F）。
    let mut query_pairs: Vec<(String, String)> = vec![
        (
            "X-Tos-Algorithm".to_string(),
            "TOS4-HMAC-SHA256".to_string(),
        ),
        ("X-Tos-Credential".to_string(), credential),
        ("X-Tos-Date".to_string(), request_date.clone()),
        ("X-Tos-Expires".to_string(), params.expires_secs.to_string()),
        ("X-Tos-SignedHeaders".to_string(), "host".to_string()),
    ];
    query_pairs.extend(extra_query.iter().cloned());
    query_pairs.sort_by(|left, right| left.0.cmp(&right.0));
    let canonical_query = query_pairs
        .iter()
        .map(|(key, value)| format!("{}={}", uri_encode(key, true), uri_encode(value, true)))
        .collect::<Vec<_>>()
        .join("&");

    // CanonicalRequest：预签名使用 UNSIGNED-PAYLOAD，CanonicalHeaders 仅包含 host。
    let canonical_request = format!(
        "{}\n{}\n{}\nhost:{}\n\nhost\nUNSIGNED-PAYLOAD",
        params.method, canonical_uri, canonical_query, params.host
    );

    // StringToSign。
    let canonical_request_hash = hex::encode(Sha256::digest(canonical_request.as_bytes()));
    let string_to_sign = format!(
        "TOS4-HMAC-SHA256\n{}\n{}\n{}",
        request_date, credential_scope, canonical_request_hash
    );

    // SigningKey 派生链：kSecret -> kDate -> kRegion -> kService -> kSigning。
    let k_date = hmac_sha256(params.credentials.secret_key.as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, params.region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"tos");
    let k_signing = hmac_sha256(&k_service, b"request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    Ok(format!(
        "https://{}{}?{}&X-Tos-Signature={}",
        params.host, canonical_uri, canonical_query, signature
    ))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC-SHA256 accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}
