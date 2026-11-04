mod backend;

use std::panic::{AssertUnwindSafe, catch_unwind};

use backend::commands;
use tauri::Manager as _;
use tauri_plugin_opener::OpenerExt as _;

/// 处理 `--keychain-access-self-test=<ref>`：返回 true 表示已完成自检、调用方应跳过启动。
///
/// 用途：一条命令回答「这个构建产物能不能正常存取凭据」。它走与线上完全相同的
/// `CredentialStore` 路径（写 → 读 → 重开再读），不依赖任何 GUI。
/// 参数名保留历史的 `keychain-` 前缀以兼容既有脚本；macOS 默认已改用文件后端，
/// 不再涉及钥匙串。
///
/// 该参数只在命令行显式给出时才生效，正常启动（由 Finder/LaunchServices 拉起）不受影响。
fn run_keychain_access_self_test_if_requested() -> bool {
    let Some(request) = backend::credentials::KeychainSelfTestRequest::parse(std::env::args())
    else {
        return false;
    };
    let outcome = backend::credentials::run_keychain_self_test(&request);
    println!("{}", outcome.report());
    if !outcome.passed() {
        eprintln!(
            "keychain-access-self-test: 该产物无法正常存取凭据。\
             这通常意味着应用数据目录不可写；可用 INFINITE_CANVAS_CREDENTIAL_BACKEND 切换后端。"
        );
    }
    // std::process::exit 不跑析构：输出重定向到管道（CI 里正是如此）时 stdout 是块缓冲的，
    // 不显式 flush 就可能丢掉上面那行结论，而调用方正是按这行判定成败。
    use std::io::Write as _;
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    // 测试脚本按这行结论与退出码判定，不做语言相关的文本匹配。
    std::process::exit(if outcome.passed() { 0 } else { 1 });
}

/// 判定 URL 是否属于应用自身、允许在主 webview 内加载。
///
/// http(s) 只放行开发服务器与 Tauri 各协议在本机的回环地址（Windows 生产环境
/// 应用来源是 `http://tauri.localhost`）；其余一律算站外，交给 `on_navigation`
/// 改走系统浏览器。host 采用全等匹配，`tauri.localhost.evil.com` 这类前缀
/// 相似的域名不会误放行。
fn is_internal_webview_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "asset" | "assetproxy" | "localbase64" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some(
                "localhost" | "127.0.0.1" | "tauri.localhost" | "asset.localhost" | "ipc.localhost"
            )
        ),
        _ => false,
    }
}

/// 主窗口必须在 Rust 侧手工创建（tauri.conf.json 不再声明 windows）：`on_navigation`
/// 只存在于 builder 上，配置自动创建的窗口挂不上。
///
/// 这是外链治理的最后一道防线（前两道在前端：main.tsx 的全局点击守卫与
/// MarkdownView 的链接处理）：任何漏网渠道触发的站外导航都被取消并改用
/// 系统浏览器打开，保证主窗口永远不会被外部页面原地顶掉——Tauri 窗口没有
/// 地址栏和返回键，用户一旦被顶掉只能杀进程。
fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let handle = app.clone();
    tauri::WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, tauri::WebviewUrl::default())
        .title("无限画布")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .center()
        .resizable(true)
        .devtools(true)
        .on_navigation(move |url| {
            if is_internal_webview_url(url) {
                return true;
            }
            tauri_plugin_log::log::info!("[导航] 拦截站外跳转，改用系统浏览器打开: {url}");
            if let Err(error) = handle.opener().open_url(url.as_str(), None::<&str>) {
                tauri_plugin_log::log::warn!("[导航] 系统浏览器打开失败: {error}");
            }
            false
        })
        .build()?;
    Ok(())
}

/// 画布工作台主窗口的标签。
///
/// 主窗口在 `setup()` 里手工创建（见 `create_main_window`），创作台窗口要靠它
/// 找回来；两处必须用同一个常量，别各写一份字面量。
const MAIN_WINDOW_LABEL: &str = "main";

/// 创作台独立窗口的标签。
///
/// 固定为 `create`：前端 `createEntry.ts` 也按这个标签判定入口（URL `?view=create`
/// 之外的第二条通道），两边必须一致。
const CREATE_WINDOW_LABEL: &str = "create";

/// 建窗口的等待上限。
///
/// 事件循环万一卡住（别的窗口创建出问题），前端不能永远等一个不 settle 的
/// promise：超时要变成人话报错，用户至少知道「再点一次」。
const WINDOW_CREATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// 关闭兜底看门狗的等待上限。
///
/// **为什么需要它**（这是「点右上角 ❌ 关不掉、只能任务管理器杀进程」的根因）：
///
/// 1. Tauri 收到窗口关闭请求时，只要发现该窗口注册过 close-requested 的
///    **JS 监听器**，就**无条件** `prevent_close()`
///    （tauri 的 `manager::window::on_window_event`）——原生的 WM_CLOSE 被吞掉；
/// 2. 窗口真正关掉，只能靠 JS 那边跑完 handler 后调用 `destroy()`；
/// 3. 而 Tauri 记录 JS 监听器的那张表（`js_event_listeners`）**只在 JS 主动
///    unlisten 时才清理**：渲染进程崩溃/被杀时，监听器注册会永久残留。
///
/// 三条合起来就是死结：渲染进程一死 → Rust 侧永远认为「有人在监听」→ 永远
/// prevent_close；JS 侧已经没人跑 handler → 永远没人调 destroy()。窗口再也
/// 关不掉，只能靠任务管理器。
///
/// 这里给关闭请求加一个看门狗：超时后窗口还在就强制销毁它，保证「点 ❌ 一定
/// 能关掉」。前端明确表示「保存失败、窗口保持打开」时会调
/// `cancel_forced_window_close` 撤掉看门狗——那时窗口的去留由前端自己决定。
const CLOSE_WATCHDOG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// 关闭看门狗的令牌：0 = 未武装；非 0 = 当前武装的那一枚。
///
/// 用令牌而不是布尔量：每次武装换一个新号，旧看门狗醒来时号对不上就自行作废。
/// 这样「先点一次 ❌（保存失败、窗口保持打开）→ 过一会儿再点一次 ❌」这种序列
/// 才不会让早先那个看门狗误伤。
static CLOSE_WATCHDOG_TOKEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 令牌自增器：保证每次武装拿到的令牌都是新的。
static CLOSE_WATCHDOG_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 给一次关闭请求上保险：超时后窗口还在，就强制销毁它。
///
/// 窗口销毁走 `Window::destroy()`（强制关闭、不再发事件），因此它不受
/// 「JS 侧 prevent_close」与「JS 侧还没跑到 destroy」的影响。
fn arm_close_watchdog<R: tauri::Runtime>(window: tauri::Window<R>) {
    use std::sync::atomic::Ordering;
    let token = CLOSE_WATCHDOG_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    CLOSE_WATCHDOG_TOKEN.store(token, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLOSE_WATCHDOG_TIMEOUT).await;
        if CLOSE_WATCHDOG_TOKEN.load(Ordering::SeqCst) != token {
            // 已经被新的关闭请求接管，或已被前端解除（保存失败、窗口保持打开）。
            return;
        }
        CLOSE_WATCHDOG_TOKEN.store(0, Ordering::SeqCst);
        let label = window.label().to_string();
        if window.app_handle().get_webview_window(&label).is_none() {
            // 窗口已经自己关掉了（前端正常走完了「保存后关闭」）。
            return;
        }
        tauri_plugin_log::log::warn!(
            "[窗口] 关闭兜底：{}ms 内没有走完「保存后关闭」，强制销毁窗口",
            CLOSE_WATCHDOG_TIMEOUT.as_millis()
        );
        if let Err(error) = window.destroy() {
            tauri_plugin_log::log::error!("[窗口] 关闭兜底强制销毁窗口失败: {error}");
        }
    });
}

/// 解除关闭兜底：前端明确「保存失败、窗口保持打开」时调用。
///
/// 看门狗是给「JS 侧彻底没反应」兜底的；只要前端还能回话，窗口的去留就由它
/// 自己决定——这时必须把看门狗撤掉，否则窗口会在几秒后被强制销毁，与「窗口
/// 保持打开」的提示自相矛盾。
#[tauri::command]
async fn cancel_forced_window_close() {
    CLOSE_WATCHDOG_TOKEN.store(0, std::sync::atomic::Ordering::SeqCst);
}

/// 在事件循环线程上执行一段「建/操作窗口」的活，并把结果回传给调用方。
///
/// **只能从 `async` 命令里调用**：`run_on_main_thread` 在事件循环线程上会就地执行
/// （tauri-runtime-wry 的 `send_user_message`），同步命令用它等于没绕开 WebView2 的
/// 重入限制（见 `open_create_window` 的注释）。
///
/// 这里把「延后到事件循环 + 回传结果 + 超时 + 前端放弃后不再执行 + 闭包 panic 被关住」
/// 五件事收在**一处**：以后再新增「命令里开窗口」的功能一律用它，别再手写一遍——手写就
/// 一定会有人漏掉超时或漏掉放弃守卫。
///
/// `action_label` 是给人看的名词（"创作台窗口" / "画布工作台"），只用来拼错误文案。
/// 必须是 `'static`：下面那个闭包要交给事件循环线程执行，得是 `'static` 的。
async fn run_window_action(
    app: &tauri::AppHandle,
    action_label: &'static str,
    action: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        // 前端已经超时放弃（接收端被丢弃）时就不再白建一个窗口——否则用户
        // 收到「超时，请重试」之后，窗口又凭空冒出来。
        if sender.is_closed() {
            return;
        }
        /*
         * 建窗口的闭包跑在事件循环线程上，它 panic 会穿出线程边界、release 下
         * 直接 abort 整个进程（与 `backend/protocol_reply.rs` 的
         * `run_catching_panic` 同一个道理）。这里把 panic 关在闭包里：panic 现场
         * 仍由进程的 panic hook 记录，前端只拿到一句人话。
         */
        let outcome = catch_unwind(AssertUnwindSafe(action));
        let _ = sender.send(match outcome {
            Ok(result) => result,
            Err(payload) => {
                let detail = payload
                    .downcast_ref::<&str>()
                    .map(|text| (*text).to_string())
                    .or_else(|| payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "未知原因".to_string());
                tauri_plugin_log::log::error!("[窗口] 窗口操作 panic: {detail}");
                Err(format!("{action_label}操作失败，请重试。"))
            }
        });
    })
    .map_err(|error| {
        tauri_plugin_log::log::error!("[窗口] 排到事件循环失败: {error}");
        // 原始报错只进日志；给前端的是人话（「复制报错」里带的是这句摘要）。
        format!("{action_label}操作失败，请重试。")
    })?;

    match tokio::time::timeout(WINDOW_CREATE_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        // 回调没跑完就被取消（应用正在退出）：告诉用户重试，别静默。
        Ok(Err(_)) => Err(format!("{action_label}操作已中断，请重试。")),
        Err(_) => Err(format!("{action_label}操作超时，请重试。")),
    }
}

/// 打开创作台独立窗口。
///
/// 创作台与主窗口共用同一份前端产物，靠 `?view=create` 区分入口（见前端
/// `createEntry.ts` 的判定顺序：URL `?view=` > hash > Tauri 窗口标签）。
/// 窗口标签固定为 `create`，重复点击时聚焦已有窗口而不是开第二个。
///
/// **为什么建窗口要绕一圈事件循环**（这里踩过 WebView2 的重入限制）：
///
/// Tauri 的**同步**命令跑在 UI 线程上，而且是在 WebView2 的 IPC 回调栈里执行的
/// （命令本来就是被 webview 的消息回调调起来的）。在那个回调里再建一个 WebView2
/// 控制器会踩 WebView2 的重入限制：新建控制器的「创建完成」回调要等当前回调返回
/// 才会派发，而 wry 正是在等这个回调（`webview2_com::wait_with_pump` → `GetMessageA`
/// 阻塞）。于是双方互等：窗口外壳建出来了（标题栏看得见），webview 永远停在
/// `about:blank`（**白屏**），整个应用的 UI 线程也被卡死（事件循环再也回不到自己
/// 手上，主窗口看上去还活着，实际已经不响应任何 Tauri 事件）。
///
/// 所以这里把「建窗口」挪到事件循环的下一轮（`run_on_main_thread` 的 Task 消息）：
/// 那时已经不在 WebView2 的回调栈里，控制器能正常创建完；而窗口仍然建在事件循环
/// 线程上——tao 要求窗口必须在事件循环线程创建，不能改成后台线程。
///
/// **注意：命令体必须是 `async`**，这不是风格问题而是前提：tauri-runtime-wry 的
/// `send_user_message` 在**事件循环线程上会就地执行**（`current_thread().id() ==
/// main_thread_id` 就直接 `handle_user_message`），所以同步命令调 `run_on_main_thread`
/// 等于没绕开——照样在 WebView2 回调栈里建窗口，照样死锁，而且没有任何编译错误。
/// 命令体是 `async` 才会跑在 Tauri 的异步运行时上，消息才真正排到下一轮。
///
/// 结果用 oneshot 回传给前端：失败时前端能拿到人话报错，而不是一个永远不 resolve
/// 的 promise。
#[tauri::command]
async fn open_create_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(CREATE_WINDOW_LABEL) {
        /*
         * 已经在开：把它拉到前台。
         *
         * 聚焦失败只意味着一件事——这个窗口正在被关闭（或者应用正在退出）。
         * 那就当它不存在，直接建一个新的；否则用户点了「创作台」却什么都没发生，
         * 只弹一条「无法打开创作台」。
         */
        if focus_window(&existing).is_ok() {
            return Ok(());
        }
    }

    tauri_plugin_log::log::info!("[创作台] 请求打开创作台窗口");
    let creator = app.clone();
    run_window_action(&app, "创作台窗口", move || {
        build_create_window(&creator)
    })
    .await
}

/// 把一个已存在的窗口拉到前台。
///
/// 只 `set_focus` 的话，**最小化**的窗口仍然缩在任务栏：用户点了「创作台」，
/// 程序这边一切正常，屏幕上却什么都没发生。所以先取消最小化再聚焦。
fn focus_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

/// 把焦点交回画布工作台主窗口。
///
/// 创作台是独立窗口（label=`create`），它的侧栏「画布 → 全部 / 新建画布」要在
/// **主窗口**里打开：入口在挂载时按 URL / 窗口标签定死，创作台窗口的标签永远是
/// `create`，在这里导航只会把创作台自己重新加载一遍；而真把画布挂进这个窗口，
/// 同一张画布就会被两个窗口的 store 同时写、互相覆盖存档。
///
/// 主窗口不存在时（用户把它关了，而创作台窗口还开着、应用并不会退出）就**重新建
/// 一个**——只报错会让用户困在创作台里回不去画布。
///
/// 这个命令也必须是 `async` 且把建窗口排到事件循环：重建主窗口同样要新建一个
/// WebView2 控制器，放在 WebView2 回调栈里做就是同一个死锁（见 `open_create_window`
/// 的注释）。
#[tauri::command]
async fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        /*
         * 主窗口还在：直接拉到前台。
         *
         * 聚焦失败只意味着一件事——它正在被关闭（或者应用正在退出）。那就当它不存在，
         * 走下面的重建。画布的保存不受影响：主窗口关闭时是先 flush 存档、再 destroy，
         * 窗口从管理器里消失的那一刻数据已经落库，所以重建出来的窗口读到的是最新存档。
         */
        if focus_window(&window).is_ok() {
            return Ok(());
        }
    }

    tauri_plugin_log::log::info!("[创作台] 主窗口已关闭，重新创建画布工作台");
    let creator = app.clone();
    run_window_action(&app, "画布工作台", move || {
        rebuild_main_window(&creator)
    })
    .await
}

/// 重新创建画布工作台主窗口。**只能在事件循环线程上调用**。
fn rebuild_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    /*
     * `create_main_window` 只建窗口，不碰应用级状态（没有注册事件处理器、没有动
     * `manage` 的状态），所以第二次调用是安全的。
     *
     * 「main」这个标签能被重新用上，靠的是 Tauri 在窗口 **Destroyed** 时把标签从注册表
     * 里摘掉（tauri 的 `on_window_close`）。主窗口的关闭流程是「先 flush 存档、再
     * destroy」，所以标签释放的那一刻数据已经落库。
     *
     * 唯一会失败的情况是旧主窗口还占着 `main` 这个标签（它正在注销）：这时不用
     * 报错，聚焦那个即将消失的窗口即可，用户再点一次「全部」就会走重建分支。
     */
    if let Err(error) = create_main_window(app) {
        return match app.get_webview_window(MAIN_WINDOW_LABEL) {
            Some(existing) => focus_window(&existing),
            None => {
                tauri_plugin_log::log::error!("[创作台] 画布工作台重建失败: {error}");
                Err("画布工作台重建失败，请重试。".to_string())
            }
        };
    }
    match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => focus_window(&window),
        None => Err("画布工作台重建后找不到窗口。".to_string()),
    }
}

/// 真正建创作台窗口。**只能在事件循环线程上调用**（见 `open_create_window` 的注释）。
fn build_create_window(app: &tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        CREATE_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html?view=create".into()),
    )
    .title("创作台")
    .inner_size(1280.0, 800.0)
    .min_inner_size(960.0, 640.0)
    .center()
    .resizable(true)
    .devtools(true)
    .on_navigation(move |url| {
        // 与主窗口同一套站外导航治理：漏网跳转一律改用系统浏览器打开。
        if is_internal_webview_url(url) {
            return true;
        }
        tauri_plugin_log::log::info!("[导航] 创作台拦截站外跳转，改用系统浏览器打开: {url}");
        if let Err(error) = handle.opener().open_url(url.as_str(), None::<&str>) {
            tauri_plugin_log::log::warn!("[导航] 系统浏览器打开失败: {error}");
        }
        false
    })
    .on_page_load(move |_webview, payload| {
        /*
         * 白屏的诊断信号。
         *
         * 「窗口已创建」有、这一行没有 = webview 压根没导航（还是 about:blank），
         * 屏幕上就是一片白。有这一行 = 页面确实加载了，地址一目了然。
         *
         * 这里不用「起个线程 sleep 两秒再读一次 url」的办法：`window.url()` 在
         * tauri-runtime-wry 里会走到事件循环线程上的 `expect("invalid webview URL")`，
         * 那是上游的一个 panic 点；页面加载事件本身已经是解析好的 `Url`，不经过它。
         */
        tauri_plugin_log::log::info!("[创作台] 页面加载 {:?}: {}", payload.event(), payload.url());
    });

    match builder.build() {
        Ok(_) => {
            tauri_plugin_log::log::info!("[创作台] 窗口已创建");
            Ok(())
        }
        Err(error) => {
            // 并发双击：另一个调用已经用同一个标签把窗口建起来了。此时聚焦它即可，
            // 不该把「标签已存在」当成失败抛给前端（用户会看到一条莫名其妙的报错）。
            match app.get_webview_window(CREATE_WINDOW_LABEL) {
                Some(existing) => match focus_window(&existing) {
                    Ok(()) => Ok(()),
                    // 聚焦也失败：这个窗口正在被关闭。报错比假装成功好——
                    // 前端至少知道这次没打开。
                    Err(focus_error) => {
                        tauri_plugin_log::log::error!(
                            "[创作台] 窗口创建失败且已有窗口无法激活: {error} / {focus_error}"
                        );
                        Err("创作台窗口正在关闭，请再点一次。".to_string())
                    }
                },
                None => {
                    tauri_plugin_log::log::error!("[创作台] 窗口创建失败: {error}");
                    // 原始报错（标签冲突、控制器创建失败……）只进日志，用户看到人话。
                    Err("创作台窗口创建失败，请重试。".to_string())
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if run_keychain_access_self_test_if_requested() {
        return;
    }
    // Windows: 禁用 WebView2 跟踪预防，避免第三方存储/cookie 被阻止
    // （例如素材库、登录等需要第三方存储的功能）
    #[cfg(target_os = "windows")]
    {
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !existing.contains("TrackingPrevention") {
            let new_val = if existing.is_empty() {
                "--disable-features=TrackingPrevention".to_string()
            } else {
                format!("{existing} --disable-features=TrackingPrevention")
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
        .register_asynchronous_uri_scheme_protocol(
            backend::local_base64_assets::LOCAL_BASE64_SCHEME,
            backend::local_base64_assets::handle_local_base64_request,
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            /*
             * 只有画布工作台主窗口有「先存后关」的 JS 监听器（见前端
             * `CanvasWorkspace.tsx` 的 `onCloseRequested`），也只有它会踩
             * 「Rust 永远 prevent_close、JS 已经没人跑」那个死结。创作台窗口
             * 没有这个监听器，关闭走的是原生路径，不受影响。
             */
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                tauri_plugin_log::log::info!("[窗口] 收到关闭请求");
                arm_close_watchdog(window.clone());
            }
        })
        .setup(|app| {
            let setup_clock = std::time::Instant::now();
            tauri_plugin_log::log::info!("[启动] setup 开始（主线程，期间事件循环不泵消息）");
            create_main_window(app.handle())?;
            let state = backend::BackendState::initialize(app.handle())?;
            tauri_plugin_log::log::info!(
                "[启动] BackendState::initialize 完成, 耗时 {}ms",
                setup_clock.elapsed().as_millis()
            );
            if let Err(error) = state.tasks.recover() {
                tauri_plugin_log::log::error!("backend recovery failed: {error}");
            }
            tauri_plugin_log::log::info!(
                "[启动] setup 结束, 总耗时 {}ms（此后事件循环才开始泵消息）",
                setup_clock.elapsed().as_millis()
            );
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
            commands::get_canvas_document,
            commands::list_canvas_documents,
            commands::start_generation,
            commands::start_canvas_image_generation,
            commands::list_image_styles,
            commands::list_image_style_categories,
            commands::start_canvas_image_translation,
            commands::list_generation_models,
            open_create_window,
            focus_main_window,
            cancel_forced_window_close,
            commands::prepare_runtime_components_for_update,
            commands::get_runtime_component_update_status,
            commands::start_video_clip,
            commands::start_clip_render,
            commands::list_clip_renders,
            commands::cancel_clip_render,
            commands::resume_clip_render,
            commands::start_long_video,
            commands::list_long_video_jobs,
            commands::get_long_video_job,
            commands::cancel_long_video_for_node,
            commands::cancel_long_video_for_canvas,
            commands::list_active_long_video_jobs,
            commands::control_long_video,
            commands::rename_generation_result,
            commands::run_prompt_node,
            commands::start_text_generation,
            commands::translate_canvas_text,
            backend::video_local_edit::save_video_edit_frame,
            backend::audio_node_edit::edit_canvas_audio,
            backend::audio_node_edit::read_canvas_audio_waveform,
            backend::audio_node_edit::split_canvas_audio,
            backend::audio_split::start_canvas_audio_timing,
            backend::audio_split::read_canvas_audio_timing,
            backend::video_edit_source::prepare_video_edit_source,
            backend::video_edit_source::prepare_canvas_media_source,
            backend::canvas_feature_generation::start_canvas_feature_generation,
            backend::video_edit_source::release_video_edit_source,
            backend::video_clip_render::fonts::list_clip_fonts,
            backend::video_clip_render::fonts::prepare_clip_font,
            backend::video_clip_render::fonts::import_clip_font,
            commands::normalize_cover_image,
            commands::read_brand_design_image,
            commands::export_brand_design_bundle,
            commands::list_brand_models,
            commands::save_brand_model_version,
            commands::approve_brand_model_version,
            commands::validate_brand_model_version,
            commands::archive_brand_model,
            commands::resume_cover_image_result,
            commands::resume_generation_result,
            commands::prepare_macos_delta_update,
            commands::get_macos_delta_update_status,
            commands::install_prepared_macos_delta_update,
            commands::list_generation_tasks,
            commands::get_generation_task,
            commands::get_generation_task_progress,
            commands::cancel_generation_task,
            commands::promote_seedance_draft,
            commands::recover_generation_tasks,
            commands::query_video_task_now,
            commands::list_remote_video_tasks,
            commands::list_assets,
            commands::count_assets_by_kind,
            commands::refresh_asset_cover,
            commands::refresh_asset_media,
            commands::observe_asset_status,
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
            commands::get_workspace_ui_prefs,
            commands::save_workspace_ui_prefs,
            commands::test_tos_connectivity,
            commands::start_staging_upload,
            commands::resume_staging_import,
            commands::get_staging_job,
            commands::list_asset_import_outputs,
            commands::resolve_imported_asset_source,
            commands::list_local_assets,
            commands::import_local_base64_asset,
            commands::save_existing_asset_to_library,
            commands::verify_generation_material,
            commands::list_local_base64_assets,
            commands::refresh_local_base64_asset_media,
            commands::list_local_base64_asset_groups,
            commands::create_local_base64_asset_group,
            commands::delete_local_base64_asset_group,
            commands::move_local_base64_assets,
            commands::delete_local_base64_asset,
            commands::refresh_local_asset_media,
            commands::refresh_staging_object_url,
            commands::pull_tos_bucket_assets,
            commands::verify_local_result,
            commands::get_video_downloader_engine,
            commands::install_video_downloader_engine,
            commands::update_video_downloader_engine,
            commands::import_downloader_cookies,
            commands::clear_downloader_cookies,
            commands::set_downloader_cookie_browser,
            commands::start_video_download,
            commands::get_video_download_job,
            commands::cancel_video_download,
            commands::list_speech_voices,
            commands::get_speech_request_status,
            commands::synthesize_speech,
            commands::compose_dubbed_video,
            commands::start_video_frame_extraction,
            commands::get_video_frame_extraction_job,
            commands::cancel_video_frame_extraction,
            commands::retry_video_frame_extraction,
            commands::probe_video_preparation,
            commands::start_video_preparation,
            commands::start_video_frame_crop,
            commands::get_video_preparation_job,
            commands::list_video_preparation_jobs,
            commands::retry_video_preparation_job,
            commands::cancel_video_preparation_job,
            commands::rename_video_preparation_output,
            backend::thumbnail::create_media_thumbnail,
            commands::backend_health,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // 应用退出兜底：非 Windows 平台没有 Job 对象，渲染子进程组
            // （node / Chrome headless-shell / ffmpeg / Blender）必须显式回收，
            // 否则退出后会留下孤儿进程。Windows 侧由 Job 的
            // KILL_ON_JOB_CLOSE 自动完成，这里是空实现。
            if matches!(event, tauri::RunEvent::Exit) {
                backend::process_tree::ProcessTree::kill_all();
            }
            if matches!(event, tauri::RunEvent::Ready) {
                tauri_plugin_log::log::info!("[启动] 事件循环就绪，开始泵消息");
            }
        });
}
