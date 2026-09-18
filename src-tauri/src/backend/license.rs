//! 收费版授权：本地试用计时 + 月付激活码。
//!
//! 试用按本机单调时钟累计运行时长，同时用首次启动墙钟做 24 小时上限。
//! 状态写入应用数据目录之外的冗余位置（Windows 注册表 / 凭据管理器 /
//! 独立 LocalAppData 目录），卸载重装不会刷新试用。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use hmac::{Hmac, Mac};
use rand::Rng as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::error::{BackendError, BackendResult};
use super::storage::now_ms;

type HmacSha256 = Hmac<Sha256>;

pub const PRICE_YUAN: u32 = 150;
pub const PERIOD_DAYS: u16 = 30;
pub const TRIAL_HOURS: u32 = 24;
pub const TRIAL_MS: i64 = TRIAL_HOURS as i64 * 60 * 60 * 1000;
pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_TICK_MS: i64 = 60 * 60 * 1000;
const CLOCK_SKEW_MS: i64 = 15 * 60 * 1000;
const MAX_NONCES: usize = 32;
const BYPASS_ENV: &str = "INFINITE_CANVAS_LICENSE_BYPASS";
const HMAC_KEY: &[u8] = b"ic.paid.v1.9f3a7c1e2b8d4f06a5c7e9b1d3f5082a7e4c";
#[cfg(target_os = "windows")]
const KEYRING_SERVICE: &str = "com.infinitecanvas.entitlement";
#[cfg(target_os = "windows")]
const KEYRING_USER: &str = "license-state";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LicenseState {
    pub version: u32,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub accumulated_ms: i64,
    pub trial_expired: bool,
    #[serde(default)]
    pub paid_until_ms: Option<i64>,
    #[serde(default)]
    pub used_nonces: Vec<String>,
    #[serde(default)]
    pub clock_untrusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LicenseBlob {
    payload: LicenseState,
    mac: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseSnapshot {
    pub unlocked: bool,
    pub phase: &'static str,
    pub reason: &'static str,
    pub trial_remaining_ms: i64,
    pub paid_until_ms: Option<i64>,
    pub paid_remaining_ms: Option<i64>,
    pub machine_id: String,
    pub price_yuan: u32,
    pub period_days: u16,
    pub trial_hours: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadOutcome {
    Missing,
    Tampered,
}

struct Runtime {
    state: LicenseState,
    last_instant: Instant,
    machine_id: String,
    sinks: Vec<Box<dyn EntitlementSink>>,
}

pub struct LicenseService {
    inner: Mutex<Runtime>,
}

trait EntitlementSink: Send + Sync {
    fn read(&self) -> Result<LicenseState, ReadOutcome>;
    fn write(&self, blob: &str) -> Result<(), String>;
}

impl LicenseState {
    fn fresh(now_ms: i64) -> Self {
        Self {
            version: 1,
            first_seen_ms: now_ms,
            last_seen_ms: now_ms,
            accumulated_ms: 0,
            trial_expired: false,
            paid_until_ms: None,
            used_nonces: Vec::new(),
            clock_untrusted: false,
        }
    }
}

pub fn machine_id() -> String {
    format_machine_id(&machine_fingerprint())
}

pub fn issue_code(machine_id: Option<&str>, days: u16) -> String {
    let days = if days == 0 { PERIOD_DAYS } else { days };
    let mut nonce = [0u8; 8];
    rand::rng().fill(&mut nonce);
    encode_code(&nonce, days, machine_id)
}

pub fn durable_state_path(app_local_data: &Path, home: Option<&Path>) -> PathBuf {
    if cfg!(windows) {
        app_local_data
            .parent()
            .unwrap_or(app_local_data)
            .join("InfiniteCanvasEntitlement")
            .join("state.json")
    } else if cfg!(target_os = "macos") {
        home.unwrap_or(app_local_data)
            .join("Library/Preferences/com.infinitecanvas.entitlement.json")
    } else {
        app_local_data.join("entitlement-durable.json")
    }
}

pub fn app_state_path(app_local_data: &Path) -> PathBuf {
    app_local_data.join("entitlement.json")
}

impl LicenseService {
    pub fn open(app_local_data: &Path, home: Option<&Path>) -> Self {
        let machine = machine_id();
        let mut sinks: Vec<Box<dyn EntitlementSink>> = vec![
            Box::new(FileSink {
                path: app_state_path(app_local_data),
            }),
            Box::new(FileSink {
                path: durable_state_path(app_local_data, home),
            }),
        ];
        #[cfg(target_os = "windows")]
        {
            sinks.push(Box::new(RegistrySink));
            sinks.push(Box::new(KeyringSink));
        }
        Self::from_sinks(sinks, machine, now_ms())
    }

    fn from_sinks(sinks: Vec<Box<dyn EntitlementSink>>, machine_id: String, now_ms: i64) -> Self {
        let state = load_merged(&sinks, now_ms);
        persist_all(&sinks, &state);
        Self {
            inner: Mutex::new(Runtime {
                state,
                last_instant: Instant::now(),
                machine_id,
                sinks,
            }),
        }
    }

    pub fn snapshot(&self) -> LicenseSnapshot {
        let mut runtime = lock_runtime(&self.inner);
        tick_runtime(&mut runtime, now_ms());
        persist_all(&runtime.sinks, &runtime.state);
        evaluate(
            &runtime.state,
            now_ms(),
            &runtime.machine_id,
            bypass_enabled(),
        )
    }

    pub fn activate(&self, code: &str) -> BackendResult<LicenseSnapshot> {
        let mut runtime = lock_runtime(&self.inner);
        tick_runtime(&mut runtime, now_ms());
        let machine_id = runtime.machine_id.clone();
        apply_code(&mut runtime.state, code, &machine_id, now_ms())?;
        persist_all(&runtime.sinks, &runtime.state);
        Ok(evaluate(
            &runtime.state,
            now_ms(),
            &runtime.machine_id,
            bypass_enabled(),
        ))
    }

    pub fn require_unlocked(&self) -> BackendResult<()> {
        let snapshot = self.snapshot();
        if snapshot.unlocked {
            return Ok(());
        }
        Err(BackendError::forbidden(
            "试用已结束，请付款激活后继续使用。",
            serde_json::json!({ "phase": snapshot.phase, "reason": snapshot.reason }),
        ))
    }
}

fn lock_runtime(lock: &Mutex<Runtime>) -> std::sync::MutexGuard<'_, Runtime> {
    lock.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn tick_runtime(runtime: &mut Runtime, now_ms: i64) {
    let elapsed = runtime
        .last_instant
        .elapsed()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    runtime.last_instant = Instant::now();
    apply_tick(&mut runtime.state, now_ms, elapsed);
}

fn bypass_enabled() -> bool {
    matches!(
        std::env::var(BYPASS_ENV)
            .ok()
            .as_deref()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1") | Some("true") | Some("yes")
    )
}

fn load_merged(sinks: &[Box<dyn EntitlementSink>], now_ms: i64) -> LicenseState {
    let mut valid = Vec::new();
    let mut tampered = false;
    for sink in sinks {
        match sink.read() {
            Ok(state) => valid.push(state),
            Err(ReadOutcome::Missing) => {}
            Err(ReadOutcome::Tampered) => tampered = true,
        }
    }
    if valid.is_empty() {
        if tampered {
            let mut expired = LicenseState::fresh(now_ms);
            expired.trial_expired = true;
            expired.clock_untrusted = true;
            return expired;
        }
        return LicenseState::fresh(now_ms);
    }
    valid
        .into_iter()
        .reduce(merge_states)
        .expect("non-empty license states")
}

fn persist_all(sinks: &[Box<dyn EntitlementSink>], state: &LicenseState) {
    let blob = encode_blob(state);
    for sink in sinks {
        let _ = sink.write(&blob);
    }
}

pub fn apply_tick(state: &mut LicenseState, now_ms: i64, elapsed_ms: i64) {
    let add = elapsed_ms.clamp(0, MAX_TICK_MS);
    state.accumulated_ms = state.accumulated_ms.saturating_add(add);
    if now_ms + CLOCK_SKEW_MS < state.last_seen_ms {
        state.clock_untrusted = true;
        state.trial_expired = true;
    } else if now_ms > state.last_seen_ms {
        state.last_seen_ms = now_ms;
    }
    let wall = if state.clock_untrusted {
        0
    } else {
        now_ms.saturating_sub(state.first_seen_ms).max(0)
    };
    if state.accumulated_ms.max(wall) >= TRIAL_MS {
        state.trial_expired = true;
    }
}

pub fn merge_states(left: LicenseState, right: LicenseState) -> LicenseState {
    let mut used = left.used_nonces;
    for nonce in right.used_nonces {
        if !used.contains(&nonce) {
            used.push(nonce);
        }
    }
    if used.len() > MAX_NONCES {
        let drain = used.len() - MAX_NONCES;
        used.drain(0..drain);
    }
    LicenseState {
        version: left.version.max(right.version).max(1),
        first_seen_ms: left.first_seen_ms.min(right.first_seen_ms),
        last_seen_ms: left.last_seen_ms.max(right.last_seen_ms),
        accumulated_ms: left.accumulated_ms.max(right.accumulated_ms),
        trial_expired: left.trial_expired || right.trial_expired,
        paid_until_ms: match (left.paid_until_ms, right.paid_until_ms) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        },
        used_nonces: used,
        clock_untrusted: left.clock_untrusted || right.clock_untrusted,
    }
}

pub fn evaluate(
    state: &LicenseState,
    now_ms: i64,
    machine_id: &str,
    bypass: bool,
) -> LicenseSnapshot {
    let wall = if state.clock_untrusted {
        0
    } else {
        now_ms.saturating_sub(state.first_seen_ms).max(0)
    };
    let consumed = state.accumulated_ms.max(wall).min(TRIAL_MS);
    let trial_remaining_ms = if state.trial_expired {
        0
    } else {
        (TRIAL_MS - consumed).max(0)
    };
    let paid_remaining_ms = state
        .paid_until_ms
        .map(|until| (until - now_ms).max(0))
        .filter(|remaining| *remaining > 0);
    let paid_active = paid_remaining_ms.is_some();
    let trial_active = !state.trial_expired && trial_remaining_ms > 0;
    let (unlocked, phase, reason) = if bypass {
        (true, "paid", "bypass")
    } else if paid_active {
        (true, "paid", "paid")
    } else if trial_active {
        (true, "trial", "trial")
    } else if state.paid_until_ms.is_some() {
        (false, "locked", "subscription_expired")
    } else {
        (false, "locked", "trial_expired")
    };
    LicenseSnapshot {
        unlocked,
        phase,
        reason,
        trial_remaining_ms,
        paid_until_ms: state.paid_until_ms,
        paid_remaining_ms,
        machine_id: machine_id.to_string(),
        price_yuan: PRICE_YUAN,
        period_days: PERIOD_DAYS,
        trial_hours: TRIAL_HOURS,
    }
}

fn apply_code(
    state: &mut LicenseState,
    code: &str,
    machine_id: &str,
    now_ms: i64,
) -> BackendResult<()> {
    let parsed = verify_code(code, machine_id).map_err(|message| {
        BackendError::validation(message, serde_json::json!({ "code": code.trim() }))
    })?;
    if state.used_nonces.iter().any(|used| used == &parsed.nonce) {
        return Err(BackendError::validation(
            "该激活码已在本机使用过。",
            serde_json::json!({ "nonce": parsed.nonce }),
        ));
    }
    let start = state
        .paid_until_ms
        .filter(|until| *until > now_ms)
        .unwrap_or(now_ms);
    state.paid_until_ms = Some(start.saturating_add(parsed.days as i64 * DAY_MS));
    state.used_nonces.push(parsed.nonce);
    if state.used_nonces.len() > MAX_NONCES {
        state.used_nonces.remove(0);
    }
    Ok(())
}

#[derive(Debug)]
struct ParsedCode {
    nonce: String,
    days: u16,
}

fn encode_code(nonce: &[u8; 8], days: u16, machine_id: Option<&str>) -> String {
    let mut body = Vec::with_capacity(19);
    body.extend_from_slice(nonce);
    body.extend_from_slice(&days.to_be_bytes());
    body.push(u8::from(machine_id.is_some()));
    let mac = hmac_bytes(&mac_message(nonce, days, machine_id.unwrap_or("*")));
    body.extend_from_slice(&mac[..8]);
    format_code(&body)
}

fn verify_code(code: &str, machine_id: &str) -> Result<ParsedCode, String> {
    let bytes = decode_code(code)?;
    if bytes.len() != 19 {
        return Err("激活码格式不正确。".into());
    }
    let nonce: [u8; 8] = bytes[0..8]
        .try_into()
        .map_err(|_| "激活码格式不正确。".to_string())?;
    let days = u16::from_be_bytes([bytes[8], bytes[9]]);
    if days == 0 {
        return Err("激活码已损坏。".into());
    }
    let bound = bytes[10] == 1;
    let provided = &bytes[11..19];
    let expected_machine = if bound { machine_id } else { "*" };
    let mac = hmac_bytes(&mac_message(&nonce, days, expected_machine));
    if !constant_eq(provided, &mac[..8]) {
        return Err("激活码无效，请向作者微信确认后再试。".into());
    }
    Ok(ParsedCode {
        nonce: hex::encode(nonce),
        days,
    })
}

fn mac_message(nonce: &[u8; 8], days: u16, machine_id: &str) -> String {
    format!("v1|{}|{days}|{machine_id}", hex::encode(nonce))
}

fn format_code(bytes: &[u8]) -> String {
    let hex = hex::encode_upper(bytes);
    let mut parts = vec!["IC1".to_string()];
    for chunk in hex.as_bytes().chunks(4) {
        parts.push(String::from_utf8_lossy(chunk).into_owned());
    }
    parts.join("-")
}

fn decode_code(code: &str) -> Result<Vec<u8>, String> {
    let normalized: String = code
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase();
    let hex_body = normalized
        .strip_prefix("IC1")
        .ok_or_else(|| "激活码格式不正确。".to_string())?;
    hex::decode(hex_body).map_err(|_| "激活码格式不正确。".to_string())
}

fn hmac_bytes(message: &str) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(HMAC_KEY).expect("hmac key");
    mac.update(message.as_bytes());
    let digest = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn hmac_hex(bytes: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(HMAC_KEY).expect("hmac key");
    mac.update(bytes);
    hex::encode(mac.finalize().into_bytes())
}

fn constant_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn encode_blob(state: &LicenseState) -> String {
    let payload = serde_json::to_vec(state).expect("license state json");
    let blob = LicenseBlob {
        payload: state.clone(),
        mac: hmac_hex(&payload),
    };
    serde_json::to_string(&blob).expect("license blob json")
}

fn decode_blob(text: &str) -> Result<LicenseState, ReadOutcome> {
    let blob: LicenseBlob = serde_json::from_str(text).map_err(|_| ReadOutcome::Tampered)?;
    let payload = serde_json::to_vec(&blob.payload).map_err(|_| ReadOutcome::Tampered)?;
    let expected = hmac_hex(&payload);
    if !constant_eq(expected.as_bytes(), blob.mac.as_bytes()) {
        return Err(ReadOutcome::Tampered);
    }
    Ok(blob.payload)
}

fn machine_fingerprint() -> String {
    let mut parts = Vec::new();
    #[cfg(target_os = "windows")]
    if let Some(guid) = read_machine_guid() {
        parts.push(guid);
    }
    if let Ok(user) = std::env::var("USERNAME").or_else(|_| std::env::var("USER")) {
        parts.push(user);
    }
    if let Ok(host) = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")) {
        parts.push(host);
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        parts.push(home);
    }
    if parts.is_empty() {
        parts.push("infinite-canvas".into());
    }
    parts.join("|")
}

fn format_machine_id(fingerprint: &str) -> String {
    let digest = Sha256::digest(fingerprint.as_bytes());
    let hex = hex::encode_upper(&digest[..8]);
    hex.as_bytes()
        .chunks(4)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

struct FileSink {
    path: PathBuf,
}

impl EntitlementSink for FileSink {
    fn read(&self) -> Result<LicenseState, ReadOutcome> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) if text.trim().is_empty() => Err(ReadOutcome::Missing),
            Ok(text) => decode_blob(&text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(ReadOutcome::Missing),
            Err(_) => Err(ReadOutcome::Missing),
        }
    }

    fn write(&self, blob: &str) -> Result<(), String> {
        if let Some(parent) = self.path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(&temp, blob).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&temp, &self.path).map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "windows")]
struct RegistrySink;

#[cfg(target_os = "windows")]
impl EntitlementSink for RegistrySink {
    fn read(&self) -> Result<LicenseState, ReadOutcome> {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey("Software\\InfiniteCanvasEntitlement")
            .map_err(|_| ReadOutcome::Missing)?;
        let value: String = key.get_value("State").map_err(|_| ReadOutcome::Missing)?;
        decode_blob(&value)
    }

    fn write(&self, blob: &str) -> Result<(), String> {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let (key, _) = hkcu
            .create_subkey("Software\\InfiniteCanvasEntitlement")
            .map_err(|error| error.to_string())?;
        key.set_value("State", &blob)
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "windows")]
fn read_machine_guid() -> Option<String> {
    let hklm = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE);
    let key = hklm.open_subkey("SOFTWARE\\Microsoft\\Cryptography").ok()?;
    key.get_value("MachineGuid").ok()
}

#[cfg(target_os = "windows")]
struct KeyringSink;

#[cfg(target_os = "windows")]
impl EntitlementSink for KeyringSink {
    fn read(&self) -> Result<LicenseState, ReadOutcome> {
        let entry =
            keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|_| ReadOutcome::Missing)?;
        match entry.get_password() {
            Ok(text) => decode_blob(&text),
            Err(keyring::Error::NoEntry) => Err(ReadOutcome::Missing),
            Err(_) => Err(ReadOutcome::Missing),
        }
    }

    fn write(&self, blob: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|error| error.to_string())?;
        entry.set_password(blob).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
struct MemorySink {
    blob: Mutex<Option<String>>,
}

#[cfg(test)]
impl EntitlementSink for MemorySink {
    fn read(&self) -> Result<LicenseState, ReadOutcome> {
        match self
            .blob
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .as_deref()
        {
            Some(text) => decode_blob(text),
            None => Err(ReadOutcome::Missing),
        }
    }

    fn write(&self, blob: &str) -> Result<(), String> {
        *self
            .blob
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(blob.to_string());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MACHINE: &str = "ABCD-EFGH-IJKL-MNOP";
    const T0: i64 = 1_700_000_000_000;

    fn sink_with(state: Option<LicenseState>) -> Box<dyn EntitlementSink> {
        Box::new(MemorySink {
            blob: Mutex::new(state.map(|value| encode_blob(&value))),
        })
    }

    #[test]
    fn fresh_trial_has_full_day() {
        let snapshot = evaluate(&LicenseState::fresh(T0), T0, MACHINE, false);
        assert!(snapshot.unlocked);
        assert_eq!(snapshot.phase, "trial");
        assert_eq!(snapshot.trial_remaining_ms, TRIAL_MS);
        assert_eq!(snapshot.price_yuan, 150);
    }

    #[test]
    fn accumulated_runtime_expires_trial() {
        let mut state = LicenseState::fresh(T0);
        for _ in 0..24 {
            apply_tick(&mut state, T0 + 60_000, 60 * 60 * 1000);
        }
        assert!(state.trial_expired);
        let snapshot = evaluate(&state, T0 + 60_000, MACHINE, false);
        assert!(!snapshot.unlocked);
        assert_eq!(snapshot.reason, "trial_expired");
        assert_eq!(snapshot.trial_remaining_ms, 0);
    }

    #[test]
    fn wall_clock_expires_trial_even_if_usage_is_short() {
        let mut state = LicenseState::fresh(T0);
        apply_tick(&mut state, T0 + TRIAL_MS, 1_000);
        assert!(state.trial_expired);
        assert!(state.accumulated_ms < TRIAL_MS);
    }

    #[test]
    fn clock_rollback_expires_trial_permanently() {
        let mut state = LicenseState::fresh(T0);
        apply_tick(&mut state, T0 + 60_000, 60_000);
        apply_tick(&mut state, T0 - DAY_MS, 1_000);
        assert!(state.trial_expired);
        assert!(state.clock_untrusted);
        apply_tick(&mut state, T0 + 120_000, 1_000);
        assert!(state.trial_expired);
    }

    #[test]
    fn merge_keeps_earliest_first_seen_and_max_usage() {
        let mut left = LicenseState::fresh(T0);
        left.accumulated_ms = 10_000;
        let mut right = LicenseState::fresh(T0 + 5_000);
        right.accumulated_ms = 80_000;
        right.trial_expired = true;
        let merged = merge_states(left, right);
        assert_eq!(merged.first_seen_ms, T0);
        assert_eq!(merged.accumulated_ms, 80_000);
        assert!(merged.trial_expired);
    }

    #[test]
    fn reinstall_reads_durable_sink_and_does_not_reset_trial() {
        let mut original = LicenseState::fresh(T0);
        original.accumulated_ms = 3_600_000;
        original.trial_expired = true;
        let durable = sink_with(Some(original.clone()));
        let service = LicenseService::from_sinks(
            vec![sink_with(None), durable],
            MACHINE.to_string(),
            T0 + DAY_MS,
        );
        let snapshot = service.snapshot();
        assert!(!snapshot.unlocked);
        assert_eq!(snapshot.reason, "trial_expired");
    }

    #[test]
    fn tampered_blob_without_valid_copy_locks() {
        let sink = Box::new(MemorySink {
            blob: Mutex::new(Some(r#"{"payload":{"version":1},"mac":"dead"}"#.into())),
        });
        let service = LicenseService::from_sinks(vec![sink], MACHINE.to_string(), T0);
        assert!(!service.snapshot().unlocked);
    }

    #[test]
    fn monthly_code_unlocks_and_cannot_be_reused() {
        let mut state = LicenseState::fresh(T0);
        state.trial_expired = true;
        let code = encode_code(b"abcdefgh", PERIOD_DAYS, Some(MACHINE));
        apply_code(&mut state, &code, MACHINE, T0).expect("activate");
        let snapshot = evaluate(&state, T0, MACHINE, false);
        assert!(snapshot.unlocked);
        assert_eq!(snapshot.phase, "paid");
        assert_eq!(
            snapshot.paid_remaining_ms,
            Some(PERIOD_DAYS as i64 * DAY_MS)
        );
        let reuse = apply_code(&mut state, &code, MACHINE, T0 + 1_000);
        assert!(reuse.is_err());
    }

    #[test]
    fn bound_code_rejects_other_machine() {
        let code = encode_code(b"12345678", PERIOD_DAYS, Some(MACHINE));
        let error = verify_code(&code, "FFFF-FFFF-FFFF-FFFF").unwrap_err();
        assert!(error.contains("无效"));
    }

    #[test]
    fn unbound_code_works_on_any_machine() {
        let code = encode_code(b"unbound!", PERIOD_DAYS, None);
        let parsed = verify_code(&code, MACHINE).expect("unbound");
        assert_eq!(parsed.days, PERIOD_DAYS);
    }

    #[test]
    fn stacked_codes_extend_from_current_expiry() {
        let mut state = LicenseState::fresh(T0);
        state.trial_expired = true;
        let first = encode_code(b"firstaaa", PERIOD_DAYS, None);
        let second = encode_code(b"secondbb", PERIOD_DAYS, None);
        apply_code(&mut state, &first, MACHINE, T0).unwrap();
        apply_code(&mut state, &second, MACHINE, T0 + 1_000).unwrap();
        assert_eq!(
            state.paid_until_ms,
            Some(T0 + 2 * PERIOD_DAYS as i64 * DAY_MS)
        );
    }

    #[test]
    fn paid_period_outlives_expired_trial() {
        let mut state = LicenseState::fresh(T0);
        state.trial_expired = true;
        state.paid_until_ms = Some(T0 + DAY_MS);
        let snapshot = evaluate(&state, T0 + 3_600_000, MACHINE, false);
        assert!(snapshot.unlocked);
        assert_eq!(snapshot.phase, "paid");
    }

    #[test]
    fn subscription_expiry_locks_again() {
        let mut state = LicenseState::fresh(T0);
        state.trial_expired = true;
        state.paid_until_ms = Some(T0 + 1_000);
        let snapshot = evaluate(&state, T0 + 2_000, MACHINE, false);
        assert!(!snapshot.unlocked);
        assert_eq!(snapshot.reason, "subscription_expired");
    }

    #[test]
    fn code_accepts_spaces_and_lowercase() {
        let code = encode_code(b"spaced01", PERIOD_DAYS, None);
        let messy = code.to_ascii_lowercase().replace('-', " ");
        verify_code(&messy, MACHINE).expect("normalized");
    }

    #[test]
    fn require_unlocked_blocks_expired_trial() {
        let mut state = LicenseState::fresh(T0);
        state.trial_expired = true;
        let service =
            LicenseService::from_sinks(vec![sink_with(Some(state))], MACHINE.to_string(), T0);
        assert!(service.require_unlocked().is_err());
    }
}
