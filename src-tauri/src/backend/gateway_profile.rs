//! 网关家族档案：模型家族级的适配器 seam（连接级的对位物见 `provider_adapter.rs`）。
//!
//! 一个 `requestProfileId` 背后是一整族网关契约知识：按模型 ID 识别家族、解析
//! 阶段是否要先取本地字节、轮询节奏、结果签名直链能否续签。这些判定曾经散在
//! provider / model_schema / media / local_results / generation_lifecycle / tasks
//! 六个文件里，每接一个新家族就逐处补一个 `if`；现在收口到这份档案表，各处
//! 只读这一个枚举。
//!
//! 与 `ProviderAdapterKind` 同构：静态分发、不引入 trait object。家族的请求体
//! 构造与响应解析仍留在各自的协议模块（`provider.rs` / `provider/pixverse.rs`），
//! 这里只收「跨文件都要问一遍」的决策与身份。

use std::time::Duration;

use serde_json::Value;

use super::model_schema::{
    RequestDialect, is_atlascloud_kling_video_model, is_atlascloud_vidu_video_model,
    is_pixverse_video_model, is_rd_video_model, is_seedance_draft_video_model,
    is_sp25_per_use_video_model,
};
use super::storage::TaskExecutionRecord;

/// 魔芋按次计费视频网关（`sp2.5-*` 型号）。档案 ID 字符串只在本文件出现，
/// 对外一律通过 [`GatewayProfile`] 比较。
const SP25_PER_USE_VIDEO_PROFILE: &str = "sp25_per_use_video_v1";
/// Seedance 2.5 RD 网关（`rd-seedance-2.5-*` 型号，顶层字段契约）。
const RD_VIDEO_PROFILE: &str = "rd_video_v1";
/// 魔芋 PixVerse V6/C1（根字段 + metadata 开关）。
const MOYU_PIXVERSE_VIDEO_PROFILE: &str = "moyu_pixverse_video_v1";
/// 魔芋 Seedance 2.5 草稿样片（draft_task 晋升合同）。
const MOYU_SEEDANCE_DRAFT_PROFILE: &str = "moyu_seedance_25_draft_v1";
/// 饭众烟连接的全部视频模型使用统一任务与素材上传协议。
const FZY_VIDEO_PROFILE: &str = "fzy_video_tasks_v1";
/// Atlas Cloud 视频生成 API（Vidu Q4 家族）：自有协议
/// （`POST /api/v1/model/generateVideo` 提交 + `GET /api/v1/model/prediction/{id}` 轮询）。
const ATLASCLOUD_VIDEO_PROFILE: &str = "atlascloud_video_v1";

/// 视频任务的默认轮询间隔。恒定节奏的家族档案与通用回退共用。
pub(crate) const DEFAULT_VIDEO_POLL_INTERVAL: Duration = Duration::from_secs(5);
const PIXVERSE_SETTLE_AFTER: Duration = Duration::from_secs(30);
const PIXVERSE_SETTLED_INTERVAL: Duration = Duration::from_secs(10);
const PIXVERSE_POLL_WINDOW: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GatewayProfile {
    /// 魔芋按次计费视频（`sp2.5-*`）。
    Sp25PerUse,
    /// Seedance 2.5 RD 网关（顶层字段契约）。
    RdVideo,
    /// 魔芋 PixVerse V6/C1。
    PixVerse,
    /// 魔芋 Seedance 2.5 草稿样片。
    SeedanceDraft,
    FzyVideo,
    /// Atlas Cloud 视频（Vidu Q4 参考图生视频）。
    AtlasCloudVideo,
}

impl GatewayProfile {
    /// 家族成员清单（遍历顺序即模型 ID 判定顺序）。已注册家族的模型 ID 互不
    /// 交叠；一旦出现子串包含关系（如 RD 的 `seedance-2.5` 含在通用 Seedance
    /// 系里），必须把更专属的家族排在前面。
    pub(crate) const REGISTRY: [GatewayProfile; 6] = [
        GatewayProfile::Sp25PerUse,
        GatewayProfile::RdVideo,
        GatewayProfile::PixVerse,
        GatewayProfile::SeedanceDraft,
        GatewayProfile::FzyVideo,
        GatewayProfile::AtlasCloudVideo,
    ];

    pub(crate) fn profile_id(self) -> &'static str {
        match self {
            GatewayProfile::Sp25PerUse => SP25_PER_USE_VIDEO_PROFILE,
            GatewayProfile::RdVideo => RD_VIDEO_PROFILE,
            GatewayProfile::PixVerse => MOYU_PIXVERSE_VIDEO_PROFILE,
            GatewayProfile::SeedanceDraft => MOYU_SEEDANCE_DRAFT_PROFILE,
            GatewayProfile::FzyVideo => FZY_VIDEO_PROFILE,
            GatewayProfile::AtlasCloudVideo => ATLASCLOUD_VIDEO_PROFILE,
        }
    }

    /// 冻结操作档案里的家族身份。`requestProfileId` 字符串只在本文件出现，
    /// 其余代码一律经由此处比较。
    pub(crate) fn from_profile_id(profile_id: &str) -> Option<Self> {
        match profile_id {
            SP25_PER_USE_VIDEO_PROFILE => Some(Self::Sp25PerUse),
            RD_VIDEO_PROFILE => Some(Self::RdVideo),
            MOYU_PIXVERSE_VIDEO_PROFILE => Some(Self::PixVerse),
            MOYU_SEEDANCE_DRAFT_PROFILE => Some(Self::SeedanceDraft),
            FZY_VIDEO_PROFILE => Some(Self::FzyVideo),
            ATLASCLOUD_VIDEO_PROFILE => Some(Self::AtlasCloudVideo),
            _ => None,
        }
    }

    /// 从冻结的模型操作 Schema 读取家族身份。
    pub(crate) fn from_operation_schema(operation_schema: &Value) -> Option<Self> {
        Self::from_profile_id(
            operation_schema
                .get("requestProfileId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
    }

    /// 从绑定的远端模型 ID 识别家族。只反映模型名，不反映连接方言——PixVerse
    /// 与草稿样片的同名模型在方舟等原生连接上保留原生契约，见 [`Self::available_on`]。
    pub(crate) fn from_model_id(model_id: &str) -> Option<Self> {
        Self::REGISTRY
            .into_iter()
            .find(|family| family.matches_model_id(model_id))
    }

    fn matches_model_id(self, model_id: &str) -> bool {
        match self {
            GatewayProfile::Sp25PerUse => is_sp25_per_use_video_model(model_id),
            GatewayProfile::RdVideo => is_rd_video_model(model_id),
            GatewayProfile::PixVerse => is_pixverse_video_model(model_id),
            GatewayProfile::SeedanceDraft => is_seedance_draft_video_model(model_id),
            // 连接决定协议；不能把同名型号在其他供应商上的协议改成饭众烟。
            GatewayProfile::FzyVideo => false,
            // Atlas Cloud 视频家族：模型名命中**只是候选**，是否真走 Atlas 协议
            // 由 `available_on` 按连接方言裁决（同名模型在兼容网关上仍是魔芋协议）。
            // 平台上的视频家族目前有 Vidu Q4 与 Kling 4.0 两个，各自一份契约。
            GatewayProfile::AtlasCloudVideo => {
                is_atlascloud_vidu_video_model(model_id)
                    || is_atlascloud_kling_video_model(model_id)
            }
        }
    }

    /// 已知家族合同是否适用于该连接方言。按次与 RD 本就只存在于 OpenAI 兼容
    /// 网关；PixVerse 与草稿样片在方舟等原生连接上必须让位给原生契约。
    pub(crate) fn available_on(self, dialect: RequestDialect) -> bool {
        if dialect == RequestDialect::FzyAi {
            return self == Self::FzyVideo;
        }
        match self {
            GatewayProfile::FzyVideo => false,
            // Atlas 视频协议只在 Atlas Cloud 连接上成立。
            GatewayProfile::AtlasCloudVideo => dialect == RequestDialect::AtlasCloud,
            GatewayProfile::Sp25PerUse | GatewayProfile::RdVideo => true,
            GatewayProfile::PixVerse | GatewayProfile::SeedanceDraft => {
                dialect == RequestDialect::OpenAiCompatible
            }
        }
    }

    /// 冻结任务里的家族身份：远端模型快照 + 连接方言快照共同决定。
    /// 取代散落各处的 `is_pixverse_gateway_task` / `is_seedance_draft_gateway_task`
    /// 与「模型判定 || 方言判定」的手工组合。
    pub(crate) fn from_task(task: &TaskExecutionRecord) -> Option<Self> {
        if task.operation != super::types::GenerationOperation::VideoGeneration {
            return None;
        }
        Self::for_frozen_snapshot(
            task.remote_model_id_snapshot.as_deref(),
            &task.adapter_id_snapshot,
        )
    }

    /// [`Self::from_task`] 的数据形态：生命周期等存储层只有快照字段，没有完整任务记录。
    pub(crate) fn for_frozen_snapshot(
        remote_model_id: Option<&str>,
        adapter_id: &str,
    ) -> Option<Self> {
        Self::for_dialect(remote_model_id, RequestDialect::for_adapter(adapter_id))
    }

    pub(crate) fn for_dialect(
        remote_model_id: Option<&str>,
        dialect: RequestDialect,
    ) -> Option<Self> {
        if dialect == RequestDialect::FzyAi {
            return Some(Self::FzyVideo);
        }
        let family = Self::from_model_id(remote_model_id?)?;
        family.available_on(dialect).then_some(family)
    }

    /// 解析阶段是否必须拿到本地字节：这些家族通过供应商上传接口把本地素材换成
    /// 公网引用；纯 URL 素材不受影响。草稿样片走通用 metadata 契约、只收公网
    /// 引用，因此不需要字节。
    pub(crate) fn needs_local_bytes(self) -> bool {
        matches!(
            self,
            GatewayProfile::Sp25PerUse
                | GatewayProfile::RdVideo
                | GatewayProfile::PixVerse
                | GatewayProfile::FzyVideo
                | GatewayProfile::AtlasCloudVideo
        )
    }

    /// 该家族的产物是「带签名的直链」，需要按「查询原任务续签」的路径下载。
    ///
    /// 按次系列、RD、PixVerse、草稿样片与饭众烟的产物都是短时效签名直链，保存时
    /// 要先重查原任务拿新链接。Atlas Cloud 的产物是**公开托管链接**（与它的出图
    /// 链路同一套下载策略），走通用下载路径即可。
    ///
    /// 判错的后果是硬失败：Atlas 会被送去「查询原任务续签」，而续签用的是网关的
    /// `/v1/video/generations/{id}`——这个端点在 Atlas 上不存在，必然 404，产物
    /// 也就永远落不了盘。
    pub(crate) fn uses_signed_result_url(self) -> bool {
        !matches!(self, GatewayProfile::AtlasCloudVideo)
    }

    /// 轮询节奏。恒定家族（按次、RD、草稿样片）与通用网关一致：5 秒一查、不限时。
    pub(crate) fn poll_cadence(self) -> GatewayPollCadence {
        match self {
            GatewayProfile::PixVerse => GatewayPollCadence {
                initial_interval: DEFAULT_VIDEO_POLL_INTERVAL,
                settle_after: PIXVERSE_SETTLE_AFTER,
                settled_interval: PIXVERSE_SETTLED_INTERVAL,
                window: Some(PIXVERSE_POLL_WINDOW),
            },
            GatewayProfile::Sp25PerUse
            | GatewayProfile::RdVideo
            | GatewayProfile::FzyVideo
            | GatewayProfile::AtlasCloudVideo
            | GatewayProfile::SeedanceDraft => {
                GatewayPollCadence::uniform(DEFAULT_VIDEO_POLL_INTERVAL)
            }
        }
    }

    /// 观察响应允许状态为空串的家族：PixVerse 成功前的空状态按排队处理。
    pub(crate) fn empty_remote_status_means_pending(self) -> bool {
        matches!(self, GatewayProfile::PixVerse)
    }
}

/// 网关家族的轮询节奏：先按 `initial_interval` 查询 `settle_after` 时长，
/// 之后收敛到 `settled_interval`；`window` 是自动轮询总窗口，到点停止
/// （`None` 表示不限时，由通用的查询重试上限兜底）。
#[derive(Clone, Copy)]
pub(crate) struct GatewayPollCadence {
    initial_interval: Duration,
    settle_after: Duration,
    settled_interval: Duration,
    window: Option<Duration>,
}

impl GatewayPollCadence {
    /// 恒定节奏：间隔不变、不限时。
    pub(crate) fn uniform(interval: Duration) -> Self {
        Self {
            initial_interval: interval,
            settle_after: Duration::ZERO,
            settled_interval: interval,
            window: None,
        }
    }

    fn interval(&self, elapsed: Duration) -> Duration {
        if elapsed >= self.settle_after {
            self.settled_interval
        } else {
            self.initial_interval
        }
    }

    /// 下一次正常轮询的等待时长；总窗口耗尽后返回 `None`，停止自动轮询。
    pub(crate) fn next_poll_wait(&self, elapsed: Duration) -> Option<Duration> {
        let interval = self.interval(elapsed);
        match self.window {
            Some(window) => {
                let remaining = window.checked_sub(elapsed)?;
                if remaining.is_zero() {
                    None
                } else {
                    Some(interval.min(remaining))
                }
            }
            None => Some(interval),
        }
    }

    /// 有总窗口的家族按当前轮询间隔给查询重试抬底，避免失败退避比正常轮询
    /// 更密；恒定节奏沿用通用退避。
    pub(crate) fn retry_delay_floor(&self, elapsed: Duration) -> Option<Duration> {
        self.window.map(|_| self.interval(elapsed))
    }

    /// 自动轮询总窗口的秒数；恒定节奏没有窗口，返回 `None`。
    pub(crate) fn window_secs(&self) -> Option<u64> {
        self.window.map(|window| window.as_secs())
    }

    /// 查询重试等待不得超过总窗口剩余；到点后停止自动轮询。
    pub(crate) fn bound_retry_wait(&self, wait: Duration, elapsed: Duration) -> Duration {
        match self.window {
            Some(window) => wait.min(window.saturating_sub(elapsed)),
            None => wait,
        }
    }
}
