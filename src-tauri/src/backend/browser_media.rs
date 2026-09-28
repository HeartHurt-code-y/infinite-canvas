//! Use the bundled local Chromium to inspect first-party video pages when a
//! site extractor does not expose a playable media format. URLs enter on stdin
//! and never appear in process arguments or diagnostic logs.

use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::header::HeaderValue;
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use url::Url;

use super::process_tree::ProcessTree;
use super::remotion_renderer::RemotionRenderService;

// Douyin short-link navigation, page navigation and detail response each have
// their own bounded waits; allow the outer process deadline to cover them.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RESULT_BYTES: usize = 64 * 1024;
const MAX_AUTH_INPUT_BYTES: usize = 64 * 1024;
const MAX_SITE_COOKIES: usize = 64;

#[derive(Clone, Copy)]
pub(super) enum SiteResolver {
    Douyin,
    Rednote,
}

impl SiteResolver {
    fn script_name(self) -> &'static str {
        match self {
            Self::Douyin => "resolve-douyin.mjs",
            Self::Rednote => "resolve-rednote.mjs",
        }
    }

    fn allows_cookie_domain(self, domain: &str) -> bool {
        let domain = domain.trim_start_matches('.').to_ascii_lowercase();
        let allowed = match self {
            Self::Douyin => &["douyin.com", "iesdouyin.com"][..],
            Self::Rednote => &["xiaohongshu.com", "rednote.com"][..],
        };
        allowed
            .iter()
            .any(|suffix| domain == *suffix || domain.ends_with(&format!(".{suffix}")))
    }

    fn allows_download_cookie_domain(self, domain: &str) -> bool {
        if self.allows_cookie_domain(domain) {
            return true;
        }
        let domain = domain.trim_start_matches('.').to_ascii_lowercase();
        let allowed = match self {
            Self::Douyin => &["douyinvod.com"][..],
            Self::Rednote => &["xhscdn.com", "rednotecdn.com"][..],
        };
        allowed
            .iter()
            .any(|suffix| domain == *suffix || domain.ends_with(&format!(".{suffix}")))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BrowserCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    secure: bool,
    http_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires: Option<i64>,
}

#[derive(Serialize)]
struct ResolverInput<'a> {
    url: &'a str,
    cookies: &'a [BrowserCookie],
}

/// yt-dlp should see only the requested site's cookies and its official media
/// CDN cookies, even when the imported Netscape file contains other accounts.
pub(super) fn scoped_cookie_copy(
    source: &Path,
    site: SiteResolver,
) -> Result<tempfile::TempPath, &'static str> {
    let metadata = std::fs::metadata(source).map_err(|_| "cookie file unavailable")?;
    if metadata.len() == 0 || metadata.len() > 2 * 1024 * 1024 {
        return Err("cookie file size invalid");
    }
    let contents = std::fs::read_to_string(source).map_err(|_| "cookie file unreadable")?;
    let mut scoped = String::from("# Netscape HTTP Cookie File\n");
    for line in contents.lines() {
        let record = line.strip_prefix("#HttpOnly_").unwrap_or(line);
        if record.is_empty() || record.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = record.splitn(7, '\t').collect();
        if fields.len() != 7 || !site.allows_download_cookie_domain(fields[0]) {
            continue;
        }
        // Tabs are format delimiters; reject all other control bytes.
        if line
            .chars()
            .any(|character| character != '\t' && character.is_control())
        {
            continue;
        }
        scoped.push_str(line);
        scoped.push('\n');
    }
    let mut private = tempfile::Builder::new()
        .prefix("infinite-canvas-site-cookies-")
        .suffix(".txt")
        .tempfile()
        .map_err(|_| "site cookie copy unavailable")?;
    super::credentials::write_private_file(private.path(), &scoped)
        .map_err(|_| "site cookie copy unavailable")?;
    private
        .as_file_mut()
        .sync_all()
        .map_err(|_| "site cookie copy unavailable")?;
    Ok(private.into_temp_path())
}

/// Read only cookies for the requested official site from a user-imported
/// Netscape cookies.txt. Never export the rest of the browser jar to Chromium.
pub(super) fn site_cookies_from_file(
    file: &Path,
    site: SiteResolver,
) -> Result<Vec<BrowserCookie>, &'static str> {
    let metadata = std::fs::metadata(file).map_err(|_| "cookie file unavailable")?;
    if metadata.len() == 0 || metadata.len() > 2 * 1024 * 1024 {
        return Err("cookie file size invalid");
    }
    let contents = std::fs::read_to_string(file).map_err(|_| "cookie file unreadable")?;
    let mut cookies = Vec::new();
    let mut scoped_bytes = 0usize;
    let now = chrono::Utc::now().timestamp();
    for line in contents.lines() {
        let (line, http_only) = if let Some(line) = line.strip_prefix("#HttpOnly_") {
            (line, true)
        } else {
            (line, false)
        };
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.splitn(7, '\t').collect();
        if fields.len() != 7 {
            continue;
        }
        let [raw_domain, subdomains, path, secure, expires, name, value] =
            <[&str; 7]>::try_from(fields).map_err(|_| "cookie file malformed")?;
        if !site.allows_cookie_domain(raw_domain) {
            continue;
        }
        if name.is_empty()
            || name.len() > 256
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&byte))
            || value.len() > 4096
            || path.len() > 256
            || !path.starts_with('/')
            || [raw_domain, path, name, value]
                .iter()
                .any(|part| part.chars().any(char::is_control))
        {
            continue;
        }
        let Some(include_subdomains) = parse_cookie_bool(subdomains) else {
            continue;
        };
        let Some(secure) = parse_cookie_bool(secure) else {
            continue;
        };
        let Ok(expires) = expires.parse::<i64>() else {
            continue;
        };
        if expires < 0 || expires > 4_102_444_800 || (expires > 0 && expires <= now) {
            continue;
        }
        let host = raw_domain.trim_start_matches('.').to_ascii_lowercase();
        if host.len() > 128
            || !host.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        {
            continue;
        }
        let domain = if include_subdomains {
            format!(".{host}")
        } else {
            host
        };
        scoped_bytes =
            scoped_bytes.saturating_add(name.len() + value.len() + domain.len() + path.len() + 128);
        if scoped_bytes > 48 * 1024 {
            return Err("site cookies too large");
        }
        cookies.push(BrowserCookie {
            name: name.to_string(),
            value: value.to_string(),
            domain,
            path: path.to_string(),
            secure,
            http_only,
            expires: (expires > 0).then_some(expires),
        });
        if cookies.len() > MAX_SITE_COOKIES {
            return Err("too many site cookies");
        }
    }
    Ok(cookies)
}

fn parse_cookie_bool(value: &str) -> Option<bool> {
    if value.eq_ignore_ascii_case("TRUE") {
        Some(true)
    } else if value.eq_ignore_ascii_case("FALSE") {
        Some(false)
    } else {
        None
    }
}

struct RednoteCdnCookie {
    name: String,
    value: String,
    domain: String,
    include_subdomains: bool,
    path: String,
}

/// Only CDN-scoped Netscape cookies from this download's isolated file.
/// This value must never be logged: cookie names and values can identify a user.
#[derive(Default)]
pub(super) struct RednoteCdnCookies {
    entries: Vec<RednoteCdnCookie>,
}

pub(super) fn read_rednote_cdn_cookies(file: &Path) -> Result<RednoteCdnCookies, &'static str> {
    let metadata = std::fs::metadata(file).map_err(|_| "site cookie file unavailable")?;
    if metadata.len() == 0 || metadata.len() > 2 * 1024 * 1024 {
        return Err("site cookie file size invalid");
    }
    let contents = std::fs::read_to_string(file).map_err(|_| "site cookie file unreadable")?;
    let now = chrono::Utc::now().timestamp();
    let mut entries = Vec::new();
    for line in contents.lines() {
        let record = line.strip_prefix("#HttpOnly_").unwrap_or(line);
        if record.is_empty() || record.starts_with('#') {
            continue;
        }
        let fields: Vec<_> = record.splitn(7, '\t').collect();
        let Ok([raw_domain, subdomains, path, secure, expires, name, value]) =
            <[&str; 7]>::try_from(fields)
        else {
            continue;
        };
        let domain = raw_domain.trim_start_matches('.').to_ascii_lowercase();
        if !is_rednote_cdn_domain(&domain)
            || domain.len() > 128
            || !domain.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
            || path.len() > 256
            || !path.starts_with('/')
            || path.chars().any(char::is_control)
            || name.is_empty()
            || name.len() > 256
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&byte))
            || value.len() > 4096
            || !value
                .bytes()
                .all(|byte| (0x21..=0x7e).contains(&byte) && !b"\",;\\".contains(&byte))
        {
            continue;
        }
        let Some(include_subdomains) = parse_cookie_bool(subdomains) else {
            continue;
        };
        let Some(_secure) = parse_cookie_bool(secure) else {
            continue;
        };
        let Ok(expires) = expires.parse::<i64>() else {
            continue;
        };
        if expires < 0 || expires > 4_102_444_800 || (expires > 0 && expires <= now) {
            continue;
        }
        entries.push(RednoteCdnCookie {
            name: name.to_string(),
            value: value.to_string(),
            domain,
            include_subdomains,
            path: path.to_string(),
        });
        if entries.len() > MAX_SITE_COOKIES {
            return Err("too many CDN cookies");
        }
    }
    Ok(RednoteCdnCookies { entries })
}

fn is_rednote_cdn_host(host: &str) -> bool {
    host.ends_with(".xhscdn.com") || host.ends_with(".rednotecdn.com")
}

fn is_rednote_cdn_domain(domain: &str) -> bool {
    matches!(domain, "xhscdn.com" | "rednotecdn.com") || is_rednote_cdn_host(domain)
}

impl RednoteCdnCookies {
    /// The URL is checked again here so callers cannot accidentally send these
    /// credentials to a redirect destination or an untrusted host.
    pub(super) fn header_for_url(&self, raw_url: &str) -> Option<HeaderValue> {
        let url = Url::parse(raw_url).ok()?;
        let host = url.host_str()?.to_ascii_lowercase();
        if url.scheme() != "https"
            || !is_rednote_cdn_host(&host)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return None;
        }
        let request_path = url.path();
        let mut matches: Vec<_> = self
            .entries
            .iter()
            .filter(|cookie| {
                (host == cookie.domain
                    || (cookie.include_subdomains
                        && host.ends_with(&format!(".{}", cookie.domain))))
                    && (request_path == cookie.path
                        || (request_path.starts_with(&cookie.path)
                            && (cookie.path.ends_with('/')
                                || request_path.as_bytes().get(cookie.path.len()) == Some(&b'/'))))
            })
            .collect();
        matches.sort_by_key(|cookie| std::cmp::Reverse(cookie.path.len()));
        let mut header = String::new();
        for cookie in matches {
            let extra =
                cookie.name.len() + cookie.value.len() + 1 + usize::from(!header.is_empty()) * 2;
            if header.len().saturating_add(extra) > 8 * 1024 {
                return None;
            }
            if !header.is_empty() {
                header.push_str("; ");
            }
            header.push_str(&cookie.name);
            header.push('=');
            header.push_str(&cookie.value);
        }
        (!header.is_empty())
            .then(|| HeaderValue::from_str(&header).ok())
            .flatten()
    }
}

fn binaries(runtime: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let (node, browser) = if cfg!(windows) {
        ("node.exe", "browser/chrome-headless-shell.exe")
    } else {
        ("node", "browser/chrome-headless-shell")
    };
    (runtime.join(node), runtime.join(browser))
}

pub(super) async fn resolve(
    renderer: &RemotionRenderService,
    site: SiteResolver,
    input_url: &str,
    cookies: Option<&[BrowserCookie]>,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, &'static str> {
    if cancelled.load(Ordering::Acquire) {
        return Err("cancelled");
    }
    let runtime = renderer
        .runtime_dir()
        .ok_or("browser runtime unavailable")?;
    let (node, browser) = binaries(&runtime);
    let script = runtime.join(site.script_name());
    if !node.is_file() || !browser.is_file() || !script.is_file() {
        return Err("site resolver missing from browser runtime");
    }
    let mut command = tokio::process::Command::new(node);
    command
        .arg(script)
        .arg(browser)
        .current_dir(runtime)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    ProcessTree::configure(&mut command);
    let mut child = command
        .spawn()
        .map_err(|_| "site resolver could not start")?;
    // The process cannot launch Chromium before receiving the URL on stdin.
    // Attach the process tree first so cancel/timeout reaps both processes.
    let process_tree = match ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(_) => {
            let _ = child.kill().await;
            return Err("site resolver process tree unavailable");
        }
    };
    let Some(mut stdin) = child.stdin.take() else {
        return Err("site resolver stdin unavailable");
    };
    let input = if let Some(cookies) = cookies.filter(|cookies| !cookies.is_empty()) {
        serde_json::to_vec(&ResolverInput {
            url: input_url,
            cookies,
        })
        .map_err(|_| "site auth input invalid")?
    } else {
        input_url.as_bytes().to_vec()
    };
    if input.len() > MAX_AUTH_INPUT_BYTES {
        return Err("site auth input too large");
    }
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(10), stdin.write_all(&input)) => {
            result.map_err(|_| "site resolver stdin timed out")?
                .map_err(|_| "site resolver stdin failed")?;
        }
        _ = wait_for_cancel(cancelled) => return Err("cancelled"),
    }
    drop(stdin);
    let output = tokio::select! {
        result = tokio::time::timeout(RESOLVE_TIMEOUT, child.wait_with_output()) => {
            result.map_err(|_| "site resolver timed out")?
                .map_err(|_| "site resolver process failed")?
        }
        _ = wait_for_cancel(cancelled) => return Err("cancelled"),
    };
    drop(process_tree);
    if !output.status.success() || output.stdout.len() > MAX_RESULT_BYTES {
        return Err("site resolver returned invalid output");
    }
    Ok(output.stdout)
}

async fn wait_for_cancel(cancelled: &AtomicBool) {
    while !cancelled.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolver_scripts_are_fixed_app_resources() {
        assert_eq!(SiteResolver::Douyin.script_name(), "resolve-douyin.mjs");
        assert_eq!(SiteResolver::Rednote.script_name(), "resolve-rednote.mjs");
    }

    #[test]
    fn imported_browser_state_contains_only_requested_site_cookies() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            file.path(),
            "# Netscape HTTP Cookie File\n#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tdouyin-secret\n.douyinvod.com\tTRUE\t/\tTRUE\t0\tcdn\tcdn-secret\n.xiaohongshu.com\tTRUE\t/\tTRUE\t0\tsession\txhs-secret\n.example.com\tTRUE\t/\tTRUE\t0\tsession\tother-secret\n.douyin.com.evil\tTRUE\t/\tTRUE\t0\tsession\tlookalike-secret\n",
        )
        .unwrap();
        let douyin = site_cookies_from_file(file.path(), SiteResolver::Douyin).unwrap();
        let serialized = serde_json::to_string(&ResolverInput {
            url: "https://www.douyin.com/video/7672064275116162235",
            cookies: &douyin,
        })
        .unwrap();
        assert_eq!(douyin.len(), 1);
        assert!(serialized.contains("douyin-secret"));
        assert!(serialized.contains("\"httpOnly\":true"));
        assert!(!serialized.contains("xhs-secret"));
        assert!(!serialized.contains("other-secret"));
        assert!(!serialized.contains("lookalike-secret"));
        let rednote = site_cookies_from_file(file.path(), SiteResolver::Rednote).unwrap();
        assert_eq!(rednote.len(), 1);
        let serialized = serde_json::to_string(&rednote).unwrap();
        assert!(serialized.contains("xhs-secret"));
        assert!(!serialized.contains("douyin-secret"));
        let scoped = scoped_cookie_copy(file.path(), SiteResolver::Douyin).unwrap();
        let scoped_text = std::fs::read_to_string(scoped.to_path_buf()).unwrap();
        assert!(scoped_text.contains("douyin-secret"));
        assert!(scoped_text.contains("cdn-secret"));
        assert!(!scoped_text.contains("xhs-secret"));
        assert!(!scoped_text.contains("other-secret"));
        assert!(!scoped_text.contains("lookalike-secret"));
    }

    #[test]
    fn rednote_cdn_cookies_obey_domain_path_expiry_and_https() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            file.path(),
            "# Netscape HTTP Cookie File\n#HttpOnly_.rednotecdn.com\tTRUE\t/\tTRUE\t0\tcdn_session\trednote-value\nsns-v11.rednotecdn.com\tFALSE\t/video\tTRUE\t0\tclip_auth\tclip-value\nsns-v11.rednotecdn.com\tFALSE\t/videoX\tTRUE\t0\twrong_path\twrong-value\nsns-v11.rednotecdn.com\tFALSE\t/\tTRUE\t1\texpired\texpired-value\n.xhscdn.com\tTRUE\t/\tTRUE\t0\txhs_auth\txhs-value\n.example.com\tTRUE\t/\tTRUE\t0\tunrelated\tunrelated-value\n.rednotecdn.com.evil.example\tTRUE\t/\tTRUE\t0\tlookalike\tlookalike-value\n.rednotecdn.com\tTRUE\t/\tTRUE\t0\tinjected\tbad;extra=bad\n",
        )
        .unwrap();
        let cookies = read_rednote_cdn_cookies(file.path()).unwrap();
        let rednote = cookies
            .header_for_url("https://sns-v11.rednotecdn.com/video/clip.mp4")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(rednote.contains("cdn_session=rednote-value"));
        assert!(rednote.contains("clip_auth=clip-value"));
        for excluded in [
            "wrong_path",
            "expired",
            "xhs_auth",
            "unrelated",
            "lookalike",
            "injected",
        ] {
            assert!(
                !rednote.contains(excluded),
                "{excluded} must not enter the CDN request"
            );
        }
        let boundary = cookies
            .header_for_url("https://sns-v11.rednotecdn.com/videoX/clip.mp4")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(!boundary.contains("clip_auth="));
        let xhs = cookies
            .header_for_url("https://sns-v11.xhscdn.com/clip.mp4")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert_eq!(xhs, "xhs_auth=xhs-value");
        assert!(
            cookies
                .header_for_url("http://sns-v11.rednotecdn.com/video/clip.mp4")
                .is_none()
        );
        assert!(
            cookies
                .header_for_url("https://sns-v11.rednotecdn.com:8443/video/clip.mp4")
                .is_none()
        );
        assert!(
            cookies
                .header_for_url("https://sns-v11.rednotecdn.com.evil.example/video/clip.mp4")
                .is_none()
        );
        assert!(
            cookies
                .header_for_url("https://evil.example/video/clip.mp4")
                .is_none()
        );
    }
}
