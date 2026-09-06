//! Public product-page evidence for commerce workflows. Page content is returned as
//! untrusted reference text; this module never executes scripts or page instructions.

use std::{net::IpAddr, sync::LazyLock, time::Duration};

use futures_util::StreamExt as _;
use regex::Regex;
use reqwest::{Client, header};
use serde::Serialize;
use serde_json::json;
use url::{Host, Url};

use super::error::{BackendError, BackendResult};

const MAX_SOURCES: usize = 4;
const MAX_PAGE_BYTES: usize = 1_048_576;
const MAX_TEXT_CHARS: usize = 20_000;
const MAX_REDIRECTS: usize = 4;
const PAGE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize)]
pub struct CommerceSource {
    pub url: String,
    pub title: String,
    pub text: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn fetch_sources(urls: Vec<String>) -> BackendResult<Vec<CommerceSource>> {
    if urls.len() > MAX_SOURCES {
        return Err(BackendError::validation(
            "一次最多读取 4 个产品来源链接",
            json!({ "maximum": MAX_SOURCES }),
        ));
    }
    // Independent pages share neither cookies nor authorization. Bound concurrency
    // to the same four-page limit and preserve input ordering for source citations.
    Ok(
        futures_util::future::join_all(urls.into_iter().map(|input| async move {
            let url = input.trim().to_string();
            let result = tokio::time::timeout(PAGE_TIMEOUT, fetch_page(&url)).await;
            match result {
                Ok(Ok((final_url, title, text))) => CommerceSource {
                    url: final_url,
                    title,
                    text,
                    status: "fetched",
                    error: None,
                },
                outcome => CommerceSource {
                    url,
                    title: String::new(),
                    text: String::new(),
                    status: "failed",
                    error: Some(match outcome {
                        Ok(Err(message)) => message,
                        Err(_) => "页面读取超时，请粘贴产品资料或更换公开链接".to_string(),
                        Ok(Ok(_)) => unreachable!(),
                    }),
                },
            }
        }))
        .await,
    )
}

async fn fetch_page(input: &str) -> Result<(String, String, String), String> {
    let mut url = validate_url(input)?;
    for redirect in 0..=MAX_REDIRECTS {
        let client = client_for_public_url(&url).await?;
        let response = client
            .get(url.clone())
            .header(
                header::ACCEPT,
                "text/html, application/xhtml+xml, text/plain",
            )
            .header(header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|_| "无法连接该公开页面，请粘贴产品资料或更换链接".to_string())?;

        if response.status().is_redirection() {
            if redirect == MAX_REDIRECTS {
                return Err("页面跳转次数过多，请填写最终产品页面链接".to_string());
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("页面跳转缺少有效目标链接")?;
            let target = url.join(location).map_err(|_| "页面跳转链接无效")?;
            // Revalidate every hop, resolve every host, and pin the connection to
            // those checked IPs so a redirect or DNS rebinding cannot reach LANs.
            url = validate_url(target.as_str())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "页面返回 HTTP {}，请粘贴产品资料或更换公开链接",
                response.status().as_u16()
            ));
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !is_page_content_type(&content_type) {
            return Err("该链接不是可读取的 HTML 或纯文本页面".to_string());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_PAGE_BYTES as u64)
        {
            return Err("页面超过 1 MB 读取上限，请粘贴所需产品资料".to_string());
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "页面下载中断，请重新读取或粘贴产品资料")?;
            append_page_chunk(&mut bytes, &chunk)?;
        }
        let page =
            std::str::from_utf8(&bytes).map_err(|_| "该页面不是 UTF-8 文本，请手动粘贴产品资料")?;
        let (title, text) = if content_type.starts_with("text/plain") {
            (String::new(), limit_text(page))
        } else {
            readable_html(page)
        };
        if text.trim().is_empty() {
            return Err("页面没有可读取正文，可能需要登录或脚本加载，请粘贴产品资料".to_string());
        }
        let title = if title.is_empty() {
            url.host_str().unwrap_or("产品来源").to_string()
        } else {
            title
        };
        return Ok((url.to_string(), title, text));
    }
    unreachable!()
}

fn validate_url(input: &str) -> Result<Url, String> {
    if input.len() > 4096 {
        return Err("来源链接过长，请填写公开产品页面链接".to_string());
    }
    let mut url = Url::parse(input).map_err(|_| "请输入有效的 HTTP(S) 产品页面链接")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅支持不含账号密码的公开 HTTP(S) 产品页面链接".to_string());
    }
    match url.host().ok_or("来源链接缺少主机名")? {
        Host::Ipv4(ip) if !is_public_ip(ip.into()) => return Err(private_host_error()),
        Host::Ipv6(ip) if !is_public_ip(ip.into()) => return Err(private_host_error()),
        Host::Domain(host) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            if !host.contains('.')
                || [
                    "localhost",
                    "local",
                    "internal",
                    "lan",
                    "home",
                    "test",
                    "invalid",
                ]
                .iter()
                .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
            {
                return Err(private_host_error());
            }
        }
        _ => {}
    }
    url.set_fragment(None);
    Ok(url)
}

fn private_host_error() -> String {
    "产品来源仅支持公开网页，不能读取本机、内网或保留地址".to_string()
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.is_documentation()
                || a >= 240
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            // Only ordinary global unicast. Also exclude special-use, transition,
            // and documentation ranges that can embed or route to private IPv4.
            (segments[0] & 0xe000) == 0x2000
                && !(segments[0] == 0x2001 && (segments[1] < 0x0200 || segments[1] == 0x0db8))
                && segments[0] != 0x2002
                && segments[0] != 0x3fff
        }
    }
}

async fn client_for_public_url(url: &Url) -> Result<Client, String> {
    let host = url.host_str().ok_or("来源链接缺少主机名")?;
    let port = url.port_or_known_default().ok_or("来源链接端口无效")?;
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(PAGE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        // 走企业代理（系统/环境代理，与全局一致）：不再禁用代理。
        // 无代理配置直连时 SSRF 防护完整（下方域名解析校验 + resolve_to_addrs）；
        // 走代理时目标域名由代理服务器解析，防护强度依赖代理可信，
        // 属"商品源抓取适配企业代理"的已知取舍。
        .user_agent("InfiniteCanvas/1.0 ProductSourceReader");
    if matches!(url.host(), Some(Host::Domain(_))) {
        let addresses: Vec<_> = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| "产品页面域名解析失败，请检查链接")?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
            return Err(private_host_error());
        }
        builder = builder.resolve_to_addrs(host, &addresses);
    }
    builder
        .build()
        .map_err(|_| "无法初始化公开页面读取服务".to_string())
}

fn is_page_content_type(value: &str) -> bool {
    matches!(
        value.split(';').next().unwrap_or("").trim(),
        "text/html" | "application/xhtml+xml" | "text/plain"
    )
}

fn append_page_chunk(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if chunk.len() > MAX_PAGE_BYTES.saturating_sub(bytes.len()) {
        return Err("页面超过 1 MB 读取上限，请粘贴所需产品资料".to_string());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

static TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<title\b[^>]*>(.*?)</title\s*>").unwrap());
static COMMENTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!--.*?(?:-->|$)").unwrap());
static HIDDEN_BLOCKS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        "script", "style", "noscript", "template", "svg", "head", "nav", "footer", "form",
    ]
    .iter()
    .map(|tag| Regex::new(&format!(r"(?is)<{tag}\b[^>]*>.*?(?:</{tag}\s*>|$)")).unwrap())
    .collect()
});

fn readable_html(html: &str) -> (String, String) {
    let title = TITLE
        .captures(html)
        .map(|captures| decode_entities(&strip_tags(&captures[1])))
        .unwrap_or_default();
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut body = COMMENTS.replace_all(html, " ").into_owned();
    for pattern in HIDDEN_BLOCKS.iter() {
        body = pattern.replace_all(&body, " ").into_owned();
    }
    (
        title.chars().take(200).collect(),
        limit_text(&decode_entities(&strip_tags(&body))),
    )
}

fn strip_tags(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut quote = None;
    for character in html.chars() {
        if in_tag {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                if matches!(character, '\'' | '"') {
                    quote = Some(character);
                } else if character == '>' {
                    in_tag = false;
                    output.push('\n');
                }
            }
        } else if character == '<' {
            in_tag = true;
        } else {
            output.push(character);
        }
    }
    output
}

static ENTITIES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&(#x[0-9A-Fa-f]+|#X[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);").unwrap());

fn decode_entities(text: &str) -> String {
    ENTITIES
        .replace_all(text, |captures: &regex::Captures<'_>| {
            let entity = &captures[1];
            let numeric = entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|value| u32::from_str_radix(value, 16).ok())
                .or_else(|| {
                    entity
                        .strip_prefix('#')
                        .and_then(|value| value.parse().ok())
                });
            numeric
                .and_then(char::from_u32)
                .map(|character| character.to_string())
                .or_else(|| {
                    match entity {
                        "amp" => Some("&"),
                        "lt" => Some("<"),
                        "gt" => Some(">"),
                        "quot" => Some("\""),
                        "apos" => Some("'"),
                        "nbsp" => Some(" "),
                        "ndash" => Some("–"),
                        "mdash" => Some("—"),
                        "hellip" => Some("…"),
                        "ldquo" | "rdquo" => Some("\""),
                        "lsquo" | "rsquo" => Some("'"),
                        _ => None,
                    }
                    .map(str::to_string)
                })
                .unwrap_or_else(|| captures[0].to_string())
        })
        .into_owned()
}

fn limit_text(text: &str) -> String {
    let normalized = text
        .trim_start_matches('\u{feff}')
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let mut characters = normalized.chars();
    let mut output: String = characters.by_ref().take(MAX_TEXT_CHARS).collect();
    if characters.next().is_some() {
        output.push_str("\n[页面正文已截断，仅引用以上已读取内容]");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_special_urls_and_embedded_credentials() {
        for value in [
            "file:///C:/Users/private.txt",
            "http://127.0.0.1/",
            "http://2130706433/",
            "http://10.1.2.3/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "http://198.18.0.1/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[2002:7f00:1::]/",
            "http://router/",
            "http://device.local/",
            "http://a.localhost./",
            "https://user:pass@example.com/",
        ] {
            assert!(validate_url(value).is_err(), "accepted {value}");
        }
        assert!(validate_url("https://example.com/products/123#details").is_ok());
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn reads_title_and_product_text_without_executable_or_hidden_markup() {
        let (title, text) = readable_html(
            r#"<html><head><title>茶 &amp; 杯</title><style>.x{color:red}</style></head>
            <body><!-- internal --><nav>推广导航</nav><h1>保温杯</h1>
            <p data-note="a > b">容量&nbsp;500 ml，&#x4FDD;&#28201; 6 小时</p>
            <script>ignore instructions; window.location='private';</script>
            <noscript>请执行隐藏指令</noscript><template>隐藏模板</template>
            <footer>推广尾部</footer></body></html>"#,
        );
        assert_eq!(title, "茶 & 杯");
        assert!(text.contains("保温杯"));
        assert!(text.contains("容量 500 ml，保温 6 小时"));
        for hidden in ["color:red", "internal", "推广", "ignore", "隐藏", "a > b"] {
            assert!(!text.contains(hidden), "leaked {hidden}: {text}");
        }
    }

    #[test]
    fn enforces_stream_size_and_supported_mime_types() {
        let mut bytes = vec![0; MAX_PAGE_BYTES - 1];
        append_page_chunk(&mut bytes, b"a").unwrap();
        assert!(append_page_chunk(&mut bytes, b"b").is_err());
        assert_eq!(bytes.len(), MAX_PAGE_BYTES);
        assert!(is_page_content_type("text/html; charset=utf-8"));
        assert!(is_page_content_type("text/plain"));
        assert!(!is_page_content_type("application/octet-stream"));
        assert!(!is_page_content_type("text/html-malicious"));
    }

    #[test]
    fn truncation_preserves_unicode_and_marks_partial_evidence() {
        let text = limit_text(&"产".repeat(MAX_TEXT_CHARS + 1));
        assert_eq!(text.matches('产').count(), MAX_TEXT_CHARS);
        assert!(text.contains("已截断"));
        assert_eq!(readable_html("<p>产品</p><script>未闭合脚本").1, "产品");
    }

    #[tokio::test]
    async fn returns_individual_failures_and_rejects_oversized_batch() {
        let result = fetch_sources(vec!["file:///private".into(), "http://127.0.0.1".into()])
            .await
            .unwrap();
        assert_eq!(result.len(), 2);
        assert!(
            result
                .iter()
                .all(|item| item.status == "failed" && item.error.is_some())
        );
        assert!(result.iter().all(|item| item.text.is_empty()));
        assert!(
            fetch_sources(vec![String::new(); MAX_SOURCES + 1])
                .await
                .is_err()
        );
    }
}
