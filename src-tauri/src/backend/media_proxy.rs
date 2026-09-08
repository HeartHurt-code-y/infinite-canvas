//! 媒体代理自定义协议：把云端 TOS 临时签名 URL 转换为同源的 `assetproxy://` URL，
//! 避免签名过期（2 小时）导致视频预览不可用。
//!
//! 前端把视频的 TOS 签名 URL 编码为：
//! `assetproxy://video?src=<url_encoded_tos_url>`
//! 本协议处理器收到请求后，用 reqwest 转发到上游 TOS URL，并把响应（含 Range 支持）
//! 原样返回给前端。

use std::collections::HashMap;

use tauri::{
    UriSchemeContext,
    http::{
        HeaderMap, HeaderName, HeaderValue, Method, Request, Response, Uri,
        response::Builder as ResponseBuilder,
    },
};
use url::Url;

/// 注册自定义协议时使用的 scheme 名。
pub const MEDIA_PROXY_SCHEME: &str = "assetproxy";

/// 协议处理入口：解析 `assetproxy://video?src=...` 请求，转发到上游 TOS URL。
///
/// Tauri 2 自定义协议回调签名：`Fn(UriSchemeContext, Request<Vec<u8>>) -> Response<T>`。
/// 参数按值传递，返回值直接是 Response（错误时返回 502 响应而非 Err）。
pub fn handle_media_proxy_request<R: tauri::Runtime>(
    _context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    // 只允许 GET 请求（视频播放用 GET + Range）。
    if request.method() != Method::GET {
        return method_not_allowed();
    }

    let uri = request.uri().clone();
    let upstream_url = match extract_upstream_url(&uri) {
        Some(url) => url,
        None => return bad_request("missing or invalid 'src' query parameter"),
    };

    // 转发请求到上游，传递 Range 头（视频 seek 必需）。
    // 自定义协议回调在 Tauri 运行时线程执行，用 block_on 驱动异步请求。
    let result = tokio::runtime::Handle::try_current()
        .ok()
        .unwrap_or_else(|| {
            tokio::runtime::Runtime::new()
                .expect("failed to create tokio runtime")
                .handle()
                .clone()
        })
        .block_on(async move { fetch_upstream(&upstream_url, request.headers()).await });

    match result {
        Ok((status, headers, body)) => build_response(status, headers, body),
        Err(error) => {
            tauri_plugin_log::log::warn!("media proxy upstream error: {error}");
            bad_gateway(&error.to_string())
        }
    }
}

/// 从 `assetproxy://video?src=<encoded>` URI 中提取并解码上游 URL。
fn extract_upstream_url(uri: &Uri) -> Option<String> {
    let path_and_query = uri.path_and_query()?.as_str();
    // path_and_query 形如 "/video?src=https%3A%2F%2F..."
    let query_start = path_and_query.find('?')?;
    let query = &path_and_query[query_start + 1..];
    let params: HashMap<&str, &str> = query
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((key, value))
        })
        .collect();

    let encoded = params.get("src")?;
    let decoded = percent_decode(encoded)?;
    // 校验是 http/https URL。
    let parsed = Url::parse(&decoded).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    Some(decoded)
}

/// 简易 percent-decode（不依赖 serde_urlencoded，避免新增依赖）。
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = hex_digit(bytes[i + 1])?;
                let lo = hex_digit(bytes[i + 2])?;
                output.push((hi << 4) | lo);
                i += 3;
            }
            b'+' => {
                output.push(b' ');
                i += 1;
            }
            other => {
                output.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8(output).ok()
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// 用 reqwest 请求上游 URL，传递 Range 等必要请求头。
async fn fetch_upstream(
    url: &str,
    request_headers: &HeaderMap,
) -> Result<(u16, HeaderMap, Vec<u8>), Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::builder()
        // 不跟随重定向：TOS 签名 URL 若被重定向到其他 Host，签名会失效；
        // 与 staging 专用客户端保持一致。
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    let mut request_builder = client.get(url);

    // 透传 Range 头（视频 seek）。
    if let Some(range) = request_headers.get("range") {
        if let Ok(value) = range.to_str() {
            request_builder = request_builder.header("Range", value);
        }
    }

    let response = request_builder.send().await?;
    let status = response.status().as_u16();

    // 复制响应头（过滤掉 hop-by-hop 头）。
    let mut headers = HeaderMap::new();
    for (key, value) in response.headers().iter() {
        let name = key.as_str().to_lowercase();
        if matches!(
            name.as_str(),
            "connection"
                | "keep-alive"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "te"
                | "trailers"
                | "transfer-encoding"
                | "upgrade"
        ) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(key.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) {
            headers.insert(name, value);
        }
    }

    let body = response.bytes().await?.to_vec();
    Ok((status, headers, body))
}

/// 构建 Tauri HTTP 响应。
fn build_response(status: u16, headers: HeaderMap, body: Vec<u8>) -> Response<Vec<u8>> {
    let mut builder = ResponseBuilder::new().status(status);
    for (key, value) in headers.iter() {
        if let Ok(value_str) = value.to_str() {
            builder = builder.header(key.as_str(), value_str);
        }
    }
    // 确保 CORS 头（Tauri WebView 中自定义协议通常同源，但加上更安全）。
    builder = builder.header("Access-Control-Allow-Origin", "*");
    builder
        .body(body)
        .unwrap_or_else(|error| internal_error_response(&error.to_string()))
}

// --- 错误响应辅助 ---

fn bad_request(message: &str) -> Response<Vec<u8>> {
    let body = format!("{{\"error\":\"bad_request\",\"message\":\"{message}\"}}");
    ResponseBuilder::new()
        .status(400)
        .header("Content-Type", "application/json")
        .body(body.into_bytes())
        .unwrap_or_else(|_| internal_error_response("bad request"))
}

fn method_not_allowed() -> Response<Vec<u8>> {
    ResponseBuilder::new()
        .status(405)
        .header("Content-Type", "application/json")
        .body(b"{\"error\":\"method_not_allowed\"}".to_vec())
        .unwrap_or_else(|_| internal_error_response("method not allowed"))
}

fn bad_gateway(message: &str) -> Response<Vec<u8>> {
    let escaped = message.replace('"', "\\\"").replace('\n', " ");
    let body = format!("{{\"error\":\"bad_gateway\",\"message\":\"{escaped}\"}}");
    ResponseBuilder::new()
        .status(502)
        .header("Content-Type", "application/json")
        .body(body.into_bytes())
        .unwrap_or_else(|_| internal_error_response("bad gateway"))
}

fn internal_error_response(message: &str) -> Response<Vec<u8>> {
    let body = format!("{{\"error\":\"internal_error\",\"message\":\"{message}\"}}");
    ResponseBuilder::new()
        .status(500)
        .header("Content-Type", "application/json")
        .body(body.into_bytes())
        .unwrap_or_else(|_| Response::new(b"{\"error\":\"internal_error\"}".to_vec()))
}
