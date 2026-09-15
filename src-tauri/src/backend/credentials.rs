use keyring::{Entry, Error as KeyringError, credential::CredentialPersistence};

use super::{
    error::{BackendError, BackendResult},
    types::CredentialStatus,
};

const SERVICE_NAME: &str = "com.infinitecanvas.desktop";

#[derive(Clone, Default)]
pub struct CredentialStore;

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
/// macOS 安装包曾经正是这个状态——`Cargo.toml` 只在公共依赖里声明了
/// `features = ["windows-native"]`，该 feature 在 macOS 上因
/// `#[cfg(all(target_os = "windows", feature = "windows-native"))]` 完全不生效，
/// 于是所有供应商 API Key、素材库令牌、TOS AK/SK 都「配不上」。
///
/// 修复由 `Cargo.toml` 的按平台依赖承担；这里再守一道：
/// 一旦运行期发现后端不持久化，就返回可诊断的错误，
/// 而不是让上层拿到误导性的 `not found: credential ...`。
fn ensure_persistent_backend() -> BackendResult<()> {
    let persistence = keyring::default::default_credential_builder().persistence();
    if persistence_is_durable(&persistence) {
        return Ok(());
    }

    Err(BackendError::Credential(format!(
        "system credential store is not persistent on {} (keyring backend: {}); \
         rebuild with the platform keyring backend enabled (`windows-native` / `apple-native`)",
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

impl CredentialStore {
    fn entry(&self, credential_ref: &str) -> BackendResult<Entry> {
        if credential_ref.trim().is_empty() {
            return Err(BackendError::validation(
                "credential reference must not be empty",
                serde_json::json!({ "credentialRef": credential_ref }),
            ));
        }
        ensure_persistent_backend()?;
        Entry::new(SERVICE_NAME, credential_ref)
            .map_err(|error| BackendError::Credential(error.to_string()))
    }

    pub fn set(&self, credential_ref: &str, secret: &str) -> BackendResult<()> {
        if secret.is_empty() {
            return Err(BackendError::validation(
                "credential secret must not be empty",
                serde_json::json!({ "credentialRef": credential_ref }),
            ));
        }
        self.entry(credential_ref)?
            .set_password(secret)
            .map_err(|error| BackendError::Credential(error.to_string()))
    }

    pub fn get(&self, credential_ref: &str) -> BackendResult<String> {
        self.entry(credential_ref)?
            .get_password()
            .map_err(|error| match error {
                KeyringError::NoEntry => {
                    BackendError::NotFound(format!("credential {credential_ref}"))
                }
                other => BackendError::Credential(other.to_string()),
            })
    }

    pub fn delete(&self, credential_ref: &str) -> BackendResult<()> {
        match self.entry(credential_ref)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(BackendError::Credential(error.to_string())),
        }
    }

    pub fn status(&self, credential_ref: &str) -> BackendResult<CredentialStatus> {
        let configured = match self.entry(credential_ref)?.get_password() {
            Ok(_) => true,
            Err(KeyringError::NoEntry) => false,
            Err(error) => return Err(BackendError::Credential(error.to_string())),
        };
        Ok(CredentialStatus {
            credential_ref: credential_ref.to_string(),
            configured,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let store = CredentialStore;
        let error = store.get("   ").expect_err("blank ref must fail");
        assert_eq!(error.payload().kind, "validation");
    }
}
