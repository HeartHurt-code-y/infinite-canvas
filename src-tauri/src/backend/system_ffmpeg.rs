//! 系统 FFmpeg 的跨平台探测。
//!
//! 除了 PATH，还要显式探测 macOS 上 Homebrew / MacPorts 的安装目录：
//! 从 Finder（LaunchServices）启动的 .app 只继承 launchd 的 PATH
//! （`/usr/bin:/bin:/usr/sbin:/sbin`），Apple Silicon 的 `/opt/homebrew/bin`
//! 与 Intel 的 `/usr/local/bin` 都不在其中。只按 PATH 探测会永远得到
//! “系统没有 ffmpeg”，从而白白回退到内置引擎或再下载一份。

use std::path::{Path, PathBuf};
use std::process::Stdio;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 已解析出的系统 FFmpeg。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SystemFfmpeg {
    pub path: PathBuf,
    /// 命中 PATH。子进程继承同一份 PATH 时无需再显式指定二进制位置。
    pub on_path: bool,
}

/// 兜底搜索目录（按优先级）。
///
/// 参数化 OS 而不是直接读 `cfg!`，是为了让 macOS 的取值能在任意平台
/// （包括 Linux CI）被单测覆盖——否则这类“只在苹果上错”的映射永远测不到。
pub(crate) fn fallback_directories(os: &str) -> &'static [&'static str] {
    match os {
        "macos" => &[
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/usr/bin",
        ],
        "linux" | "freebsd" | "openbsd" => &["/usr/local/bin", "/usr/bin", "/bin"],
        _ => &[],
    }
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// 平台兜底目录下的候选二进制路径。
pub(crate) fn candidate_paths() -> Vec<PathBuf> {
    fallback_directories(std::env::consts::OS)
        .iter()
        .map(|directory| PathBuf::from(directory).join(binary_name()))
        .collect()
}

async fn usable(binary: &Path) -> bool {
    let mut command = tokio::process::Command::new(binary);
    command.arg("-version").stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .output()
        .await
        .is_ok_and(|output| output.status.success())
}

/// 解析可用的系统 ffmpeg：先按 PATH 找，再按平台兜底目录找。
///
/// 返回 `None` 表示系统里确实没有可用的 ffmpeg，调用方应回退到内置引擎。
pub(crate) async fn resolve() -> Option<SystemFfmpeg> {
    let on_path = PathBuf::from(binary_name());
    if usable(&on_path).await {
        return Some(SystemFfmpeg {
            path: on_path,
            on_path: true,
        });
    }
    for candidate in candidate_paths() {
        if usable(&candidate).await {
            return Some(SystemFfmpeg {
                path: candidate,
                on_path: false,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_fallback_directories_cover_homebrew_prefixes() {
        let directories = fallback_directories("macos");
        assert!(
            directories.contains(&"/opt/homebrew/bin"),
            "Apple Silicon Homebrew 前缀缺失：{directories:?}"
        );
        assert!(
            directories.contains(&"/usr/local/bin"),
            "Intel Homebrew 前缀缺失：{directories:?}"
        );
        // Windows 依赖完整继承的 PATH，不需要兜底目录。
        assert!(fallback_directories("windows").is_empty());
    }

    #[test]
    fn candidates_use_the_platform_binary_name() {
        for candidate in candidate_paths() {
            assert_eq!(
                candidate.file_name().and_then(|name| name.to_str()),
                Some(binary_name()),
            );
        }
    }
}
