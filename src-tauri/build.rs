fn main() {
    use sha2::{Digest as _, Sha256};
    use std::path::Path;

    fn manifest(path: &str) -> Option<(Vec<u8>, serde_json::Value)> {
        println!("cargo:rerun-if-changed={path}");
        let bytes = std::fs::read(Path::new(path)).ok()?;
        let value = serde_json::from_slice(&bytes).ok()?;
        Some((bytes, value))
    }
    fn emit(name: &str, value: Option<&str>) {
        println!("cargo:rustc-env={name}={}", value.unwrap_or(""));
    }

    println!("cargo:rerun-if-env-changed=IC_DISTRIBUTION_EDITION");
    let edition = std::env::var("IC_DISTRIBUTION_EDITION").unwrap_or_else(|_| "offline".into());
    assert!(
        edition == "offline" || edition == "online",
        "invalid distribution edition"
    );
    emit("IC_DISTRIBUTION_EDITION", Some(&edition));

    // FFmpeg 随安装包内置；它的清单摘要在发布链路上被校验，缺失即构建失败。
    let ffmpeg = manifest("resources/ffmpeg/manifest.json");
    let ffmpeg_hash = ffmpeg
        .as_ref()
        .map(|(bytes, _)| hex::encode(Sha256::digest(bytes)));
    emit("IC_FFMPEG_MANIFEST_SHA256", ffmpeg_hash.as_deref());
    emit(
        "IC_FFMPEG_SHA256",
        ffmpeg
            .as_ref()
            .and_then(|(_, value)| value["ffmpegSha256"].as_str()),
    );
    emit(
        "IC_FFPROBE_SHA256",
        ffmpeg
            .as_ref()
            .and_then(|(_, value)| value["ffprobeSha256"].as_str()),
    );
    let macos_target = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos");
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && (ffmpeg_hash.is_none()
            || ffmpeg.as_ref().is_none_or(|(_, value)| {
                value["ffmpegSha256"].as_str().is_none()
                    || (value["ffprobeSha256"].as_str().is_none()
                        && !(macos_target
                            && value.get("ffprobeSha256") == Some(&serde_json::Value::Null)
                            && value["ffprobeUnavailable"] == true))
            }))
    {
        panic!("release build requires a complete prepared FFmpeg manifest");
    }
    tauri_build::build()
}
