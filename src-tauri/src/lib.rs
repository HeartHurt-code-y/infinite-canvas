mod backend;

use backend::commands;
use tauri::Manager as _;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Windows: 禁用 WebView2 跟踪预防，避免第三方存储/cookie 被阻止
    // （例如素材库、登录等需要第三方存储的功能）
    #[cfg(target_os = "windows")]
    {
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !existing.contains("TrackingPrevention") {
            let new_val = if existing.is_empty() {
                "--disable-features=TrackingPrevention".to_string()
            } else {
                format!("{} --disable-features=TrackingPrevention", existing)
            };
            // SAFETY: 应用启动时设置环境变量，此时 WebView2 尚未初始化，无数据竞争
            unsafe {
                std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", new_val);
            }
        }
    }

    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol(
            backend::media_proxy::MEDIA_PROXY_SCHEME,
            backend::media_proxy::handle_media_proxy_request,
        )
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_upload::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                // 使用本机时区而非 UTC：默认 UseUtc 会让日志时间比本机慢 8 小时。
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = backend::BackendState::initialize(app.handle())?;
            if let Err(error) = state.tasks.recover() {
                tauri_plugin_log::log::error!("backend recovery failed: {error}");
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::upsert_provider_connection,
            commands::list_provider_connections,
            commands::set_credential,
            commands::delete_credential,
            commands::get_credential_status,
            commands::get_credential,
            commands::list_model_definitions,
            commands::list_provider_model_bindings,
            commands::fetch_provider_models,
            commands::test_provider_connection,
            commands::replace_provider_model_bindings,
            commands::list_provider_token_groups,
            commands::upsert_provider_token_group,
            commands::delete_provider_token_group,
            commands::save_canvas_document,
            commands::delete_canvas_document,
            commands::save_workflow_history,
            commands::list_workflow_history,
            commands::get_workflow_history,
            commands::recover_workflow_history,
            commands::get_canvas_document,
            commands::list_canvas_documents,
            commands::start_generation,
            commands::run_prompt_node,
            commands::fetch_commerce_sources,
            commands::save_reverse_video_evidence,
            backend::video_local_edit::save_video_edit_frame,
            backend::video_edit_source::prepare_video_edit_source,
            backend::video_edit_source::release_video_edit_source,
            commands::get_reverse_video_learning,
            commands::deliver_reverse_video,
            commands::normalize_cover_image,
            commands::resume_cover_image_result,
            commands::remotion_renderer_preflight,
            commands::start_remotion_render,
            commands::get_remotion_render,
            commands::cancel_remotion_render,
            commands::list_generation_tasks,
            commands::get_generation_task,
            commands::recover_generation_tasks,
            commands::query_video_task_now,
            commands::list_remote_video_tasks,
            commands::list_assets,
            commands::refresh_asset_cover,
            commands::refresh_asset_media,
            commands::list_asset_groups,
            commands::create_asset_group,
            commands::rename_asset,
            commands::update_asset_group,
            commands::delete_asset_group,
            commands::create_real_person_auth_link,
            commands::list_real_person_groups,
            commands::delete_real_person_asset,
            commands::delete_real_person_group,
            commands::delete_asset,
            commands::configure_tos_staging,
            commands::get_tos_staging_config,
            commands::test_tos_connectivity,
            commands::start_staging_upload,
            commands::get_staging_job,
            commands::list_local_assets,
            commands::pull_tos_bucket_assets,
            commands::verify_local_result,
            commands::get_video_downloader_engine,
            commands::install_video_downloader_engine,
            commands::update_video_downloader_engine,
            commands::import_downloader_cookies,
            commands::clear_downloader_cookies,
            commands::start_video_download,
            commands::get_video_download_job,
            commands::cancel_video_download,
            commands::get_video_composer_engine,
            commands::install_video_composer_engine,
            commands::start_video_composition,
            commands::get_video_composition_job,
            commands::cancel_video_composition,
            commands::start_video_frame_extraction,
            commands::get_video_frame_extraction_job,
            commands::cancel_video_frame_extraction,
            backend::thumbnail::create_media_thumbnail,
            commands::backend_health,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
