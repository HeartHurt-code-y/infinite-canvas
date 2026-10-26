//! 自定义协议响应的统一回传通道：主线程投递 + 分池并发上限 + 回写兜底。
//!
//! 背景：`assetproxy` / `localbase64` 两个异步自定义协议原先直接在 tokio /
//! `spawn_blocking` 工作线程上调用 `UriSchemeResponder::respond`。wry 0.55.1 的 responder
//! （`wry-0.55.1/src/wkwebview/class/url_scheme_handler.rs`）会在**调用线程**上直接执行
//! `WKURLSchemeTask` 的 `didReceiveResponse:` / `didReceiveData:` / `didFinish`，不做任何
//! 主线程派发；跨线程调用时，WebKit 为了校验任务状态需要同步回到主 RunLoop
//! （`getExceptionTypeFromMainRunLoop` / `callOnMainRunLoopAndWait`），于是工作线程会与
//! 主线程上的 `stop_task`、图层提交互相等待/穿插。素材库一次拉 100 个素材、100 张预览
//! 同时加载的突发会把这种跨线程同步等待放大成 SIGABRT（infinite-canvas 0.2.4 的 macOS
//! 崩溃报告：tokio-rt-worker 栈在 URLSchemeHandler responder 里，兄弟 worker 卡在
//! `didReceiveResponse:` 的 `callOnMainRunLoopAndWait`，主线程同时在提交大量
//! RemoteLayerTree 图层）。崩溃报告里多个 worker 都能从不同线程调用 did*，说明新版
//! WebKit 确实在容忍跨线程调用、把校验转派回主 RunLoop —— 但这份「容错」在突发下会退化
//! 成跨线程同步等待与任务生命周期竞态，不能依赖。按 Apple 文档与老 WebKit 的语义，
//! WKURLSchemeTask 的回写本来就应该在主线程完成，因此这里统一投递回主线程。
//!
//! 必须同时成立的前提：release 不能用 `panic = "abort"`。objc2 0.6 的文档明确说明
//! （`objc2/src/exception.rs`）：`panic = "abort"` 时 `objc2::exception::catch` 抓不住
//! Objective-C 异常；而 wry 的 responder 正是用 `exception::catch` 包住 WebKit 的 did*
//! 调用。一旦 WebKit 抛出 NSException（例如 "No response sent"），abort 会直接终结整个
//! 进程；保留 unwind 才能让单次异常被捕获、被记录，而不是闪退。这是本次修复必须与
//! `panic = "unwind"` 同时生效的原因。
//!
//! 这里统一做五件事：
//! 1. [`deliver_protocol_response`] 把 responder 投递到主线程执行，并用 oneshot 确认主线程
//!    真正执行了 respond。等待超过 30s 只记一次日志、不释放许可，继续等主线程执行 ——
//!    oneshot await 不占 worker 线程，真正给「在途响应体」封顶的是许可池，因此主线程
//!    冻结时排队响应体最多等于池大小，不会无界滞留；
//! 2. 三个 [`ProtocolSlotPool`] 分池限制「响应计算 + 主线程投递」的在途数量：
//!    [`MEDIA_PROXY_RESPONSE_SLOTS`]（上游/通用 8）、[`LOCAL_BASE64_RESPONSE_SLOTS`]
//!    （本地 Base64 解码 4）。拆池的目的是让慢速大上游不会饿死本地解码；
//!    两池相加（8+4=12）同时就是在途响应体的总量上界。另有
//!    [`WARM_PREVIEW_RESPONSE_SLOTS`]（2）只服务后台预热：预热必须给前台预览让路，
//!    拿不到许可就跳过，不计入响应在途上限；
//! 3. [`ProtocolReplyGuard`] 是回写兜底：任务一开始就接管 responder，正常路径经它回写；
//!    任务 panic 或提前退出时，它的 `Drop` 会 fire-and-forget 一个 503，保证 WebKit
//!    任务一定有终态，不会永远等一个已经被 drop 的 responder；
//! 4. [`run_catching_panic`] 把主线程回调里的 panic 关在回调内部：wry 的 responder 内部
//!    有 `to_str().unwrap()` 这类 panic 点，panic 穿出主线程事件循环的 Rust 边界会直接
//!    abort 整个进程；
//! 5. [`InFlightResponseBytes`] 记录在途响应体字节的 current/peak：峰值首次越过
//!    512 MiB 告警线时打一条固定日志（只含聚合字节数），供 macOS 真机 100 素材页回归时
//!    对照 RSS、判断是否需要给响应体加字节配额。
//!
//! 这里不按平台 cfg 分流：主线程投递在 Windows / Linux 上同样安全（Tauri 的 responder
//! 本就设计为可从任意线程调用、由运行时切到主线程），保持一份实现才能让这段逻辑在
//! Windows 上编译、在 Windows 上跑单测；macOS 特有的约束不必靠 cfg 藏起来。

use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

use serde_json::json;
use tauri::{
    AppHandle, Runtime, UriSchemeResponder,
    http::{HeaderMap, HeaderValue, Response, StatusCode},
};
use tokio::sync::{Semaphore, SemaphorePermit, oneshot};

/// 上游/通用 `assetproxy` 响应许可数。
///
/// 8 是在「预览批次吞吐」与「主线程 / WebKit 压力」之间取的保守值：一屏 100 张预览按
/// 8 个一批推进只需十几轮，而同时在途的上游响应体、阻塞线程与主线程投递队列都保持有界。
/// 慢速大上游（传输预算最长 20 分钟）只会占满这个池，不会影响另外两个池。
pub(crate) const MEDIA_PROXY_RESPONSE_SLOTS: usize = 8;

/// 本地 Base64 解码/响应许可数。
///
/// 本地素材解码是 CPU + 阻塞 IO，与上游取字节完全不同源；单独 4 个许可既限制阻塞线程
/// 与响应体，也不会被网络慢的上游请求拖住。
pub(crate) const LOCAL_BASE64_RESPONSE_SLOTS: usize = 4;

/// 后台预览预热许可数。
///
/// 预热只在前台空闲时用 2 个许可：拿不到就直接跳过这张图的预热（前台有按需加载路径，
/// 不会丢预览）。后台预热必须给前台预览让路，不能和用户正在看的 100 张卡片抢带宽/内存。
pub(crate) const WARM_PREVIEW_RESPONSE_SLOTS: usize = 2;

/// 等待主线程确认执行 `respond` 的提示阈值。
///
/// 超过它只打一条日志，**不释放许可、不放弃等待**：真正给在途响应封顶的是许可池。
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(30);

/// 进程级自定义协议响应许可池：可 `const` 构造，直接定义成 `static`。
///
/// 每个池独立计数，互不阻塞；`&'static self` 的 acquire 让 permit 也是 `'static`，可以
/// 跨 await 一直持有到响应写完。
pub(crate) struct ProtocolSlotPool {
    slots: Semaphore,
}

impl ProtocolSlotPool {
    /// `const` 构造：用 [`Semaphore::const_new`] 初始化 static，无需 `OnceLock`。
    pub(crate) const fn new(permits: usize) -> Self {
        Self {
            slots: Semaphore::const_new(permits),
        }
    }

    /// 取一个许可；信号量已关闭（只可能在进程退出阶段）时返回 `None`。
    ///
    /// permit 要覆盖「整段响应计算 + 主线程投递」，而不只是「调用 respond 的那一瞬」：
    /// 这样在途响应体大小、阻塞线程数量与主线程投递队列长度才有硬上界。
    ///
    /// 取许可的时机必须在 `fetch_shared` 登记**之前**（见
    /// `media_proxy::handle_media_proxy_request`）：同一个上游地址只有领导请求真正取
    /// 字节，跟随请求在 `fetch_shared` 里等它的结果。领导请求在登记之前就已经持有许可，
    /// 并且一直持有到自己的取字节完成、结果发布，所以跟随请求不可能把它挤掉 —— 若反过来
    /// 「先登记再取许可」，跟随请求可能先占满许可，而领导请求还在等许可，于是跟随者等
    /// 领导、领导等许可的环形等待就会出现。现在的顺序是：领导在许可内推进，跟随者的
    /// 等待一定以领导发布结果或领导被取消（`InFlightGuard` 摘除死槽位）结束。
    pub(crate) async fn acquire(&'static self) -> Option<SemaphorePermit<'static>> {
        self.slots.acquire().await.ok()
    }

    /// 非阻塞取许可：拿不到就返回 `None`。
    ///
    /// 后台预热（`media_proxy::warm_one`）用这个接口：池满时必须立刻让路，而不是排队等
    /// 前台预览释放 —— 预热本来就可以跳过，前台有按需加载路径，不会丢图。
    pub(crate) fn try_acquire(&'static self) -> Option<SemaphorePermit<'static>> {
        self.slots.try_acquire().ok()
    }
}

/// 上游/通用 `assetproxy` 响应池。
pub(crate) static MEDIA_PROXY_RESPONSE_POOL: ProtocolSlotPool =
    ProtocolSlotPool::new(MEDIA_PROXY_RESPONSE_SLOTS);
/// 本地 Base64 解码/响应池。
pub(crate) static LOCAL_BASE64_RESPONSE_POOL: ProtocolSlotPool =
    ProtocolSlotPool::new(LOCAL_BASE64_RESPONSE_SLOTS);
/// 后台预览预热池：拿不到许可就跳过预热，给前台预览让路。
pub(crate) static WARM_PREVIEW_RESPONSE_POOL: ProtocolSlotPool =
    ProtocolSlotPool::new(WARM_PREVIEW_RESPONSE_SLOTS);

/// 在途响应体字节告警线（512 MiB）。
///
/// 这是**可观测告警阈值，不是硬限制**：真正的并发上限由许可池决定，单条响应体的上限
/// 见各协议自己的 `MAX_*` 常量。峰值首次越过这条线时打一条固定日志（带 current/peak
/// 字节数、不带 URL / 签名），用于 macOS 真机用 100 素材页回归时对照 RSS、判断是否需要
/// 引入字节配额。
const IN_FLIGHT_BYTES_WARN_THRESHOLD: usize = 512 * 1024 * 1024;

/// 进程级在途响应体字节统计。
///
/// 从 [`deliver_protocol_response`] 入口开始把 `response.body().len()` 计入 current，
/// 直到主线程确认回写才归还：峰值可用于真机回归时对照 RSS，判断三池并发的响应体是否
/// 接近内存上限。等待超时**不**提前归还 —— 响应体此刻仍被主线程闭包持有，提前归还会让
/// current 偏小、峰值失真，也让「在途响应体 ≤ 池大小」这个硬上界失去观测依据。
/// 测试可以构造独立实例，不碰全局计数。
struct InFlightResponseBytes {
    current: AtomicUsize,
    peak: AtomicUsize,
}

impl InFlightResponseBytes {
    const fn new() -> Self {
        Self {
            current: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
        }
    }

    /// 记账一段在途响应体，返回 RAII 句柄：Drop 时自动归还。
    ///
    /// 峰值用 CAS 更新；并发下只有把峰值从「未超阈值」推进到「超过阈值」的那一个线程
    /// 打告警日志，因此不会刷屏。
    fn track(&self, len: usize) -> InFlightResponseBytesGuard<'_> {
        if len > 0 {
            let current = self.current.fetch_add(len, Ordering::SeqCst) + len;
            let mut peak = self.peak.load(Ordering::Relaxed);
            while current > peak {
                match self.peak.compare_exchange_weak(
                    peak,
                    current,
                    Ordering::SeqCst,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => {
                        if current > IN_FLIGHT_BYTES_WARN_THRESHOLD
                            && peak <= IN_FLIGHT_BYTES_WARN_THRESHOLD
                        {
                            // 固定文案，不带 URL / 签名：只报聚合字节数。peak 取更新后的
                            // 真实峰值（并发下可能已被其它线程推得更高）。
                            let peak_now = self.peak.load(Ordering::SeqCst);
                            tauri_plugin_log::log::warn!(
                                "自定义协议在途响应体峰值超过 512 MiB 告警线：current={current} bytes, peak={peak_now} bytes"
                            );
                        }
                        break;
                    }
                    Err(actual) => peak = actual,
                }
            }
        }
        InFlightResponseBytesGuard { stats: self, len }
    }
}

/// 进程级在途响应体字节统计的全局实例。
static IN_FLIGHT_RESPONSE_BYTES: InFlightResponseBytes = InFlightResponseBytes::new();

/// 在途响应体字节的 RAII 句柄：作用域结束（正常返回 / 提前 return / panic）时归还。
///
/// 用 RAII 而不是手动归还：这段代码的每条出口都可能提前退出，漏一次就会让
/// current 永久偏大，峰值告警随之失真。
struct InFlightResponseBytesGuard<'a> {
    stats: &'a InFlightResponseBytes,
    len: usize,
}

impl Drop for InFlightResponseBytesGuard<'_> {
    fn drop(&mut self) {
        if self.len > 0 {
            self.stats.current.fetch_sub(self.len, Ordering::SeqCst);
        }
    }
}

/// 在主线程回调里执行 `action`，把 panic 关在回调内部。
///
/// 为什么必须 catch：`run_on_main_thread` 把闭包交给主线程事件循环执行，任其 panic 会
/// 穿出 Rust 边界，在 release 下直接 abort 整个进程（本次崩溃报告里的 SIGABRT 就有
/// 这种形态）。`catch_unwind` 让回调安全返回，主线程继续运行；panic 现场仍由进程的
/// panic hook 记录。
///
/// 返回 `true` 表示正常执行完毕，`false` 表示捕获到 panic（该次响应可能没有完成）。
fn run_catching_panic<F: FnOnce() + Send + 'static>(action: F) -> bool {
    catch_unwind(AssertUnwindSafe(action)).is_ok()
}

/// 把自定义协议响应交给主线程回写，并等待主线程真正执行完 `respond`。
///
/// 主线程回写才安全：wry 的 responder 会在调用线程直接调用 WKURLSchemeTask 的 did*
/// 方法，跨线程时 WebKit 需要同步回主 RunLoop 校验任务（见模块文档），因此这里不区分
/// 平台，统一走 `AppHandle::run_on_main_thread`。`UriSchemeResponder` 与
/// `Response<Vec<u8>>` 都是 `Send + 'static`，可以直接 move 进主线程闭包；工作线程持有
/// 的只是一个 oneshot 接收端，只用来确认「主线程已经执行了 respond」，不观察 WebKit
/// 后续状态（任务被 stop 等仍由主线程处理）。
///
/// 等待语义：超过 [`DELIVERY_TIMEOUT`] 只记一次日志，**继续等**主线程执行闭包，不释放
/// 调用方的许可。`oneshot` 的 await 不会阻塞 worker 线程，所以 worker 线程不会被挂死；而
/// 主线程冻结时，每个池最多只有池大小段响应体在排队（不会因为「超时即返回」而让响应体
/// 无界滞留）。主线程恢复后闭包照常执行；应用退出导致通道关闭时 `rx.await` 返回 `Err`，
/// 函数正常结束。
///
/// 本函数假定调用方已经把 responder 交出去且一定会被调用；handler 层应通过
/// [`ProtocolReplyGuard::deliver`] 使用它，这样任务在调用本函数之前 panic 时仍有 Drop
/// 兜底，不会让 WebKit 任务永远等一个悬空的 responder。
///
/// 进入函数即把 `response.body().len()` 计入在途响应体字节统计（见
/// [`InFlightResponseBytes`]），函数返回时由 RAII 句柄归还；这是真机回归时观察内存
/// 峰值的数据来源，不改变任何响应语义。
pub(crate) async fn deliver_protocol_response<R: Runtime>(
    app: &AppHandle<R>,
    responder: UriSchemeResponder,
    response: Response<Vec<u8>>,
) {
    let body_len = response.body().len();
    let _in_flight = IN_FLIGHT_RESPONSE_BYTES.track(body_len);
    let (tx, mut rx) = oneshot::channel::<()>();
    let app = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = run_catching_panic(move || {
            let _ = responder.respond(response);
        });
        let _ = tx.send(());
    });
    /*
     * 结束条件只有一个：**主线程真正执行完 respond**（闭包里的 `tx.send(())`）。
     *
     * 超过 [`DELIVERY_TIMEOUT`] 只记一次日志然后**继续等**，绝不能直接返回。一旦返回，
     * 调用方的许可（`SemaphorePermit`）与本函数的字节记账句柄会一起被释放，而响应体
     * 此刻**仍被主线程闭包持有**（responder 与 response 都 move 进了闭包）。那会同时
     * 捅穿两个硬上界：
     *   - 许可池提前放行 → 新请求涌进来，主线程队列里的响应体无界滞留；
     *   - 在途字节提前归还 → [`IN_FLIGHT_BYTES_WARN_THRESHOLD`] 的计数失真。
     * 主线程冻结时每个池最多只有池大小段响应体在排队，这正是许可池要保证的性质，
     * 也正是模块文档承诺的「超时只记一次日志、不释放许可、继续等主线程执行」。
     *
     * oneshot 的 await 不占 worker 线程：等待期间这个任务只是挂起，不会把 tokio
     * worker 线程堵死。
     *
     * 通道关闭（`run_on_main_thread` 投递失败时闭包被丢弃）意味着闭包从未执行、响应体
     * 已随之释放，此时归还字节记账并让调用方释放许可是正确的。
     */
    let wait = tokio::time::timeout(DELIVERY_TIMEOUT, &mut rx).await;
    match wait {
        Ok(Ok(())) => {}
        Ok(Err(_)) => {
            tauri_plugin_log::log::warn!(
                "自定义协议响应回写通道已关闭（主线程投递未确认）：body={body_len} bytes"
            );
        }
        Err(_) => {
            tauri_plugin_log::log::warn!(
                "自定义协议响应回写等待超时，继续等待主线程执行：body={body_len} bytes"
            );
            // 不释放许可、不归还字节记账：继续等主线程真正执行完 respond。
            let _ = rx.await;
        }
    }
}

/// 兜底响应：并发闸门不可用或响应任务失败时回一个明确状态，避免 WebKit 任务悬空。
///
/// 带 `access-control-allow-origin: *` 与 `cache-control: no-store`：自定义协议上的
/// 4xx/5xx 会被前端 `fetch` 当作网络层失败处理（被 CORS 挡掉时 WebView 可能把状态码
/// 变成不透明的失败），补上 CORS 才能让前端拿到干净的失败语义；no-store 避免错误响应
/// 被中途缓存。`assetproxy` 与 `localbase64` 共用 503 空体语义，JSON 错误体仍由
/// `media_proxy::error_response` 负责。
pub(crate) fn unavailable_response(
    status: StatusCode,
    error: &str,
    is_head: bool,
) -> Response<Vec<u8>> {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers.insert(
        "access-control-allow-origin",
        HeaderValue::from_static("*"),
    );
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    let body = if is_head {
        Vec::new()
    } else {
        serde_json::to_vec(&json!({ "error": error })).unwrap_or_default()
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

/// 立即回一个错误响应（不排队、不等许可）。
///
/// 走主线程 + `catch_unwind`：wry 的 responder 内部有 `to_str().unwrap()` 这类
/// panic 点，直接在工作线程裸调 `respond()`，panic 会穿出线程边界；
/// 在 Windows 上 release 下等价于 abort 整个进程。
pub(crate) fn respond_unavailable<R: Runtime>(
    app: &AppHandle<R>,
    responder: UriSchemeResponder,
    error: &str,
) {
    let response = unavailable_response(StatusCode::SERVICE_UNAVAILABLE, error, false);
    let app = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = run_catching_panic(move || {
            let _ = responder.respond(response);
        });
    });
}

/// 自定义协议响应的「回写守卫」：保证每个 WebKit 自定义协议任务一定拿到终态。
///
/// 两个 `handle_*` 入口都在异步任务里计算响应。若在响应算完之后、`respond` 之前发生
/// panic（release 现在是 unwind，tokio 捕获 panic 后直接结束该任务），或代码提前 return
/// 漏掉回写，`UriSchemeResponder` 就会随任务一起被 drop：WebKit 的自定义协议任务永远
/// 等不到 `didReceiveResponse:/didFinish`，轻则图片永久转圈，重则触发 WebKit 的
/// "No response sent" NSException。
///
/// 因此入口在任务一开始就构造本守卫并接管 responder：正常路径调用
/// [`ProtocolReplyGuard::deliver`]，由它 take 出 responder 再走主线程投递；任务 panic 或
/// 提前退出时，[`Drop`] 是最后一道兜底 —— fire-and-forget 回一个 503 空响应，保证
/// WebKit 任务有终态。
///
/// `UriSchemeResponder` 只能 respond 一次，所以内部用 `Option` 记录：`deliver` 先 take，
/// Drop 只会看到 `None`，不会重复回写。
pub(crate) struct ProtocolReplyGuard<R: Runtime> {
    app: AppHandle<R>,
    responder: Option<UriSchemeResponder>,
}

impl<R: Runtime> ProtocolReplyGuard<R> {
    /// 任务一开始就接管 responder。
    pub(crate) fn new(app: &AppHandle<R>, responder: UriSchemeResponder) -> Self {
        Self {
            app: app.clone(),
            responder: Some(responder),
        }
    }

    /// 正常路径：take 出 responder 交还调用方去投递。
    pub(crate) fn take_responder(&mut self) -> Option<UriSchemeResponder> {
        self.responder.take()
    }
}

impl<R: Runtime> Drop for ProtocolReplyGuard<R> {
    fn drop(&mut self) {
        let Some(responder) = self.responder.take() else {
            return;
        };
        let app = self.app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = run_catching_panic(move || {
                let _ = responder.respond(unavailable_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "protocol_response_aborted",
                    false,
                ));
            });
        });
    }
}
