use super::*;
use std::io::Cursor;

fn invalid_region_inputs() -> BackendError {
    BackendError::validation("扩图与重绘需要尺寸一致的 PNG 底图和非空黑白蒙版（最长边不超过 1024 像素）。", Value::Null)
}

fn region_png(media: &ResolvedMedia) -> BackendResult<image::ImageReader<Cursor<&[u8]>>> {
    let bytes = media.bytes.as_deref().filter(|_| media.mime_type == "image/png").ok_or_else(invalid_region_inputs)?;
    Ok(image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png))
}

impl ProviderRuntime {
    pub(super) async fn build_atlascloud_canvas_media_tool(
        &self, task: &TaskExecutionRecord, attempt_id: &str,
        context: &ResolvedProviderContext, resolved: &ResolvedGeneration,
    ) -> BackendResult<Value> {
        use super::super::canvas_feature_generation::{IMAGE_BACKGROUND, IMAGE_LAYERS, VIDEO_UPSCALER};
        let model = task.remote_model_id_snapshot.as_deref().unwrap_or_default();
        let (field, media) = match (model, resolved.images.as_slice(), resolved.videos.as_slice(), resolved.audios.as_slice()) {
            (VIDEO_UPSCALER, [], [video], []) => ("video", video),
            (IMAGE_BACKGROUND | IMAGE_LAYERS, [image], [], []) => ("image", image),
            _ => return Err(BackendError::validation("此工具需要且只能使用一项对应类型的素材。", Value::Null)),
        };
        let url = self.upload_atlascloud_media(task, attempt_id, context, media).await?;
        let mut body = Map::from_iter([("model".into(), json!(model)), (field.into(), json!(url))]);
        if model == IMAGE_LAYERS && !resolved.rendered_prompt.trim().is_empty() {
            body.insert("prompt".into(), json!(resolved.rendered_prompt.trim()));
        }
        insert_atlascloud_declared_parameters(&mut body, resolved, false)?;
        Ok(Value::Object(body))
    }

    pub(super) async fn build_image_upscale_body(
        &self, task: &TaskExecutionRecord, attempt_id: &str,
        context: &ResolvedProviderContext, resolved: &ResolvedGeneration,
    ) -> BackendResult<Value> {
        if resolved.images.len() != 1 || !resolved.videos.is_empty() || !resolved.audios.is_empty() {
            return Err(BackendError::validation("图片高清需要且只能使用一张图片，请调整参考素材。", json!({"images":resolved.images.len()})));
        }
        let image_url = self.upload_atlascloud_media(task, attempt_id, context, &resolved.images[0]).await?;
        let mut body = Map::new();
        body.insert("model".into(), json!(super::super::model_schema::ATLASCLOUD_UPSCALER_MODEL));
        body.insert("image".into(), json!(image_url));
        insert_atlascloud_declared_parameters(&mut body, resolved, false)?;
        Ok(Value::Object(body))
    }

    pub(super) async fn build_atlascloud_region_edit_body(
        &self, task: &TaskExecutionRecord, attempt_id: &str,
        context: &ResolvedProviderContext, resolved: &ResolvedGeneration,
    ) -> BackendResult<Value> {
        if task.adapter_id_snapshot != ATLASCLOUD_ADAPTER_ID || resolved.images.len() != 2 ||
            !resolved.videos.is_empty() || !resolved.audios.is_empty() {
            return Err(invalid_region_inputs());
        }
        let image = resolved.images.iter().find(|item| item.role == "image").ok_or_else(invalid_region_inputs)?;
        let mask = resolved.images.iter().find(|item| item.role == "mask").ok_or_else(invalid_region_inputs)?;
        let (width, height) = region_png(image)?.into_dimensions().map_err(|_| invalid_region_inputs())?;
        if width == 0 || height == 0 || width.max(height) > 1024 ||
            region_png(mask)?.into_dimensions().map_err(|_| invalid_region_inputs())? != (width, height) {
            return Err(invalid_region_inputs());
        }
        let pixels = region_png(mask)?.decode().map_err(|_| invalid_region_inputs())?.into_rgba8();
        let mut has_white = false;
        for pixel in pixels.pixels() {
            match pixel.0 {
                [0, 0, 0, 255] => {}
                [255, 255, 255, 255] => has_white = true,
                _ => return Err(invalid_region_inputs()),
            }
        }
        if !has_white {
            return Err(invalid_region_inputs());
        }
        let prompt = resolved.rendered_prompt.trim();
        let num_images = resolved.parameters.get("num_images").and_then(Value::as_u64)
            .filter(|value| (1..=4).contains(value));
        let Some(num_images) = num_images.filter(|_| !prompt.is_empty()) else {
            return Err(BackendError::validation("请提供编辑描述并选择 1–4 张结果。", Value::Null));
        };
        let image_url = self.upload_atlascloud_media(task, attempt_id, context, image).await?;
        let mask_url = self.upload_atlascloud_media(task, attempt_id, context, mask).await?;
        Ok(json!({
            "model": super::super::model_schema::ATLASCLOUD_REGION_EDIT_MODEL,
            "image": image_url, "mask_image": mask_url, "size": format!("{width}*{height}"),
            "prompt": prompt, "num_images": num_images
        }))
    }

    async fn upload_atlascloud_media(
        &self, task: &TaskExecutionRecord, attempt_id: &str,
        context: &ResolvedProviderContext, media: &ResolvedMedia,
    ) -> BackendResult<String> {
        if let Some(url) = media.remote_reference.as_deref().filter(|url| url.starts_with("https://")) {
            return Ok(url.to_string());
        }
        let bytes = media.bytes.as_ref().ok_or_else(|| BackendError::validation("无法读取待上传的素材，请重新选择。", media.archive()))?;
        let url = endpoint(&context.base_url, "/api/v1/model/uploadMedia")?;
        let call_id = Uuid::new_v4().to_string();
        self.lifecycle.commit(&task.id, GenerationLifecycleFact::ProviderCallPrepared {
            call_id: call_id.clone(), attempt_id: attempt_id.into(), phase: "upload".into(),
            request: json!({"providerConnectionId":context.provider_connection_id,"method":"POST","url":sanitize_url(&url),
                "bodyType":"multipart","file":{"field":"file","fileName":media.file_name,"mimeType":media.mime_type,"byteSize":media.byte_size,"sha256":media.sha256}}),
        })?;
        let part = multipart::Part::bytes(bytes.clone()).file_name(media.file_name.clone()).mime_str(&media.mime_type)?;
        let request = self.client.post(url).bearer_auth(&context.api_key).multipart(multipart::Form::new().part("file", part));
        let response = self.send_captured(&task.id, &call_id, "POST /api/v1/model/uploadMedia", request).await?;
        require_success(&response)?;
        let value: Value = serde_json::from_str(&response.body)?;
        value.get("url").or_else(|| value.pointer("/data/url")).and_then(Value::as_str)
            .filter(|url| url.starts_with("https://")).map(str::to_owned)
            .ok_or_else(|| BackendError::protocol("Atlas Cloud 素材上传未返回可用地址", value))
    }
}
