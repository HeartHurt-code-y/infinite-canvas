import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location("core", Path(__file__).with_name("worker.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


class WorkerTests(unittest.TestCase):
    def test_partial_pipe_frame_is_never_accepted(self):
        self.assertIsNone(core.read_exact(io.BytesIO(), 4))
        with self.assertRaises(RuntimeError):
            core.read_exact(io.BytesIO(b"abc"), 4)

    def test_track_selection_excludes_cover_art(self):
        result = core.first_video_stream({"streams": [
            {"index": 0, "codec_type": "video", "disposition": {"attached_pic": 1}},
            {"index": 1, "codec_type": "audio"}, {"index": 2, "codec_type": "video"},
        ]})
        self.assertEqual(result["index"], 2)

    def test_temporal_windows_are_bounded_keep_every_pts_and_align_overlap(self):
        total = 97
        frames = [(np.full((8, 12, 3), index, dtype=np.uint8), index * 0.041 + (index % 3) * 0.001, 0.041) for index in range(total)]
        calls = []

        def infer(window):
            calls.append(len(window))
            scale = 1 + len(calls) * 0.7
            gradient = np.linspace(0, 1, 12, dtype=np.float32)[None, :] + np.zeros((8, 1), dtype=np.float32)
            return np.stack([(gradient + int(item[0, 0, 0])) * scale + len(calls) for item in window])

        outputs = list(core.temporal_depth_arrays(iter(frames), infer, lambda pts: None))
        self.assertEqual(calls, [32] * 4)
        self.assertEqual(len(outputs), total)
        np.testing.assert_array_equal([item[1] for item in outputs], [item[1] for item in frames])
        # Every window's arbitrary affine scale should be aligned back to the first one.
        expected = np.asarray([index * 1.7 + 1 for index in range(total)])
        np.testing.assert_allclose([item[0][0, 0] for item in outputs], expected, rtol=0.00001, atol=0.00001)

    def test_hard_cut_resets_temporal_context_and_display_scale(self):
        frames = [(np.full((8, 12, 3), 0 if index < 40 else 255, dtype=np.uint8), index * 0.04, 0.04) for index in range(62)]
        outputs = list(core.temporal_depth_arrays(frames, lambda window: np.stack([frame[..., 0].astype(np.float32) for frame in window]), lambda pts: None))
        self.assertEqual(len(outputs), 62)
        self.assertEqual([index for index, item in enumerate(outputs) if item[3]], [0, 40])
        self.assertTrue(all(float(item[0][0, 0]) == 255 for item in outputs[40:]))

    def test_real_ffmpeg_variable_pts_and_depth_preview_last_frame(self):
        ffmpeg = Path(__file__).resolve().parents[2] / "src-tauri/resources/ffmpeg/ffmpeg.exe"
        ffprobe = ffmpeg.with_name("ffprobe.exe")
        if not ffmpeg.is_file():
            self.skipTest("project FFmpeg unavailable")
        request = {"ffmpegPath": str(ffmpeg), "ffprobePath": str(ffprobe), "name": "PTS", "runtimeProfile": "lite"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            core.command([ffmpeg, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10:duration=1",
                          "-vf", "select=not(eq(n\\,2)+eq(n\\,5))", "-fps_mode", "vfr", "-c:v", "libx264", "-y", source])
            probe = core.probe_media(request, source)
            frames = list(core.source_frames(request, source, probe, 96, 64, 0.15, 0.85))
            np.testing.assert_allclose([frame[1] for frame in frames], [0.3, 0.4, 0.6, 0.7, 0.8], atol=0.000001)
            outputs = core.save_depth_outputs(request, root, 0.15, 0.85, "cpu", 96, 64, 252,
                ((frame[..., 0].astype(np.float32), pts, duration, index == 0) for index, (frame, pts, duration) in enumerate(frames)))
            preview = root / outputs[0]["path"]
            decoded = json.loads(core.command([ffprobe, "-v", "error", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time,pkt_duration_time", "-of", "json", preview], text=True).stdout)
            np.testing.assert_allclose([float(frame["best_effort_timestamp_time"]) for frame in decoded["frames"]], [0, 0.1, 0.3, 0.4, 0.5], atol=0.000001)
            self.assertAlmostEqual(outputs[0]["durationSeconds"], 0.55, places=6)
            preview_info = core.probe_media(request, preview)
            self.assertAlmostEqual(float(preview_info["format"]["duration"]), 0.55, places=5)


if __name__ == "__main__":
    unittest.main()
