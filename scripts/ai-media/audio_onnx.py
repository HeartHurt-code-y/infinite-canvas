"""Bounded offline vocals separation with the MIT Open-Unmix-HQ ONNX core.

FFT and overlap synthesis use NumPy. This module has no Torch dependency.
The accompaniment is the aligned mixture minus predicted vocals, preserving gain.
"""
import json
import math

import numpy as np

FFT_SIZE = 4096
HOP_SIZE = 1024
FRAME_COUNT = 256
SEGMENT_SAMPLES = (FRAME_COUNT - 1) * HOP_SIZE
SAMPLE_RATE = 44100
OVERLAP_SAMPLES = SAMPLE_RATE


def stft(signal):
    """Match the upstream centered, periodic-Hann STFT (channels, bins, frames)."""
    signal = np.asarray(signal, dtype=np.float32)
    if signal.ndim != 2 or signal.shape[1] != 2 or signal.shape[0] != SEGMENT_SAMPLES:
        raise ValueError("音源分离块的形状无效")
    padded = np.pad(signal, ((FFT_SIZE // 2, FFT_SIZE // 2), (0, 0)), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, FFT_SIZE, axis=0)[::HOP_SIZE]
    window = np.hanning(FFT_SIZE + 1)[:-1].astype(np.float32)
    transformed = np.fft.rfft(frames * window, axis=-1).astype(np.complex64)
    return transformed.transpose(1, 2, 0)


def istft(spectrum, length=SEGMENT_SAMPLES):
    frames = np.fft.irfft(spectrum.transpose(2, 0, 1), n=FFT_SIZE, axis=-1).astype(np.float32)
    window = np.hanning(FFT_SIZE + 1)[:-1].astype(np.float32)
    reconstructed = np.zeros(((frames.shape[0] - 1) * HOP_SIZE + FFT_SIZE, 2), dtype=np.float32)
    normalization = np.zeros(reconstructed.shape[0], dtype=np.float32)
    for index, frame in enumerate(frames):
        position = index * HOP_SIZE
        reconstructed[position:position + FFT_SIZE] += (frame * window).T
        normalization[position:position + FFT_SIZE] += window * window
    start = FFT_SIZE // 2
    return reconstructed[start:start + length] / np.maximum(normalization[start:start + length, None], 1e-8)


def separate_block(signal, session):
    spectrum = stft(signal)
    magnitude = np.abs(spectrum).astype(np.float32)
    prediction = session.run(["vocals_magnitude"], {"magnitude": magnitude[None]})[0][0]
    if prediction.shape != magnitude.shape or not np.isfinite(prediction).all():
        raise RuntimeError("轻量模型输出无效，无法继续音源分离")
    # Bound the mask; high-frequency residuals stay in accompaniment rather than
    # introducing new clipping or independently rescaling the two stems.
    mask = np.clip(prediction / np.maximum(magnitude, 1e-8), 0, 1)
    return istft(spectrum * mask)


def create_session(model, device):
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    if device == "directml":
        if "DmlExecutionProvider" not in ort.get_available_providers():
            raise RuntimeError("此轻量组件不包含 Windows GPU 支持，请使用 CPU")
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        providers = ["DmlExecutionProvider", "CPUExecutionProvider"]
    elif device == "cpu":
        providers = ["CPUExecutionProvider"]
    else:
        raise RuntimeError("轻量音源分离不支持所选推理设备")
    return ort.InferenceSession(str(model), sess_options=options, providers=providers)


def run_separation(request, root, source, output, start, end, device):
    import soundfile as sf
    from worker_core import audio_crossfade, audio_windows, command, emit, inside, output_metadata, probe_media
    session = create_session(inside(root, "models/open_unmix_vocals.onnx"), device)
    probe = probe_media(request, source)
    streams = [stream for stream in probe["streams"] if stream.get("codec_type") == "audio"]
    stream_index = request.get("audioStreamIndex")
    stream = next((item for item in streams if item["index"] == stream_index), None)
    if stream is None:
        raise ValueError("所选音轨不存在")
    samples = round((end - start) * SAMPLE_RATE)
    if samples < 1:
        raise ValueError("音频选区过短")
    origin = float(probe.get("format", {}).get("start_time", 0))
    track_start = float(stream.get("start_time", origin)) - origin
    silence = max(track_start - start, 0)
    data_path = output / "mixture.f32"
    filter_value = f"asetpts=PTS-STARTPTS,atrim=start={max(start-track_start,0):.9f}:end={max(end-track_start,0):.9f},asetpts=PTS-STARTPTS,aresample={SAMPLE_RATE}"
    if silence:
        filter_value += f",adelay={round(silence*SAMPLE_RATE)}S:all=1"
    filter_value += f",apad=whole_len={samples},atrim=end_sample={samples}"
    command([request["ffmpegPath"], "-nostdin", "-v", "error", "-y", "-i", source, "-map", f"0:{stream_index}",
             "-vn", "-sn", "-dn", "-af", filter_value, "-ar", str(SAMPLE_RATE), "-ac", "2", "-f", "f32le", data_path])
    if data_path.stat().st_size != samples * 8:
        raise RuntimeError("音频解码长度与选区不匹配")
    mixture = np.memmap(data_path, dtype=np.float32, mode="r", shape=(samples, 2))
    accumulated_path, weights_path = output / "vocals-accumulation.f32", output / "overlap-weights.f32"
    accumulated = np.memmap(accumulated_path, dtype=np.float32, mode="w+", shape=(samples, 2))
    weights = np.memmap(weights_path, dtype=np.float32, mode="w+", shape=(samples,))
    emit({"type": "progress", "progress": 5, "message": "正在使用轻量模型分离人声与伴奏", "device": device})
    for position, length in audio_windows(samples, SEGMENT_SAMPLES, OVERLAP_SAMPLES):
        signal = np.zeros((SEGMENT_SAMPLES, 2), dtype=np.float32)
        signal[:length] = mixture[position:position + length]
        vocals = separate_block(signal, session)[:length]
        window = audio_crossfade(length, OVERLAP_SAMPLES, position == 0, position + length == samples, np)
        accumulated[position:position + length] += vocals * window[:, None]
        weights[position:position + length] += window
        emit({"type": "progress", "progress": min(95, 5 + 90 * (position + length) / samples), "message": "正在使用轻量模型分离人声与伴奏", "device": device})
    vocals_name, accompaniment_name, manifest_name = "vocals.wav", "accompaniment.wav", "audio-manifest.json"
    peak, square_error, count = 0.0, 0.0, 0
    with sf.SoundFile(output / vocals_name, "w", samplerate=SAMPLE_RATE, channels=2, format="WAV", subtype="FLOAT") as vocals_file, sf.SoundFile(output / accompaniment_name, "w", samplerate=SAMPLE_RATE, channels=2, format="WAV", subtype="FLOAT") as accompaniment_file:
        for position in range(0, samples, SAMPLE_RATE * 10):
            length = min(SAMPLE_RATE * 10, samples - position)
            vocal = np.asarray(accumulated[position:position + length]) / np.maximum(np.asarray(weights[position:position + length]), 1e-9)[:, None]
            original = np.asarray(mixture[position:position + length])
            accompaniment = original - vocal
            if not np.isfinite(vocal).all() or not np.isfinite(accompaniment).all():
                raise RuntimeError("轻量模型产生非有限音频")
            vocals_file.write(vocal)
            accompaniment_file.write(accompaniment)
            peak = max(peak, float(np.abs(vocal).max()), float(np.abs(accompaniment).max()))
            square_error += float(np.square(original - (vocal + accompaniment)).sum())
            count += original.size
    manifest = {"schemaVersion": 1, "operation": "audio_separation", "model": "Open-Unmix-HQ vocals", "modelLicense": "MIT",
                "runtimeProfile": "lite", "startSeconds": start, "endSeconds": end, "durationSeconds": samples / SAMPLE_RATE,
                "audioStreamIndex": stream_index, "sampleRate": SAMPLE_RATE, "channels": 2, "sampleCount": samples,
                "device": device, "format": "float32_wav", "peakAmplitude": peak, "reconstructionRmse": math.sqrt(square_error / max(1, count)),
                "fftSize": FFT_SIZE, "hopSize": HOP_SIZE, "windowSamples": SEGMENT_SAMPLES, "overlapSamples": OVERLAP_SAMPLES,
                "outputs": {"vocals": vocals_name, "accompaniment": accompaniment_name},
                "limitations": "轻量音乐人声模型，对白、混响与环境声可能残留；伴奏为原混合音频减人声，保留时间与增益关系。"}
    (output / manifest_name).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    # A final ndarray view also owns the mapped mixture on Windows.
    del original, accumulated, weights, mixture
    for temporary in (data_path, accumulated_path, weights_path):
        temporary.unlink()
    name = request.get("name", "视频")
    return [output_metadata("vocals", "audio", vocals_name, name + " · 人声", "audio/wav", samples / SAMPLE_RATE),
            output_metadata("accompaniment", "audio", accompaniment_name, name + " · 伴奏", "audio/wav", samples / SAMPLE_RATE),
            output_metadata("manifest", "data", manifest_name, name + " · 分离清单", "application/json", samples / SAMPLE_RATE)]
