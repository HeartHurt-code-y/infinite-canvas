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

    let blender = manifest("resources/blender/manifest.json");
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
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && (blender_inventory.is_none()
            || remotion_inventory.is_none()
            || !remotion_inventory_ready
            || remotion.as_ref().map_or(true, |(_, value)| {
                value["criticalSha256"]
                    .as_object()
                    .map_or(true, |files| files.len() < 5)
            })
            || style_hash.is_none()
            || ffmpeg.as_ref().map_or(true, |(_, value)| {
                value["ffmpegSha256"].as_str().is_none()
                    || value["ffprobeSha256"].as_str().is_none()
            }))
    {
        panic!(
            "release build requires complete prepared Blender, Remotion, FFmpeg, and style manifests"
        );
    }
    tauri_build::build()
}
