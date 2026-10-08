pub mod ai_media;
pub mod ai_media_runtime;
pub mod asset_library;
pub mod blender;
mod browser_media;
pub mod commands;
pub mod commerce_sources;
pub mod component_archive;
pub mod component_download;
pub mod component_manager;
pub mod composer;
pub mod cover_images;
pub mod credentials;
pub mod downloader;
pub mod error;
pub mod frame_extractor;
mod gpt_image_style_library;
pub mod image_normalize;
pub mod local_base64_assets;
pub mod local_results;
pub mod mac_delta_update;
pub mod material_transfer;
pub mod media;
pub mod media_cache;
pub mod media_proxy;
pub mod model_schema;
pub mod mv_audio;
pub mod mv_media;
pub(crate) mod process_tree;
pub mod product_scene_images;
pub mod prompt_optimize;
pub mod provider;
pub mod provider_adapter;
pub mod reelbench;
pub mod remote_video_tasks;
pub mod remotion_renderer;
pub mod resource_update;
pub mod result_transfer;
pub mod reverse_video;
pub mod runtime_components;
mod seedance_draft;
pub mod speech;
pub mod staging;
pub mod storage;
pub mod system_ffmpeg;
pub mod tasks;
pub mod thumbnail;
pub mod tos_sign;
pub mod types;
pub mod video_edit_source;
pub mod video_local_edit;
pub mod video_preparation;
pub mod volcengine_ark;
mod xiaohongshu;

use std::sync::Arc;

use ai_media::AiMediaService;
use asset_library::AssetLibrary;
use blender::BlenderRenderService;
use component_manager::ComponentManager;
use composer::VideoCompositionService;
use cover_images::CoverImageService;
use credentials::CredentialStore;
use downloader::VideoDownloadService;
use error::BackendResult;
use frame_extractor::VideoFrameExtractionService;
use local_base64_assets::LocalBase64Library;
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
use video_preparation::VideoPreparationService;

pub struct BackendState {
    pub runtime_migration: Arc<RuntimeComponentMigration>,
    pub component_manager: ComponentManager,
    pub storage: Arc<Storage>,
    pub lifecycle: GenerationTaskLifecycle,
    pub credentials: CredentialStore,
    pub providers: ProviderRuntime,
    pub assets: AssetLibrary,
    pub local_results: LocalResultService,
    pub local_base64_assets: LocalBase64Library,
    pub material_transfer_root: std::path::PathBuf,
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
    pub video_preparation: VideoPreparationService,
    pub ai_media: AiMediaService,
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
        let runtime_store = data_directory.join("runtime-components");
        let component_manager =
            ComponentManager::new(data_directory.clone(), resource_directory.clone());
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
        let material_transfer_root = data_directory.join("material-transfer-sources");
        material_transfer::cleanup_orphan_sources(&material_transfer_root, &storage)?;
        log_startup_stage!("Provider/本地库/孤儿清理");
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
        let ai_media = AiMediaService::new(
            downloads_directory.clone(),
            data_directory.clone(),
            resource_directory.clone(),
            composer.clone(),
            video_edit_sources.clone(),
            Arc::clone(&storage),
        )?;
        let cover_images = CoverImageService::new(downloads_directory.clone(), composer.clone());
        let product_scene_images = ProductSceneImageService::new(downloads_directory.clone());
        let reverse_video =
            ReverseVideoService::new(downloads_directory.clone(), Arc::clone(&storage));
        log_startup_stage!("抽帧/视频预备/AI 媒体/封面服务");
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
            downloads_directory.clone(),
            resource_directory.clone(),
            Some(remotion_component.clone()),
        );
        // Share the already bundled local Chromium with official-site fallback
        // resolvers. Download outputs still use the yt-dlp engine and directory.
        let downloader = VideoDownloadService::new_with_browser_runtime(
            downloads_directory,
            app.path().app_local_data_dir()?.join("yt-dlp-engine"),
            composer.clone(),
            Some(remotion_renderer.clone()),
        )?;
        log_startup_stage!("Blender/Remotion/下载服务");
        let mut migration_plans = vec![
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
                    runtime_store.clone(),
                    resource_directory.join("skills/gpt-image-2-style-library"),
                    "gpt-image-2-style-library",
                    "data/manifest.json",
                ),
                ready: gpt_image_style_library::style_component_ready,
            },
        ];
        // Optional AI resources are migrated only when this build includes a
        // pinned, complete pack; media prep stays available without the pack.
        if ai_media_runtime::runtime_ready(&resource_directory.join("ai-media-runtime")) {
            migration_plans.push(ComponentPlan {
                component: RuntimeComponent::new(
                    runtime_store.clone(),
                    resource_directory.join("ai-media-runtime"),
                    "ai-media-runtime",
                    "runtime-manifest.json",
                ),
                ready: ai_media_runtime::runtime_ready,
            });
        }
        if ai_media_runtime::quality_runtime_ready(
            &resource_directory.join("ai-media-quality-runtime"),
        ) {
            migration_plans.push(ComponentPlan {
                component: RuntimeComponent::new(
                    runtime_store.clone(),
                    resource_directory.join("ai-media-quality-runtime"),
                    "ai-media-quality-runtime",
                    "runtime-manifest.json",
                ),
                ready: ai_media_runtime::quality_runtime_ready,
            });
        }
        if component_manager::pose_runtime_ready(&resource_directory.join("pose-runtime")) {
            migration_plans.push(ComponentPlan {
                component: RuntimeComponent::new(
                    runtime_store,
                    resource_directory.join("pose-runtime"),
                    "pose-runtime",
                    "runtime-manifest.json",
                ),
                ready: component_manager::pose_runtime_ready,
            });
        }
        // Optional resources absent from an online installer do not gate core startup.
        migration_plans.retain(|plan| plan.component.resolve(plan.ready).is_some());
        log_startup_stage!("组件迁移计划就绪探测");
        // `tauri dev` uses build-tree resources directly. Copying ~1.7 GB is only
        // needed by packaged bridge releases before they can offer slim updates.
        let runtime_migration = RuntimeComponentMigration::start(if cfg!(debug_assertions) {
            Vec::new()
        } else {
            migration_plans
        });

        Ok(Self {
            runtime_migration,
            component_manager,
            storage,
            lifecycle,
            credentials,
            providers,
            assets,
            local_results,
            local_base64_assets,
            material_transfer_root,
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
            video_preparation,
            ai_media,
        })
    }
}
