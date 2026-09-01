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
    if params.host.trim().is_empty() || params.object_key.is_empty() {
        return Err(BackendError::validation(
            "TOS presign host and object key must be non-empty",
            serde_json::json!({ "host": params.host, "objectKey": params.object_key }),
        ));
    }

    let date = params.now.format("%Y%m%d").to_string();
    let request_date = params.now.format("%Y%m%dT%H%M%SZ").to_string();
    let credential_scope = format!("{}/{}/tos/request", date, params.region);
    let credential = format!("{}/{}", params.credentials.access_key, credential_scope);

    // CanonicalURI：对象键整体编码，仅保留路径分隔符 `/`。
    let canonical_uri = format!("/{}", uri_encode(params.object_key, false));

    // CanonicalQueryString：所有参数按 key 的 ASCII 序排列；值全部 UriEncode（`/` 编码为 %2F）。
    let canonical_query = [
        ("X-Tos-Algorithm", "TOS4-HMAC-SHA256".to_string()),
        ("X-Tos-Credential", credential),
        ("X-Tos-Date", request_date.clone()),
        ("X-Tos-Expires", params.expires_secs.to_string()),
        ("X-Tos-SignedHeaders", "host".to_string()),
    ]
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

#[cfg(test)]
mod tests {
    use chrono::TimeZone as _;

    use super::*;

    /// 官方文档《URL 中包含签名》的完整签名示例：
    /// https://www.volcengine.com/docs/6349/129226
    /// 桶 examplebucket、对象 exampleobject、地域 cn-beijing、
    /// 时间 2022-01-01T00:00:00Z、AK testAK、SK testSK、有效期 86400 秒，
    /// 期望签名 353aa55583eceb222aad4bdcb70d4045a202a4af9a3096f25a656b82c8ec2f56。
    #[test]
    fn presign_matches_official_document_vector() {
        let credentials = TosCredentials {
            access_key: "testAK".into(),
            secret_key: "testSK".into(),
        };
        let url = presign_url(&PresignParams {
            method: "GET",
            host: "examplebucket.tos-cn-beijing.volces.com",
            object_key: "exampleobject",
            region: "cn-beijing",
            credentials: &credentials,
            expires_secs: 86_400,
            now: Utc.with_ymd_and_hms(2022, 1, 1, 0, 0, 0).unwrap(),
        })
        .expect("presign should succeed");
        assert_eq!(
            url,
            "https://examplebucket.tos-cn-beijing.volces.com/exampleobject\
             ?X-Tos-Algorithm=TOS4-HMAC-SHA256\
             &X-Tos-Credential=testAK%2F20220101%2Fcn-beijing%2Ftos%2Frequest\
             &X-Tos-Date=20220101T000000Z\
             &X-Tos-Expires=86400\
             &X-Tos-SignedHeaders=host\
             &X-Tos-Signature=353aa55583eceb222aad4bdcb70d4045a202a4af9a3096f25a656b82c8ec2f56"
        );
    }

    #[test]
    fn uri_encode_follows_tos_rules() {
        // 空格 -> %20；`/` 在路径形态不编码、在查询值形态编码为 %2F；十六进制大写。
        assert_eq!(uri_encode("a b/c", false), "a%20b/c");
        assert_eq!(uri_encode("a/b", true), "a%2Fb");
        assert_eq!(uri_encode("AZaz09-._~", false), "AZaz09-._~");
        assert_eq!(uri_encode("中", false), "%E4%B8%AD");
    }

    #[test]
    fn presign_encodes_object_key_segments() {
        let credentials = TosCredentials {
            access_key: "testAK".into(),
            secret_key: "testSK".into(),
        };
        let url = presign_url(&PresignParams {
            method: "PUT",
            host: "examplebucket.tos-cn-beijing.volces.com",
            object_key: "staging/a b/c~d.png",
            region: "cn-beijing",
            credentials: &credentials,
            expires_secs: 900,
            now: Utc.with_ymd_and_hms(2022, 1, 1, 0, 0, 0).unwrap(),
        })
        .expect("presign should succeed");
        assert!(
            url.starts_with(
                "https://examplebucket.tos-cn-beijing.volces.com/staging/a%20b/c~d.png?"
            )
        );
    }

    #[test]
    fn presign_rejects_invalid_expiry() {
        let credentials = TosCredentials {
            access_key: "testAK".into(),
            secret_key: "testSK".into(),
        };
        let now = Utc.with_ymd_and_hms(2022, 1, 1, 0, 0, 0).unwrap();
        for expires in [0, MAX_EXPIRES_SECS + 1] {
            let result = presign_url(&PresignParams {
                method: "GET",
                host: "examplebucket.tos-cn-beijing.volces.com",
                object_key: "exampleobject",
                region: "cn-beijing",
                credentials: &credentials,
                expires_secs: expires,
                now,
            });
            assert!(result.is_err(), "expiry {expires} should be rejected");
        }
    }

    #[test]
    fn credential_secret_roundtrip_and_validation() {
        let credentials = TosCredentials {
            access_key: "AK123".into(),
            secret_key: "SK456".into(),
        };
        // 与前端保存时组装的 JSON 形态保持一致。
        let secret = r#"{"accessKey":"AK123","secretKey":"SK456"}"#.to_string();
        assert_eq!(TosCredentials::parse(&secret).unwrap(), credentials);
        assert!(TosCredentials::parse("not json").is_err());
        assert!(
            TosCredentials::parse(r#"{"accessKey":"","secretKey":"SK"}"#).is_err(),
            "empty accessKey must be rejected"
        );
        assert!(
            TosCredentials::parse(r#"{"accessKey":"AK","secretKey":""}"#).is_err(),
            "empty secretKey must be rejected"
        );
    }

    /// 回归测试：控制台复制的 AK/SK 常带首尾空白（尤其结尾换行），
    /// 必须被 trim，否则 HMAC 用错误密钥计算 → SignatureDoesNotMatch。
    #[test]
    fn credential_secret_is_trimmed() {
        let secret = r#"{"accessKey":"  AK123\n","secretKey":"\tSK456  "}"#;
        let parsed = TosCredentials::parse(secret).unwrap();
        assert_eq!(parsed.access_key, "AK123");
        assert_eq!(parsed.secret_key, "SK456");
        // 纯空白的密钥视为空，必须拒绝。
        assert!(TosCredentials::parse(r#"{"accessKey":"  ","secretKey":"\t"}"#).is_err());
    }
}
