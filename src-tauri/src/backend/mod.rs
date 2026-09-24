pub mod asset_library;
pub mod blender;
pub mod commands;
pub mod commerce_sources;
pub mod composer;
pub mod cover_images;
pub mod credentials;
pub mod downloader;
pub mod error;
pub mod frame_extractor;
mod gpt_image_style_library;
pub mod image_normalize;
pub mod local_results;
pub mod media;
pub mod media_cache;
pub mod media_proxy;
pub mod model_schema;
pub mod mv_media;
pub(crate) mod process_tree;
pub mod product_scene_images;
pub mod prompt_optimize;
pub mod provider;
pub mod provider_adapter;
pub mod remote_video_tasks;
pub mod remotion_renderer;
pub mod result_transfer;
pub mod reverse_video;
pub mod runtime_components;
pub mod staging;
pub mod storage;
pub mod system_ffmpeg;
pub mod tasks;
pub mod thumbnail;
pub mod tos_sign;
pub mod types;
pub mod video_edit_source;
pub mod video_local_edit;
pub mod volcengine_ark;

use std::sync::Arc;

use asset_library::AssetLibrary;
use blender::BlenderRenderService;
use composer::VideoCompositionService;
use cover_images::CoverImageService;
use credentials::CredentialStore;
use downloader::VideoDownloadService;
use error::BackendResult;
use frame_extractor::VideoFrameExtractionService;
use local_results::LocalResultService;
use media::MediaResolver;
use product_scene_images::ProductSceneImageService;
use provider::ProviderRuntime;
use remotion_renderer::RemotionRenderService;
use reverse_video::ReverseVideoService;
use runtime_components::{ComponentPlan, RuntimeComponent, RuntimeComponentMigration};
use staging::StagingService;
use storage::{GenerationTaskLifecycle, Storage};
use tasks::GenerationTaskService;
use tauri::{AppHandle, Manager as _};
use video_edit_source::VideoEditSourceService;

pub struct BackendState {
    pub runtime_migration: Arc<RuntimeComponentMigration>,
    pub storage: Arc<Storage>,
    pub lifecycle: GenerationTaskLifecycle,
    pub credentials: CredentialStore,
    pub providers: ProviderRuntime,
    pub assets: AssetLibrary,
    pub local_results: LocalResultService,
    pub staging: StagingService,
    pub tasks: GenerationTaskService,
    pub downloader: VideoDownloadService,
    pub composer: VideoCompositionService,
    pub cover_images: CoverImageService,
    pub product_scene_images: ProductSceneImageService,
    pub frame_extractor: VideoFrameExtractionService,
    pub remotion_renderer: RemotionRenderService,
    pub blender: BlenderRenderService,
    pub reverse_video: ReverseVideoService,
    pub video_edit_sources: VideoEditSourceService,
}

impl BackendState {
    pub fn initialize(app: &AppHandle) -> BackendResult<Self> {
        let data_directory = app.path().app_local_data_dir()?;
        let resource_directory = app.path().resource_dir()?;
        let runtime_store = data_directory.join("runtime-components");
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
        // FFmpeg 合成引擎：安装包内置构建（resources/ffmpeg）优先，缺失时
        // 回退到应用数据目录并自动下载。合成产物与下载产物同目录。
        // 需在 StagingService 之前创建：素材导入遇到不支持格式（如 avif）时
        // 复用同一套 FFmpeg 引擎做本地转码。
        let composer = VideoCompositionService::new_with_runtime_store(
            downloads_directory.clone(),
            data_directory.join("ffmpeg-engine"),
            resource_directory.clone(),
            runtime_store.clone(),
        )?;
        let staging = StagingService::new(
            Arc::clone(&storage),
            credentials.clone(),
            assets.clone(),
            composer.clone(),
        )?;
        let media = MediaResolver::new(
            providers.clone(),
            assets.clone(),
            local_results.clone(),
            staging.clone(),
            composer.clone(),
        );
        let video_edit_sources = VideoEditSourceService::new(
            assets.clone(),
            staging.clone(),
            local_results.clone(),
            app.path().app_local_data_dir()?.join("video-edit-previews"),
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
        // yt-dlp 引擎与浏览器 Cookies 存放在应用数据目录；下载产物与生成结果
        // 一致落在系统下载目录的「无限画布」子目录。
        let downloader = VideoDownloadService::new(
            downloads_directory.clone(),
            app.path().app_local_data_dir()?.join("yt-dlp-engine"),
            composer.clone(),
        )?;
        // 视频抽帧复用同一套 FFmpeg 引擎；产物落在下载目录「无限画布/抽帧」。
        let frame_extractor =
            VideoFrameExtractionService::new(downloads_directory.clone(), composer.clone());
        let cover_images = CoverImageService::new(downloads_directory.clone(), composer.clone());
        let product_scene_images = ProductSceneImageService::new(downloads_directory.clone());
        let reverse_video =
            ReverseVideoService::new(downloads_directory.clone(), Arc::clone(&storage));
        let blender_component = RuntimeComponent::new(
            runtime_store.clone(),
            resource_directory.join("blender"),
            "blender",
            "manifest.json",
        );
        let remotion_component = RuntimeComponent::new(
            runtime_store.clone(),
            resource_directory.join("remotion-runtime"),
            "remotion-runtime",
            "runtime-manifest.json",
        );
        let blender = BlenderRenderService::new_with_runtime_store(
            downloads_directory.clone(),
            composer.clone(),
            Some(resource_directory.join("blender")),
            Some(blender_component.clone()),
        );
        let remotion_renderer = RemotionRenderService::new_with_runtime_store(
            downloads_directory,
            resource_directory.clone(),
            Some(remotion_component.clone()),
        );
        let migration_plans = vec![
            ComponentPlan {
                component: blender_component,
                ready: blender::blender_runtime_ready,
            },
            ComponentPlan {
                component: remotion_component,
                ready: remotion_renderer::runtime_ready,
            },
            ComponentPlan {
                component: RuntimeComponent::new(
                    runtime_store.clone(),
                    resource_directory.join("ffmpeg"),
                    "ffmpeg",
                    "manifest.json",
                ),
                ready: composer::engine_ready_in,
            },
            ComponentPlan {
                component: RuntimeComponent::new(
                    runtime_store,
                    resource_directory.join("skills/gpt-image-2-style-library"),
                    "gpt-image-2-style-library",
                    "data/manifest.json",
                ),
                ready: gpt_image_style_library::style_component_ready,
            },
        ];
        // `tauri dev` uses build-tree resources directly. Copying ~1.7 GB is only
        // needed by packaged bridge releases before they can offer slim updates.
        let runtime_migration = RuntimeComponentMigration::start(if cfg!(debug_assertions) {
            Vec::new()
        } else {
            migration_plans
        });

        Ok(Self {
            runtime_migration,
            storage,
            lifecycle,
            credentials,
            providers,
            assets,
            local_results,
            staging,
            tasks,
            downloader,
            composer,
            cover_images,
            product_scene_images,
            frame_extractor,
            remotion_renderer,
            blender,
            reverse_video,
            video_edit_sources,
        })
    }
}
