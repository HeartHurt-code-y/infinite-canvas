"""Build-only export of the MIT UMX-HQ vocals checkpoint to an offline ONNX core.

Weight provenance and license: https://zenodo.org/records/3370489
Architecture: https://github.com/sigsep/open-unmix-pytorch (MIT).
Torch and Open-Unmix are build dependencies, never part of the lightweight pack.
"""
import argparse
import inspect
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import onnx
import onnxruntime as ort
import torch
from openunmix.model import OpenUnmix


def export(checkpoint, output):
    torch.set_num_threads(4)
    model = OpenUnmix(nb_bins=2049, nb_channels=2, hidden_size=512, max_bin=1487)
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    missing, unexpected = model.load_state_dict(state, strict=False)
    legacy_buffers = {"sample_rate", "stft.window", "transform.0.window"}
    if missing or any(key not in legacy_buffers for key in unexpected):
        raise RuntimeError(f"UMX-HQ checkpoint is incompatible: missing={missing}, unexpected={unexpected}")
    if "sample_rate" in state and float(state["sample_rate"]) != 44100:
        raise RuntimeError("UMX-HQ checkpoint sample rate is incompatible")
    for key in ("stft.window", "transform.0.window"):
        if key in state:
            torch.testing.assert_close(state[key].flatten(), torch.hann_window(4096))
    model.eval()
    model.freeze()
    from audio_onnx import SEGMENT_SAMPLES, stft, istft
    signal = np.random.default_rng(51).normal(0, 0.03, (SEGMENT_SAMPLES, 2)).astype(np.float32)
    expected_stft = torch.stft(torch.from_numpy(signal.T.copy()), n_fft=4096, hop_length=1024,
                               window=torch.hann_window(4096), center=True, return_complex=True).numpy()
    np.testing.assert_allclose(stft(signal), expected_stft, rtol=0.0005, atol=0.000004)
    np.testing.assert_allclose(istft(stft(signal)), signal, rtol=0.00003, atol=0.000001)
    sample = torch.rand(1, 2, 2049, 256, generator=torch.Generator().manual_seed(48))
    output.parent.mkdir(parents=True, exist_ok=True)
    export_options = {"input_names": ["magnitude"], "output_names": ["vocals_magnitude"],
                      "opset_version": 17, "do_constant_folding": True}
    # The final Intel-macOS Torch release uses the legacy exporter without a
    # dynamo argument; newer Torch must explicitly select the same exporter.
    if "dynamo" in inspect.signature(torch.onnx.export).parameters:
        export_options["dynamo"] = False
    torch.onnx.export(model, sample, str(output), **export_options)
    onnx.checker.check_model(str(output))
    session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    # Two distinct inputs establish that exported inference is faithful and input-dependent.
    largest = 0.0
    for factor in (1.0, 0.37):
        with torch.inference_mode():
            expected = model(sample * factor).numpy()
        actual = session.run(None, {"magnitude": (sample * factor).numpy()})[0]
        if not np.isfinite(actual).all():
            raise RuntimeError("Exported vocals model produced non-finite values")
        np.testing.assert_allclose(actual, expected, rtol=0.003, atol=0.0002)
        largest = max(largest, float(np.abs(expected - actual).max()))
    report = {"model": "Open-Unmix-HQ vocals", "license": "MIT", "source": "https://zenodo.org/records/3370489",
              "inputShape": [1, 2, 2049, 256], "sampleRate": 44100, "fftSize": 4096, "hopSize": 1024,
              "maxAbsoluteError": largest, "comparison": "PyTorch vs ONNX Runtime CPU, two fixed inputs"}
    output.with_suffix(".validation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    export(args.checkpoint, args.output)
