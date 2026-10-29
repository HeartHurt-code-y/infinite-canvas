pub mod asset_library;
pub mod brand_design;
pub mod brand_models;
pub mod commands;
pub mod canvas_image;
pub mod camera_control;
pub mod composer;
pub mod cover_images;
pub mod credentials;
pub mod downloader;
pub mod error;
pub mod frame_extractor;
pub(crate) mod gateway_profile;
pub mod generation_materials;
pub mod image_normalize;
pub mod image_presets;
pub mod local_base64_assets;
pub mod local_results;
pub mod long_video;
pub mod mac_delta_update;
pub mod material_transfer;
pub mod media;
pub mod media_cache;
pub mod media_proxy;
pub(crate) mod media_source;
pub mod model_schema;
pub mod process_tree;
pub mod prompt_optimize;
pub(crate) mod protocol_reply;
pub mod provider;
pub mod provider_adapter;
pub mod remote_video_tasks;
pub mod resource_update;
pub mod result_transfer;
mod seedance_draft;
pub mod speech;
pub mod staging;
pub mod storage;
pub mod system_ffmpeg;
pub mod tasks;
pub mod thumbnail;
pub mod tos_sign;
pub mod types;
pub mod video_clip;
pub mod video_clip_render;
pub mod video_edit_source;
pub mod video_local_edit;
pub mod video_preparation;
pub mod volcengine_ark;
mod xiaohongshu;

use std::sync::Arc;

use asset_library::AssetLibrary;
use brand_models::BrandModelLibrary;
use composer::VideoCompositionService;
use cover_images::CoverImageService;
use credentials::CredentialStore;
use downloader::VideoDownloadService;
use error::BackendResult;
use frame_extractor::VideoFrameExtractionService;
use local_base64_assets::LocalBase64Library;
use local_results::LocalResultService;
use media::MediaResolver;
use provider::ProviderRuntime;
use staging::StagingService;
use storage::{GenerationTaskLifecycle, Storage};
use tasks::GenerationTaskService;
use tauri::{AppHandle, Manager as _};
use video_clip::VideoClipService;
use video_edit_source::VideoEditSourceService;
use video_preparation::VideoPreparationService;

pub struct BackendState {
    pub storage: Arc<Storage>,
    pub lifecycle: GenerationTaskLifecycle,
    pub credentials: CredentialStore,
    pub providers: ProviderRuntime,
    pub assets: AssetLibrary,
    pub local_results: LocalResultService,
    pub local_base64_assets: LocalBase64Library,
    pub brand_models: BrandModelLibrary,
    pub material_transfer_root: std::path::PathBuf,
    pub staging: StagingService,
    pub tasks: GenerationTaskService,
    pub downloader: VideoDownloadService,
    pub composer: VideoCompositionService,
    pub cover_images: CoverImageService,
    pub frame_extractor: VideoFrameExtractionService,
    pub video_edit_sources: VideoEditSourceService,
    pub video_preparation: VideoPreparationService,
    /// 智能剪辑（video clip）：模式目录校验 + 合成载荷组装，复用生成任务管线。
    pub video_clip: VideoClipService,
    pub clip_render: video_clip_render::ClipRenderService,
    pub long_video: long_video::LongVideoService,
}

impl BackendState {
    pub fn initialize(app: &AppHandle) -> BackendResult<Self> {
        // 启动阶段计时：setup 跑在主线程上，任何一步卡住都会冻结整个窗口
        // （白屏 + 系统判定“未响应”）。逐阶段落日志，异常卡顿可直接定位。
        let startup_clock = std::time::Instant::now();
        macro_rules! log_startup_stage {
            ($name:expr) => {
                tauri_plugin_log::log::info!(
                    "[启动] {}: 累计 {}ms",
                    $name,
                    startup_clock.elapsed().as_millis()
                )
            };
        }
        let data_directory = app.path().app_local_data_dir()?;
        let resource_directory = app.path().resource_dir()?;
        let database_path = data_directory.join("infinite-canvas.sqlite3");
        let downloads_directory = app.path().download_dir()?;
        let sqlite_existed = database_path.exists();
        tauri_plugin_log::log::info!(
            "app local data dir: {}, sqlite existed before open: {sqlite_existed}",
            data_directory.display()
        );
        let storage = Arc::new(Storage::open(&database_path)?);
        let lifecycle = GenerationTaskLifecycle::new(Arc::clone(&storage));
        // macOS 默认用应用数据目录下的明文文件（避开钥匙串密码框），
        // 其余平台用系统凭据库；逐字说明与取舍见 credentials.rs 模块文档。
        let credentials = CredentialStore::new(&data_directory);
        tauri_plugin_log::log::info!("credential backend: {}", credentials.backend_label());
        let tos_loaded = match storage.get_tos_config() {
            Ok(Some(config)) => format!(
                "enabled={}, bucket_set={}",
                config.enabled,
                !config.bucket.trim().is_empty()
            ),
            Ok(None) => "none".to_string(),
            Err(error) => format!("read_error:{error}"),
        };
        let tos_credential = credentials
            .status("tos-ak-sk")
            .map(|status| status.configured)
            .unwrap_or(false);
        tauri_plugin_log::log::info!(
            "TOS staging loaded: {tos_loaded}; leftover tos-ak-sk credential: {tos_credential}"
        );
        log_startup_stage!("存储与凭据");
        media_proxy::configure_preview_cache_directory(media_proxy::preview_cache_directory(
            &data_directory,
        ));
        let providers =
            ProviderRuntime::new(Arc::clone(&storage), lifecycle.clone(), credentials.clone())?;
        let assets = AssetLibrary::new(providers.clone());
        let local_results = LocalResultService::new(
            Arc::clone(&storage),
            lifecycle.clone(),
            providers.client().clone(),
            downloads_directory.clone(),
            providers.clone(),
        );
        let local_base64_assets = LocalBase64Library::new(Arc::clone(&storage), &data_directory)?;
        let brand_models = BrandModelLibrary::new(Arc::clone(&storage), &data_directory)?;
        let material_transfer_root = data_directory.join("material-transfer-sources");
        material_transfer::cleanup_orphan_sources(&material_transfer_root, &storage)?;
        log_startup_stage!("Provider/本地库/孤儿清理");
        // FFmpeg 合成引擎：安装包内置构建（resources/ffmpeg）优先，缺失时
        // 回退到应用数据目录并自动下载。视频合成任务已下线，这里只提供引擎，
        // 供合成/抽帧/下载转码共用。
        // 需在 StagingService 之前创建：素材导入遇到不支持格式（如 avif）时
        // 复用同一套 FFmpeg 引擎做本地转码。
        let composer = VideoCompositionService::new(
            data_directory.join("ffmpeg-engine"),
            resource_directory.clone(),
        )?;
        let staging = StagingService::new(
            Arc::clone(&storage),
            credentials.clone(),
            assets.clone(),
            composer.clone(),
        )?;
        log_startup_stage!("FFmpeg 引擎与暂存服务");
        let media = MediaResolver::new(
            providers.clone(),
            assets.clone(),
            local_results.clone(),
            staging.clone(),
            local_base64_assets.clone(),
        );
        let video_edit_sources = VideoEditSourceService::new(
            assets.clone(),
            staging.clone(),
            local_results.clone(),
            app.path().app_local_data_dir()?.join("video-edit-previews"),
            local_base64_assets.clone(),
        )?;
        let tasks = GenerationTaskService::new(
            app.clone(),
            Arc::clone(&storage),
            lifecycle.clone(),
            providers.clone(),
            media,
            local_results.clone(),
            staging.clone(),
        );
        // 智能剪辑复用同一套生成任务管线：任务服务整体是 Clone（内部都是 Arc），
        // 这里克隆一份给智能剪辑服务，产物与历史沿用同一条链路。
        let video_clip = VideoClipService::new(tasks.clone());
        let clip_render = video_clip_render::ClipRenderService::new(
            downloads_directory.join("无限画布").join("智能剪辑"),
            video_edit_sources.clone(), composer.clone(), tasks.clone(),
            video_clip_render::ClipPlannerRuntime { app: app.clone(), storage: Arc::clone(&storage), lifecycle: lifecycle.clone(),
                providers: providers.clone(), assets: assets.clone(), staging: staging.clone(), base64: local_base64_assets.clone(), results: local_results.clone() },
        )?;
        let long_video = long_video::LongVideoService::new(
            app.clone(),
            Arc::clone(&storage),
            tasks.clone(),
            composer.clone(),
            providers.clone(),
            lifecycle.clone(),
            assets.clone(),
            staging.clone(),
            local_base64_assets.clone(),
            local_results.clone(),
            downloads_directory.join("无限画布").join("超长视频"),
        )?;
        log_startup_stage!("媒体解析/视频剪辑源/生成任务服务");
        // 视频抽帧复用同一套 FFmpeg 引擎；产物落在下载目录「无限画布/抽帧」。
        let frame_extractor = VideoFrameExtractionService::new_with_storage(
            downloads_directory.clone(),
            composer.clone(),
            Arc::clone(&storage),
        )?;
        let video_preparation = VideoPreparationService::new(
            downloads_directory.clone(),
            composer.clone(),
            video_edit_sources.clone(),
            Arc::clone(&storage),
        )?;
        let cover_images = CoverImageService::new(downloads_directory.clone(), composer.clone());
        log_startup_stage!("抽帧/视频预备/封面服务");
        // 下载服务只用内置 yt-dlp 引擎与 FFmpeg 合成能力；浏览器运行时（登录抓取）
        // 已随「网络爆款视频下载」下线。
        let downloader = VideoDownloadService::new(
            downloads_directory,
            app.path().app_local_data_dir()?.join("yt-dlp-engine"),
            composer.clone(),
        )?;
        log_startup_stage!("下载服务");

        Ok(Self {
            storage,
            lifecycle,
            credentials,
            providers,
            assets,
            local_results,
            local_base64_assets,
            brand_models,
            material_transfer_root,
            staging,
            tasks,
            downloader,
            composer,
            cover_images,
            frame_extractor,
            video_edit_sources,
            video_preparation,
            video_clip,
            clip_render,
            long_video,
        })
    }
}
