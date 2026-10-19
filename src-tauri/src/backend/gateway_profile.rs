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
    RequestDialect, is_pixverse_video_model, is_rd_video_model, is_seedance_draft_video_model,
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
}

impl GatewayProfile {
    /// 家族成员清单（遍历顺序即模型 ID 判定顺序）。已注册家族的模型 ID 互不
    /// 交叠；一旦出现子串包含关系（如 RD 的 `seedance-2.5` 含在通用 Seedance
    /// 系里），必须把更专属的家族排在前面。
    pub(crate) const REGISTRY: [GatewayProfile; 5] = [
        GatewayProfile::Sp25PerUse,
        GatewayProfile::RdVideo,
        GatewayProfile::PixVerse,
        GatewayProfile::SeedanceDraft,
        GatewayProfile::FzyVideo,
    ];

    pub(crate) fn profile_id(self) -> &'static str {
        match self {
            GatewayProfile::Sp25PerUse => SP25_PER_USE_VIDEO_PROFILE,
            GatewayProfile::RdVideo => RD_VIDEO_PROFILE,
            GatewayProfile::PixVerse => MOYU_PIXVERSE_VIDEO_PROFILE,
            GatewayProfile::SeedanceDraft => MOYU_SEEDANCE_DRAFT_PROFILE,
            GatewayProfile::FzyVideo => FZY_VIDEO_PROFILE,
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
        )
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn profile_ids_round_trip_through_the_registry() {
        for family in GatewayProfile::REGISTRY {
            assert_eq!(
                GatewayProfile::from_profile_id(family.profile_id()),
                Some(family),
                "档案 ID 必须能反查回家族：{}",
                family.profile_id()
            );
        }
        assert_eq!(GatewayProfile::REGISTRY.len(), 5);
    }

    #[test]
    fn unknown_profile_ids_are_not_families() {
        // 通用魔芋 metadata 契约不是专属家族;更不能把空串当成家族。
        for profile_id in ["", "moyu_video_metadata_v1", "rd_video_v2", "sp25_video_v1"] {
            assert_eq!(GatewayProfile::from_profile_id(profile_id), None);
        }
    }

    #[test]
    fn family_model_ids_are_disjoint_and_ordered() {
        // RD 型号含 seedance-2.5 子串，必须与通用家族互斥，否则判定顺序会漂移。
        let samples = [
            ("sp2.5-720p-30s-ch5", GatewayProfile::Sp25PerUse),
            ("rd-seedance-2.5-1080p", GatewayProfile::RdVideo),
            ("PixVerse-V6", GatewayProfile::PixVerse),
            ("pixverse-c1", GatewayProfile::PixVerse),
            ("doubao-seedance-2-5-260628", GatewayProfile::SeedanceDraft),
            ("doubao-seedance-2.5", GatewayProfile::SeedanceDraft),
        ];
        for (model_id, expected) in samples {
            assert_eq!(
                GatewayProfile::from_model_id(model_id),
                Some(expected),
                "模型 {model_id} 应判定为 {expected:?}"
            );
        }
        for unrelated in ["wan3.0-video", "veo-3.1", "seedance-2.0-260128"] {
            assert_eq!(
                GatewayProfile::from_model_id(unrelated),
                None,
                "{unrelated} 不属于任何已注册家族"
            );
        }
    }

    #[test]
    fn pixverse_and_draft_contracts_require_openai_compatible_dialect() {
        for family in [GatewayProfile::PixVerse, GatewayProfile::SeedanceDraft] {
            assert!(family.available_on(RequestDialect::OpenAiCompatible));
            assert!(!family.available_on(RequestDialect::VolcengineArk));
        }
        for family in [GatewayProfile::Sp25PerUse, GatewayProfile::RdVideo] {
            assert!(family.available_on(RequestDialect::OpenAiCompatible));
            assert!(family.available_on(RequestDialect::VolcengineArk));
        }
        for model in ["doubao-seedance-2-5-260628", "doubao-seedance-2.5"] {
            assert_eq!(
                GatewayProfile::for_frozen_snapshot(
                    Some(model),
                    super::super::provider_adapter::MOYU_ADAPTER_ID
                ),
                Some(GatewayProfile::SeedanceDraft)
            );
            assert_eq!(
                GatewayProfile::for_frozen_snapshot(
                    Some(model),
                    super::super::provider_adapter::ARK_ADAPTER_ID
                ),
                None
            );
        }
    }

    #[test]
    fn pixverse_cadence_settles_and_stops_within_ten_minutes() {
        let cadence = GatewayProfile::PixVerse.poll_cadence();
        assert_eq!(
            cadence.next_poll_wait(Duration::ZERO),
            Some(Duration::from_secs(5))
        );
        assert_eq!(
            cadence.next_poll_wait(Duration::from_secs(29)),
            Some(Duration::from_secs(5))
        );
        assert_eq!(
            cadence.next_poll_wait(Duration::from_secs(30)),
            Some(Duration::from_secs(10))
        );
        assert_eq!(
            cadence.next_poll_wait(Duration::from_secs(599)),
            Some(Duration::from_secs(1))
        );
        assert_eq!(cadence.next_poll_wait(Duration::from_secs(600)), None);
        assert_eq!(
            cadence.retry_delay_floor(Duration::from_secs(30)),
            Some(Duration::from_secs(10))
        );
    }

    #[test]
    fn constant_families_keep_the_default_cadence_without_a_window() {
        for family in [
            GatewayProfile::Sp25PerUse,
            GatewayProfile::RdVideo,
            GatewayProfile::SeedanceDraft,
        ] {
            let cadence = family.poll_cadence();
            assert_eq!(
                cadence.next_poll_wait(Duration::from_secs(600)),
                Some(DEFAULT_VIDEO_POLL_INTERVAL)
            );
            assert_eq!(cadence.retry_delay_floor(Duration::from_secs(600)), None);
            assert_eq!(
                cadence.bound_retry_wait(Duration::from_secs(30), Duration::from_secs(600)),
                Duration::from_secs(30)
            );
        }
    }

    #[test]
    fn local_byte_requirements_cover_uploading_families_only() {
        for family in [
            GatewayProfile::Sp25PerUse,
            GatewayProfile::RdVideo,
            GatewayProfile::PixVerse,
        ] {
            assert!(family.needs_local_bytes(), "{family:?} 需要本地字节");
        }
        assert!(!GatewayProfile::SeedanceDraft.needs_local_bytes());
    }

    #[test]
    fn empty_remote_status_is_pixverse_only() {
        assert!(GatewayProfile::PixVerse.empty_remote_status_means_pending());
        for family in GatewayProfile::REGISTRY {
            if family != GatewayProfile::PixVerse {
                assert!(!family.empty_remote_status_means_pending());
            }
        }
    }

    #[test]
    fn frozen_snapshots_gate_on_dialect() {
        for model_id in ["PixVerse-V6", "doubao-seedance-2.5", "custom-video"] {
            assert_eq!(
                GatewayProfile::for_frozen_snapshot(Some(model_id), "fzy_ai_v1"),
                Some(GatewayProfile::FzyVideo)
            );
        }
        assert_eq!(
            GatewayProfile::for_frozen_snapshot(Some("PixVerse-V6"), "moyu_v1"),
            Some(GatewayProfile::PixVerse)
        );
        assert_eq!(
            GatewayProfile::for_frozen_snapshot(Some("PixVerse-V6"), "volcengine_ark_v1"),
            None
        );
        assert_eq!(
            GatewayProfile::for_frozen_snapshot(Some("sp2.5-720p-30s-ch5"), "moyu_v1"),
            Some(GatewayProfile::Sp25PerUse)
        );
        assert_eq!(GatewayProfile::for_frozen_snapshot(None, "moyu_v1"), None);
    }

    #[test]
    fn operation_schema_profile_lookup_reads_the_frozen_contract() {
        let schema = json!({ "requestProfileId": RD_VIDEO_PROFILE });
        assert_eq!(
            GatewayProfile::from_operation_schema(&schema),
            Some(GatewayProfile::RdVideo)
        );
        assert_eq!(
            GatewayProfile::from_operation_schema(&json!({})),
            None,
            "没有冻结档案的通用契约不是家族"
        );
    }
}
