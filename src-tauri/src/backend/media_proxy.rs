//! Native media protocol for HTTP(S) videos whose origins do not allow WebView CORS.
//! This transports bytes; refreshing expiring provider URLs belongs to the asset library.
//!
//! 图片预览在这里落盘复用（见 `media_cache`）：自定义协议的响应 WebView 不会缓存，
//! 素材库卡片与画布节点每次重挂载都会重新下载同一张图；同一份素材下载一次之后，
//! 后续请求（含重启后、签名过期后、远端暂时不可达时）直接由本地副本应答。

use std::{path::PathBuf, time::Duration};

use tauri::{
    Manager as _, UriSchemeContext, UriSchemeResponder,
    http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, Uri},
};
use url::Url;

use super::media_cache::{
    MediaCache, is_cacheable_content_type, permits_storage, within_entry_limit,
};

pub const MEDIA_PROXY_SCHEME: &str = "assetproxy";

/// 上游单次返回的最大分块（8 MiB）。WebView 视频栈用 `Range: bytes=X-` 探测/续播大媒体，
/// 把开放区间钳制为固定窗口后，每个请求的内存上界恒定，避免整段视频常驻内存。
/// 说明：Tauri 自定义协议的响应体必须是完整 `Vec<u8>`，无法向 WebView 真流式；
/// 分块是约束内存的唯一手段。若上游不支持 Range 返回 200 全量，则退化为旧行为（全量缓冲）。
const MAX_RANGE_CHUNK_BYTES: u64 = 8 * 1024 * 1024;

/// 把开放区间 `bytes=X-` 钳制为 `bytes=X-{X+chunk-1}`；有界区间、后缀区间与
/// 多区间请求保持原样（返回 None 即不修改）。
fn clamp_open_ended_range(header: &HeaderValue) -> Option<HeaderValue> {
    let raw = header.to_str().ok()?;
    let start = raw.trim().strip_prefix("bytes=")?.strip_suffix('-')?;
    let start: u64 = start.parse().ok()?;
    let end = start
        .saturating_add(MAX_RANGE_CHUNK_BYTES)
        .saturating_sub(1);
    HeaderValue::from_str(&format!("bytes={start}-{end}")).ok()
}

/// Use Tauri's persistent async runtime; never block a WebView callback or create a
/// short-lived runtime whose I/O drivers have already been dropped.
pub fn handle_media_proxy_request<R: tauri::Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    // 缓存目录按应用数据目录解析；解析失败（路径不可用）时退化为直连穿透。
    let cache = context
        .app_handle()
        .path()
        .app_local_data_dir()
        .ok()
        .map(|directory| MediaCache::new(preview_cache_directory(&directory)));
    tauri::async_runtime::spawn(async move {
        responder.respond(proxy_response(request, cache.as_ref()).await);
    });
}

/// 预览媒体缓存目录：与缩略图缓存同级，便于用户按需整体清理。
fn preview_cache_directory(local_data: &std::path::Path) -> PathBuf {
    local_data.join("media-preview-cache")
}

async fn proxy_response(
    request: Request<Vec<u8>>,
    cache: Option<&MediaCache>,
) -> Response<Vec<u8>> {
    if request.method() == Method::OPTIONS {
        return build_response(StatusCode::NO_CONTENT, HeaderMap::new(), Vec::new());
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return error_response(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", false);
    }
    let is_head = request.method() == Method::HEAD;
    let Some(upstream_url) = extract_upstream_url(request.uri()) else {
        return error_response(StatusCode::BAD_REQUEST, "invalid_media_source", is_head);
    };
    // Range 请求（视频探测/续播）不参与缓存：分块响应不是完整内容。
    let range_requested = request.headers().contains_key("range");
    if let Some(cache) = cache {
        if !range_requested {
            if let Some(cached) = cache.read(&upstream_url) {
                return cached_response(cached.content_type, cached.body, is_head);
            }
        }
    }
    match fetch_upstream(&upstream_url, request.method().clone(), request.headers()).await {
        Ok((status, mut headers, body)) => {
            if status == StatusCode::RANGE_NOT_SATISFIABLE {
                headers.insert("content-length", HeaderValue::from_static("0"));
                build_response(status, headers, Vec::new())
            } else if status.is_success() {
                store_cacheable(
                    cache,
                    &upstream_url,
                    &status,
                    &headers,
                    &body,
                    range_requested,
                );
                let cached_control =
                    response_cache_header(&status, &headers, &body, range_requested);
                if let Some(value) = cached_control {
                    headers.insert("cache-control", value);
                }
                build_response(status, headers, body)
            } else {
                // 远端明确报错（常见于签名过期）：本地有副本时继续用副本，
                // 不必把一屏已经下载过的预览打成「预览不可用」。
                if let Some(cache) = cache {
                    if let Some(cached) = cache.read(&upstream_url) {
                        return cached_response(cached.content_type, cached.body, is_head);
                    }
                }
                // Upstream error pages can echo signed URLs or authentication details.
                let status = if status.is_redirection() {
                    StatusCode::BAD_GATEWAY
                } else {
                    status
                };
                error_response(status, "upstream_media_error", is_head)
            }
        }
        Err(error) => {
            let kind = if error.is_timeout() {
                "media_source_timeout"
            } else if error.is_redirect() {
                "media_source_redirect_error"
            } else {
                "media_source_unavailable"
            };
            // Reqwest's Display may include a signed URL; record only a fixed category.
            tauri_plugin_log::log::warn!("media proxy failed: {kind}");
            if let Some(cache) = cache {
                if let Some(cached) = cache.read(&upstream_url) {
                    return cached_response(cached.content_type, cached.body, is_head);
                }
            }
            error_response(StatusCode::BAD_GATEWAY, kind, is_head)
        }
    }
}

/// 命中本地副本时的响应：长度按缓存文件重算，不再回放上游那一次的元数据。
fn cached_response(
    content_type: Option<String>,
    body: Vec<u8>,
    is_head: bool,
) -> Response<Vec<u8>> {
    let mut headers = HeaderMap::new();
    if let Some(content_type) = content_type.and_then(|value| HeaderValue::from_str(&value).ok()) {
        headers.insert("content-type", content_type);
    }
    headers.insert("accept-ranges", HeaderValue::from_static("none"));
    headers.insert(
        "cache-control",
        HeaderValue::from_static("private, max-age=86400"),
    );
    let length = body.len();
    let body = if is_head { Vec::new() } else { body };
    if let Ok(value) = HeaderValue::from_str(&length.to_string()) {
        headers.insert("content-length", value);
    }
    build_response(StatusCode::OK, headers, body)
}

/// 判断这份响应是否值得落盘；只有完整、图片、未被上游禁止的响应才写入。
fn store_cacheable(
    cache: Option<&MediaCache>,
    upstream_url: &Url,
    status: &StatusCode,
    headers: &HeaderMap,
    body: &[u8],
    range_requested: bool,
) {
    let Some(cache) = cache else {
        return;
    };
    if range_requested || *status != StatusCode::OK {
        return;
    }
    let content_type = header_str(headers, "content-type");
    if !is_cacheable_content_type(content_type)
        || !permits_storage(header_str(headers, "cache-control"))
    {
        return;
    }
    if !within_entry_limit(header_u64(headers, "content-length").or(Some(body.len() as u64))) {
        return;
    }
    cache.store(upstream_url, content_type, body);
}

/// 落盘成功的响应附上缓存指令，让 WebView 在内存里也复用同一份内容。
fn response_cache_header(
    status: &StatusCode,
    headers: &HeaderMap,
    body: &[u8],
    range_requested: bool,
) -> Option<HeaderValue> {
    if range_requested || *status != StatusCode::OK {
        return None;
    }
    let content_type = header_str(headers, "content-type");
    if !is_cacheable_content_type(content_type) {
        return None;
    }
    if !within_entry_limit(Some(body.len() as u64)) {
        return None;
    }
    Some(HeaderValue::from_static("private, max-age=86400"))
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn header_u64(headers: &HeaderMap, name: &str) -> Option<u64> {
    header_str(headers, name)?.trim().parse().ok()
}

fn extract_upstream_url(uri: &Uri) -> Option<Url> {
    let query = uri.query()?;
    let source = url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "src")?
        .1;
    let url = Url::parse(&source).ok()?;
    valid_upstream(&url).then_some(url)
}

fn valid_upstream(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

async fn fetch_upstream(
    url: &Url,
    method: Method,
    request_headers: &HeaderMap,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), reqwest::Error> {
    let client = reqwest::Client::builder()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(120))
        .referer(false)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("media redirect limit reached")
            } else if !valid_upstream(attempt.url()) {
                attempt.error("unsupported media redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()?;
    // Range 单独处理：开放区间钳制为固定窗口，约束单请求内存；其余区间原样转发。
    // 先计算 outgoing（method 之后被 move），再构建请求。
    let outgoing_range = request_headers.get("range").map(|value| {
        if method == Method::GET {
            clamp_open_ended_range(value).unwrap_or_else(|| value.clone())
        } else {
            value.clone()
        }
    });
    let mut builder = client
        .request(method, url.clone())
        .header("accept-encoding", "identity");
    // Intentionally do not forward WebView cookies, authorization, origin or referer.
    // These two validators are needed for seek and resumed media requests.
    if let Some(value) = request_headers.get("if-range") {
        builder = builder.header("if-range", value.clone());
    }
    if let Some(outgoing) = outgoing_range {
        builder = builder.header("range", outgoing);
    }
    let response = builder.send().await?;
    let status = response.status();
    let mut headers = HeaderMap::new();
    // A response allowlist excludes hop-by-hop headers, Set-Cookie and upstream CORS.
    // Preserve range metadata and validators, including on HEAD and 416 responses.
    for name in [
        "content-type",
        "content-length",
        "content-range",
        "content-encoding",
        "accept-ranges",
        "etag",
        "last-modified",
        "cache-control",
        "expires",
    ] {
        if let Some(value) = response.headers().get(name) {
            headers.insert(name, value.clone());
        }
    }
    let body = response.bytes().await?.to_vec();
    Ok((status, headers, body))
}

fn build_response(status: StatusCode, mut headers: HeaderMap, body: Vec<u8>) -> Response<Vec<u8>> {
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    headers.insert(
        "access-control-allow-headers",
        HeaderValue::from_static("Range, If-Range, Content-Type"),
    );
    headers.insert(
        "access-control-expose-headers",
        HeaderValue::from_static(
            "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
        ),
    );
    headers.insert("allow", HeaderValue::from_static("GET, HEAD, OPTIONS"));
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

fn error_response(status: StatusCode, error: &str, is_head: bool) -> Response<Vec<u8>> {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    let body = if is_head {
        Vec::new()
    } else {
        serde_json::json!({ "error": error })
            .to_string()
            .into_bytes()
    };
    build_response(status, headers, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        thread,
    };

    struct HttpFixture {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl HttpFixture {
        fn new() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let captured = requests.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = stop.clone();
            let worker = thread::spawn(move || {
                while !stopping.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut buffer = Vec::new();
                    loop {
                        let mut chunk = [0u8; 1024];
                        let Ok(count) = stream.read(&mut chunk) else {
                            break;
                        };
                        if count == 0 {
                            break;
                        }
                        buffer.extend_from_slice(&chunk[..count]);
                        if buffer.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let request = String::from_utf8_lossy(&buffer).into_owned();
                    let first = request.lines().next().unwrap_or_default();
                    let path = first.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let is_head = first.starts_with("HEAD ");
                    let lower = request.to_ascii_lowercase();
                    let (status, mut headers, body) = match path.as_str() {
                        "/redirect" => (
                            "302 Found",
                            format!("Location: http://localhost:{port}/media\r\n"),
                            "",
                        ),
                        "/loop" => ("302 Found", "Location: /loop\r\n".into(), ""),
                        "/unsupported" => ("302 Found", "Location: file:///secret.mp4\r\n".into(), ""),
                        "/fail" => ("503 Service Unavailable", String::new(), "secret-signed-url"),
                        "/media" if lower.contains("range: bytes=1-3") => (
                            "206 Partial Content",
                            "Content-Range: bytes 1-3/5\r\n".into(),
                            "ide",
                        ),
                        // 代理对开放区间 `bytes=0-` 的钳制请求：上游以分块 206 响应。
                        "/media" if lower.contains("range: bytes=0-") => (
                            "206 Partial Content",
                            format!("Content-Range: bytes 0-{}/5\r\n", MAX_RANGE_CHUNK_BYTES - 1),
                            "video",
                        ),
                        "/media" if lower.contains("range: bytes=99-") => (
                            "416 Range Not Satisfiable",
                            "Content-Range: bytes */5\r\n".into(),
                            "",
                        ),
                        "/cors" => (
                            "200 OK",
                            "Access-Control-Allow-Origin: https://upstream.example\r\nSet-Cookie: secret=1\r\n".into(),
                            "video",
                        ),
                        // 图片预览：缓存测试用的可缓存响应。更具体的路径必须先匹配，
                        // 否则会被下面的 `/image` 兜底吃掉。
                        "/image-no-store" => (
                            "200 OK",
                            "Content-Type: image/png\r\nCache-Control: no-store\r\n".into(),
                            "PNGBYTES",
                        ),
                        // 同一路径先成功、后失败：用于验证「远端报错时本地副本接管」。
                        "/image-flaky" if lower.contains("x-fail") => (
                            "503 Service Unavailable",
                            "Content-Type: text/plain\r\n".into(),
                            "secret-signed-url",
                        ),
                        path if path.starts_with("/image") => (
                            "200 OK",
                            "Content-Type: image/png\r\nCache-Control: public, max-age=3600\r\n".into(),
                            if path == "/image-deny" { "" } else { "PNGBYTES" },
                        ),
                        _ => ("200 OK", String::new(), "video"),
                    };
                    // 图片路径自带 Content-Type，不再追加视频头。路径要在 `request` 被 move
                    // 进夹具记录之前转成自有字符串（它借用自 `request`）。
                    let is_image_response = path.starts_with("/image");
                    captured.lock().unwrap().push(request);
                    if !is_image_response {
                        headers.push_str(&format!(
                            "Content-Type: video/mp4\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"media-v1\"\r\nConnection: close\r\n",
                            body.len(),
                        ));
                    } else if !headers.contains("Content-Length:") {
                        headers.push_str(&format!("Content-Length: {}\r\n", body.len()));
                    }
                    let response = format!(
                        "HTTP/1.1 {status}\r\n{headers}\r\n{}",
                        if is_head { "" } else { body },
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
            });
            Self {
                url: format!("http://127.0.0.1:{port}"),
                requests,
                stop,
                worker: Some(worker),
            }
        }

        fn request(&self, method: Method, path: &str) -> tauri::http::request::Builder {
            let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
            url.query_pairs_mut()
                .append_pair("src", &format!("{}{path}", self.url));
            Request::builder().method(method).uri(url.as_str())
        }
    }

    impl Drop for HttpFixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.worker.take().unwrap().join().unwrap();
        }
    }

    /// 无缓存穿透语义：既有的传输层用例只关心代理转发，不关心缓存。
    async fn proxy_response_uncached(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        proxy_response(request, None).await
    }

    fn test_cache() -> (tempfile::TempDir, MediaCache) {
        let directory = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(directory.path().join("media-preview-cache"));
        (directory, cache)
    }

    #[tokio::test]
    async fn follows_a_no_cors_http_redirect_and_preserves_the_media_body() {
        let server = HttpFixture::new();
        let response = proxy_response_uncached(
            server
                .request(Method::GET, "/redirect")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"video");
        assert_eq!(response.headers()["content-type"], "video/mp4");
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn forwards_range_and_if_range_but_not_webview_credentials_across_hosts() {
        let server = HttpFixture::new();
        let response = proxy_response_uncached(
            server
                .request(Method::GET, "/redirect")
                .header("range", "bytes=1-3")
                .header("if-range", "\"media-v1\"")
                .header("cookie", "session=secret")
                .header("authorization", "Bearer secret")
                .header("referer", "https://app.example/?signed=secret")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"ide");
        assert_eq!(response.headers()["content-range"], "bytes 1-3/5");
        assert_eq!(response.headers()["content-length"], "3");
        for request in server.requests.lock().unwrap().iter() {
            let request = request.to_ascii_lowercase();
            assert!(request.contains("range: bytes=1-3"));
            assert!(request.contains("if-range: \"media-v1\""));
            assert!(!request.contains("secret"));
        }
    }

    #[tokio::test]
    async fn clamps_open_ended_ranges_to_a_bounded_chunk_and_passes_the_partial_response() {
        let server = HttpFixture::new();
        let response = proxy_response_uncached(
            server
                .request(Method::GET, "/media")
                .header("range", "bytes=0-")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        // 上游收到钳制后的分块请求，206 分块响应（头/体）原样透传给 WebView。
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"video");
        assert_eq!(
            response.headers()["content-range"],
            format!("bytes 0-{}/5", MAX_RANGE_CHUNK_BYTES - 1)
        );
        let requests = server.requests.lock().unwrap();
        let last = requests.last().unwrap().to_ascii_lowercase();
        assert!(last.contains(&format!("range: bytes=0-{}", MAX_RANGE_CHUNK_BYTES - 1)));
        assert!(!last.contains("\nrange: bytes=0-\r\n"));
    }

    #[test]
    fn range_clamping_only_rewrites_open_ended_byte_ranges() {
        let clamp = |value: &str| {
            clamp_open_ended_range(&HeaderValue::from_str(value).unwrap())
                .and_then(|header| header.to_str().ok().map(str::to_owned))
        };
        assert_eq!(
            clamp("bytes=8388607-").as_deref(),
            Some("bytes=8388607-16777214")
        );
        // 有界区间、后缀区间、多区间与非 bytes 单位不重写。
        assert_eq!(clamp("bytes=1-3").as_deref(), None);
        assert_eq!(clamp("bytes=-500").as_deref(), None);
        assert_eq!(clamp("bytes=0-1,5-6").as_deref(), None);
        assert_eq!(clamp("chunks=0-").as_deref(), None);
    }

    #[tokio::test]
    async fn preserves_head_and_unsatisfiable_ranges() {
        let server = HttpFixture::new();
        let head = proxy_response_uncached(
            server
                .request(Method::HEAD, "/media")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
        assert_eq!(head.headers()["content-length"], "5");
        let range = proxy_response_uncached(
            server
                .request(Method::GET, "/media")
                .header("range", "bytes=99-")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        assert_eq!(range.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(range.headers()["content-range"], "bytes */5");
        assert_eq!(range.headers()["access-control-allow-origin"], "*");
    }

    #[tokio::test]
    async fn replaces_upstream_cors_and_omits_cookies() {
        let server = HttpFixture::new();
        let response = proxy_response_uncached(
            server
                .request(Method::GET, "/cors")
                .body(Vec::new())
                .unwrap(),
        )
        .await;
        assert_eq!(
            response
                .headers()
                .get_all("access-control-allow-origin")
                .iter()
                .count(),
            1
        );
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        assert!(!response.headers().contains_key("set-cookie"));
    }

    #[tokio::test]
    async fn bounds_redirects_and_redacts_upstream_failures() {
        let server = HttpFixture::new();
        for path in ["/loop", "/unsupported", "/fail"] {
            let response = proxy_response_uncached(
                server.request(Method::GET, path).body(Vec::new()).unwrap(),
            )
            .await;
            assert!(response.status().is_server_error());
            assert_eq!(response.headers()["access-control-allow-origin"], "*");
            let body = String::from_utf8_lossy(response.body());
            assert!(!body.contains("secret"));
            assert!(!body.contains(&server.url));
        }
        assert!(server.requests.lock().unwrap().len() <= 8);
    }

    #[tokio::test]
    async fn provides_cors_for_preflight_invalid_sources_and_unsupported_methods() {
        for (method, status) in [
            (Method::OPTIONS, StatusCode::NO_CONTENT),
            (Method::POST, StatusCode::METHOD_NOT_ALLOWED),
            (Method::GET, StatusCode::BAD_REQUEST),
        ] {
            let response = proxy_response_uncached(
                Request::builder()
                    .method(method)
                    .uri("http://assetproxy.localhost/video")
                    .body(Vec::new())
                    .unwrap(),
            )
            .await;
            assert_eq!(response.status(), status);
            assert_eq!(response.headers()["access-control-allow-origin"], "*");
            assert_eq!(
                response.headers()["access-control-allow-headers"],
                "Range, If-Range, Content-Type"
            );
        }
    }

    #[tokio::test]
    async fn serves_a_repeated_image_preview_from_the_local_copy_without_asking_upstream_again() {
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();
        let source = Url::parse(&format!("{}/image.png?sig=first", server.url)).unwrap();
        let request = || {
            let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
            url.query_pairs_mut().append_pair("src", source.as_str());
            Request::builder()
                .method(Method::GET)
                .uri(url.as_str())
                .body(Vec::new())
                .unwrap()
        };

        let first = proxy_response(request(), Some(&cache)).await;
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(first.body(), b"PNGBYTES");
        assert_eq!(server.requests.lock().unwrap().len(), 1);

        // 第二次（重开面板 / 重挂载卡片 / 重启后同一素材）：不再打扰上游，直接回本地副本。
        let second = proxy_response(request(), Some(&cache)).await;
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(second.body(), b"PNGBYTES");
        assert_eq!(second.headers()["content-length"], "8");
        assert_eq!(second.headers()["content-type"], "image/png");
        assert_eq!(second.headers()["cache-control"], "private, max-age=86400");
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "命中缓存后不得再请求上游"
        );

        // 续签换了签名参数：仍是同一对象，继续命中同一份副本。
        let resigned = Url::parse(&format!("{}/image.png?sig=second", server.url)).unwrap();
        assert!(cache.read(&resigned).is_some());
    }

    #[tokio::test]
    async fn falls_back_to_the_local_copy_when_upstream_fails() {
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();
        let source = format!("{}/image-flaky", server.url);
        let signed = Url::parse(&format!("{source}?sig=1")).unwrap();
        let request = |fail: bool| {
            let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
            url.query_pairs_mut()
                .append_pair("src", &format!("{source}?sig={}", if fail { 2 } else { 1 }));
            let builder = Request::builder().method(Method::GET).uri(url.as_str());
            let builder = if fail {
                builder.header("x-fail", "1")
            } else {
                builder
            };
            builder.body(Vec::new()).unwrap()
        };

        // 先成功取一次：字节落盘。
        let first = proxy_response(request(false), Some(&cache)).await;
        assert_eq!(first.status(), StatusCode::OK);
        assert!(cache.read(&signed).is_some());

        // 远端随后报错（典型是签名过期 / 网络不可达）：本地副本接管，预览不再变成「不可用」。
        let second = proxy_response(request(true), Some(&cache)).await;
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(second.body(), b"PNGBYTES");
        assert_eq!(second.headers()["content-type"], "image/png");
        // 上游错误正文可能带签名或认证细节，不能被透传出去。
        assert!(!String::from_utf8_lossy(second.body()).contains("secret"));
    }

    #[tokio::test]
    async fn does_not_cache_video_bodies_ranges_or_no_store_images() {
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();

        // 视频正文：不落盘（按 Range 播放）。
        let video = proxy_response(
            server
                .request(Method::GET, "/media")
                .body(Vec::new())
                .unwrap(),
            Some(&cache),
        )
        .await;
        assert_eq!(video.status(), StatusCode::OK);
        assert!(
            cache
                .read(&Url::parse(&format!("{}/media", server.url)).unwrap())
                .is_none()
        );

        // 上游声明 no-store：尊重其意图，不落盘。
        let no_store = proxy_response(
            server
                .request(Method::GET, "/image-no-store")
                .body(Vec::new())
                .unwrap(),
            Some(&cache),
        )
        .await;
        assert_eq!(no_store.status(), StatusCode::OK);
        assert!(
            cache
                .read(&Url::parse(&format!("{}/image-no-store", server.url)).unwrap())
                .is_none()
        );

        // Range 请求（视频续播）即使是图片也不写缓存：分块响应不是完整内容。
        let ranged = proxy_response(
            server
                .request(Method::GET, "/image.png")
                .header("range", "bytes=0-3")
                .body(Vec::new())
                .unwrap(),
            Some(&cache),
        )
        .await;
        assert!(ranged.status().is_success());
        assert!(
            cache
                .read(&Url::parse(&format!("{}/image.png", server.url)).unwrap())
                .is_none()
        );
    }

    #[tokio::test]
    async fn answers_head_from_the_local_copy_without_a_body() {
        let server = HttpFixture::new();
        let (_guard, cache) = test_cache();
        let source = Url::parse(&format!("{}/image.png", server.url)).unwrap();
        cache.store(&source, Some("image/png"), b"PNGBYTES");

        let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
        url.query_pairs_mut().append_pair("src", source.as_str());
        let response = proxy_response(
            Request::builder()
                .method(Method::HEAD)
                .uri(url.as_str())
                .body(Vec::new())
                .unwrap(),
            Some(&cache),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.body().is_empty());
        assert_eq!(response.headers()["content-length"], "8");
        assert_eq!(server.requests.lock().unwrap().len(), 0);
    }

    #[test]
    fn accepts_native_and_webview_proxy_uris_without_corrupting_signed_queries() {
        let original = "https://cdn.example/video.mp4?token=a%2Bb&signature=x+y";
        for prefix in [
            "assetproxy://video",
            "assetproxy://localhost/video",
            "http://assetproxy.localhost/video",
        ] {
            let mut url = Url::parse(prefix).unwrap();
            url.query_pairs_mut().append_pair("src", original);
            let uri: Uri = url.as_str().parse().unwrap();
            assert_eq!(extract_upstream_url(&uri).unwrap().as_str(), original);
        }
        for source in [
            "file:///C:/video.mp4",
            "data:video/mp4,test",
            "https://user:secret@cdn.example/video",
        ] {
            let mut url = Url::parse("http://assetproxy.localhost/video").unwrap();
            url.query_pairs_mut().append_pair("src", source);
            assert!(extract_upstream_url(&url.as_str().parse().unwrap()).is_none());
        }
    }
}
