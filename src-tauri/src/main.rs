// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Windows: 在 Tauri 初始化之前禁用 WebView2 跟踪预防，
    // 避免第三方存储/cookie 被阻止（例如素材库、登录等功能）。
    // 必须在 main() 最开始设置，确保 WebView2 加载器读取到环境变量。
    #[cfg(target_os = "windows")]
    {
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !existing.contains("TrackingPrevention") {
            let new_val = if existing.is_empty() {
                "--disable-features=TrackingPrevention".to_string()
            } else {
                format!("{} --disable-features=TrackingPrevention", existing)
            };
            // SAFETY: 程序入口处设置环境变量，此时尚无其他线程运行，无数据竞争
            unsafe {
                std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", new_val);
            }
        }
    }

    infinite_canvas_lib::run()
}
