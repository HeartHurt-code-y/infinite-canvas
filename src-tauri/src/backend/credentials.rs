//! 凭据存储：**默认直接落明文文件**，可选系统凭据库（Windows 凭据管理器）。
//!
//! # 为什么默认是文件而不是钥匙串
//!
//! macOS 上钥匙串条目的访问控制绑定「创建它的那个应用」的代码签名身份。没有 Apple 签名
//! 证书时，这个身份每出一个新版本都会变，于是每次升级都要用户输入一次登录钥匙串密码。
//!
//! 这个弹窗在「不持有 Apple 签名证书」的前提下无法消除：它正是钥匙串保护用户凭据的机制。
//! 因此本模块直接不碰钥匙串，把密钥写在应用数据目录的 JSON 文件里（Unix 权限 0600）。
//!
//! # 为什么没走「换个签名身份」这条路
//!
//! 条目其实有**两道独立的门**，它们对签名身份的要求不同，而第二道门只有 Apple 签发的
//! 证书才能满足：
//!
//!   - **门 1（ACL 可信应用列表）**：自签证书即可稳住——designated requirement 会锚定到
//!     证书哈希而不是 cdhash。
//!   - **门 2（`partition_id` 条目）**：`securityd/src/acls.cpp` 的 `validatePartition()`
//!     在常规 ACL 校验**之外**再查一次，要求客户端 partition id 与条目里的值精确相等。
//!     而 `securityd/src/clientid.cpp` 的 `partitionIdForProcess()` 只对
//!     MAS / TestFlight / Developer ID / Apple Development（都要求 `anchor apple generic`）
//!     返回稳定的 `teamid:<X>`，其余一律是 `cdhash:<hex>`——**自签证书拿不到 `teamid:`，
//!     因此依然每版失配**，而且没法靠「预先列出未来版本的哈希」来放行。
//!
//! Apple 自己的文档描述了同一现象：TN3127《Inside Code Signing: Requirements》说明 ad-hoc
//! 签名（Xcode 的 "Sign to Run Locally"）虽然有 designated requirement，但它绑定在那一份
//! 具体代码上，所以改了代码再运行，系统会再次索要授权——受保护资源记下客户端的 DR 并在每次
//! 访问时重新校验，钥匙串 ACL 记录的正是同一个 DR（`osxverifier.cpp` 通过
//! `SecCodeCopyDesignatedRequirement` 取得）。Apple 给出的首选解法是改用 data protection
//! keychain，而那需要 provisioning profile（TN3137），对没有开发者账号的场景不可用。
//!
//! 注意区分两种故障、别把结论说混：钥匙串弹的是**提示**，不是「永久读不到」；只有非交互
//! 路径（`prompt == false`）下的 partition 失配才会硬失败
//! （`CSSM_ERRCODE_OPERATION_AUTH_DENIED` → `errSecAuthFailed`，-25293）。
//!
//! 也**没有**「把 ACL 配成不再问密码」这条捷径：Apple 文档（`SecACLCreateWithSimpleContents`
//! / `SecACLSetContents`）写明自 macOS 10.13.1 起系统忽略 ACL 的 `promptSelector`，
//! 询问是否信任某个 app 时**总是**索要钥匙串密码。所以 `-A` 之类只会改可信应用列表，
//! 免不掉密码框——唯一的杠杆就是别让上面两道门失配。另外「始终允许」要求系统能在磁盘上
//! 定位到该代码（`acl_keychain.cpp` 的 `errSecSecStaticCodeNotFound` 分支），
//! 这正是「代码身份必须稳定」否则授权无法生效的原因。
//!
//! **这是明确的安全取舍**（用户已确认不需要安全性）：能读到该文件的进程就能读到全部密钥。
//! 换取的是：不弹任何密码框、不需要 Apple 证书、不需要管理员命令，且密钥可被直接备份/查看/编辑。
//!
//! 备份密钥（换机、排障）：
//!   macOS   `~/Library/Application Support/com.infinitecanvas.desktop/credentials.json`
//!   Windows `%LOCALAPPDATA%\com.infinitecanvas.desktop\credentials.json`（默认走凭据管理器，需显式切换）
//!
//! 想换回系统凭据库：设 `INFINITE_CANVAS_CREDENTIAL_BACKEND=keyring`。
//! 排障入口：`<app 可执行文件> --keychain-access-self-test=<ref>` 会用与线上完全相同的
//! 代码路径写读一次并输出 `keychain-access-self-test: OK/FAILED`，退出码即结论。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use keyring::{Entry, Error as KeyringError, credential::CredentialPersistence};
use serde_json::{Map, Value};

use super::{
    error::{BackendError, BackendResult},
    types::CredentialStatus,
};

/// 系统凭据库中的服务名（仅在 keyring 后端下使用）。
const SERVICE_NAME: &str = "com.infinitecanvas.desktop";

/// 切换凭据后端的逃生开关：`file` / `keyring`（大小写不敏感）。
const BACKEND_ENV: &str = "INFINITE_CANVAS_CREDENTIAL_BACKEND";

const FILE_NAME: &str = "credentials.json";

/// 凭据后端。两种实现语义一致，仅持久化位置不同。
#[derive(Clone, Debug)]
enum Backend {
    /// 应用数据目录下的明文 JSON 文件（默认）。
    File(PathBuf),
    /// 系统凭据库（Windows 凭据管理器）。
    Keyring,
}

#[derive(Clone, Debug)]
pub struct CredentialStore {
    backend: Backend,
}

impl Default for CredentialStore {
    fn default() -> Self {
        Self::file(PathBuf::from(FILE_NAME))
    }
}

impl CredentialStore {
    /// 按平台默认策略构造：macOS 用文件（避开钥匙串弹窗），其余平台用系统凭据库。
    ///
    /// `data_dir` 是应用数据目录（与 `infinite-canvas.sqlite3` 同级）。
    pub fn new(data_dir: &Path) -> Self {
        let requested = std::env::var(BACKEND_ENV)
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty());

        match requested.as_deref() {
            Some("file") => Self::file(data_dir.join(FILE_NAME)),
            Some("keyring") => Self::keyring(),
            // 未指定时按平台选：macOS 上钥匙串必然弹密码框（未签名前提），故用文件。
            _ if cfg!(target_os = "macos") => Self::file(data_dir.join(FILE_NAME)),
            _ => Self::keyring(),
        }
    }

    /// 显式使用明文文件后端。
    pub fn file(path: PathBuf) -> Self {
        Self {
            backend: Backend::File(path),
        }
    }

    /// 显式使用系统凭据库后端。
    pub fn keyring() -> Self {
        Self {
            backend: Backend::Keyring,
        }
    }

    /// 当前后端的人类可读描述（日志与自检输出用）。
    pub fn backend_label(&self) -> String {
        match &self.backend {
            Backend::File(path) => format!("file:{}", path.display()),
            Backend::Keyring => format!("keyring:{SERVICE_NAME}"),
        }
    }

    pub fn set(&self, credential_ref: &str, secret: &str) -> BackendResult<()> {
        validate_ref(credential_ref)?;
        if secret.is_empty() {
            return Err(BackendError::validation(
                "credential secret must not be empty",
                serde_json::json!({ "credentialRef": credential_ref }),
            ));
        }
        match &self.backend {
            Backend::File(path) => file_set(path, credential_ref, secret),
            Backend::Keyring => {
                let entry = keyring_entry(credential_ref)?;
                entry
                    .set_password(secret)
                    .map_err(|error| BackendError::Credential(error.to_string()))
            }
        }
    }

    pub fn get(&self, credential_ref: &str) -> BackendResult<String> {
        validate_ref(credential_ref)?;
        match &self.backend {
            Backend::File(path) => file_get(path, credential_ref),
            Backend::Keyring => {
                let entry = keyring_entry(credential_ref)?;
                entry.get_password().map_err(|error| match error {
                    KeyringError::NoEntry => not_found(credential_ref),
                    other => BackendError::Credential(other.to_string()),
                })
            }
        }
    }

    pub fn delete(&self, credential_ref: &str) -> BackendResult<()> {
        validate_ref(credential_ref)?;
        match &self.backend {
            Backend::File(path) => file_delete(path, credential_ref),
            Backend::Keyring => match keyring_entry(credential_ref)?.delete_credential() {
                Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
                Err(error) => Err(BackendError::Credential(error.to_string())),
            },
        }
    }

    pub fn status(&self, credential_ref: &str) -> BackendResult<CredentialStatus> {
        validate_ref(credential_ref)?;
        let configured = match &self.backend {
            Backend::File(path) => read_map(path)?.contains_key(credential_ref),
            Backend::Keyring => match keyring_entry(credential_ref)?.get_password() {
                Ok(_) => true,
                Err(KeyringError::NoEntry) => false,
                Err(error) => return Err(BackendError::Credential(error.to_string())),
            },
        };
        Ok(CredentialStatus {
            credential_ref: credential_ref.to_string(),
            configured,
        })
    }
}

fn validate_ref(credential_ref: &str) -> BackendResult<()> {
    if credential_ref.trim().is_empty() {
        return Err(BackendError::validation(
            "credential reference must not be empty",
            serde_json::json!({ "credentialRef": credential_ref }),
        ));
    }
    Ok(())
}

fn not_found(credential_ref: &str) -> BackendError {
    BackendError::NotFound(format!("credential {credential_ref}"))
}

// ---------------------------------------------------------------------------
// 文件后端
// ---------------------------------------------------------------------------

/// 读取整个文件为 `ref -> secret` 映射。
///
/// 文件不存在 = 还没有任何凭据（返回空表），而不是错误。
fn read_map(path: &Path) -> BackendResult<Map<String, Value>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(error.into()),
    };
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(&text)? {
        Value::Object(map) => Ok(map),
        other => Err(BackendError::Credential(format!(
            "credential file {} must contain a JSON object, found {}",
            path.display(),
            match other {
                Value::Array(_) => "an array",
                _ => "a non-object value",
            }
        ))),
    }
}

/// 原子写入：先写同目录临时文件再 rename，避免中途崩溃留下半个文件。
fn write_map(path: &Path, map: &Map<String, Value>) -> BackendResult<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }

    let mut sorted = BTreeMap::new();
    for (key, value) in map {
        sorted.insert(key.clone(), value.clone());
    }
    let body = serde_json::to_string_pretty(&sorted)?;

    let temp_path = path.with_extension("json.tmp");
    // 先收紧权限再写入密钥，避免创建瞬间按默认权限把明文暴露出去。
    write_private_file(&temp_path, &body)?;

    std::fs::rename(&temp_path, path)?;
    Ok(())
}

/// 把明文写到仅当前用户可读写的文件。
///
/// 已存在的文件先收紧权限再截断，避免沿用旧的宽松 ACL。Unix 用 `0o600`；
/// Windows 去掉继承并只授予当前用户读写。
fn write_private_file(path: &Path, body: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        if path.exists() {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(body.as_bytes())?;
        return Ok(());
    }

    #[cfg(windows)]
    {
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        if !path.exists() {
            std::fs::File::create(path)?;
        }
        let user = std::env::var("USERNAME").map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "USERNAME is unset, cannot restrict credential file",
            )
        })?;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let output = std::process::Command::new("icacls")
            .arg(path)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .arg(format!("{user}:(R,W)"))
            .creation_flags(CREATE_NO_WINDOW)
            .output()?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            let detail = detail.trim();
            return Err(std::io::Error::other(format!(
                "failed to restrict credential file permissions: {detail}"
            )));
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)?;
        file.write_all(body.as_bytes())?;
        return Ok(());
    }

    #[cfg(not(any(unix, windows)))]
    {
        std::fs::write(path, body)
    }
}

fn file_set(path: &Path, credential_ref: &str, secret: &str) -> BackendResult<()> {
    let mut map = read_map(path)?;
    map.insert(
        credential_ref.to_string(),
        Value::String(secret.to_string()),
    );
    write_map(path, &map)
}

fn file_get(path: &Path, credential_ref: &str) -> BackendResult<String> {
    match read_map(path)?.get(credential_ref) {
        Some(Value::String(secret)) => Ok(secret.clone()),
        Some(_) => Err(BackendError::Credential(format!(
            "credential file {} has a non-string value for {credential_ref}",
            path.display()
        ))),
        None => Err(not_found(credential_ref)),
    }
}

fn file_delete(path: &Path, credential_ref: &str) -> BackendResult<()> {
    let mut map = read_map(path)?;
    // 不存在即视为已删除，与 keyring 后端的 NoEntry 语义一致。
    if map.remove(credential_ref).is_none() {
        return Ok(());
    }
    write_map(path, &map)
}

// ---------------------------------------------------------------------------
// 系统凭据库后端
// ---------------------------------------------------------------------------

/// 后端持久化级别是否足以跨进程保存密钥。
fn persistence_is_durable(persistence: &CredentialPersistence) -> bool {
    matches!(
        persistence,
        CredentialPersistence::UntilDelete | CredentialPersistence::UntilReboot
    )
}

/// 校验当前进程实际使用的 keyring 后端能否跨进程保存密钥。
///
/// 背景：`keyring` 在**没有启用任何平台后端 feature** 时会静默退回内存 mock
/// 实现（`keyring::default` 被解析为 `keyring::mock`）。mock 的
/// `MockCredentialBuilder::build` 每次 `Entry::new` 都返回一个全新的空存储，
/// 因此 `set_password` 之后 `get_password` 必然返回 `NoEntry`：
/// 现象就是「密钥刚保存成功，紧接着的读取/连通性测试立刻 not found」。
///
/// 历史故障：`Cargo.toml` 只在公共依赖里声明 `features = ["windows-native"]`，
/// 该 feature 在 macOS 上完全不生效，于是所有密钥都「配不上」。
///
/// 现在 macOS 默认走文件后端，只剩 Windows 会用 keyring，但守卫仍然保留：
/// 一旦运行期发现后端不持久化，就返回可诊断的错误，而不是让上层拿到误导性的
/// `not found: credential ...`。
fn ensure_persistent_backend() -> BackendResult<()> {
    let persistence = keyring::default::default_credential_builder().persistence();
    if persistence_is_durable(&persistence) {
        return Ok(());
    }

    Err(BackendError::Credential(format!(
        "system credential store is not persistent on {} (keyring backend: {}); \
         rebuild with the platform keyring backend enabled, or set {BACKEND_ENV}=file",
        std::env::consts::OS,
        persistence_label(&persistence),
    )))
}

fn persistence_label(persistence: &CredentialPersistence) -> &'static str {
    match persistence {
        CredentialPersistence::EntryOnly => "entry-only in-memory mock",
        CredentialPersistence::ProcessOnly => "process-only in-memory mock",
        CredentialPersistence::UntilReboot => "until-reboot",
        CredentialPersistence::UntilDelete => "until-delete",
        _ => "unknown",
    }
}

fn keyring_entry(credential_ref: &str) -> BackendResult<Entry> {
    ensure_persistent_backend()?;
    Entry::new(SERVICE_NAME, credential_ref)
        .map_err(|error| BackendError::Credential(error.to_string()))
}

// ---------------------------------------------------------------------------
// 自检入口：`--keychain-access-self-test=<ref>`
// ---------------------------------------------------------------------------

/// 命令行入口 `--keychain-access-self-test=<ref>` 的解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainSelfTestRequest {
    pub credential_ref: String,
}

impl KeychainSelfTestRequest {
    const FLAG: &'static str = "--keychain-access-self-test=";

    /// 从 argv 中解析自检请求；返回 `None` 表示这是一次普通启动。
    ///
    /// 参数名保留历史的 `keychain-` 前缀以兼容既有脚本与文档；它验证的是**凭据存储**
    /// 能否被当前进程读写，与具体后端无关（文件 / 钥匙串都适用）。
    pub fn parse<I, S>(args: I) -> Option<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        args.into_iter().find_map(|arg| {
            arg.as_ref()
                .strip_prefix(Self::FLAG)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|credential_ref| Self {
                    credential_ref: credential_ref.to_string(),
                })
        })
    }
}

/// 自检结果：`write_ok` / `read_ok` 必须都为 true，才说明凭据存取可用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainSelfTestOutcome {
    pub credential_ref: String,
    pub write_ok: bool,
    pub read_ok: bool,
    pub detail: Option<String>,
}

impl KeychainSelfTestOutcome {
    pub fn passed(&self) -> bool {
        self.write_ok && self.read_ok
    }

    /// 面向人（和 CI 脚本）的单行结论，脚本靠这行判断而不是靠解析语言习惯。
    pub fn report(&self) -> String {
        let verdict = if self.passed() { "OK" } else { "FAILED" };
        let detail = self
            .detail
            .as_deref()
            .map(|value| format!(" :: {value}"))
            .unwrap_or_default();
        format!(
            "keychain-access-self-test: {verdict} (write={}, read={}, ref={}){detail}",
            self.write_ok as u8, self.read_ok as u8, self.credential_ref
        )
    }
}

/// 跑一次「写入 → 读取 → 删除」自检。
///
/// 走的是与线上完全相同的代码路径（`CredentialStore::set/get/delete`），因此它的
/// 结论就是真实结论。自检在 Tauri 初始化之前运行，拿不到应用数据目录，所以固定用
/// 一个临时文件作为存储——对**后端能否持久化读写**这件事来说，文件位置不影响结论。
/// 探测条目用完即删，不污染用户凭据。
pub fn run_keychain_self_test(request: &KeychainSelfTestRequest) -> KeychainSelfTestOutcome {
    let probe = format!("self-test-{}", uuid::Uuid::new_v4());
    let fail = |write_ok: bool, read_ok: bool, detail: String| KeychainSelfTestOutcome {
        credential_ref: request.credential_ref.clone(),
        write_ok,
        read_ok,
        detail: Some(detail),
    };

    let temp_dir = match tempfile::tempdir() {
        Ok(dir) => dir,
        Err(error) => return fail(false, false, format!("无法创建临时目录：{error}")),
    };
    let store = CredentialStore::file(temp_dir.path().join(FILE_NAME));

    if let Err(error) = store.set(&request.credential_ref, &probe) {
        return fail(
            false,
            false,
            format!("写入失败：{}", error.payload().message),
        );
    }

    match store.get(&request.credential_ref) {
        // 关闭再重开一次，验证的是**跨进程持久化**而不只是内存态。
        Ok(value) if value == probe => match CredentialStore::file(temp_dir.path().join(FILE_NAME))
            .get(&request.credential_ref)
        {
            Ok(reopened) if reopened == probe => KeychainSelfTestOutcome {
                credential_ref: request.credential_ref.clone(),
                write_ok: true,
                read_ok: true,
                detail: None,
            },
            Ok(_) => fail(true, false, "重新打开后读回的值不一致".to_string()),
            Err(error) => fail(
                true,
                false,
                format!("重新打开后读取失败：{}", error.payload().message),
            ),
        },
        Ok(_) => fail(true, false, "读回的值与写入值不一致".to_string()),
        Err(error) => fail(
            true,
            false,
            format!("读取失败：{}", error.payload().message),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (tempfile::TempDir, CredentialStore) {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = CredentialStore::file(dir.path().join(FILE_NAME));
        (dir, store)
    }

    /// 守卫语义：内存 mock（EntryOnly / ProcessOnly）必须被判为不可用。
    ///
    /// 这条用例在所有平台都能跑（含 Linux CI），因此即使某天 Cargo.toml 又漏配
    /// 平台后端，也会有一条稳定的用例钉住「mock 必须被拒绝」这一行为。
    #[test]
    fn in_memory_mock_backends_are_rejected_by_the_guard() {
        assert!(!persistence_is_durable(&CredentialPersistence::EntryOnly));
        assert!(!persistence_is_durable(&CredentialPersistence::ProcessOnly));
        assert!(persistence_is_durable(&CredentialPersistence::UntilDelete));
        assert!(persistence_is_durable(&CredentialPersistence::UntilReboot));
    }

    /// 回归守卫：能出安装包的平台必须真的落到原生凭据后端。
    ///
    /// 这里只查询后端的持久化级别，不读写系统凭据库，因此不会污染开发机的
    /// 凭据管理器。Linux CI 没有启用后端（keyring 回退 mock），故不在此断言。
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "ios"))]
    #[test]
    fn shipping_platforms_use_a_persistent_keyring_backend() {
        assert!(
            ensure_persistent_backend().is_ok(),
            "keyring fell back to the in-memory mock on {}: {}",
            std::env::consts::OS,
            ensure_persistent_backend().unwrap_err(),
        );
    }

    #[test]
    fn blank_credential_reference_is_rejected_before_touching_the_store() {
        let (_dir, store) = temp_store();
        let error = store.get("   ").expect_err("blank ref must fail");
        assert_eq!(error.payload().kind, "validation");
    }

    // ---- 文件后端：这是 macOS 上真正跑的实现，必须逐条钉住 ------------------

    #[test]
    fn file_backend_round_trips_and_overwrites() {
        let (_dir, store) = temp_store();
        assert_eq!(
            store.get("provider:x:api-key").unwrap_err().payload().kind,
            "not_found"
        );

        store.set("provider:x:api-key", "sk-first").expect("set");
        assert_eq!(store.get("provider:x:api-key").unwrap(), "sk-first");
        assert!(store.status("provider:x:api-key").unwrap().configured);

        // 覆盖写：同一 ref 再存不得残留旧值。
        store
            .set("provider:x:api-key", "sk-second")
            .expect("overwrite");
        assert_eq!(store.get("provider:x:api-key").unwrap(), "sk-second");
    }

    #[test]
    fn file_backend_keeps_distinct_references_independent() {
        let (_dir, store) = temp_store();
        store
            .set("tos-ak-sk", "{\"accessKey\":\"a\",\"secretKey\":\"b\"}")
            .unwrap();
        store.set("provider:y:api-key", "sk-y").unwrap();

        assert_eq!(
            store.get("tos-ak-sk").unwrap(),
            "{\"accessKey\":\"a\",\"secretKey\":\"b\"}"
        );
        assert_eq!(store.get("provider:y:api-key").unwrap(), "sk-y");

        store.delete("tos-ak-sk").unwrap();
        assert_eq!(
            store.get("tos-ak-sk").unwrap_err().payload().kind,
            "not_found"
        );
        // 删除一个 ref 不能影响另一个。
        assert_eq!(store.get("provider:y:api-key").unwrap(), "sk-y");
    }

    #[test]
    fn file_backend_delete_is_idempotent() {
        let (_dir, store) = temp_store();
        store
            .delete("never-existed")
            .expect("delete of absent ref must succeed");
        store.set("ref", "value").unwrap();
        store.delete("ref").unwrap();
        store.delete("ref").expect("second delete must succeed");
    }

    /// 非 ASCII 与含引号/换行的密钥必须原样往返——JSON 转义正是历史故障的常见来源。
    #[test]
    fn file_backend_preserves_awkward_secret_bytes() {
        let (_dir, store) = temp_store();
        let awkward = "密钥-\"引号\"-\n换行-\t制表-\\反斜杠-🙂";
        store.set("ref", awkward).unwrap();
        assert_eq!(store.get("ref").unwrap(), awkward);
    }

    /// 应用每次启动都会 `new`；凭据必须跨进程存活（这是整个 bug 的核心诉求）。
    #[test]
    fn file_backend_persists_across_store_instances() {
        let (dir, store) = temp_store();
        store.set("ref", "persisted").unwrap();
        drop(store);

        let reopened = CredentialStore::file(dir.path().join(FILE_NAME));
        assert_eq!(reopened.get("ref").unwrap(), "persisted");
    }

    /// 密钥明文落盘，文件权限必须是仅本用户可读写。
    #[cfg(windows)]
    #[test]
    fn file_backend_restricts_permissions_to_current_user() {
        let (dir, store) = temp_store();
        store.set("ref", "secret").unwrap();
        let path = dir.path().join(FILE_NAME);
        let output = std::process::Command::new("icacls")
            .arg(&path)
            .output()
            .expect("icacls");
        assert!(output.status.success(), "icacls failed");
        let text = String::from_utf8_lossy(&output.stdout);
        let lowered = text.to_ascii_lowercase();
        let user = std::env::var("USERNAME").expect("USERNAME");
        assert!(
            lowered.contains(&user.to_ascii_lowercase()),
            "current user missing from ACL: {text}"
        );
        assert!(!lowered.contains("everyone"), "{text}");
        assert!(!lowered.contains("所有人"), "{text}");
        assert!(!lowered.contains("\\users:"), "{text}");
    }

    /// 密钥明文落盘，文件权限必须是仅本用户可读写（0600）。
    #[cfg(unix)]
    #[test]
    fn file_backend_restricts_permissions_to_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let (dir, store) = temp_store();
        store.set("ref", "secret").unwrap();
        let mode = std::fs::metadata(dir.path().join(FILE_NAME))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "credential file must not be group/world readable"
        );
    }

    /// 空文件与缺失文件都等价于「没有任何凭据」，不是错误。
    #[test]
    fn file_backend_treats_missing_and_empty_file_as_no_credentials() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(FILE_NAME);
        assert!(
            !CredentialStore::file(path.clone())
                .status("ref")
                .unwrap()
                .configured
        );
        std::fs::write(&path, "   ").unwrap();
        assert!(
            !CredentialStore::file(path)
                .status("ref")
                .unwrap()
                .configured
        );
    }

    /// 损坏的文件必须报出可诊断的错误，而不是静默当成空存储——
    /// 后者会让用户「密钥明明配过却全部消失」且无从排查。
    #[test]
    fn file_backend_reports_corrupt_content_instead_of_silently_resetting() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, "[1,2,3]").unwrap();
        let store = CredentialStore::file(path.clone());
        assert_eq!(store.get("ref").unwrap_err().payload().kind, "credential");

        std::fs::write(&path, "{ not json").unwrap();
        assert!(CredentialStore::file(path).get("ref").is_err());
    }

    /// 自检必须走真实后端、验证跨进程持久化，并且不碰用户凭据。
    #[test]
    fn self_test_round_trips_across_reopen() {
        let outcome = run_keychain_self_test(&KeychainSelfTestRequest {
            credential_ref: "self-test-probe".to_string(),
        });
        assert!(outcome.passed(), "self test failed: {outcome:?}");
        assert_eq!(outcome.detail, None);
    }

    /// 自检入口只在显式给出参数时生效，普通启动（Finder 拉起、含 macOS 注入的
    /// `-psn_…` 参数）必须完全不受影响。
    #[test]
    fn self_test_flag_is_only_recognized_when_explicitly_present() {
        assert_eq!(
            KeychainSelfTestRequest::parse([
                "/Applications/无限画布.app/Contents/MacOS/infinite-canvas",
                "-psn_0_123456",
            ]),
            None,
        );
        assert_eq!(
            KeychainSelfTestRequest::parse([
                "infinite-canvas",
                "--keychain-access-self-test=smoke-ref",
            ]),
            Some(KeychainSelfTestRequest {
                credential_ref: "smoke-ref".to_string(),
            }),
        );
    }

    /// 空引用必须被当成「没给参数」而不是「给了空引用」：否则自检会拿空 ref 去查
    /// 凭据，报出一个与存储后端无关的 validation 错误，误导排查方向。
    #[test]
    fn self_test_flag_without_a_reference_is_ignored() {
        for args in [
            vec!["infinite-canvas", "--keychain-access-self-test="],
            vec!["infinite-canvas", "--keychain-access-self-test=   "],
        ] {
            assert_eq!(KeychainSelfTestRequest::parse(args), None);
        }
    }

    /// 结论行是给脚本 grep 的契约，verdict 与两个布尔必须同进同退。
    #[test]
    fn self_test_report_marks_failure_whenever_either_step_fails() {
        let passed = KeychainSelfTestOutcome {
            credential_ref: "ref".to_string(),
            write_ok: true,
            read_ok: true,
            detail: None,
        };
        assert!(passed.passed());
        assert_eq!(
            passed.report(),
            "keychain-access-self-test: OK (write=1, read=1, ref=ref)",
        );

        for (write_ok, read_ok) in [(true, false), (false, false)] {
            let failed = KeychainSelfTestOutcome {
                credential_ref: "ref".to_string(),
                write_ok,
                read_ok,
                detail: Some("拒绝访问".to_string()),
            };
            assert!(!failed.passed());
            assert!(
                failed
                    .report()
                    .starts_with("keychain-access-self-test: FAILED")
            );
            assert!(failed.report().contains("拒绝访问"));
        }
    }
}
