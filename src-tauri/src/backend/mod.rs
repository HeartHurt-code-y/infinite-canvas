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
pub(crate) mod process_tree;
pub mod prompt_optimize;
pub mod provider;
pub mod remote_video_tasks;
pub mod remotion_renderer;
pub mod reverse_video;
pub mod staging;
pub mod storage;
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
use provider::ProviderRuntime;
use remotion_renderer::RemotionRenderService;
use reverse_video::ReverseVideoService;
use staging::StagingService;
use storage::{GenerationTaskLifecycle, Storage};
use tasks::GenerationTaskService;
use tauri::{AppHandle, Manager as _};
use video_edit_source::VideoEditSourceService;

pub struct BackendState {
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
    pub frame_extractor: VideoFrameExtractionService,
    pub remotion_renderer: RemotionRenderService,
    pub blender: BlenderRenderService,
    pub reverse_video: ReverseVideoService,
    pub video_edit_sources: VideoEditSourceService,
}

impl BackendState {
    pub fn initialize(app: &AppHandle) -> BackendResult<Self> {
        let database_path = app
            .path()
            .app_local_data_dir()?
            .join("infinite-canvas.sqlite3");
        let downloads_directory = app.path().download_dir()?;
        let storage = Arc::new(Storage::open(&database_path)?);
        let lifecycle = GenerationTaskLifecycle::new(Arc::clone(&storage));
        let credentials = CredentialStore;
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
        let composer = VideoCompositionService::new(
            downloads_directory.clone(),
            app.path().app_local_data_dir()?.join("ffmpeg-engine"),
            app.path().resource_dir()?,
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
        let reverse_video =
            ReverseVideoService::new(downloads_directory.clone(), Arc::clone(&storage));
        let blender = BlenderRenderService::new(downloads_directory.clone(), composer.clone());
        let remotion_renderer =
            RemotionRenderService::new(downloads_directory, app.path().resource_dir()?);

        Ok(Self {
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
            frame_extractor,
            remotion_renderer,
            blender,
            reverse_video,
            video_edit_sources,
        })
    }
}
