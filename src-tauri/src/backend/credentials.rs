use keyring::{Entry, Error as KeyringError};

use super::{
    error::{BackendError, BackendResult},
    types::CredentialStatus,
};

const SERVICE_NAME: &str = "com.infinitecanvas.desktop";

#[derive(Clone, Default)]
pub struct CredentialStore;

impl CredentialStore {
    fn entry(&self, credential_ref: &str) -> BackendResult<Entry> {
        if credential_ref.trim().is_empty() {
            return Err(BackendError::validation(
                "credential reference must not be empty",
                serde_json::json!({ "credentialRef": credential_ref }),
            ));
        }
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
