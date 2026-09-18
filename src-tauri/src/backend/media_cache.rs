//! 远端预览媒体的磁盘缓存：同一份素材只从远端下载一次，重启后继续复用本地副本。
//!
//! 素材库卡片与画布素材节点的预览都经 `assetproxy` 协议取字节，而 WebView 不会缓存
//! 自定义协议的响应；供应商/对象存储给出的签名地址每次都不同（也没有可用作缓存键的
//! 稳定标识），于是同一张图片在切画布、重开面板、重挂载卡片时被反复下载 —— 网络稍慢
//! 就表现为「预览一直在转圈」或「预览不可用」。这里把字节落盘，按素材身份复用。
//!
//! 缓存键 = `hash(主机 + 路径)`：签名参数被有意丢弃，续签出来的新地址指向同一对象时
//! 命中同一份副本。这里依赖一个前提：同一主机上对象路径唯一决定内容 —— 本项目取字节的
//! 对象存储与供应商 CDN 都满足（路径即对象键或含唯一素材 ID）。上游若在同一个对象键上
//! 换掉内容（对象存储才可能出现），最迟在 `MAX_ENTRY_AGE` 之后重新下载一次，不会长期显示旧图。
//!
//! 只缓存图片：视频按 Range 分块播放，落盘整段视频既占磁盘又不解决秒开，还容易在
//! 分块/续播语义上产生错误命中。`no-store` 响应同样不缓存，尊重上游的隐私意图。
//!
//! 容量上限由 [`CacheLimits`] 给出：生产用默认值，测试用小值以便在毫秒级观察淘汰行为。

use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

/// 缓存容量上限。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheLimits {
    /// 单个条目的字节上限；超过这条线的响应不落盘。
    pub max_entry_bytes: u64,
    /// 缓存目录总字节上限；超出后按最近写入时间淘汰最旧的条目。
    pub max_cache_bytes: u64,
}

impl Default for CacheLimits {
    fn default() -> Self {
        Self {
            // 单条上限放到 128 MiB：手机原图动辄几十 MB（例如 5464×7285 的 36 MB JPEG），
            // 卡在 32 MiB 时这类素材永远落不了盘 —— 每次预览、每次重挂载都要重新整包
            // 下载几十 MB，弱网或并发下必然被打成「预览不可用」。
            max_entry_bytes: 128 * 1024 * 1024,
            // 总量随之放到 1 GiB：否则几张几十 MB 的大图就会把目录填满并互相淘汰，
            // 形成「缓存永远命中不了」的抖动。
            max_cache_bytes: 1024 * 1024 * 1024,
        }
    }
}

/// 条目最长保留时间：超过后按未命中处理并重新下载，避免签名中蕴含的内容变化长期不生效。
const MAX_ENTRY_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// 两次容量巡检的最小间隔：目录填满后不再每次落盘都全量扫描（那会在浏览时周期性卡顿）。
const PRUNE_INTERVAL: Duration = Duration::from_secs(60);

/// 一条命中的缓存条目。
pub struct CachedPreview {
    pub body: Vec<u8>,
    pub content_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheMetadata {
    content_type: Option<String>,
    /// 写入时刻（Unix 毫秒）；用于过期判定。
    stored_at_ms: u128,
}

/// 缓存目录句柄。缺失目录不报错：缓存不可用时退化为直连穿透，不影响预览可用性。
pub struct MediaCache {
    directory: PathBuf,
    limits: CacheLimits,
    /// 上次容量巡检的时刻（Unix 毫秒），0 表示从未巡检。
    pruned_at_ms: AtomicU64,
}

impl MediaCache {
    pub fn new(directory: PathBuf) -> Self {
        Self::with_limits(directory, CacheLimits::default())
    }

    /// 显式指定容量上限：测试用小上限，避免为了观察淘汰行为写入几百 MB。
    pub fn with_limits(directory: PathBuf, limits: CacheLimits) -> Self {
        Self {
            directory,
            limits,
            pruned_at_ms: AtomicU64::new(0),
        }
    }

    /// 读回当前上限：只有测试需要断言默认值（生产代码不消费它）。
    #[cfg(test)]
    pub fn limits(&self) -> CacheLimits {
        self.limits
    }

    /// 内容长度是否在单条上限之内。未知长度时允许尝试，落盘那一刻再按实际大小判定。
    pub fn accepts_length(&self, content_length: Option<u64>) -> bool {
        content_length
            .map(|value| value <= self.limits.max_entry_bytes)
            .unwrap_or(true)
    }

    /// 命中（且未过期）时返回字节；未命中、已过期或缓存文件损坏时返回 `None`。
    pub fn read(&self, url: &Url) -> Option<CachedPreview> {
        let digest = cache_digest(url)?;
        self.read_digest(&digest)
    }

    /// 落盘一份可缓存的响应。只有 200 与完整内容会被调用方传进来。
    pub fn store(&self, url: &Url, content_type: Option<&str>, body: &[u8]) {
        if body.is_empty() || body.len() as u64 > self.limits.max_entry_bytes {
            return;
        }
        let Some(digest) = cache_digest(url) else {
            return;
        };
        if fs::create_dir_all(&self.directory).is_err() {
            return;
        }
        let body_path = self.body_path(&digest);
        let meta_path = self.meta_path(&digest);
        if fs::write(&body_path, body).is_err() {
            return;
        }
        let metadata = CacheMetadata {
            content_type: content_type.map(str::to_owned),
            stored_at_ms: now_ms(),
        };
        match serde_json::to_vec(&metadata) {
            Ok(encoded) => {
                if fs::write(&meta_path, encoded).is_err() {
                    // 元数据写不进去时条目不可用，避免留下半份缓存。
                    let _ = fs::remove_file(&body_path);
                    return;
                }
            }
            Err(_) => {
                let _ = fs::remove_file(&body_path);
                return;
            }
        }
        self.prune();
    }

    /// 供测试与调试：按缓存键读取（不解析 URL）。
    pub fn read_digest(&self, digest: &str) -> Option<CachedPreview> {
        let body_path = self.body_path(digest);
        let meta_path = self.meta_path(digest);
        let metadata: CacheMetadata = serde_json::from_slice(&fs::read(&meta_path).ok()?).ok()?;
        if now_ms().saturating_sub(metadata.stored_at_ms) > MAX_ENTRY_AGE.as_millis() {
            let _ = fs::remove_file(&body_path);
            let _ = fs::remove_file(&meta_path);
            return None;
        }
        let body = fs::read(&body_path).ok()?;
        if body.is_empty() {
            let _ = fs::remove_file(&body_path);
            let _ = fs::remove_file(&meta_path);
            return None;
        }
        Some(CachedPreview {
            body,
            content_type: metadata.content_type,
        })
    }

    /// 超出总容量时淘汰最旧的条目（按修改时间）。目录不可读时静默跳过。
    fn prune(&self) {
        if !self.prune_due() {
            return;
        }
        self.prune_now();
    }

    /// 容量巡检是否到点：测试里直接推进这个时间戳来观察淘汰行为。
    fn prune_due(&self) -> bool {
        let now = now_ms();
        let last = self.pruned_at_ms.load(Ordering::Relaxed);
        if last != 0 && now.saturating_sub(u128::from(last)) < PRUNE_INTERVAL.as_millis() {
            return false;
        }
        self.pruned_at_ms
            .store(now.min(u128::from(u64::MAX)) as u64, Ordering::Relaxed);
        true
    }

    fn prune_now(&self) {
        let Ok(entries) = fs::read_dir(&self.directory) else {
            return;
        };
        let mut bodies: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
        let mut total = 0u64;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some(EXTENSION) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            total = total.saturating_add(metadata.len());
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            bodies.push((path, metadata.len(), modified));
        }
        if total <= self.limits.max_cache_bytes {
            return;
        }
        bodies.sort_by_key(|(_, _, modified)| *modified);
        for (path, size, _) in bodies {
            if total <= self.limits.max_cache_bytes {
                break;
            }
            let digest = path
                .file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_owned);
            if fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
                if let Some(digest) = digest {
                    let _ = fs::remove_file(self.meta_path(&digest));
                }
            }
        }
    }

    fn body_path(&self, digest: &str) -> PathBuf {
        self.directory.join(format!("{digest}.{EXTENSION}"))
    }

    fn meta_path(&self, digest: &str) -> PathBuf {
        self.directory
            .join(format!("{digest}.{METADATA_EXTENSION}"))
    }
}

const EXTENSION: &str = "bin";
const METADATA_EXTENSION: &str = "json";

/// 只有图片值得落盘：视频走 Range 分块，音频同样按需流式读取。
pub fn is_cacheable_content_type(content_type: Option<&str>) -> bool {
    content_type
        .map(|value| value.trim().to_ascii_lowercase().starts_with("image/"))
        .unwrap_or(false)
}

/// `no-store` 表示连用户代理也不该存；`private` 只禁止共享缓存，本机预览副本正是 private。
pub fn permits_storage(cache_control: Option<&str>) -> bool {
    let Some(value) = cache_control else {
        return true;
    };
    !value.to_ascii_lowercase().contains("no-store")
}

/// 缓存键：主机 + 路径。签名参数有意不参与运算。
fn cache_digest(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    let mut hasher = Sha256::new();
    hasher.update(host.as_bytes());
    hasher.update(url.path().as_bytes());
    Some(hex::encode(hasher.finalize()))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    fn cache() -> (tempfile::TempDir, MediaCache) {
        let directory = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(directory.path().join("media-preview-cache"));
        (directory, cache)
    }

    /// 小上限缓存：容量类行为用小值观察，避免测试写入几百 MB。
    fn small_cache(limits: CacheLimits) -> (tempfile::TempDir, MediaCache) {
        let directory = tempfile::tempdir().unwrap();
        let cache = MediaCache::with_limits(directory.path().join("media-preview-cache"), limits);
        (directory, cache)
    }

    #[test]
    fn 缓存键忽略签名参数_续签后的地址命中同一份字节() {
        let (_guard, cache) = cache();
        let signed =
            url("https://tos.example.com/assets/a.png?X-Tos-Signature=abc&X-Tos-Expires=3600");
        cache.store(&signed, Some("image/png"), b"original");

        // 续签换了一整套签名参数：同一对象必须命中同一份缓存。
        let resigned =
            url("https://tos.example.com/assets/a.png?X-Tos-Signature=zzz&X-Tos-Expires=7200");
        let hit = cache.read(&resigned).expect("resigned url hits the cache");
        assert_eq!(hit.body, b"original");
        assert_eq!(hit.content_type.as_deref(), Some("image/png"));
    }

    #[test]
    fn 缓存键区分主机与路径() {
        let (_guard, cache) = cache();
        cache.store(
            &url("https://a.example.com/x.png?sig=1"),
            Some("image/png"),
            b"a",
        );
        assert!(
            cache
                .read(&url("https://b.example.com/x.png?sig=1"))
                .is_none()
        );
        assert!(
            cache
                .read(&url("https://a.example.com/y.png?sig=1"))
                .is_none()
        );
        assert!(
            cache
                .read(&url("https://a.example.com/x.png?sig=2"))
                .is_some()
        );
    }

    #[test]
    fn 未写入的地址不命中() {
        let (_guard, cache) = cache();
        assert!(
            cache
                .read(&url("https://cdn.example.com/never.png"))
                .is_none()
        );
    }

    #[test]
    fn 元数据缺失或过期时按未命中处理并清掉坏条目() {
        let (_guard, cache) = cache();
        let source = url("https://cdn.example.com/stale.png");
        cache.store(&source, Some("image/png"), b"bytes");
        let digest = cache_digest(&source).unwrap();
        let meta_path = cache.meta_path(&digest);
        let body_path = cache.body_path(&digest);

        // 只有正文、没有元数据：不可用。
        fs::remove_file(&meta_path).unwrap();
        assert!(cache.read(&source).is_none());

        // 元数据过期：按未命中处理，并删除正文。
        cache.store(&source, Some("image/png"), b"bytes");
        let expired = CacheMetadata {
            content_type: Some("image/png".into()),
            stored_at_ms: now_ms().saturating_sub(MAX_ENTRY_AGE.as_millis() + 1),
        };
        fs::write(&meta_path, serde_json::to_vec(&expired).unwrap()).unwrap();
        assert!(cache.read(&source).is_none());
        assert!(!body_path.exists(), "过期条目应被删除");
    }

    #[test]
    fn 超出单条上限的字节不落盘() {
        let (_guard, cache) = small_cache(CacheLimits {
            max_entry_bytes: 8,
            max_cache_bytes: 1024,
        });
        let source = url("https://cdn.example.com/huge.png");
        cache.store(&source, Some("image/png"), &[0u8; 9]);
        assert!(cache.read(&source).is_none());
        assert!(!cache.accepts_length(Some(9)));
        assert!(cache.accepts_length(Some(8)));
        // 上游没给长度时允许尝试，落盘那一刻再按实际大小判定。
        assert!(cache.accepts_length(None));
        // 空响应不写缓存。
        cache.store(&source, Some("image/png"), b"");
        assert!(cache.read(&source).is_none());
        // 刚好等于上限的响应正常落盘。
        cache.store(&source, Some("image/png"), &[7u8; 8]);
        assert_eq!(cache.read(&source).unwrap().body, vec![7u8; 8]);
    }

    #[test]
    fn 默认上限必须容得下几十兆的手机原图() {
        // 真实回归：一张 5464×7285 的本地素材是 36,852,238 字节。旧上限 32 MiB 让它
        // 永远落不了盘，于是每次预览、每次重挂载都要重新整包下载，弱网/并发下被打成
        // 「预览不可用」。
        let (_guard, cache) = cache();
        let limits = cache.limits();
        assert!(cache.accepts_length(Some(36_852_238)));
        assert!(limits.max_entry_bytes >= 64 * 1024 * 1024);
        // 总量必须容得下若干张大图，否则缓存会在几张图之间反复互相淘汰。
        assert!(limits.max_cache_bytes >= limits.max_entry_bytes * 4);
    }

    #[test]
    fn 只缓存图片_并尊重上游的不可缓存声明() {
        assert!(is_cacheable_content_type(Some("image/png")));
        assert!(is_cacheable_content_type(Some(
            "IMAGE/JPEG; charset=binary"
        )));
        assert!(!is_cacheable_content_type(Some("video/mp4")));
        assert!(!is_cacheable_content_type(Some("audio/mpeg")));
        assert!(!is_cacheable_content_type(None));
        assert!(permits_storage(None));
        assert!(permits_storage(Some("public, max-age=3600")));
        assert!(!permits_storage(Some("no-store")));
        assert!(permits_storage(Some("private, max-age=60")));
    }

    #[test]
    fn 超出总容量时淘汰最旧的条目() {
        // 按「单条上限」的量级堆到超过总上限会太慢，这里用小上限 + 1 MiB 小块观察淘汰。
        let chunk = vec![0u8; 1024 * 1024];
        let (_guard, cache) = small_cache(CacheLimits {
            max_entry_bytes: 2 * 1024 * 1024,
            max_cache_bytes: 4 * 1024 * 1024,
        });
        let mut sources = Vec::new();
        for index in 0..7 {
            let source = url(&format!("https://cdn.example.com/frame-{index}.png"));
            // 生产里巡检是节流的（避免每次落盘都全量扫描目录）；这里把上次巡检时间
            // 推回过去，让每一步落盘都能立刻观察淘汰结果。
            cache.pruned_at_ms.store(0, Ordering::Relaxed);
            cache.store(&source, Some("image/png"), &chunk);
            std::thread::sleep(Duration::from_millis(2));
            sources.push(source);
        }

        // 最新写入的条目必须还在（正在看的图不能被淘汰掉）。
        let newest = sources.last().unwrap();
        assert!(cache.read(newest).is_some(), "最新条目必须保留");
        // 总容量已被压回上限之内：至少最旧的那些条目已被删除。
        let removed = sources
            .iter()
            .filter(|source| cache.read(source).is_none())
            .count();
        assert!(removed >= 1, "超过上限后必须淘汰最旧条目: {removed}");
        assert!(
            cache.read(sources.first().unwrap()).is_none(),
            "最旧条目应最先被淘汰"
        );
    }

    #[test]
    fn 巡检按间隔节流_不会每次落盘都全量扫描目录() {
        let (_guard, cache) = cache();
        cache.prune_due();
        assert!(cache.pruned_at_ms.load(Ordering::Relaxed) > 0);
        // 刚刚巡检过：紧接着的每一次落盘都不再重复扫描。
        assert!(!cache.prune_due());
        assert!(!cache.prune_due());
    }
}
