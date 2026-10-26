# Vendored wry 0.55.1 — 补丁说明

本目录是 `wry 0.55.1` 的 fork，用于在 macOS 上彻底修掉自定义协议（`WKURLSchemeHandler`）的
两个问题：Foundation 抛 `NSException` 时因 Rust 帧没有 catch 而 abort 进程的残余路径，以及
响应体被整包二次拷贝。

## 来源与范围

- fork 自 crates.io 的 `wry 0.55.1`（本机 registry 路径
  `%USERPROFILE%\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\wry-0.55.1`），全部 82 个文件、
  约 819 KB 原样复制。
- 只改动两个文件：
  - `src/wkwebview/class/url_scheme_handler.rs`（补丁 a–e 与 g）
  - `Cargo.toml`（补丁 f：`objc2-foundation` 增加 `block2` feature）
- 其余文件（`build.rs`、`src/**`、`Cargo.lock`、`CHANGELOG.md` 等）保持上游原样；`LICENSE-APACHE`
  与 `LICENSE-MIT` 未做任何修改，授权条款仍以上游为准。目录里上游自带的 `Cargo.lock` 在 path
  依赖下不参与解析，保留只为和上游文件一一对应。
- **版本号故意保持 `0.55.1`，不要改**：主仓用 `[patch.crates-io]` 接管，cargo 要求 path 包的版本
  满足 tauri 对 `wry = "0.55"` 的 semver 约束；擅自 bump 会导致 patch 不生效（cargo 报 unused patch）。

## 背景

0.55.1 中 `WKURLSchemeTask` 的 `didReceiveResponse` / `didReceiveData` / `didFinish` 已经用
`objc2::exception::catch` 包住了，但同一个回调里还有两条 Foundation 调用裸露在 catch 之外：

1. `[NSData initWithBytes:length:]` 构造响应体（而且为了避开 double free，每个响应都整包 memcpy 一次）；
2. `[NSHTTPURLResponse initWithURL:statusCode:HTTPVersion:headerFields:]`。

当 Foundation/WebKit 抛 `NSException`（如 `NSMallocException`、`NSInvalidArgumentException`）时，
异常会穿过 Rust 帧，在 `extern "C"` 边界触发 abort —— 用户看到的是画布进程直接闪退。

同一个回调里还有若干 Rust panic 点同样会 abort 整个进程：`request.URL()`、`url.absoluteString()`、
`request.HTTPMethod()`、`allHTTPHeaderFields` 取值、`WEBVIEW_STATE.read().unwrap()`（锁中毒后
此后所有协议响应都会 panic），以及 `respond_with_404` 里的两处 Foundation 调用。补丁 g 一并收掉。

## 补丁清单

| 编号 | 位置（`src/wkwebview/class/url_scheme_handler.rs`） | 改动 | 原因 |
| --- | --- | --- | --- |
| a | `response()`：body 读取 | `let content = sent_response.body();` → `let content_len = sent_response.body().len();`；`CONTENT_LENGTH` 头改用 `content_len`；删除旧的 `NSData::alloc()/initWithBytes_length` 块 | 只为拿长度，不再提前借用整包 body，为 b 的所有权转移做准备 |
| b | `response()`：响应体构造 | 改成 `match sent_response.into_body() { Cow::Owned(bytes) => NSData::from_vec(bytes), Cow::Borrowed(bytes) => NSData::with_bytes(bytes) }`，并整体包进 `objc2::exception::catch(AssertUnwindSafe(...))`，`Err` 映射为 `crate::Error::CustomProtocolTaskInvalid` | Owned body 的 `Vec` 所有权直接转给 `NSData`（0.57 的零拷贝做法），去掉二次整包拷贝；同时兜住 `NSMallocException` 等 Foundation 异常 |
| c | `response()`：`NSHTTPURLResponse` 构造 | 先在 catch 外做 `let status_code: isize = wanted_status_code.try_into().unwrap();`（`i32 -> isize` 恒成立）；init 调用包进 `objc2::exception::catch`，返回值是 `Option<Retained<Self>>`，`Err` 与 `None` 都映射为 `CustomProtocolTaskInvalid` | 该 init 在非法 URL/头时会抛 `NSInvalidArgumentException`；原 `.unwrap()` 既是 Rust panic 点，也拦不住 NSException |
| d | `response()`：Content-Type 头 | `mime.to_str().unwrap()` → `if let Ok(mime) = mime.to_str() { headers.insert(...) }` | 该回调可能跑在 WebKit 线程，任何 Rust panic 跨 Objective-C 帧都会 abort；非法 mime 直接跳过即可，不值得让进程崩 |
| e | 顶部 import | `ffi::{c_char, c_void, CStr}` → `ffi::{c_char, CStr}` | a/b 之后 `c_void` 已无使用 |
| f | `Cargo.toml` | `[target.'cfg(target_vendor = "apple")'.dependencies.objc2-foundation]` 的 features 增加 `"block2"` | `NSData::from_vec` 在 objc2-foundation 0.3.x 里由 `block2` feature 门控（见该 crate `src/data.rs`）；wry 0.57.0 上游也补了同一个 feature |
| g | `start_task` 与 `respond_with_404`（主线程/WebKit 线程回调） | ① `this.class().instance_variable(...)`、`request.URL()`、`url.absoluteString()`、`request.HTTPMethod()` 改为 `let Some(..) = .. else { return; }`（tracing 开启时先 `tracing::warn!`）；② `allHTTPHeaderFields` 的 `valueForKey(..).unwrap()` 改为 `if let Some(v)` 跳过坏头；③ body stream 的 `NonNull::new(p).unwrap()` 改为 `let Some(p) else { break }`；④ 3 处 `WEBVIEW_STATE.read().unwrap()` 改为 `.read().unwrap_or_else(|poisoned| poisoned.into_inner())`；⑤ `respond_with_404` 的 `NSHTTPURLResponse` init 包 catch（`Err`/`Ok(None)` 直接 return + warn），`didReceiveResponse`/`didFinish` 也各包 catch、失败仅告警 | 这些 `.unwrap()` 在 `extern "C"` 回调里触发时会直接 abort 进程；毒锁还会让此后所有自定义协议响应永久 panic。改成失败即放弃本次响应，不再让进程崩 |

除上述改动外，0.55.1 的其余逻辑（响应有效性校验、tracing span、`stop_task`、`create`）保持原样。

## 编译 / 运行时前提

- **必须保持 `panic = "unwind"`**：`objc2::exception::catch` 依赖 unwind 机制，`panic = "abort"` 时它
  抓不住 Objective-C 异常。主仓 `src-tauri/Cargo.toml` 的 `[profile.release]` 已有注释说明且未设置
  `panic = "abort"`，本补丁与之一致。
- 绑定版本以主仓 `src-tauri/Cargo.lock` 为准：objc2 0.6.4 / objc2-foundation 0.3.2 /
  objc2-web-kit 0.3.2。其中 `NSHTTPURLResponse::initWithURL_statusCode_HTTPVersion_headerFields`
  的 statusCode 参数类型是 `NSInteger`（objc2 0.6.4 `src/ffi/types.rs` 中
  `pub type NSInteger = isize;`），返回 `Option<Retained<Self>>`。升级 objc2 系版本时要重新核对。
- 启用 f 之后 cargo 会解析 `block2 0.6.2`，主仓 lock 里已有该包，不需要新增依赖版本。

## 验证边界（重要）

- 本文件位于 `src/wkwebview/**`，只在 `target_os = "macos"`（及 iOS）下参与编译。**Windows 主机上
  的 `cargo check`/构建根本不会编译它**，所以本地无法验证 macOS 路径；Windows 本地只能确认
  WebView2 路径不受影响（该文件不进入 Windows 构建）。
- 本次本地已做的校验：`rustfmt --check`（语法 + 格式通过）、Python `tomllib` 解析 `Cargo.toml`、
  与上游文件逐行 diff 复核补丁段落类型与括号配对。
- 补丁 g 同样只落在 macOS/iOS 路径上：Windows 构建不会编译该文件，因此本地 `cargo check` 只能
  证明 Windows/WebView2 路径不受影响，不能证明 g 的改动可编译；g 的编译与行为验证同样必须
  由 macOS CI 完成。
- 真正的编译与行为验证必须在 macOS CI 上：CI 构建 macOS 包即可覆盖编译；运行时建议冒烟测试
  自定义协议加载本地 HTML/JS、大响应体（数 MB 以上）、404 路径，以及 WebView 反复刷新/关闭
  （最易触发 task stop 竞态与异常）。若 CI 报 `NSData::from_vec` 不存在，先确认 vendored manifest
  的 `block2` feature 没被合并丢失：`cargo tree -e features -p objc2-foundation`。

## 升级 tauri / wry 时如何重打

1. 先判断是否还需要 fork：对比目标版本上游的 `src/wkwebview/class/url_scheme_handler.rs`。0.57.0
   已采纳零拷贝（补丁 a/b 的主体），但它的 `NSData` 构造和 `NSHTTPURLResponse` init **仍裸露在
   catch 之外**（0.57.0 里是 `let data = match sent_response.into_body() { ... }` 和
   `.unwrap()`），`start_task` 里的 `.unwrap()` 与锁 `.unwrap()` 也仍在。只有新版本把这些都
   处理了，才可以直接删掉本 vendor 目录和主仓 `[patch.crates-io]`。
2. 需要重打时：从 registry 重新拷贝目标版本到本目录，然后以**同版本上游文件**为基准，按上表
   (a)–(g) 逐条重贴。生成当前补丁视图的命令：

   ```powershell
   $up = "$env:USERPROFILE\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\wry-0.55.1"
   git diff --no-index -- "$up\src\wkwebview\class\url_scheme_handler.rs" `
                        "src-tauri\vendor\wry\src\wkwebview\class\url_scheme_handler.rs"
   git diff --no-index -- "$up\Cargo.toml" "src-tauri\vendor\wry\Cargo.toml"
   ```

3. 注意上游 API 形态会变：0.55.1 的 `response()` 是 `unsafe fn`，0.57.0 已改成安全 fn + 内部
   `unsafe {}` 块。重打时按目标版本的实际签名适配，不要照抄旧代码；同时核对 objc2 绑定里
   statusCode 的类型与 init 的 `Option` 返回值。
4. 改完重新校验：`rustfmt --check`、`git status --short`（应只出现 `src-tauri/vendor/wry/**`），
   并务必跑一遍 macOS CI 构建与上面的冒烟用例。

## 已知残余（有意保留）

- `create()` 里的 `CStr::from_bytes_with_nul(..).unwrap()` 与 `AnyClass::get(..).expect(..)` 仍在：
  它们只在创建协议处理器类时执行一次（启动期，不在 WebKit 主线程回调里），且输入是本文件拼出
  的常量字符串，属于上游原样逻辑，未改动。
- `response()` 里的 `let status_code: isize = wanted_status_code.try_into().unwrap();` 保留：
  `i32 -> isize` 在所有 Apple 目标上恒成功，且按设计必须放在 catch 外（见补丁 c）。
- 主仓的 `Cargo.toml` / `Cargo.lock` 不在本目录范围内（`[patch.crates-io]` 由接线方负责）。
