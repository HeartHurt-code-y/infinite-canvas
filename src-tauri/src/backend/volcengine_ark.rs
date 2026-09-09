//! 火山引擎 OpenAPI（方舟 Ark 素材资产库）的 V4 签名（HMAC-SHA256）本地实现。
//!
//! 依据官方文档《签名机制》（https://www.volcengine.com/docs/6638/195554）与
//! 官方签名示例（https://www.volcengine.com/docs/6408/78948）：
//! - CanonicalRequest = Method + "\n" + CanonicalURI + "\n" + CanonicalQueryString
//!   + "\n" + CanonicalHeaders（每行 `key:value\n`） + "\n" + SignedHeaders
//!   + "\n" + HexEncode(SHA256(RequestPayload))；
//! - StringToSign = "HMAC-SHA256" + RequestDate + CredentialScope + SHA256(CanonicalRequest)；
//! - kSigning = HMAC(HMAC(HMAC(HMAC(SK, ShortDate), Region), Service), "request")；
//! - Authorization: HMAC-SHA256 Credential={AK}/{scope}, SignedHeaders=..., Signature=...。
//!
//! Ark 素材资产库 OpenAPI（Action=ListAssets 等，Version=2024-01-01）仅支持
//! Access Key 鉴权。桌面端持有长期 AK/SK（仅存于系统凭据管理器），本地派生签名。

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{error::BackendResult, tos_sign::uri_encode};

type HmacSha256 = Hmac<Sha256>;

/// Ark OpenAPI 的服务名（签名 CredentialScope 与网关路由均使用）。
pub(crate) const ARK_SERVICE: &str = "ark";
/// Ark OpenAPI 的默认地域（北京）。
pub(crate) const ARK_REGION: &str = "cn-beijing";
/// Ark 素材资产库 OpenAPI 的接口版本（查询参数 `Version`）。
pub(crate) const ARK_API_VERSION: &str = "2024-01-01";

/// 桌面端持有的火山引擎 Access Key（仅存于系统凭据管理器）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArkCredentials {
    pub access_key: String,
    pub secret_key: String,
}

#[derive(Deserialize)]
struct CredentialSecretJson {
    #[serde(rename = "accessKey")]
    access_key: String,
    #[serde(rename = "secretKey")]
    secret_key: String,
}

impl ArkCredentials {
    /// 解析凭据管理器中保存的 JSON 形态密钥：`{"accessKey":"...","secretKey":"..."}`。
    ///
    /// 与 TOS 暂存凭据共用同一形态，方便用户在两处粘贴同一对 AK/SK。控制台复制的
    /// AK/SK 常带首尾空白（尤其结尾换行），未清理会让 HMAC 用错误密钥计算 →
    /// SignatureDoesNotMatch，因此对两端都 trim。
    pub fn parse(secret: &str) -> BackendResult<Self> {
        let parsed: CredentialSecretJson = serde_json::from_str(secret).map_err(|error| {
            super::error::BackendError::validation(
                "火山引擎凭据必须为 JSON 形态 {\"accessKey\":\"...\",\"secretKey\":\"...\"}",
                serde_json::json!({ "source": error.to_string() }),
            )
        })?;
        let access_key = parsed.access_key.trim().to_string();
        let secret_key = parsed.secret_key.trim().to_string();
        if access_key.is_empty() || secret_key.is_empty() {
            return Err(super::error::BackendError::validation(
                "火山引擎 accessKey 与 secretKey 均不能为空",
                serde_json::json!({}),
            ));
        }
        Ok(Self {
            access_key,
            secret_key,
        })
    }
}

/// 一次已签名的 Ark 请求头集合（逐字加入请求头）。
#[derive(Debug, Clone)]
pub(crate) struct ArkSignature {
    pub x_date: String,
    pub x_content_sha256: String,
    pub authorization: String,
}

/// 参与签名的请求头（小写、ASCII 升序、分号连接）。
const SIGNED_HEADERS: &str = "content-type;host;x-content-sha256;x-date";

/// 为一次火山引擎 OpenAPI 请求派生 V4 签名。
///
/// - `query_pairs`：查询参数（会按 key ASCII 升序参与签名，与请求 URL 保持一致）；
/// - `payload`：请求体的**精确字节形态**（签名哈希与实际发送的 body 必须一致）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn sign_request(
    credentials: &ArkCredentials,
    service: &str,
    region: &str,
    method: &str,
    canonical_uri: &str,
    query_pairs: &[(String, String)],
    host: &str,
    content_type: &str,
    payload: &str,
    now: &DateTime<Utc>,
) -> ArkSignature {
    let short_date = now.format("%Y%m%d").to_string();
    let request_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let payload_hash = hex::encode(Sha256::digest(payload.as_bytes()));

    // CanonicalQueryString：按 key ASCII 升序，key 与 value 均按官方 UriEncode 规则编码。
    let mut sorted_query = query_pairs.to_vec();
    sorted_query.sort_by(|left, right| left.0.cmp(&right.0));
    let canonical_query = sorted_query
        .iter()
        .map(|(key, value)| format!("{}={}", uri_encode(key, true), uri_encode(value, true)))
        .collect::<Vec<_>>()
        .join("&");

    // CanonicalHeaders：头名称小写 ASCII 升序，每行 `key:value\n`（整体以 \n 结尾）。
    let canonical_headers = format!(
        "content-type:{content_type}\nhost:{host}\nx-content-sha256:{payload_hash}\nx-date:{request_date}\n"
    );

    // CanonicalRequest：注意 CanonicalHeaders 与 SignedHeaders 之间是一个空行
    // （CanonicalHeaders 自带结尾换行 + join 分隔换行）。
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{SIGNED_HEADERS}\n{payload_hash}"
    );

    let credential_scope = format!("{short_date}/{region}/{service}/request");
    let string_to_sign = format!(
        "HMAC-SHA256\n{request_date}\n{credential_scope}\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );

    // SigningKey 派生链：kSecret -> kDate -> kRegion -> kService -> kSigning。
    let k_date = hmac_sha256(credentials.secret_key.as_bytes(), short_date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={SIGNED_HEADERS}, Signature={signature}",
        credentials.access_key
    );

    ArkSignature {
        x_date: request_date,
        x_content_sha256: payload_hash,
        authorization,
    }
}

/// 从网关主机名解析签名用的 `(service, region)`。
///
/// 火山引擎 OpenAPI 主机形如 `ark.cn-beijing.volcengineapi.com`
/// （`{service}.{region}.volcengineapi.com`）；无法解析时回退 Ark 默认值。
pub(crate) fn service_region_from_host(host: &str) -> (String, String) {
    let host = host.trim().to_ascii_lowercase();
    let segments: Vec<&str> = host.split('.').collect();
    if segments.len() >= 4
        && segments[segments.len() - 2] == "volcengineapi"
        && segments[segments.len() - 1] == "com"
    {
        let service = segments[0].trim();
        let region = segments[1].trim();
        if !service.is_empty() && !region.is_empty() {
            return (service.to_string(), region.to_string());
        }
    }
    (ARK_SERVICE.to_string(), ARK_REGION.to_string())
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC-SHA256 accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone as _;

    use super::*;

    /// 官方文档《签名示例》（https://www.volcengine.com/docs/6369/67270）的完整向量：
    /// GET iam.volcengineapi.com ListUsers、时间 20240619T071306Z、
    /// AK `AKLTYWViMTVmZGYzM2E0NDI5Mzk2MDZjNjFmMjc2MjRjMzg`、
    /// SK `WkRZeE1EQmxPVGhsWWpWak5HVmtNbUUxTXpZeU9UVXlOMlE1TmpZeVlqTQ==`。
    ///
    /// 文档逐步给出 CanonicalRequest 的 SHA256、SigningKey 与最终 Signature 的
    /// 期望值，本测试逐项比对，校验整条派生链（CanonicalRequest → StringToSign →
    /// kSigning → Signature）。文档示例的 SignedHeaders 为 `host;x-date`
    /// （GET 无请求体），这里手工构造官方示例的 CanonicalRequest 并驱动派生链；
    /// `sign_request` 的集成覆盖见 `signature_covers_query_payload_and_time`。
    #[test]
    fn signature_matches_official_document_vector() {
        let credentials = ArkCredentials {
            access_key: "AKLTYWViMTVmZGYzM2E0NDI5Mzk2MDZjNjFmMjc2MjRjMzg".into(),
            secret_key: "WkRZeE1EQmxPVGhsWWpWak5HVmtNbUUxTXpZeU9UVXlOMlE1TmpZeVlqTQ==".into(),
        };
        let payload_hash = hex::encode(Sha256::digest(b""));
        // 官方示例：空请求体。
        assert_eq!(
            payload_hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        let canonical_request = "GET\n/\nAction=ListUsers&Limit=10&Offset=0&Version=2018-01-01\n\
            host:iam.volcengineapi.com\nx-date:20240619T071306Z\n\n\
            host;x-date\n\
            e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let hashed_canonical_request = hex::encode(Sha256::digest(canonical_request.as_bytes()));
        assert_eq!(
            hashed_canonical_request,
            "5ed5bca3905e1fcbf789abb56a17c2d819674a3bcfa468ae476bd1ea80d135cb"
        );

        let string_to_sign = "HMAC-SHA256\n20240619T071306Z\n20240619/cn-beijing/iam/request\n\
            5ed5bca3905e1fcbf789abb56a17c2d819674a3bcfa468ae476bd1ea80d135cb";
        let k_date = hmac_sha256(credentials.secret_key.as_bytes(), b"20240619");
        let k_region = hmac_sha256(&k_date, b"cn-beijing");
        let k_service = hmac_sha256(&k_region, b"iam");
        let k_signing = hmac_sha256(&k_service, b"request");
        assert_eq!(
            hex::encode(&k_signing),
            "abee62e533a58934c49954459a3c3237d2fccea517c9a7c8a2651d8ea7779826"
        );
        let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));
        assert_eq!(
            signature,
            "e31c4558bcfe08a286001f59cedbf0791ffd0b2362f10e55ee2627467bcdde93"
        );

        let authorization = format!(
            "HMAC-SHA256 Credential={}/20240619/cn-beijing/iam/request, \
             SignedHeaders=host;x-date, Signature={signature}",
            credentials.access_key
        );
        assert_eq!(
            authorization,
            "HMAC-SHA256 Credential=AKLTYWViMTVmZGYzM2E0NDI5Mzk2MDZjNjFmMjc2MjRjMzg/20240619/cn-beijing/iam/request, \
             SignedHeaders=host;x-date, \
             Signature=e31c4558bcfe08a286001f59cedbf0791ffd0b2362f10e55ee2627467bcdde93"
        );
    }

    #[test]
    fn signature_covers_query_payload_and_time() {
        let credentials = ArkCredentials {
            access_key: "AK".into(),
            secret_key: "SK".into(),
        };
        let now = Utc.with_ymd_and_hms(2026, 9, 9, 1, 2, 3).unwrap();
        let base = sign_request(
            &credentials,
            ARK_SERVICE,
            ARK_REGION,
            "POST",
            "/",
            &[
                ("Action".into(), "ListAssets".into()),
                ("Version".into(), ARK_API_VERSION.into()),
            ],
            "ark.cn-beijing.volcengineapi.com",
            "application/json",
            "{}",
            &now,
        );
        // 任一输入变化（body / action / 时间）都应产生不同签名。
        let changed_body = sign_request(
            &credentials,
            ARK_SERVICE,
            ARK_REGION,
            "POST",
            "/",
            &[
                ("Action".into(), "ListAssets".into()),
                ("Version".into(), ARK_API_VERSION.into()),
            ],
            "ark.cn-beijing.volcengineapi.com",
            "application/json",
            "{\"Filter\":{}}",
            &now,
        );
        let changed_action = sign_request(
            &credentials,
            ARK_SERVICE,
            ARK_REGION,
            "POST",
            "/",
            &[
                ("Action".into(), "CreateAsset".into()),
                ("Version".into(), ARK_API_VERSION.into()),
            ],
            "ark.cn-beijing.volcengineapi.com",
            "application/json",
            "{}",
            &now,
        );
        let changed_time = sign_request(
            &credentials,
            ARK_SERVICE,
            ARK_REGION,
            "POST",
            "/",
            &[
                ("Action".into(), "ListAssets".into()),
                ("Version".into(), ARK_API_VERSION.into()),
            ],
            "ark.cn-beijing.volcengineapi.com",
            "application/json",
            "{}",
            &Utc.with_ymd_and_hms(2026, 9, 9, 1, 2, 4).unwrap(),
        );
        assert_ne!(base.authorization, changed_body.authorization);
        assert_ne!(base.authorization, changed_action.authorization);
        assert_ne!(base.authorization, changed_time.authorization);
    }

    #[test]
    fn service_region_is_parsed_from_gateway_host() {
        assert_eq!(
            service_region_from_host("ark.cn-beijing.volcengineapi.com"),
            (ARK_SERVICE.to_string(), "cn-beijing".to_string())
        );
        // 非网关主机回退 Ark 默认值。
        assert_eq!(
            service_region_from_host("example.com"),
            (ARK_SERVICE.to_string(), ARK_REGION.to_string())
        );
    }

    #[test]
    fn credentials_parse_trims_and_validates() {
        let parsed =
            ArkCredentials::parse(" {\"accessKey\": \" AK123 \\n\", \"secretKey\": \"SK456\\n\"} ")
                .expect("parse should succeed");
        assert_eq!(
            parsed,
            ArkCredentials {
                access_key: "AK123".into(),
                secret_key: "SK456".into(),
            }
        );
        assert!(ArkCredentials::parse("not-json").is_err());
        assert!(ArkCredentials::parse("{\"accessKey\":\"\",\"secretKey\":\"\"}").is_err());
    }
}
