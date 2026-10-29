use crate::backend::{tasks::FrozenGenerationProfile, types::StartGenerationCommand};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 旧版本记录里没有这个字段，缺省按 3 个在途片段处理。
fn default_max_concurrent_segments() -> u32 {
    3
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLongVideoCommand {
    pub request_id: String,
    pub generation: StartGenerationCommand,
    pub planner_provider_id: String,
    pub planner_model_id: String,
    pub target_seconds: u32,
    pub segment_seconds: u32,
    pub duration_parameter: String,
    pub submission_budget: u32,
    pub link_previous_frame: bool,
    pub approve_script: bool,
    /// 同时在途的片段任务上限。原站是并发排队出片段，串行提交会让 5 分钟视频耗时不可接受。
    /// 开启尾帧承接时恒为 1：尾帧依赖上一镜头的成片，片段必须按顺序执行。
    #[serde(default = "default_max_concurrent_segments")]
    pub max_concurrent_segments: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LongVideoStatus {
    Planning,
    AwaitingApproval,
    Generating,
    Composing,
    Paused,
    AwaitingBudget,
    NeedsAttention,
    Completed,
    Cancelled,
}
impl LongVideoStatus {
    pub fn running(self) -> bool {
        matches!(self, Self::Planning | Self::Generating | Self::Composing)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planning => "planning",
            Self::AwaitingApproval => "awaiting_approval",
            Self::Generating => "generating",
            Self::Composing => "composing",
            Self::Paused => "paused",
            Self::AwaitingBudget => "awaiting_budget",
            Self::NeedsAttention => "needs_attention",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongVideoShot {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub duration_seconds: u32,
    pub attempts: Vec<String>,
    pub status: String,
    pub progress: Option<f64>,
    pub result_index: Option<u32>,
    pub final_path: Option<String>,
    pub error: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongVideoEvent {
    pub at: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongVideoOutput {
    pub path: String,
    pub name: String,
    pub duration_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub byte_size: u64,
    pub sha256: String,
    pub partial: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongVideoJob {
    pub id: String,
    pub request_id: String,
    pub canvas_id: String,
    pub source_node_id: String,
    pub title: String,
    pub status: LongVideoStatus,
    pub revision: u64,
    pub target_seconds: u32,
    pub segment_seconds: u32,
    pub composition_progress: f64,
    pub submission_budget: u32,
    pub reserved_submissions: u32,
    pub planner_task_id: String,
    pub continuity: String,
    pub shots: Vec<LongVideoShot>,
    pub output: Option<LongVideoOutput>,
    pub error: Option<Value>,
    pub yield_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub events: Vec<LongVideoEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LongVideoRecord {
    pub job: LongVideoJob,
    pub command: StartLongVideoCommand,
    pub video_profile: FrozenGenerationProfile,
    pub planner_profile: FrozenGenerationProfile,
    pub script_approved: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LongVideoAction {
    Approve,
    Pause,
    Resume,
    Cancel,
    SetBudget,
    RetryFailed,
    Replan,
    ComposePartial,
    Query,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongVideoControl {
    pub job_id: String,
    pub action: LongVideoAction,
    pub revision: Option<u64>,
    pub submission_budget: Option<u32>,
    pub shots: Option<Vec<LongVideoShotEdit>>,
    pub continuity: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongVideoShotEdit {
    pub id: String,
    pub title: String,
    pub prompt: String,
}
