//! 登录捕获：下载遇到登录/站点验证墙时，弹出「可见」的系统 Chromium 系
//! 浏览器（Edge/Chrome/Brave/Chromium），用户在窗口里完成登录或验证；
//! 运行时脚本通过 playwright 读取该站点 Cookie，Rust 侧校验后写成
//! Netscape 会话文件，供本次重试与后续下载复用。
//!
//! 安全边界：URL 与临时 profile 路径走 stdin，不进进程参数与日志；脚本
//! stderr 只在 stdout 契约被破坏（启动即崩溃、浏览器尚未启动）时截取尾部
//! 进日志。Cookie 只允许目标站点主域（含官方 CDN），会话文件经
//! `credentials::write_private_file` 落盘；浏览器使用独立临时 profile，
//! 不读取也不污染用户已登录的真实浏览器。

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;

use super::process_tree::ProcessTree;
use super::remotion_renderer::RemotionRenderService;

/// 用户在可见浏览器里完成登录的耐心上限；脚本内部超时略短，留出进程收尾余量。
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(360);
const MAX_RESULT_BYTES: usize = 512 * 1024;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_SITE_COOKIES: usize = 64;
/// 契约被破坏时 stderr 尾部日志的行数与单行字符上限，防止刷爆日志。
const STDERR_TAIL_LINES: usize = 5;
const STDERR_TAIL_LINE_CHARS: usize = 300;

/// 支持登录捕获的站点。判定与 Cookie 范围都只认主域及其子域。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum LoginSite {
    Douyin,
    Rednote,
    Bilibili,
}

impl LoginSite {
    /// 会话文件名，存放在下载引擎目录。
    pub(super) fn session_file_name(self) -> &'static str {
        match self {
            Self::Douyin => "session-douyin.txt",
            Self::Rednote => "session-rednote.txt",
            Self::Bilibili => "session-bilibili.txt",
        }
    }

    /// 会话文件允许的 Cookie 主域：登录态域 + 官方媒体 CDN（对齐
    /// browser_media 的下载口径）。
    fn allows_cookie_domain(self, domain: &str) -> bool {
        let domain = domain.trim_start_matches('.').to_ascii_lowercase();
        let allowed: &[&str] = match self {
            Self::Douyin => &["douyin.com", "iesdouyin.com", "douyinvod.com"],
            Self::Rednote => &["xiaohongshu.com", "xhscdn.com", "rednotecdn.com"],
            Self::Bilibili => &["bilibili.com"],
        };
        allowed
            .iter()
            .any(|apex| domain == *apex || domain.ends_with(&format!(".{apex}")))
    }

    pub(super) fn for_url(value: &str) -> Option<Self> {
        let url = url::Url::parse(value).ok()?;
        if url.scheme() != "https" {
            return None;
        }
        let host = url.host_str()?.to_ascii_lowercase();
        let matches = |apexes: &[&str]| {
            apexes
                .iter()
                .any(|apex| host == *apex || host.ends_with(&format!(".{apex}")))
        };
        if matches(&["douyin.com", "iesdouyin.com"]) {
            Some(Self::Douyin)
        } else if matches(&["xiaohongshu.com"]) {
            Some(Self::Rednote)
        } else if matches(&["bilibili.com", "b23.tv"]) {
            Some(Self::Bilibili)
        } else {
            None
        }
    }
}

/// 等待登录期间展示给用户的任务状态文案。
pub(super) fn login_prompt_text(site: LoginSite) -> String {
    let site_name = match site {
        LoginSite::Douyin => "抖音",
        LoginSite::Rednote => "小红书",
        LoginSite::Bilibili => "哔哩哔哩",
    };
    format!(
        "下载需要登录或站点验证：已打开{site_name}的浏览器窗口，请在窗口中完成登录或验证，完成后会自动继续下载；不需要登录时可直接关闭窗口。"
    )
}

/// 依据失败诊断判断该站点是否值得弹窗登录。只认稳定的引擎错误签名，
/// 避免把无关失败也升级成弹窗。
pub(super) fn login_capture_required(url: &str, diagnostics: &str) -> Option<LoginSite> {
    let site = LoginSite::for_url(url)?;
    let lower = diagnostics.to_ascii_lowercase();
    let needed = match site {
        // 抖音详情接口风控的统一口径：yt-dlp 把空详情统一报成 Fresh cookies，
        // 与是否真的登录无关；可见浏览器里通过一次站点验证即可刷新。
        LoginSite::Douyin => lower.contains("fresh cookies"),
        LoginSite::Rednote | LoginSite::Bilibili => {
            ["login", "请登录", "登录后", "registered users"]
                .iter()
                .any(|signature| lower.contains(signature))
        }
    };
    needed.then_some(site)
}

/// 运行时脚本回传的单条 Cookie（字段已在脚本侧过滤，这里再严格校验一遍）。
#[derive(Debug)]
pub(super) struct ScriptCookie {
    name: String,
    value: String,
    /// 保留 Netscape 惯例：前导点表示包含子域。
    domain: String,
    path: String,
    secure: bool,
    http_only: bool,
    /// Unix 秒；None/-1 为会话 Cookie，落盘为 0。
    expires: Option<i64>,
}

fn valid_cookie_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&byte))
}

fn parse_script_cookies(payload: &Value, site: LoginSite) -> Option<Vec<ScriptCookie>> {
    let entries = payload.get("cookies")?.as_array()?;
    let mut cookies = Vec::new();
    for entry in entries {
        if cookies.len() >= MAX_SITE_COOKIES {
            break;
        }
        let (Some(name), Some(value), Some(domain), Some(path)) = (
            entry.get("name").and_then(Value::as_str),
            entry.get("value").and_then(Value::as_str),
            entry.get("domain").and_then(Value::as_str),
            entry.get("path").and_then(Value::as_str),
        ) else {
            continue;
        };
        let host = domain.trim_start_matches('.').to_ascii_lowercase();
        let domain_ok = host.len() <= 128
            && site.allows_cookie_domain(domain)
            && host.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            });
        if !domain_ok
            || !valid_cookie_name(name)
            || value.is_empty()
            || value.len() > 4096
            || value.chars().any(char::is_control)
            || path.len() > 256
            || !path.starts_with('/')
            || path.chars().any(char::is_control)
        {
            continue;
        }
        let expires = match entry.get("expires") {
            None => None,
            Some(value) => match value.as_i64() {
                // -1（会话 Cookie）合法；其余必须在合理年份内。
                Some(-1) => None,
                Some(seconds) if (0..=4_102_444_800).contains(&seconds) => Some(seconds),
                _ => continue,
            },
        };
        cookies.push(ScriptCookie {
            name: name.to_string(),
            value: value.to_string(),
            domain: domain.to_ascii_lowercase(),
            path: path.to_string(),
            secure: entry
                .get("secure")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            http_only: entry
                .get("httpOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            expires,
        });
    }
    (!cookies.is_empty()).then_some(cookies)
}

/// 把脚本回传的 Cookie 写成 yt-dlp 可读的 Netscape cookies.txt。
fn netscape_text(site: LoginSite, cookies: &[ScriptCookie]) -> String {
    let mut scoped: Vec<&ScriptCookie> = cookies
        .iter()
        .filter(|cookie| site.allows_cookie_domain(&cookie.domain))
        .collect();
    scoped.truncate(MAX_SITE_COOKIES);
    let mut text = String::from("# Netscape HTTP Cookie File\n");
    for cookie in scoped {
        let include_subdomains = cookie.domain.starts_with('.');
        text.push_str(&format!(
            "{http_only}{domain}\t{include}\t{path}\t{secure}\t{expires}\t{name}\t{value}\n",
            http_only = if cookie.http_only { "#HttpOnly_" } else { "" },
            domain = cookie.domain,
            include = if include_subdomains { "TRUE" } else { "FALSE" },
            path = cookie.path,
            secure = if cookie.secure { "TRUE" } else { "FALSE" },
            expires = cookie.expires.unwrap_or(0),
            name = cookie.name,
            value = cookie.value,
        ));
    }
    text
}

/// 契约被破坏时（脚本崩溃于模块加载期、浏览器尚未启动，不可能有 Cookie）
/// 截取 stderr 尾部进日志，把「bytes=0」这类盲区变成可诊断的信号。
/// 逐行去空白、只留尾部、按字符截断，避免截出半个字符或刷爆日志。
fn stderr_tail_lines(stderr: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines.len().saturating_sub(STDERR_TAIL_LINES);
    lines[start..]
        .iter()
        .map(|line| line.chars().take(STDERR_TAIL_LINE_CHARS).collect())
        .collect()
}

/// 登录捕获与站点解析共用：脚本没写出 JSON 契约时记录 stderr 尾部。
pub(super) fn log_stderr_tail(context: &str, stderr: &[u8]) {
    let lines = stderr_tail_lines(stderr);
    if lines.is_empty() {
        tauri_plugin_log::log::warn!("{context} 脚本无任何输出（stdout 未写出 JSON，stderr 为空）");
        return;
    }
    tauri_plugin_log::log::warn!(
        "{context} 脚本启动即失败（stdout 未写出 JSON），stderr 尾部 {} 行：",
        lines.len()
    );
    for line in lines {
        tauri_plugin_log::log::warn!("{context} stderr| {line}");
    }
}

/// 解析脚本回传的 stdout 契约。脚本无论成败都把单行 JSON 写到 stdout
/// （失败时 exitCode=1），所以错误原因以 stdout 为准，退出码只用来兜底
/// 识别脚本连 JSON 都没写出来的崩溃——此时附带 stderr 尾部定位启动失败。
/// 日志只记 code/detail 与字节数，不记 stdout 原文（成功路径含 Cookie 值）。
fn interpret_capture_output(
    status_success: bool,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<Value, &'static str> {
    if stdout.len() > MAX_RESULT_BYTES {
        tauri_plugin_log::log::warn!("[登录捕获] 脚本输出超限：bytes={}", stdout.len());
        return Err("login capture returned invalid output");
    }
    let payload: Value = match serde_json::from_slice(stdout) {
        Ok(payload) => payload,
        Err(_) => {
            tauri_plugin_log::log::warn!(
                "[登录捕获] 脚本输出不是 JSON：bytes={}, exit_ok={}",
                stdout.len(),
                status_success
            );
            log_stderr_tail("[登录捕获]", stderr);
            return Err("login capture returned invalid output");
        }
    };
    if payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(payload);
    }
    let code = payload
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let detail = payload
        .get("detail")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mapped = match code {
        "browser_unavailable" => "login capture browser unavailable",
        "login_timeout" => "login capture login timeout",
        "browser_closed" => "login capture browser closed early",
        "invalid_input" | "unsupported_url" => "login capture input rejected",
        "unexpected_state" => "login capture unexpected state",
        _ if !status_success && code.is_empty() => "login capture returned invalid output",
        _ => "login capture script error",
    };
    tauri_plugin_log::log::warn!(
        "[登录捕获] 站点脚本上报失败：code={code}, detail={detail}, exit_ok={status_success}, 归类={mapped}"
    );
    Err(mapped)
}

/// 弹出可见浏览器等待用户登录，返回可直接落盘的 Netscape 会话文本。
/// 浏览器由脚本负责关闭；取消与超时由本函数强制回收进程树。
pub(super) async fn capture(
    renderer: &RemotionRenderService,
    site: LoginSite,
    page_url: &str,
    cancelled: &AtomicBool,
) -> Result<String, &'static str> {
    if cancelled.load(Ordering::Acquire) {
        return Err("cancelled");
    }
    let runtime = renderer
        .runtime_dir()
        .ok_or("login capture runtime unavailable")?;
    let node = if cfg!(windows) {
        runtime.join("node.exe")
    } else {
        runtime.join("node")
    };
    let script = runtime.join("capture-login.mjs");
    if !node.is_file() || !script.is_file() {
        return Err("login capture script unavailable");
    }
    let profile = tempfile::TempDir::new().map_err(|error| {
        tauri_plugin_log::log::warn!("[登录捕获] 临时 profile 创建失败：{error}");
        "login profile unavailable"
    })?;
    let mut command = tokio::process::Command::new(&node);
    command
        .arg(&script)
        .current_dir(runtime)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // stderr 平时不入日志：只有 stdout 契约被破坏（启动即崩溃、浏览器
        // 尚未启动）时才截取尾部，崩溃路径不可能携带 Cookie。
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    // 只隐藏 node 自身的控制台；浏览器是 GUI 子进程，窗口照常弹出。
    command.creation_flags(0x0800_0000);
    ProcessTree::configure(&mut command);
    let mut child = command.spawn().map_err(|error| {
        tauri_plugin_log::log::warn!("[登录捕获] 脚本进程启动失败：{error}");
        "login capture could not start"
    })?;
    let process_tree = match ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(_) => {
            let _ = child.kill().await;
            return Err("login capture process tree unavailable");
        }
    };
    let input = serde_json::json!({
        "url": page_url,
        "profileDir": profile.path().to_string_lossy(),
    })
    .to_string();
    if input.len() > MAX_INPUT_BYTES {
        return Err("login capture input too large");
    }
    let Some(mut stdin) = child.stdin.take() else {
        return Err("login capture stdin unavailable");
    };
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(10), stdin.write_all(input.as_bytes())) => {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tauri_plugin_log::log::warn!("[登录捕获] stdin 写入失败：{error}");
                    return Err("login capture stdin failed");
                }
                Err(_) => {
                    tauri_plugin_log::log::warn!("[登录捕获] stdin 写入超时（10 秒）");
                    return Err("login capture stdin timed out");
                }
            }
        }
        _ = wait_for_cancel(cancelled) => return Err("cancelled"),
    }
    drop(stdin);
    let output = tokio::select! {
        result = tokio::time::timeout(CAPTURE_TIMEOUT, child.wait_with_output()) => {
            match result {
                Ok(Ok(output)) => output,
                Ok(Err(error)) => {
                    tauri_plugin_log::log::warn!("[登录捕获] 脚本进程异常退出：{error}");
                    return Err("login capture process failed");
                }
                Err(_) => {
                    tauri_plugin_log::log::warn!(
                        "[登录捕获] 等待脚本退出超时（{} 秒），已强制结束",
                        CAPTURE_TIMEOUT.as_secs()
                    );
                    return Err("login capture timed out");
                }
            }
        }
        _ = wait_for_cancel(cancelled) => return Err("cancelled"),
    };
    drop(process_tree);
    drop(profile);
    let payload =
        interpret_capture_output(output.status.success(), &output.stdout, &output.stderr)?;
    // 站点与允许域由本侧再判定一次，不信任脚本回传的站点字段。
    parse_script_cookies(&payload, site)
        .map(|cookies| netscape_text(site, &cookies))
        .ok_or("login capture returned no site cookies")
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
    fn login_sites_recognize_official_hosts_only() {
        assert_eq!(
            LoginSite::for_url("https://www.douyin.com/video/123"),
            Some(LoginSite::Douyin)
        );
        assert_eq!(
            LoginSite::for_url("https://v.douyin.com/abc/"),
            Some(LoginSite::Douyin)
        );
        assert_eq!(
            LoginSite::for_url("https://www.xiaohongshu.com/explore/123"),
            Some(LoginSite::Rednote)
        );
        assert_eq!(
            LoginSite::for_url("https://b23.tv/abc"),
            Some(LoginSite::Bilibili)
        );
        assert_eq!(LoginSite::for_url("http://www.douyin.com/video/123"), None);
        assert_eq!(
            LoginSite::for_url("https://www.douyin.com.evil.example/video/123"),
            None
        );
        assert_eq!(LoginSite::for_url("https://example.com/video"), None);
    }

    #[test]
    fn capture_is_only_offered_for_stable_login_signatures() {
        assert_eq!(
            login_capture_required(
                "https://www.douyin.com/video/123",
                "ERROR: [Douyin] 123: Fresh cookies (not necessarily logged in) are needed",
            ),
            Some(LoginSite::Douyin)
        );
        assert_eq!(
            login_capture_required("https://www.douyin.com/video/123", "格式不可用"),
            None
        );
        assert_eq!(
            login_capture_required(
                "https://www.bilibili.com/video/BV1",
                "ERROR: This video is only available to registered users",
            ),
            Some(LoginSite::Bilibili)
        );
        assert_eq!(
            login_capture_required("https://www.youtube.com/watch?v=1", "login"),
            None
        );
    }

    #[test]
    fn capture_output_is_interpreted_from_stdout_contract() {
        // 失败也带结构化 code：退出码非 0 不再掩盖真实原因。
        let payload = serde_json::json!({"ok": false, "code": "login_timeout"}).to_string();
        assert_eq!(
            interpret_capture_output(false, payload.as_bytes(), b""),
            Err("login capture login timeout")
        );
        let payload = serde_json::json!({"ok": false, "code": "browser_unavailable"}).to_string();
        assert_eq!(
            interpret_capture_output(false, payload.as_bytes(), b""),
            Err("login capture browser unavailable")
        );
        // 未知 code 归入脚本错误；完全没写出 JSON 才是 invalid output。
        let payload = serde_json::json!({"ok": false, "code": "future_code"}).to_string();
        assert_eq!(
            interpret_capture_output(false, payload.as_bytes(), b""),
            Err("login capture script error")
        );
        assert_eq!(
            interpret_capture_output(false, b"", b""),
            Err("login capture returned invalid output")
        );
        assert_eq!(
            interpret_capture_output(true, b"not json", b""),
            Err("login capture returned invalid output")
        );
        // ok:true 即成功，退出码不影响。
        let payload = serde_json::json!({"ok": true, "cookies": []}).to_string();
        assert_eq!(
            interpret_capture_output(true, payload.as_bytes(), b"").unwrap(),
            serde_json::json!({"ok": true, "cookies": []})
        );
    }

    #[test]
    fn stderr_tail_is_trimmed_tail_only_and_char_safe() {
        assert!(stderr_tail_lines(b"").is_empty());
        assert_eq!(
            stderr_tail_lines(b"first\n\n   second  \n"),
            vec!["first", "second"]
        );
        let many: String = (0..10).map(|i| format!("line{i}\n")).collect();
        assert_eq!(
            stderr_tail_lines(many.as_bytes()),
            vec!["line5", "line6", "line7", "line8", "line9"]
        );
        // 按字符截断：超长单行（含非 ASCII）不截出半个字符。
        let long = "界".repeat(STDERR_TAIL_LINE_CHARS + 40);
        let lines = stderr_tail_lines(long.as_bytes());
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].chars().count(), STDERR_TAIL_LINE_CHARS);
    }

    #[test]
    fn script_cookies_are_validated_scoped_and_written_as_netscape() {
        let payload: Value = serde_json::json!({
            "ok": true,
            "reason": "login_marker",
            "cookies": [
                {"name": "sessionid", "value": "secret", "domain": ".douyin.com", "path": "/", "secure": true, "httpOnly": true, "expires": 4102444800i64},
                {"name": "ttwid", "value": "device", "domain": "douyin.com", "path": "/"},
                {"name": "cdn", "value": "token", "domain": ".douyinvod.com", "path": "/", "expires": -1},
                {"name": "unrelated", "value": "x", "domain": ".example.com", "path": "/"},
                {"name": "lookalike", "value": "x", "domain": ".douyin.com.evil.example", "path": "/"},
                {"name": "bad name", "value": "x", "domain": ".douyin.com", "path": "/"},
                {"name": "bad_value", "value": "line\nbreak", "domain": ".douyin.com", "path": "/"},
                {"name": "bad_path", "value": "x", "domain": ".douyin.com", "path": "no-slash"},
                {"name": "bad_expiry", "value": "x", "domain": ".douyin.com", "path": "/", "expires": 5000000000i64},
            ],
        });
        let cookies = parse_script_cookies(&payload, LoginSite::Douyin).unwrap();
        let names: Vec<&str> = cookies.iter().map(|cookie| cookie.name.as_str()).collect();
        assert_eq!(names, ["sessionid", "ttwid", "cdn"]);
        let text = netscape_text(LoginSite::Douyin, &cookies);
        let lines: Vec<&str> = text.lines().skip(1).collect();
        assert_eq!(lines.len(), 3);
        assert!(
            lines[0]
                .starts_with("#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t4102444800\tsessionid\tsecret")
        );
        assert!(lines[1].starts_with("douyin.com\tFALSE\t/\tFALSE\t0\tttwid\tdevice"));
        // 会话 Cookie（-1）落盘为 0，yt-dlp 视为会话级。
        assert!(lines[2].starts_with(".douyinvod.com\tTRUE\t/\tFALSE\t0\tcdn\ttoken"));

        // 其他站点的 Cookie 不进入本站会话文件；全部无效时返回 None。
        let rednote = parse_script_cookies(
            &serde_json::json!({"ok": true, "cookies": [
                {"name": "a1", "value": "x", "domain": ".xiaohongshu.com", "path": "/"},
            ]}),
            LoginSite::Rednote,
        )
        .unwrap();
        assert!(netscape_text(LoginSite::Rednote, &rednote).contains("a1"));
        // 其他站点的 Cookie 不进入本站会话文件（只留文件头）。
        let cross_site = netscape_text(LoginSite::Douyin, &rednote);
        assert!(!cross_site.contains("a1"));
        assert_eq!(cross_site.lines().count(), 1);
        assert!(
            parse_script_cookies(
                &serde_json::json!({"ok": true, "cookies": [
                    {"name": "unrelated", "value": "x", "domain": ".example.com", "path": "/"},
                ]}),
                LoginSite::Douyin,
            )
            .is_none()
        );
    }

    /// Windows canonicalize 后的运行时路径带 \\?\ 前缀；仍须进入脚本并返回
    /// JSON。用不受支持的 URL 在打开浏览器前结束，不访问网络或真实 Cookie。
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires prepared bundled Node runtime; does not open a browser or access the network"]
    async fn canonical_runtime_login_script_returns_structured_result() {
        let directory = tempfile::tempdir().unwrap();
        let resources = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .canonicalize()
            .unwrap();
        assert!(resources.to_string_lossy().starts_with(r"\\?\"));
        let renderer = RemotionRenderService::new(directory.path().into(), resources);
        assert!(renderer.preflight().ready);
        assert_eq!(
            capture(
                &renderer,
                LoginSite::Douyin,
                "https://example.com/",
                &AtomicBool::new(false),
            )
            .await,
            Err("login capture input rejected")
        );
    }

    /// 人工验证：真实拉起可见浏览器跑完整捕获链路（依赖网络与桌面会话，
    /// 会弹出浏览器窗口约半分钟），默认跳过。
    /// 运行：cargo test --lib login_capture_end_to_end -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "spawns a visible system browser and hits the real site; run manually"]
    async fn login_capture_end_to_end_against_runtime() {
        use std::path::Path;
        let runtime_base = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug");
        let renderer = super::super::remotion_renderer::RemotionRenderService::new(
            tempfile::TempDir::new().unwrap().path().to_path_buf(),
            runtime_base,
        );
        let result = capture(
            &renderer,
            LoginSite::Douyin,
            "https://www.douyin.com/video/7666362682715241683",
            &AtomicBool::new(false),
        )
        .await;
        let text = result.expect("capture should deliver site cookies");
        assert!(text.starts_with("# Netscape HTTP Cookie File"));
        assert!(text.contains("douyin"));
    }
}
