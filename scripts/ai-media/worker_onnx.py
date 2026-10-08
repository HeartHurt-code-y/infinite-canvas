"""Default lightweight offline worker: ONNX Runtime + NumPy, without Torch."""

import argparse
import json
import os
from pathlib import Path
import sys
import traceback

sys.path.insert(0, str(Path(__file__).resolve().parent))
import worker_core as core


def session_for(model, device):
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(8, os.cpu_count() or 1))
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    # ORT 1.22's reshape fusion corrupts this temporal model's dynamic graph.
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    providers = ["CPUExecutionProvider"]
    if device == "directml":
        options.enable_mem_pattern = False
        providers.insert(0, "DmlExecutionProvider")
    return ort.InferenceSession(str(model), sess_options=options, providers=providers)


def device_for(preference):
    import onnxruntime as ort

    if preference not in ("auto", "cpu", "directml"):
        raise ValueError("轻量运行包支持 CPU；DirectML 需安装对应包，CUDA/MPS 请选增强运行包")
    available = "DmlExecutionProvider" in ort.get_available_providers()
    if preference == "directml" and not available:
        raise ValueError("当前轻量运行包未包含 DirectML，请选择 CPU")
    return "directml" if preference != "cpu" and available else "cpu"


def run_depth(request, root, source, output, start, end, device):
    import cv2
    import numpy as np
    from video_depth_anything.util.transform import Resize, NormalizeImage, PrepareForNet

    probe = core.probe_media(request, source)
    video = core.first_video_stream(probe)
    if video is None:
        raise ValueError("源媒体没有视频轨道")
    rotation = 0
    for side in video.get("side_data_list", []):
        rotation = int(side.get("rotation", rotation))
    source_width, source_height = int(video["width"]), int(video["height"])
    if abs(rotation) % 180 == 90:
        source_width, source_height = source_height, source_width
    maximum = request.get("depthMaxSide", 480)
    scale = min(1.0, maximum / max(source_width, source_height))
    width = max(2, int(source_width * scale) // 2 * 2)
    height = max(2, int(source_height * scale) // 2 * 2)
    input_size = 252 if maximum == 480 else 392
    ratio = max(width, height) / min(width, height)
    if ratio > 1.78:
        input_size = max(70, round(input_size * 1.777 / ratio / 14) * 14)
    resize = Resize(input_size, input_size, resize_target=False, keep_aspect_ratio=True,
                    ensure_multiple_of=14, resize_method="lower_bound", image_interpolation_method=cv2.INTER_CUBIC)
    normalize = NormalizeImage(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
    prepare = PrepareForNet()
    session = session_for(core.inside(root, "models/video_depth_anything_vits.onnx"), device)

    def infer(frames):
        values = [prepare(normalize(resize({"image": frame.astype(np.float32) / 255})))["image"] for frame in frames]
        tensor = np.stack(values, axis=0)[None].astype(np.float32)
        prediction = session.run(["depth"], {"frames": tensor})[0][0]
        # Match torch bilinear align_corners=True without OpenCV's 1/32-pixel
        # interpolation-table quantization.
        source_h, source_w = prediction.shape[1:]
        x = np.linspace(0, source_w - 1, width, dtype=np.float32)
        y = np.linspace(0, source_h - 1, height, dtype=np.float32)
        x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
        x1, y1 = np.minimum(x0 + 1, source_w - 1), np.minimum(y0 + 1, source_h - 1)
        wx, wy = x - x0.astype(np.float32), y - y0.astype(np.float32)
        horizontal = prediction[:, :, x0] * (1 - wx)[None, None] + prediction[:, :, x1] * wx[None, None]
        return horizontal[:, y0] * (1 - wy)[None, :, None] + horizontal[:, y1] * wy[None, :, None]

    generator = core.temporal_depth_arrays(
        core.source_frames(request, source, probe, width, height, start, end), infer,
        lambda pts: core.emit({"type": "progress", "progress": min(95, 5 + 85 * (pts - start) / (end - start)),
                               "message": "正在计算连续时序深度", "device": device}),
    )
    return core.save_depth_outputs({**request, "runtimeProfile": "lite"}, output, start, end, device, width, height, input_size, generator)


def run(request):
    # Common validation accepts the enhanced device names. Validate the lite
    # preference separately so a requested accelerator never silently disappears.
    validated = {**request, "device": "cpu"}
    source, output, start, end = core.validate_request(validated)
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / "runtime-manifest.json").read_text(encoding="utf-8"))
    sys.path.insert(0, str(core.inside(root, manifest["codeRoot"])))
    device = device_for(request.get("device", "auto"))
    core.emit({"type": "progress", "progress": 1, "message": "轻量本地模型已加载", "device": device})
    if request["operation"] == "video_depth":
        outputs = run_depth(request, root, source, output, start, end, device)
    else:
        from audio_onnx import run_separation
        outputs = run_separation(request, root, source, output, start, end, device)
    for index, item in enumerate(outputs):
        item["resultIndex"] = index
    core.emit({"type": "result", "outputs": outputs, "device": device, "actualDevice": device})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    try:
        run(json.loads(Path(args.request).read_text(encoding="utf-8-sig")))
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        core.emit({"type": "error", "message": str(error)[:4000]})
        sys.exit(1)
