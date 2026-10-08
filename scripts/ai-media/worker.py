"""Offline AI media worker. JSONL is the only stdout protocol.

Temporal window scheduling follows Video Depth Anything (Apache-2.0),
https://github.com/DepthAnything/Video-Depth-Anything at 4f5ae23172ba60fd7bc11ef671cca678842c7072.
Demucs htdemucs is used under MIT. Neither model downloads at inference time.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import traceback
import zipfile


def command(args, **kwargs):
    return subprocess.run(
        [str(arg) for arg in args], check=True, capture_output=True,
        creationflags=0x08000000 if os.name == "nt" else 0, **kwargs
    )


def popen(args, **kwargs):
    return subprocess.Popen(
        [str(arg) for arg in args], creationflags=0x08000000 if os.name == "nt" else 0,
        **kwargs
    )


def inside(root, relative):
    target = (root / relative).resolve()
    if not target.is_relative_to(root.resolve()):
        raise ValueError("运行包路径越界")
    return target


def validate_request(request):
    if request.get("schemaVersion", 1) != 1:
        raise ValueError("AI 媒体请求版本不兼容")
    if request.get("operation") not in ("video_depth", "audio_separation"):
        raise ValueError("未知 AI 媒体操作")
    start = request.get("startSeconds", 0)
    end = request.get("endSeconds")
    if not isinstance(start, (int, float)) or not math.isfinite(start) or start < 0:
        raise ValueError("开始时间无效")
    if end is None or not isinstance(end, (int, float)) or not math.isfinite(end) or end <= start:
        raise ValueError("结束时间必须晚于开始时间")
    if request.get("depthMaxSide", 480) not in (480, 720):
        raise ValueError("深度视频尺寸必须为 480 或 720")
    if request.get("device", "auto") not in ("auto", "cpu", "cuda", "mps"):
        raise ValueError("未知推理设备")
    source = Path(request.get("sourcePath") or request.get("inputPath") or "")
    if not source.is_absolute() or not source.is_file():
        raise ValueError("源媒体路径不存在")
    output = Path(request["outputDir"])
    if not output.is_absolute() or not output.is_dir():
        raise ValueError("产物目录不存在")
    return source, output, float(start), float(end)


def resolve_device(torch, preference):
    if preference == "auto":
        if torch.cuda.is_available():
            device = "cuda"
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    else:
        device = preference
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA 不可用，请选择 CPU 或准备 CUDA 运行包")
    if device == "mps" and not (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()):
        raise RuntimeError("Apple GPU 不可用，请选择 CPU")
    if device == "cuda":
        capability = torch.cuda.get_device_capability()
        available = torch.cuda.get_arch_list()
        if f"sm_{capability[0]}{capability[1]}" not in available and not any(
            arch.startswith("compute_") for arch in available
        ):
            raise RuntimeError("当前 CUDA 运行包不支持此显卡架构，请更换兼容运行包或使用 CPU")
    return device


def probe_media(request, source):
    response = command([
        request["ffprobePath"], "-v", "error", "-show_streams", "-show_format",
        "-of", "json", source,
    ], text=True, encoding="utf-8")
    return json.loads(response.stdout)


def first_video_stream(probe):
    return next((stream for stream in probe["streams"] if stream.get("codec_type") == "video"
                 and not stream.get("disposition", {}).get("attached_pic", 0)), None)


def output_metadata(role, kind, filename, name, mime, duration, **extra):
    return {
        "role": role, "kind": kind, "path": filename, "name": name,
        "mimeType": mime, "durationSeconds": duration, **extra,
    }


def read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        block = stream.read(size - len(data))
        if not block:
            if not data:
                return None
            raise RuntimeError("媒体解码输出不完整")
        data.extend(block)
    return bytes(data)


def parse_frame_line(line, origin, start, end):
    values = dict(
        field.split("=", 1) for field in line.strip().split("|") if "=" in field
    )
    pts = values.get("best_effort_timestamp_time")
    if pts in (None, "N/A"):
        return None
    time = float(pts) - origin
    if time < start - 0.000001 or time >= end - 0.000001:
        return None
    duration = values.get("pkt_duration_time", values.get("duration_time", "0"))
    return time, float(duration) if duration != "N/A" else 0.0


def source_frames(request, source, probe, width, height, start, end):
    """Two streaming pipes: decoded RGB and the matching source presentation timestamps."""
    import numpy as np

    origin = float(probe.get("format", {}).get("start_time", 0))
    video = first_video_stream(probe)
    if video is None:
        raise ValueError("源媒体没有视频轨道")
    video_index = video["index"]
    timestamp_process = popen([
        request["ffprobePath"], "-v", "error", "-select_streams", str(video_index),
        "-show_frames", "-show_entries",
        "frame=best_effort_timestamp_time,pkt_duration_time,duration_time", "-of", "compact=p=0",
        source,
    ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
    # Keep original timing while resetting container origin, then trim in source-relative seconds.
    errors = tempfile.TemporaryFile()
    process = popen([
        request["ffmpegPath"], "-nostdin", "-v", "error", "-copyts", "-start_at_zero",
        "-i", source, "-map", f"0:{video_index}", "-an", "-sn", "-dn", "-vf",
        f"trim=start={start:.9f}:end={end:.9f},scale={width}:{height}:flags=bicubic",
        "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ], stdout=subprocess.PIPE, stderr=errors)
    last = None
    count = 0
    try:
        for line in timestamp_process.stdout:
            parsed = parse_frame_line(line, origin, start, end)
            if parsed is None:
                continue
            pts, duration = parsed
            if last is not None and pts <= last:
                raise RuntimeError("源视频时间戳未单调递增，无法可靠对齐连续深度")
            raw = read_exact(process.stdout, width * height * 3)
            if raw is None:
                raise RuntimeError("视频帧和源时间戳数量不匹配")
            count += 1
            last = pts
            yield np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3), pts, duration
        if read_exact(process.stdout, width * height * 3) is not None:
            raise RuntimeError("视频帧和源时间戳数量不匹配")
        if process.wait() != 0:
            errors.seek(0)
            raise RuntimeError("视频解码失败: " + errors.read()[-4000:].decode("utf-8", errors="replace"))
        if timestamp_process.wait() != 0:
            raise RuntimeError("读取源视频时间戳失败")
        if count == 0:
            raise RuntimeError("所选时间范围没有视频帧")
    finally:
        for child in (process, timestamp_process):
            if child.poll() is None:
                child.kill()
            child.wait()
            if child.stdout:
                child.stdout.close()
        errors.close()


def hard_cut(previous, current):
    """Conservative hard-cut detector. Only reset when both pixels and histogram differ."""
    import numpy as np
    import cv2

    if previous is None:
        return False
    before = cv2.resize(previous, (64, 36)).astype(np.float32) / 255
    after = cv2.resize(current, (64, 36)).astype(np.float32) / 255
    distance = float(np.abs(before - after).mean())
    first, _ = np.histogram(before, bins=32, range=(0, 1), density=False)
    second, _ = np.histogram(after, bins=32, range=(0, 1), density=False)
    histogram = float(np.abs(first / first.sum() - second / second.sum()).sum())
    return distance > 0.26 and histogram > 0.55


def align_depth(prediction, target):
    """Solve finite overlap scale/shift without retaining full-resolution video arrays."""
    import numpy as np

    first = np.asarray(prediction, dtype=np.float64).reshape(-1)
    second = np.asarray(target, dtype=np.float64).reshape(-1)
    valid = np.isfinite(first) & np.isfinite(second)
    first, second = first[valid], second[valid]
    if first.size < 2 or float(first.var()) < 1e-12:
        return 1.0, 0.0
    scale = float(((first - first.mean()) * (second - second.mean())).mean() / first.var())
    shift = float(second.mean() - scale * first.mean())
    if not math.isfinite(scale) or not math.isfinite(shift) or scale <= 0:
        return 1.0, 0.0
    return scale, shift


def temporal_depth_arrays(frames, infer, progress):
    """Bounded 32-frame offline inference, with official anchor/overlap/interpolation logic.

    The first two reference frames retain their anchor identity. Eight overlapping
    predictions are blended before being emitted; a hard cut ends the previous scene.
    No previous scene's tensor or scale is used after a cut.
    """
    import numpy as np

    iterator = iter(frames)
    carried = None
    previous_rgb = None
    keys = [0, 12, 24, 25, 26, 27, 28, 29, 30, 31]
    finished = False
    while not finished:
        pre_input = None
        reference = None
        pending = []
        scene = True
        while scene:
            wanted = 32 if pre_input is None else 22
            incoming = []
            boundary = False
            for _ in range(wanted):
                try:
                    item = carried if carried is not None else next(iterator)
                    carried = None
                except StopIteration:
                    finished = True
                    break
                if hard_cut(previous_rgb, item[0]):
                    carried = item
                    previous_rgb = None
                    boundary = True
                    break
                incoming.append(item)
                previous_rgb = item[0]
            if not incoming:
                for item in pending:
                    yield item
                break
            real_count = len(incoming)
            padded = incoming + [incoming[-1]] * (wanted - real_count)
            fresh = [item[0] for item in padded]
            current = fresh if pre_input is None else [pre_input[key] for key in keys] + fresh
            raw = infer(current)
            if not np.isfinite(raw).all():
                raise RuntimeError("深度模型产生非有限值，请使用 CPU 或兼容运行包")
            if pre_input is None:
                reference = [raw[0].copy(), raw[12].copy()]
                predictions = [(raw[i], incoming[i][1], incoming[i][2], True if i == 0 else False)
                               for i in range(real_count)]
            else:
                scale, shift = align_depth(raw[:2, ::8, ::8], np.asarray(reference)[:, ::8, ::8])
                raw = np.maximum(raw * scale + shift, 0)
                for index, old in enumerate(pending):
                    weight = index / 7
                    yield (old[0] * (1 - weight) + raw[2 + index] * weight, old[1], old[2], old[3])
                reference = [reference[0], raw[12].copy()]
                predictions = [(raw[10 + i], incoming[i][1], incoming[i][2], False) for i in range(real_count)]
            scene = not finished and not boundary
            if scene:
                hold = min(8, len(predictions))
                for item in predictions[:-hold]:
                    yield item
                pending = predictions[-hold:]
                pre_input = current
            else:
                for item in predictions:
                    yield item
                pending = []
            progress(incoming[-1][1])
        del pre_input


def temporal_depth(frames, model, transform, torch, device, progress):
    import numpy as np
    import torch.nn.functional as functional

    def infer(frames):
        tensors = [torch.from_numpy(transform({"image": frame.astype(np.float32) / 255})["image"])
                   for frame in frames]
        current = torch.stack(tensors, dim=0).unsqueeze(0).to(device)
        autocast = torch.autocast(device_type="cuda", dtype=torch.float16) if device == "cuda" else contextlib.nullcontext()
        with torch.inference_mode(), autocast:
            raw = model(current)
            return functional.interpolate(raw.flatten(0, 1).unsqueeze(1).float(), size=frames[0].shape[:2],
                                          mode="bilinear", align_corners=True)[:, 0].cpu().numpy()
    yield from temporal_depth_arrays(frames, infer, progress)


def run_depth(request, root, source, output, start, end, torch, device):
    import cv2
    import numpy as np
    from torchvision.transforms import Compose
    from video_depth_anything.video_depth import VideoDepthAnything
    from video_depth_anything.util.transform import Resize, NormalizeImage, PrepareForNet

    probe = probe_media(request, source)
    video = first_video_stream(probe)
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
    # Preserve output resolution, but bound transformer token count for long production clips.
    input_size = 252 if maximum == 480 else 392
    ratio = max(width, height) / min(width, height)
    if ratio > 1.78:
        input_size = max(70, round(input_size * 1.777 / ratio / 14) * 14)
    transform = Compose([
        Resize(input_size, input_size, resize_target=False, keep_aspect_ratio=True,
               ensure_multiple_of=14, resize_method="lower_bound", image_interpolation_method=cv2.INTER_CUBIC),
        NormalizeImage(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]), PrepareForNet(),
    ])
    model = VideoDepthAnything(encoder="vits", features=64, out_channels=[48, 96, 192, 384])
    weights = inside(root, "models/video_depth_anything_vits.pth")
    model.load_state_dict(torch.load(weights, map_location="cpu", weights_only=True))
    model.eval().to(device)
    generator = temporal_depth(
        source_frames(request, source, probe, width, height, start, end), model, transform, torch, device,
        lambda pts: emit({"type": "progress", "progress": min(95, 5 + 85 * (pts - start) / (end - start)), "message": "正在计算连续时序深度"}),
    )
    return save_depth_outputs(request, output, start, end, device, width, height, input_size, generator)


def save_depth_outputs(request, output, start, end, device, width, height, input_size, generator):
    import cv2
    import numpy as np

    emit({"type": "progress", "progress": 5, "message": "正在计算连续时序深度", "device": device})
    manifest_name, raw_name, video_name = "depth-manifest.json", "depth-data.zip", "depth.mp4"
    first_pts = None
    last_pts = None
    count = 0
    final_duration = 0
    chunk = []
    chunk_times = []
    chunks = []
    cut_frames = []
    limits = None
    with zipfile.ZipFile(output / raw_name, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive, tempfile.TemporaryDirectory(prefix="depth-frames-", dir=output) as temp:
        frames_dir = Path(temp)
        concat = frames_dir / "frames.ffconcat"
        listing = concat.open("w", encoding="utf-8", newline="\n")
        listing.write("ffconcat version 1.0\n")
        prior_filename = None
        prior_time = None

        def flush_chunk():
            if not chunk:
                return
            filename = f"chunks/{len(chunks):06d}.npz"
            buffer = io.BytesIO()
            np.savez(buffer, depth=np.stack(chunk).astype(np.float32), pts_seconds=np.asarray(chunk_times, dtype=np.float64))
            archive.writestr(filename, buffer.getvalue())
            chunks.append({"path": filename, "startFrame": count - len(chunk), "frameCount": len(chunk)})
            chunk.clear()
            chunk_times.clear()

        with (output / "depth-timestamps.jsonl").open("w", encoding="utf-8") as timestamp_file:
            for depth, pts, duration, scene_start in generator:
                if first_pts is None:
                    first_pts = pts
                if last_pts is not None and pts <= last_pts:
                    raise RuntimeError("深度帧顺序无效")
                if scene_start or limits is None:
                    # Per-scene fixed display scale prevents framewise contrast flicker.
                    low, high = np.percentile(depth, [2, 98]).tolist()
                    limits = (float(low), max(float(high), float(low) + 1e-6))
                    cut_frames.append(count)
                image = np.clip((depth - limits[0]) / (limits[1] - limits[0]), 0, 1)
                filename = f"{count:09d}.png"
                if not cv2.imwrite(str(frames_dir / filename), (image * 255).astype(np.uint8)):
                    raise RuntimeError("写入深度预览帧失败")
                if prior_filename is not None:
                    listing.write(f"file '{prior_filename}'\noption framerate 1000000\nduration {pts - prior_time:.9f}\n")
                prior_filename, prior_time = filename, pts
                timestamp_file.write(json.dumps({"frame": count, "sourcePtsSeconds": pts, "outputPtsSeconds": pts - first_pts}) + "\n")
                chunk.append(depth.copy())
                chunk_times.append(pts)
                count += 1
                last_pts = pts
                final_duration = min(max(duration, 0.000001), end - pts)
                if len(chunk) == 16:
                    flush_chunk()
            if not count:
                raise RuntimeError("深度处理未产生视频帧")
            listing.write(f"file '{prior_filename}'\noption framerate 1000000\nduration {final_duration:.9f}\n")
            # A duplicate boundary frame gives the concat demuxer a real endpoint;
            # -t below discards that endpoint rather than truncating the last frame.
            listing.write(f"file '{prior_filename}'\noption framerate 1000000\n")
            listing.close()
            flush_chunk()
        duration = min(end - start, last_pts - first_pts + final_duration)
        manifest = {
            "schemaVersion": 1, "operation": "video_depth", "model": "Video-Depth-Anything-Small",
            "runtimeProfile": request.get("runtimeProfile", "quality"),
            "modelLicense": "Apache-2.0", "depthType": "relative_inverse_depth", "units": "relative",
            "width": width, "height": height, "frameCount": count, "startSeconds": start, "endSeconds": end,
            "firstSourcePtsSeconds": first_pts, "durationSeconds": duration, "device": device,
            "selection": {"startSeconds": start, "endSeconds": end},
            "outputOffsetSeconds": first_pts - start,
            "selectionOffsetSeconds": first_pts - start, "lastFrameDurationSeconds": final_duration,
            "temporalWindow": 32, "overlap": 10, "inferenceInputSize": input_size,
            "hardCutFrames": cut_frames, "preview": video_name, "timestamps": "depth-timestamps.jsonl",
            "dataType": "float32", "chunks": chunks,
            "previewScaling": "fixed_2_98_percentile_per_scene", "previewDescription": "白色较近；灰度为显示映射，原始浮点深度见 chunks",
        }
        (output / manifest_name).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        archive.write(output / manifest_name, manifest_name)
        archive.write(output / "depth-timestamps.jsonl", "depth-timestamps.jsonl")
        emit({"type": "progress", "progress": 96, "message": "正在封装保留源时间戳的深度视频"})
        command([
            request["ffmpegPath"], "-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0",
            "-i", concat, "-an", "-c:v", "libx264", "-crf", "18", "-preset", "fast",
            "-bf", "0", "-bsf:v", f"setts=duration=if(eq(N\\,{count - 1})\\,{final_duration:.9f}/TB\\,DURATION)",
            "-pix_fmt", "yuv420p", "-fps_mode", "vfr", "-enc_time_base", "1:1000000",
            "-video_track_timescale", "1000000", "-t", f"{duration:.9f}", "-movflags", "+faststart", output / video_name,
        ])
    (output / "depth-timestamps.jsonl").unlink()
    name = request.get("name", "视频")
    return [
        output_metadata("depth_video", "video", video_name, name + " · 连续深度", "video/mp4", duration, width=width, height=height),
        output_metadata("depth_data", "data", raw_name, name + " · 深度数据", "application/zip", duration),
        output_metadata("manifest", "data", manifest_name, name + " · 深度清单", "application/json", duration),
    ]


def audio_windows(total, size, overlap):
    step = size - overlap
    position = 0
    while position < total:
        yield position, min(size, total - position)
        if position + size >= total:
            break
        position += step


def audio_crossfade(length, overlap, first, last, np):
    weights = np.ones(length, dtype=np.float32)
    if not first:
        weights[:min(overlap, length)] = np.linspace(0, 1, min(overlap, length), dtype=np.float32)
    if not last:
        weights[-min(overlap, length):] = np.linspace(1, 0, min(overlap, length), dtype=np.float32)
    return weights


def run_separation(request, root, source, output, start, end, torch, device):
    import numpy as np
    import soundfile as sf
    from demucs.htdemucs import HTDemucs
    from demucs.states import load_model
    from demucs.apply import apply_model
    from fractions import Fraction

    checkpoint = inside(root, "models/demucs/955717e8-8726e21a.th")
    with checkpoint.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    if digest != "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4":
        raise RuntimeError("Demucs 权重校验失败")
    # Older Demucs checkpoints include their architecture class. New PyTorch
    # defaults to weights_only=True; permit only this fixed checkpoint's known
    # constructors instead of globally disabling safe loading.
    if hasattr(torch.serialization, "safe_globals"):
        permitted = [HTDemucs, Fraction, np.dtype, np.core.multiarray.scalar,
                     type(np.dtype(np.float64)), type(np.dtype(np.float32))]
        with torch.serialization.safe_globals(permitted):
            package = torch.load(checkpoint, map_location="cpu", weights_only=True)
    else:
        # The last Intel-macOS PyTorch lacks scoped safe_globals; the full fixed
        # upstream checksum above is required before its legacy deserializer.
        package = torch.load(checkpoint, map_location="cpu", weights_only=False)
    model = load_model(package)
    model.eval().to(device)
    sample_rate = int(model.samplerate)
    duration = end - start
    samples = round(duration * sample_rate)
    if samples < 1:
        raise ValueError("音频时间范围过短")
    probe = probe_media(request, source)
    streams = [stream for stream in probe["streams"] if stream.get("codec_type") == "audio"]
    stream_index = request.get("audioStreamIndex")
    stream = next((item for item in streams if item["index"] == stream_index), None) if stream_index is not None else next(iter(streams), None)
    if stream is None:
        raise ValueError("所选音轨不存在")
    origin = float(probe.get("format", {}).get("start_time", 0))
    track_start = float(stream.get("start_time", origin)) - origin
    silence = max(track_start - start, 0)
    data_path = output / "mixture.f32"
    filter_value = f"asetpts=PTS-STARTPTS,atrim=start={max(start - track_start, 0):.9f}:end={max(end - track_start, 0):.9f},asetpts=PTS-STARTPTS,aresample={sample_rate}"
    if silence:
        filter_value += f",adelay={round(silence * sample_rate)}S:all=1"
    filter_value += f",apad=whole_len={samples},atrim=end_sample={samples}"
    command([
        request["ffmpegPath"], "-nostdin", "-v", "error", "-y", "-i", source,
        "-map", f"0:{stream['index']}", "-vn", "-sn", "-dn", "-af", filter_value,
        "-ar", str(sample_rate), "-ac", "2", "-f", "f32le", data_path,
    ])
    if data_path.stat().st_size != samples * 2 * 4:
        raise RuntimeError("音频解码长度不匹配，不能可靠对齐源视频")
    mixture = np.memmap(data_path, dtype=np.float32, mode="r", shape=(samples, 2))
    accumulation_path = output / "vocals-accumulation.f32"
    weights_path = output / "overlap-weights.f32"
    accumulated = np.memmap(accumulation_path, dtype=np.float32, mode="w+", shape=(samples, 2))
    weights = np.memmap(weights_path, dtype=np.float32, mode="w+", shape=(samples,))
    # HTDemucs has a 7.8-second maximum segment; use 7 seconds with 1.75 seconds overlap.
    size, overlap = sample_rate * 7, round(sample_rate * 1.75)
    vocals_index = model.sources.index("vocals")
    for position, length in audio_windows(samples, size, overlap):
        block = torch.from_numpy(np.asarray(mixture[position:position + length]).copy().T)
        reference = block.mean(0)
        mean = reference.mean()
        standard = reference.std(unbiased=False)
        if float(standard) < 1e-8:
            prediction = np.zeros((length, 2), dtype=np.float32)
        else:
            normalized = (block - mean) / standard
            with torch.inference_mode():
                stems = apply_model(model, normalized[None], device=device, shifts=0, split=True,
                                    overlap=0.25, progress=False, num_workers=0, segment=7)[0]
            prediction = ((stems[vocals_index].cpu() * standard) + mean).numpy().T[:, :]
        window = audio_crossfade(length, overlap, position == 0, position + length == samples, np)
        accumulated[position:position + length] += prediction[:length] * window[:, None]
        weights[position:position + length] += window
        emit({"type": "progress", "progress": min(96, 5 + 90 * (position + length) / samples), "message": "正在分离人声与伴奏", "device": device})
    vocals_name, accompaniment_name, manifest_name = "vocals.wav", "accompaniment.wav", "audio-manifest.json"
    peak = 0.0
    square_error = 0.0
    count = 0
    with sf.SoundFile(output / vocals_name, "w", samplerate=sample_rate, channels=2, format="WAV", subtype="FLOAT") as vocals_file, sf.SoundFile(output / accompaniment_name, "w", samplerate=sample_rate, channels=2, format="WAV", subtype="FLOAT") as accompaniment_file:
        for position in range(0, samples, sample_rate * 10):
            length = min(sample_rate * 10, samples - position)
            vocal = np.asarray(accumulated[position:position + length]) / np.maximum(np.asarray(weights[position:position + length]), 1e-9)[:, None]
            original = np.asarray(mixture[position:position + length])
            accompaniment = original - vocal
            if not np.isfinite(vocal).all() or not np.isfinite(accompaniment).all():
                raise RuntimeError("分离模型产生非有限音频")
            vocals_file.write(vocal)
            accompaniment_file.write(accompaniment)
            peak = max(peak, float(np.abs(vocal).max()), float(np.abs(accompaniment).max()))
            square_error += float(np.square(original - (vocal + accompaniment)).sum())
            count += original.size
    # Float WAV preserves relative stem gain without independently rescaling or clipping.
    manifest = {
        "schemaVersion": 1, "operation": "audio_separation", "model": "Demucs htdemucs", "modelLicense": "MIT",
        "runtimeProfile": "quality",
        "startSeconds": start, "endSeconds": end, "durationSeconds": samples / sample_rate,
        "audioStreamIndex": stream["index"], "sampleRate": sample_rate, "channels": 2,
        "sampleCount": samples, "device": device, "format": "float32_wav", "peakAmplitude": peak,
        "reconstructionRmse": math.sqrt(square_error / max(1, count)),
        "outputs": {"vocals": vocals_name, "accompaniment": accompaniment_name},
        "limitations": "模型针对音乐人声；对白、环境声、混响与背景音乐可能残留。伴奏使用混合音频减人声以保持重建一致。",
    }
    (output / manifest_name).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    del original, accumulated, weights, mixture
    for temporary in (data_path, accumulation_path, weights_path):
        temporary.unlink()
    name = request.get("name", "视频")
    return [
        output_metadata("vocals", "audio", vocals_name, name + " · 人声", "audio/wav", samples / sample_rate),
        output_metadata("accompaniment", "audio", accompaniment_name, name + " · 伴奏", "audio/wav", samples / sample_rate),
        output_metadata("manifest", "data", manifest_name, name + " · 分离清单", "application/json", samples / sample_rate),
    ]


def run(request):
    source, output, start, end = validate_request(request)
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / "runtime-manifest.json").read_text(encoding="utf-8"))
    code = inside(root, manifest["codeRoot"])
    sys.path.insert(0, str(code))
    os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "PYTORCH_ENABLE_MPS_FALLBACK": "1"})
    # Third-party model modules may print informational messages; keep JSONL stdout clean.
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))
        device = resolve_device(torch, request.get("device", "auto"))
    emit({"type": "progress", "progress": 1, "message": "本地模型已加载", "device": device})
    with contextlib.redirect_stdout(sys.stderr):
        operation = run_depth if request["operation"] == "video_depth" else run_separation
        # Protocol emitter uses the original stream even while model stdout is redirected.
        outputs = operation(request, root, source, output, start, end, torch, device)
    for index, item in enumerate(outputs):
        item["resultIndex"] = index
    emit({"type": "result", "outputs": outputs, "device": device, "actualDevice": device})


PROTOCOL_STDOUT = sys.stdout


def emit(event):
    PROTOCOL_STDOUT.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n")
    PROTOCOL_STDOUT.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    arguments = parser.parse_args()
    try:
        run(json.loads(Path(arguments.request).read_text(encoding="utf-8-sig")))
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "message": str(error)[:4000]})
        sys.exit(1)
