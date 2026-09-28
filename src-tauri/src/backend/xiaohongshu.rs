//! 小红书浏览器解析结果校验及下载失败诊断。
//!
//! 隔离浏览器读取官方 RedNote 页面的视频状态后，本模块只接受精确笔记 ID
//! 和官方 CDN HTTPS MP4，并在下载前检查文件头。yt-dlp 回退失败时保留
//! 空笔记状态、安全拦截等具体诊断。

use std::path::Path;
use std::time::Duration;
use std::{collections::HashSet, future::Future};

use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HeaderValue, RANGE};
use serde_json::Value;
use url::Url;

use super::browser_media;

const VIDEO_LIMIT: u64 = 4 * 1024 * 1024 * 1024;

/// 只包含已验证的官方 CDN 直链，不带页面标题或分享令牌。
/// `media_url` 本身可能包含 CDN 签名，调用者不能写入日志或前端状态。
#[derive(Debug, Clone)]
pub(super) struct VerifiedRednoteMedia {
    pub media_url: String,
    pub expected_size: u64,
}

#[derive(Debug, Clone)]
pub(super) struct ResolvedRednoteVideo {
    pub note_id: String,
    pub media_candidates: Vec<VerifiedRednoteMedia>,
}

pub(super) fn supports_rednote_fallback(input_url: &str) -> bool {
    classify_source_url(input_url).is_some()
}

/// 检查隔离浏览器脚本的单行输出，再用独立 HTTPS 请求确认 CDN 文件确为 MP4。
/// 失败输出的 reason 是脚本内部静态代码，不作为诊断原文回传；任何签名 URL
/// 均不能进入日志或前端状态。
pub(super) async fn verify_browser_output(
    input_url: &str,
    stdout: &[u8],
    cookie_file: Option<&Path>,
) -> Result<Option<ResolvedRednoteVideo>, &'static str> {
    let cdn_cookies = match cookie_file {
        Some(file) => browser_media::read_rednote_cdn_cookies(file)?,
        None => browser_media::RednoteCdnCookies::default(),
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "小红书媒体验证准备失败")?;
    verify_browser_output_with(input_url, stdout, |media_url| {
        let client = &client;
        let cookie_header = cdn_cookies.header_for_url(&media_url);
        async move { verify_mp4(client, &media_url, cookie_header).await }
    })
    .await
}

async fn verify_browser_output_with<F, Fut>(
    input_url: &str,
    stdout: &[u8],
    mut verify: F,
) -> Result<Option<ResolvedRednoteVideo>, &'static str>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Option<u64>>,
{
    let Some(source) = classify_source_url(input_url) else {
        return Ok(None);
    };
    if stdout.len() > 16 * 1024 {
        return Err("小红书浏览器解析结果过大");
    }
    let result: Value = serde_json::from_slice(stdout).map_err(|_| "小红书浏览器解析结果无效")?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    let note_id = result
        .get("noteId")
        .and_then(Value::as_str)
        .filter(|id| id.len() == 24 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("小红书浏览器结果缺少有效笔记 ID")?;
    if let SourceUrl::Direct(input_id) = source {
        if !note_id.eq_ignore_ascii_case(&input_id) {
            return Err("小红书浏览器结果笔记 ID 与输入不匹配");
        }
    }
    let media_urls = result
        .get("mediaUrls")
        .and_then(Value::as_array)
        .filter(|urls| !urls.is_empty() && urls.len() <= 8)
        .ok_or("小红书浏览器结果未提供视频候选")?;
    let mut media_candidates = Vec::new();
    let mut seen = HashSet::new();
    for raw in media_urls {
        let Some(raw) = raw.as_str() else { continue };
        if !raw.starts_with("https://") || raw.len() > 2048 {
            continue;
        }
        let Some(media_url) = validated_cdn_url(raw) else {
            continue;
        };
        if !seen.insert(media_url.clone()) {
            continue;
        }
        if let Some(expected_size) = verify(media_url.clone()).await {
            media_candidates.push(VerifiedRednoteMedia {
                media_url,
                expected_size,
            });
        }
    }
    if media_candidates.is_empty() {
        return Err("小红书官方 CDN 视频流未通过 HTTPS MP4 验证");
    }
    Ok(Some(ResolvedRednoteVideo {
        note_id: note_id.to_ascii_lowercase(),
        media_candidates,
    }))
}

enum SourceUrl {
    Direct(String),
    Short,
}

fn classify_source_url(raw: &str) -> Option<SourceUrl> {
    let url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let segments: Vec<_> = url.path_segments()?.collect();
    if matches!(
        host.as_str(),
        "xhslink.com" | "www.xhslink.com" | "xhslink.cn" | "www.xhslink.cn"
    ) {
        if segments.len() != 2
            || !["o", "a", "m"]
                .iter()
                .any(|prefix| segments[0].eq_ignore_ascii_case(prefix))
            || segments[1].len() < 4
            || segments[1].len() > 64
            || !segments[1].bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return None;
        }
        return Some(SourceUrl::Short);
    }
    if !matches!(
        host.as_str(),
        "xiaohongshu.com" | "www.xiaohongshu.com" | "rednote.com" | "www.rednote.com"
    ) {
        return None;
    }
    let id = match segments.as_slice() {
        ["explore", id] | ["discovery", "item", id] => *id,
        _ => return None,
    };
    if id.len() != 24 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let id = id.to_ascii_lowercase();
    Some(SourceUrl::Direct(id))
}

fn validated_cdn_url(raw: &str) -> Option<String> {
    if raw.chars().any(char::is_control) {
        return None;
    }
    let mut url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if !(host.ends_with(".xhscdn.com") || host.ends_with(".rednotecdn.com")) {
        return None;
    }
    url.set_scheme("https").ok()?;
    Some(url.to_string())
}

async fn verify_mp4(
    client: &reqwest::Client,
    raw_url: &str,
    cookie_header: Option<HeaderValue>,
) -> Option<u64> {
    let mut head_request = client.head(raw_url);
    if let Some(value) = &cookie_header {
        head_request = head_request.header(COOKIE, value.clone());
    }
    let head = head_request.send().await.ok()?;
    if !head.status().is_success() || !is_mp4_content_type(head.headers()) {
        return None;
    }
    let size = head
        .headers()
        .get(CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .parse::<u64>()
        .ok()?;
    if !(1024..=VIDEO_LIMIT).contains(&size) {
        return None;
    }
    let mut range_request = client.get(raw_url).header(RANGE, "bytes=0-31");
    if let Some(value) = cookie_header {
        range_request = range_request.header(COOKIE, value);
    }
    let mut response = range_request.send().await.ok()?;
    if !(response.status().is_success()
        || response.status() == reqwest::StatusCode::PARTIAL_CONTENT)
        || !is_mp4_content_type(response.headers())
    {
        return None;
    }
    let mut prefix = Vec::new();
    while prefix.len() < 12 {
        let chunk = response.chunk().await.ok()??;
        prefix.extend_from_slice(&chunk[..chunk.len().min(32 - prefix.len())]);
    }
    (prefix.get(4..8) == Some(b"ftyp")).then_some(size)
}

fn is_mp4_content_type(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("video/mp4"))
}

fn is_xiaohongshu_host(host: &str) -> bool {
    matches!(
        host,
        "xiaohongshu.com"
            | "www.xiaohongshu.com"
            | "rednote.com"
            | "www.rednote.com"
            | "xhslink.com"
            | "xhslink.cn"
    ) || host.ends_with(".xiaohongshu.com")
}

pub(super) fn failure_hint(input_url: &str, stderr: &str) -> Option<&'static str> {
    let parsed = Url::parse(input_url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || !is_xiaohongshu_host(parsed.host_str()?) {
        return None;
    }

    let stderr = stderr.to_ascii_lowercase();
    if stderr.contains("/404/sec_")
        || (stderr.contains("unsupported url") && stderr.contains("xiaohongshu.com/404"))
    {
        return Some(
            "提示：小红书把此分享链接跳转到了安全拦截页，当前会话无法取得视频。请在已登录的小红书浏览器或 App 中重新复制完整分享链接，并选用对应的登录态重试；若站点仍拦截，请稍后在浏览器内确认该笔记可播放。",
        );
    }
    if stderr.contains("no video formats found")
        || stderr.contains("unable to extract initial state")
    {
        return Some(
            "提示：小红书当前返回的笔记页面没有可供提取的视频流（可能是空笔记状态、无效分享令牌或非视频笔记）。请在已登录的小红书浏览器或 App 中重新复制保留完整查询参数的分享链接，并选用对应的登录态重试；若浏览器可播放但仍失败，可能是站点限制了提取器。",
        );
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        SourceUrl, classify_source_url, failure_hint, validated_cdn_url, verify_browser_output,
        verify_browser_output_with,
    };

    #[test]
    fn explains_empty_note_state_without_exposing_share_token() {
        let url = "https://www.xiaohongshu.com/explore/123?xsec_token=private-token";
        let hint = failure_hint(url, "ERROR: [XiaoHongShu] 123: No video formats found!").unwrap();
        assert!(hint.contains("没有可供提取的视频流"));
        assert!(!hint.contains("private-token"));
    }

    #[test]
    fn explains_short_link_security_redirect() {
        let hint = failure_hint(
            "http://xhslink.com/o/example",
            "ERROR: Unsupported URL: https://www.xiaohongshu.com/404?source=/404/sec_abc",
        )
        .unwrap();
        assert!(hint.contains("安全拦截页"));
    }

    #[test]
    fn does_not_classify_other_hosts_or_unrelated_failures() {
        assert!(
            failure_hint(
                "https://www.xiaohongshu.com.evil.example/explore/123",
                "No video formats found!",
            )
            .is_none()
        );
        assert!(
            failure_hint("https://www.xiaohongshu.com/explore/123", "HTTP Error 503",).is_none()
        );
    }

    #[test]
    fn accepts_only_official_note_urls_and_short_links() {
        assert!(matches!(
            classify_source_url(
                "https://www.xiaohongshu.com/discovery/item/6aab4a3f000000000d02574a?xsec_token=abc"
            ),
            Some(SourceUrl::Direct(_))
        ));
        assert!(matches!(
            classify_source_url("http://xhslink.com/o/5R8D9WCH5SX"),
            Some(SourceUrl::Short)
        ));
        assert!(matches!(
            classify_source_url("https://xhslink.com/A/5R8D9WCH5SX"),
            Some(SourceUrl::Short)
        ));
        for url in [
            "https://www.xiaohongshu.com.evil.example/discovery/item/6aab4a3f000000000d02574a",
            "https://www.xiaohongshu.com:444/discovery/item/6aab4a3f000000000d02574a",
            "https://www.xiaohongshu.com/discovery/item/not-a-note-id",
            "https://xhslink.com/o/../../localhost",
        ] {
            assert!(classify_source_url(url).is_none(), "{url}");
        }
    }

    #[test]
    fn upgrades_only_allowlisted_cdn_to_https() {
        assert_eq!(
            validated_cdn_url("http://sns-v11.rednotecdn.com/a.mp4").as_deref(),
            Some("https://sns-v11.rednotecdn.com/a.mp4")
        );
        assert!(validated_cdn_url("http://sns-v11.rednotecdn.com.evil.example/a.mp4").is_none());
        assert!(validated_cdn_url("https://127.0.0.1/video.mp4").is_none());
        assert!(validated_cdn_url("https://sns-v11.rednotecdn.com:444/a.mp4").is_none());
    }

    #[tokio::test]
    async fn browser_result_rejects_mismatched_id_and_untrusted_media() {
        let input = "https://www.xiaohongshu.com/explore/6aab4a3f000000000d02574a";
        let mismatch = br#"{"ok":true,"noteId":"6aab4a3f000000000d02574b","mediaUrls":["https://sns-v11.rednotecdn.com/a.mp4"]}"#;
        assert_eq!(
            verify_browser_output(input, mismatch, None)
                .await
                .unwrap_err(),
            "小红书浏览器结果笔记 ID 与输入不匹配"
        );
        let untrusted = br#"{"ok":true,"noteId":"6aab4a3f000000000d02574a","mediaUrls":["https://127.0.0.1/video.mp4"]}"#;
        assert_eq!(
            verify_browser_output(input, untrusted, None)
                .await
                .unwrap_err(),
            "小红书官方 CDN 视频流未通过 HTTPS MP4 验证"
        );
        assert!(
            verify_browser_output(input, br#"{"ok":false,"reason":"not_video"}"#, None)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn retains_verified_backup_streams_in_order() {
        let input = "https://www.xiaohongshu.com/explore/6aab4a3f000000000d02574a";
        let stdout = br#"{"ok":true,"noteId":"6aab4a3f000000000d02574a","mediaUrls":["https://sns-v11.rednotecdn.com/first.mp4","https://evil.example/clip.mp4","https://sns-v11.rednotecdn.com/expired.mp4","https://sns-v11.rednotecdn.com/second.mp4","https://sns-v11.rednotecdn.com/first.mp4"]}"#;
        let checked = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let result = verify_browser_output_with(input, stdout, |url| {
            let checked = checked.clone();
            async move {
                checked.lock().unwrap().push(url.clone());
                if url.ends_with("first.mp4") {
                    Some(1024)
                } else if url.ends_with("second.mp4") {
                    Some(2048)
                } else {
                    None
                }
            }
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result.note_id, "6aab4a3f000000000d02574a");
        assert_eq!(result.media_candidates.len(), 2);
        assert!(result.media_candidates[0].media_url.ends_with("first.mp4"));
        assert_eq!(result.media_candidates[0].expected_size, 1024);
        assert!(result.media_candidates[1].media_url.ends_with("second.mp4"));
        assert_eq!(result.media_candidates[1].expected_size, 2048);
        let checked = checked.lock().unwrap();
        assert_eq!(
            checked.len(),
            3,
            "untrusted and duplicate URLs must not be verified"
        );
    }

    #[tokio::test]
    async fn single_verified_stream_stays_downloadable() {
        let input = "https://www.xiaohongshu.com/explore/6aab4a3f000000000d02574a";
        let stdout = br#"{"ok":true,"noteId":"6aab4a3f000000000d02574a","mediaUrls":["https://sns-v11.rednotecdn.com/only.mp4"]}"#;
        let result = verify_browser_output_with(input, stdout, |_| async { Some(4096) })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.media_candidates.len(), 1);
        assert_eq!(result.media_candidates[0].expected_size, 4096);
    }

    #[tokio::test]
    #[ignore = "requires a live public Xiaohongshu video and browser resolver output"]
    async fn browser_output_live_smoke() {
        let stdout = std::env::var("XHS_TEST_RESOLVER_JSON").expect("missing live resolver JSON");
        let video =
            verify_browser_output("http://xhslink.com/o/5R8D9WCH5SX", stdout.as_bytes(), None)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(video.note_id, "6aab4a3f000000000d02574a");
        let first = &video.media_candidates[0];
        assert!(first.expected_size > 1024);
        assert!(
            first
                .media_url
                .starts_with("https://sns-v11.rednotecdn.com/")
        );
        let host = url::Url::parse(&first.media_url).unwrap();
        println!(
            "note_id={} bytes={} cdn_host={}",
            video.note_id,
            first.expected_size,
            host.host_str().unwrap()
        );
    }
}
