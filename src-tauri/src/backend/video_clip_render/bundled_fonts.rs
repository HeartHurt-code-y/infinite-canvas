//! Original extension fonts ship as resources; selection never requires a network request.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FontVariant { weight: u16, file: String, sha256: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledFamily { id: String, family: String, chinese: bool, default_weight: u16, variants: Vec<FontVariant> }
#[derive(Deserialize)]
struct BundledCatalog { version: u8, entries: Vec<BundledFamily> }
fn catalog() -> BackendResult<Vec<BundledFamily>> {
    let catalog: BundledCatalog = serde_json::from_str(include_str!("../../../resources/fonts/liblib-extended/manifest.json"))?;
    if catalog.version != 1 || catalog.entries.len() != 136 { return Err(invalid("内置字体目录不完整，请修复或重新安装应用")); }
    Ok(catalog.entries)
}
pub(super) fn items() -> BackendResult<Vec<FontItem>> {
    Ok(catalog()?.into_iter().map(|font| FontItem { id: font.id, family: font.family, chinese: font.chinese, cached: true, local: false, bundled: true }).collect())
}
fn resource_file(app: &tauri::AppHandle, relative: &str) -> BackendResult<PathBuf> {
    // Paths are embedded build metadata, and must still stay inside the resource directory.
    if relative.contains(['\\', ':']) || Path::new(relative).components().any(|part| !matches!(part, std::path::Component::Normal(_))) { return Err(invalid("内置字体资源路径无效")); }
    let installed = app.path().resource_dir()?.join("fonts/liblib-extended").join(relative);
    if installed.is_file() { return Ok(installed); }
    #[cfg(debug_assertions)]
    {
        let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/fonts/liblib-extended").join(relative);
        if development.is_file() { return Ok(development); }
    }
    Err(invalid("内置字体文件缺失，请修复或重新安装应用；无需重新配置模型"))
}
pub(super) fn prepare(app: &tauri::AppHandle, id: &str, weight: Option<u16>) -> BackendResult<Option<PreparedFont>> {
    let (family_id, suffix) = id.split_once('@').map(|(id, weight)| (id, Some(weight))).unwrap_or((id, None));
    if !family_id.starts_with("liblib-") { return Ok(None); }
    let family = catalog()?.into_iter().find(|font| font.id == family_id).ok_or_else(|| invalid("内置字体不在目录中，请重新选择字体"))?;
    let weight = weight.or(suffix.map(|value| value.parse::<u16>()).transpose().map_err(|_| invalid("内置字体字重无效"))?).unwrap_or(family.default_weight);
    let variant = family.variants.iter().find(|variant| variant.weight == weight).ok_or_else(|| invalid("此内置字体没有所选字重，请选择已有字重或其他字体"))?;
    let directory = root(app)?;
    let cached = read_ref(&directory, &variant.sha256).and_then(|font| verified(&directory, font)).ok();
    let mut prepared = if let Some(cached) = cached { cached } else {
        let bytes = std::fs::read(resource_file(app, &variant.file)?)?;
        if hex::encode(Sha256::digest(&bytes)) != variant.sha256 { return Err(invalid("内置字体文件校验失败，请修复或重新安装应用")); }
        store(&directory, &bytes, Some(format!("{}@{weight}",family.id)))?
    };
    if prepared.font.variable || prepared.font.weight != weight { return Err(invalid("内置字体字重与目录不一致，请修复应用资源")); }
    prepared.font.source_id = Some(format!("{}@{weight}", family.id));
    prepared.font.weights = family.variants.iter().map(|variant| variant.weight).collect();
    let mut manifest = tempfile::NamedTempFile::new_in(&directory)?;
    manifest.write_all(&serde_json::to_vec(&prepared.font)?)?;
    manifest.persist(directory.join(format!("{}.json", prepared.font.id))).map_err(|error| error.error)?;
    Ok(Some(prepared))
}
