//! 小红书下载失败诊断与链接识别。
//!
//! 隔离浏览器（`browser_media`）已随「网络爆款视频下载」的登录捕获能力下线，
//! 因此这里只保留与浏览器无关的两件事：识别小红书/RedNote 链接是否值得回退，
//! 以及把 yt-dlp 的失败输出翻译成可执行的用户提示。

use url::Url;

/// 小红书 / RedNote 链接是否需要走专用回退路径。
pub(super) fn supports_rednote_fallback(input_url: &str) -> bool {
    classify_source_url(input_url).is_some()
}

enum SourceUrl {
    Direct,
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
    Some(SourceUrl::Direct)
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

/// 把 yt-dlp 的失败输出翻译成用户能照做的提示。
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
