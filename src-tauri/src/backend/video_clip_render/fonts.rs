//! Public font catalog and immutable, content-addressed local font files.
use super::*;
use crate::backend::error::{CommandResult, IntoCommandResult as _};
use sha2::{Digest, Sha256};
use tauri::Manager as _;
#[path = "bundled_fonts.rs"] mod bundled;

const MAX_FONT: usize = 32 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipFontRef {
    pub id: String, pub family: String, pub source_id: Option<String>, pub weight: u16, pub variable: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")] pub weights: Vec<u16>,
}
#[derive(Serialize, Deserialize)]
struct CatalogFont { id: String, family: String, url: String, chinese: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontItem { id: String, family: String, chinese: bool, cached: bool, local: bool, bundled: bool }
#[derive(Serialize)]
pub struct PreparedFont { pub font: ClipFontRef, pub path: String }
fn catalog() -> BackendResult<Vec<CatalogFont>> { Ok(serde_json::from_str(include_str!("../../../resources/fonts/catalog.json"))?) }
pub(super) fn root(app: &tauri::AppHandle) -> BackendResult<PathBuf> {
    let path = app.path().app_local_data_dir()?.join("clip-fonts"); std::fs::create_dir_all(&path)?; Ok(path)
}
fn valid_id(id: &str) -> bool { id.len() == 64 && id.as_bytes().iter().all(u8::is_ascii_hexdigit) }
fn read_ref(directory: &Path, id: &str) -> BackendResult<ClipFontRef> {
    if !valid_id(id) { return Err(invalid("字体身份无效，请重新选择字体")); }
    let data = std::fs::read(directory.join(format!("{id}.json"))).map_err(|_| invalid("此工程的字体尚未安装，请在字体库重新下载或导入原字体"))?;
    let font: ClipFontRef = serde_json::from_slice(&data)?;
    if font.id != id { return Err(invalid("字体记录损坏，请重新导入原字体")); }
    Ok(font)
}
fn verified(directory: &Path, font: ClipFontRef) -> BackendResult<PreparedFont> {
    let path = directory.join(format!("{}.ttf", font.id));
    let bytes = std::fs::read(&path).map_err(|_| invalid("字体文件已丢失，请在字体库重新下载或导入"))?;
    if bytes.len() > MAX_FONT || hex::encode(Sha256::digest(&bytes)) != font.id { return Err(invalid("字体文件校验失败，请重新下载或导入原字体")); }
    Ok(PreparedFont { font, path: path.to_string_lossy().into_owned() })
}
fn store(directory: &Path, bytes: &[u8], source_id: Option<String>) -> BackendResult<PreparedFont> {
    if bytes.is_empty() || bytes.len() > MAX_FONT { return Err(invalid("请选择32 MB以内的有效 TTF 或 OTF 字体")); }
    let face = ttf_parser::Face::parse(bytes, 0).map_err(|_| invalid("字体内容无效，仅支持 TTF 和 OTF；请勿选择网页、压缩包或字体集合"))?;
    let mut names = face.names().into_iter().filter(|name| name.name_id == ttf_parser::name_id::FAMILY);
    let name = names.clone().find(|name| name.language_id == 0x409).and_then(|name| name.to_string()).or_else(|| names.find_map(|name| name.to_string()));
    let family = name.filter(|value| !value.is_empty() && value.chars().count() <= 120 && !value.contains([',', '\\', '{', '}', '\n', '\r'])).ok_or_else(|| invalid("字体缺少有效家族名称，请换用标准 TTF 或 OTF 文件"))?;
    let id = hex::encode(Sha256::digest(bytes));
    let source_id = source_id.or_else(|| read_ref(directory, &id).ok().and_then(|font| font.source_id));
    let font = ClipFontRef { id, family, source_id, weight: face.weight().to_number(), variable: face.is_variable(), weights: Vec::new() };
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(bytes)?;
    let target = directory.join(format!("{}.ttf", font.id));
    if !target.exists() { file.persist_noclobber(&target).map_err(|error| error.error)?; }
    let mut manifest = tempfile::NamedTempFile::new_in(directory)?;
    manifest.write_all(&serde_json::to_vec(&font)?)?;
    manifest.persist(directory.join(format!("{}.json", font.id))).map_err(|error| error.error)?;
    verified(directory, font)
}
async fn download(directory: &Path, id: &str) -> BackendResult<PreparedFont> {
    let (catalog_id, requested_weight) = id.split_once('@').map(|(id, weight)| (id, weight.parse::<u16>().ok())).unwrap_or((id, None));
    if requested_weight.is_some_and(|weight| !(100..=900).contains(&weight)) { return Err(invalid("字体字重须在100至900之间")); }
    let entry = catalog()?.into_iter().find(|font| font.id == catalog_id).ok_or_else(|| invalid("字体不在公开目录中，请重新选择或导入本地字体"))?;
    // Only catalog URLs are accepted. Never fetch a URL supplied by a project or model.
    let client = reqwest::Client::builder().timeout(Duration::from_secs(120)).build()?;
    // libass does not select variable-font axes. Ask Google's legacy CSS endpoint for
    // a real static instance, then use that identical file in the browser and export.
    let mut css_url = url::Url::parse("https://fonts.googleapis.com/css2")?;
    css_url.query_pairs_mut().append_pair("family", &format!("{}:wght@{}",entry.family,requested_weight.unwrap_or(400)));
    let css = client.get(css_url).header(reqwest::header::USER_AGENT,"Mozilla/5.0").send().await.map_err(|error| BackendError::Transport(error.without_url()))?;
    let asset_url = if css.status().is_success() {
        let text = css.text().await.map_err(|error| BackendError::Transport(error.without_url()))?;
        let captures = regex::Regex::new(r"url\((https://fonts\.gstatic\.(?:com|cn)/[^\s)]+)\)").map_err(|_| invalid("字体目录解析失败"))?;
        let urls: Vec<_> = captures.captures_iter(&text).filter_map(|c| c.get(1).map(|v| v.as_str().to_owned())).collect();
        if urls.len()!=1 { return Err(invalid("字体服务未返回完整 TTF 字体，请导入本地静态字体")); }
        urls[0].replace("fonts.gstatic.com","fonts.gstatic.cn")
    } else if requested_weight.is_none() { entry.url.clone() }
    else { return Err(invalid(format!("此字体不提供所选字重（{}），请选择其他字重",requested_weight.unwrap_or(400)))); };
    let mut response = client.get(asset_url).send().await.map_err(|error| BackendError::Transport(error.without_url()))?;
    if !response.status().is_success() { return Err(invalid(format!("字体下载失败（HTTP {}），请检查网络后重试，或导入本地字体", response.status().as_u16()))); }
    if response.content_length().is_some_and(|size| size > MAX_FONT as u64) { return Err(invalid("字体文件超过32 MB，请导入较小的字体")); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| BackendError::Transport(error.without_url()))? {
        if bytes.len() + chunk.len() > MAX_FONT { return Err(invalid("字体文件超过32 MB，已停止下载")); }
        bytes.extend_from_slice(&chunk);
    }
    let face = ttf_parser::Face::parse(&bytes,0).map_err(|_| invalid("下载的字体无效，请重试或导入本地静态字体"))?;
    if face.is_variable() { return Err(invalid("此字体未提供可用于视频导出的静态字重，请导入静态 TTF / OTF 字体")); }
    let source_id = format!("{catalog_id}@{}",requested_weight.unwrap_or(face.weight().to_number()));
    store(directory, &bytes, Some(source_id))
}
pub(super) async fn resolve(app: &tauri::AppHandle, font: &ClipFontRef) -> BackendResult<PreparedFont> {
    let directory = root(app)?;
    if let Ok(cached) = read_ref(&directory, &font.id).and_then(|font| verified(&directory, font)) { return Ok(cached); }
    let source = font.source_id.as_deref().ok_or_else(|| invalid("此工程使用的本地字体尚未安装，请先导入原字体文件"))?;
    let prepared = if let Some(prepared) = bundled::prepare(app, source, Some(font.weight))? { prepared } else { download(&directory, source).await? };
    if prepared.font.id != font.id { return Err(invalid("线上字体版本已变化，请在字体库重新选择后再导出")); }
    Ok(prepared)
}
fn cached_fonts(directory: &Path) -> BackendResult<Vec<ClipFontRef>> {
    let mut result = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") && let Some(id) = path.file_stem().and_then(|s| s.to_str()) && let Ok(font) = read_ref(directory, id) { result.push(font); }
    }
    Ok(result)
}
#[tauri::command]
pub async fn list_clip_fonts(app: tauri::AppHandle) -> CommandResult<Vec<FontItem>> {
    (|| -> BackendResult<_> {
        let cached = cached_fonts(&root(&app)?)?;
        let mut result = bundled::items()?;
        result.extend(catalog()?.into_iter().map(|font| FontItem { cached: cached.iter().any(|item| item.source_id.as_deref().is_some_and(|id| id.split('@').next()==Some(&font.id))), id: font.id, family: font.family, chinese: font.chinese, local: false, bundled: false }));
        result.extend(cached.into_iter().filter(|font| font.source_id.is_none()).map(|font| FontItem { id: font.id, family: font.family, chinese: true, cached: true, local: true, bundled: false }));
        Ok(result)
    })().command()
}
#[tauri::command]
pub async fn prepare_clip_font(app: tauri::AppHandle, id: String, weight: Option<u16>) -> CommandResult<PreparedFont> {
    async {
        let directory = root(&app)?;
        if let Some(prepared) = bundled::prepare(&app, &id, weight)? { return Ok(prepared); }
        let request = if valid_id(&id) {
            let font = read_ref(&directory, &id)?;
            if weight.is_none_or(|weight| weight == font.weight) && !font.variable { return verified(&directory, font); }
            let source = font.source_id.ok_or_else(|| invalid("本地字体请导入对应字重的静态 TTF / OTF 文件"))?;
            format!("{}@{}",source.split('@').next().unwrap_or(&source),weight.unwrap_or(font.weight))
        } else if let Some(weight) = weight { format!("{}@{weight}",id.split('@').next().unwrap_or(&id)) } else { id };
        let key = if request.contains('@') { request.clone() } else { format!("{request}@400") };
        if let Some(prepared) = bundled::prepare(&app, &request, weight)? { return Ok(prepared); }
        if let Some(font) = cached_fonts(&directory)?.into_iter().find(|font| font.source_id.as_deref() == Some(&key)) && let Ok(cached) = verified(&directory, font) { return Ok(cached); }
        download(&directory, &request).await
    }.await.command()
}
#[tauri::command]
pub async fn import_clip_font(app: tauri::AppHandle, path: String) -> CommandResult<PreparedFont> {
    async {
        let path = tokio::fs::canonicalize(path).await?;
        if !path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("ttf") || ext.eq_ignore_ascii_case("otf")) { return Err(invalid("请选择 TTF 或 OTF 字体文件")); }
        if tokio::fs::metadata(&path).await?.len() > MAX_FONT as u64 { return Err(invalid("字体文件不能超过32 MB")); }
        let bytes = tokio::fs::read(path).await?;
        if ttf_parser::Face::parse(&bytes,0).is_ok_and(|face| face.is_variable()) { return Err(invalid("请导入所需字重的静态 TTF / OTF 字体；可变字体可在字体库中选择并下载对应字重")); }
        store(&root(&app)?, &bytes, None)
    }.await.command()
}
