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
    let catalog = manifest("resources/component-catalog.json");
    let catalog_hash = catalog
        .as_ref()
        .map(|(bytes, _)| hex::encode(Sha256::digest(bytes)));
    emit("IC_COMPONENT_CATALOG_SHA256", catalog_hash.as_deref());
    if edition == "online" {
        let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
        let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
        let platform = match (target_os.as_str(), target_arch.as_str()) {
            ("windows", "x86_64") => "windows-x86_64",
            ("macos", "aarch64") => "darwin-aarch64",
            ("macos", "x86_64") => "darwin-x86_64",
            _ => panic!("online edition supports Windows x86_64 and macOS aarch64/x86_64"),
        };
        let (_, value) = catalog
            .as_ref()
            .expect("online edition requires a prepared component catalog");
        assert!(
            value["schemaVersion"] == 1
                && value["platform"] == platform
                && value["applicationVersion"] == env!("CARGO_PKG_VERSION"),
            "online component catalog does not match this application build"
        );
    }

    let pose = manifest("resources/pose-runtime/runtime-manifest.json");
    let pose_hash = pose
        .as_ref()
        .map(|(bytes, _)| hex::encode(Sha256::digest(bytes)));
    emit("IC_POSE_MANIFEST_SHA256", pose_hash.as_deref());
    let pose_inventory = pose
        .as_ref()
        .and_then(|(_, value)| value["inventory"]["sha256"].as_str());
    emit("IC_POSE_INVENTORY_SHA256", pose_inventory);
    let pose_inventory_ready = pose.as_ref().is_some_and(|(_, value)| {
        println!("cargo:rerun-if-changed=resources/pose-runtime/files-manifest.json");
        value["inventory"]["path"] == "files-manifest.json"
            && std::fs::read("resources/pose-runtime/files-manifest.json")
                .ok()
                .is_some_and(|bytes| {
                    value["inventory"]["sha256"].as_str()
                        == Some(hex::encode(Sha256::digest(bytes)).as_str())
                })
    });

    let blender = manifest("resources/blender/manifest.json");
    let blender_hash = blender
        .as_ref()
        .map(|(bytes, _)| hex::encode(Sha256::digest(bytes)));
    emit("IC_BLENDER_MANIFEST_SHA256", blender_hash.as_deref());
    let blender_inventory = blender
        .as_ref()
        .and_then(|(_, value)| value["inventory"]["sha256"].as_str());
    emit("IC_BLENDER_INVENTORY_SHA256", blender_inventory);
    emit(
        "IC_BLENDER_EXECUTABLE",
        blender
            .as_ref()
            .and_then(|(_, value)| value["executable"].as_str()),
    );
    let remotion = manifest("resources/remotion-runtime/runtime-manifest.json");
    let remotion_hash = remotion
        .as_ref()
        .map(|(bytes, _)| hex::encode(Sha256::digest(bytes)));
    emit("IC_REMOTION_MANIFEST_SHA256", remotion_hash.as_deref());
    let remotion_inventory = remotion
        .as_ref()
        .and_then(|(_, value)| value["inventory"]["sha256"].as_str());
    emit("IC_REMOTION_INVENTORY_SHA256", remotion_inventory);
    let remotion_inventory_ready = remotion.as_ref().is_some_and(|(_, value)| {
        let expected = value["inventory"]["sha256"].as_str();
        let path = value["inventory"]["path"].as_str();
        if path != Some("files-manifest.json") {
            return false;
        }
        let inventory_path = "resources/remotion-runtime/files-manifest.json";
        println!("cargo:rerun-if-changed={inventory_path}");
        std::fs::read(inventory_path)
            .ok()
            .is_some_and(|bytes| expected == Some(hex::encode(Sha256::digest(bytes)).as_str()))
    });
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
    let style = manifest("skills/gpt-image-2-style-library/data/manifest.json");
    let style_hash = style
        .as_ref()
        .map(|(bytes, _)| hex::encode(Sha256::digest(bytes)));
    emit("IC_STYLE_MANIFEST_SHA256", style_hash.as_deref());
    // AI inference is an optional offline component. A prepared pack is trusted by
    // this exact build; an absent pack must not break existing media operations.
    let ai_media = manifest("resources/ai-media-runtime/runtime-manifest.json");
    let ai_media_hash = ai_media
        .as_ref()
        .map(|(bytes, _)| hex::encode(Sha256::digest(bytes)));
    emit("IC_AI_MEDIA_MANIFEST_SHA256", ai_media_hash.as_deref());
    emit(
        "IC_AI_MEDIA_INVENTORY_SHA256",
        ai_media
            .as_ref()
            .and_then(|(_, value)| value["inventory"]["sha256"].as_str()),
    );
    let ai_media_quality = manifest("resources/ai-media-quality-runtime/runtime-manifest.json");
    let ai_media_quality_hash = ai_media_quality
        .as_ref()
        .map(|(bytes, _)| hex::encode(Sha256::digest(bytes)));
    emit(
        "IC_AI_MEDIA_QUALITY_MANIFEST_SHA256",
        ai_media_quality_hash.as_deref(),
    );
    emit(
        "IC_AI_MEDIA_QUALITY_INVENTORY_SHA256",
        ai_media_quality
            .as_ref()
            .and_then(|(_, value)| value["inventory"]["sha256"].as_str()),
    );
    let macos_target = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos");
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && (blender_hash.is_none()
            || (edition == "online" && (pose_hash.is_none() || !pose_inventory_ready))
            || remotion_hash.is_none()
            || ffmpeg_hash.is_none()
            || blender_inventory.is_none()
            || remotion_inventory.is_none()
            || !remotion_inventory_ready
            || remotion.as_ref().is_none_or(|(_, value)| {
                value["criticalSha256"]
                    .as_object()
                    .is_none_or(|files| files.len() < 5)
            })
            || style_hash.is_none()
            || ffmpeg.as_ref().is_none_or(|(_, value)| {
                value["ffmpegSha256"].as_str().is_none()
                    || (value["ffprobeSha256"].as_str().is_none()
                        && !(macos_target
                            && value.get("ffprobeSha256") == Some(&serde_json::Value::Null)
                            && value["ffprobeUnavailable"] == true))
            }))
    {
        panic!(
            "release build requires complete prepared Blender, Remotion, FFmpeg, and style manifests"
        );
    }
    tauri_build::build()
}
