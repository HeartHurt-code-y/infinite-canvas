# Optional local AI media components

The main Tauri installer does not include these components. Basic video clipping,
frame extraction, audio extraction and silent-video export use the existing FFmpeg
runtime and do not need an AI model. AI processing starts only after a compatible,
verified component has been installed.

The default `lite` component uses ONNX Runtime and does not ship PyTorch. It includes
the Apache-2.0 Video Depth Anything Small **temporal** model and MIT Open-Unmix HQ
vocals model. Depth remains relative depth rather than a measured distance in metres.
Audio separation targets vocals and musical accompaniment; overlapping dialogue,
reverberation and sound effects can remain in either output. Neither result should
be represented as a perfect reconstruction of the original production stems.

The optional `quality` component uses PyTorch, the same Small temporal depth model
and MIT Demucs `htdemucs` for audio separation. Its extra framework files take more
disk space. ONNX conversion preserves model parameters and is verified numerically;
it does not establish lower GPU memory usage. Use CPU unless an accelerator path
has been tested on the target device.

## Build and distribute a compatible component

Run from the repository root using pnpm:

```powershell
pnpm ai-media:prepare
pnpm ai-media:pack
```

Preparation uses a separate, pinned Python distribution and a build-only Torch
environment for ONNX conversion. The packaged lite runtime includes neither that
conversion environment nor source `.pth` checkpoints. Downloads are hash checked;
both exporters compare the exported graph against the original model. The resulting
runtime manifest and complete file inventory are hashed into the Rust binary by
`build.rs`, so compile the application **after** preparing components.

To enable the quality mode for the same application build, additionally prepare it
before compiling Rust:

```powershell
pnpm ai-media:prepare:quality
pnpm ai-media:pack --profile quality
```

The quality CUDA profile is a separate build option (`--profile quality-cuda`) and
requires a compatible NVIDIA device. CPU and CUDA packages have different manifests
and are not interchangeable. Compile the application against the component that
will actually be distributed. Component compatibility is pinned to the manifest,
inventory, platform and architecture, not merely the version displayed in the UI.

ZIP packages are written under `.cache/ai-media/packages/`. Distribute that component
ZIP separately from the application installer. Extract it to a folder, open video
preparation in the application, choose the matching mode and import that folder.
The application verifies every listed file, copies the component into its local
runtime store and rejects modified or additional executable files. No global
Python installation or pip command is needed on the customer's machine.

There is currently no published download endpoint or automatic component downloader.
The implemented installation path is importing an offline component folder. A release
must prepare the component on each target platform, compile the matching application,
and distribute both as a compatible pair. The main bundle resource map intentionally
excludes `ai-media-runtime` and `ai-media-quality-runtime`.

## Outputs and job recovery

Video depth produces a silent preview MP4, a ZIP containing float32 relative depth
frames and source timestamps, and a JSON manifest. Audio separation produces vocals
and accompaniment as stereo 44.1 kHz float32 WAV files, plus a JSON manifest. The
selected audio stream and source selection determine both stems; sample counts are
preserved and validated before delivery.

Jobs preserve the original source identity and hash, selection, mode, device and
output indices. Output names remain editable without changing the source identity.
Cancellation terminates the worker process tree. On application restart, incomplete
jobs become paused; retry reprocesses the frozen selection under the same job ID.
Model execution does not currently resume within a partially processed selection.
Adding a result to the canvas is explicit and produces local media cards. Depth data
and manifests remain downloadable artifacts rather than playable media cards.

## Targeted verification

```powershell
pnpm ai-media:test
```

The standard-library worker tests cover timestamp, temporal-window and output
contracts. `test_audio_onnx.py` additionally needs NumPy for numerical STFT/ISTFT
checks. Actual inference must be exercised with the prepared component and FFmpeg;
mocked process tests do not establish model quality or accelerator compatibility.

Upstream sources and weight licences:

- [Video Depth Anything](https://github.com/DepthAnything/Video-Depth-Anything)
- [Open-Unmix HQ weights](https://zenodo.org/records/3370489)
- [Demucs](https://github.com/facebookresearch/demucs)
- [ONNX Runtime](https://onnxruntime.ai/)
