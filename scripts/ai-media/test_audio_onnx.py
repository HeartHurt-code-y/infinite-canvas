"""Targeted numerical checks for the lightweight audio signal path, without model downloads."""
import unittest

import numpy as np
from audio_onnx import SEGMENT_SAMPLES, istft, separate_block, stft


class AudioTransformTests(unittest.TestCase):
    def test_stereo_round_trip_preserves_samples_channels_and_gain(self):
        random = np.random.default_rng(49)
        signal = random.normal(0, 0.06, (SEGMENT_SAMPLES, 2)).astype(np.float32)
        recovered = istft(stft(signal))
        self.assertEqual(recovered.shape, signal.shape)
        np.testing.assert_allclose(recovered, signal, rtol=0.00002, atol=0.000001)

    def test_phase_reconstruction_with_identity_mask_preserves_mixture(self):
        class IdentitySession:
            def run(self, outputs, inputs):
                return [inputs["magnitude"]]
        time = np.arange(SEGMENT_SAMPLES) / 44100
        signal = np.stack((0.2 * np.sin(2*np.pi*440*time), 0.1 * np.cos(2*np.pi*880*time)), axis=1).astype(np.float32)
        recovered = separate_block(signal, IdentitySession())
        np.testing.assert_allclose(recovered, signal, rtol=0.00002, atol=0.000001)

    def test_silence_is_finite_and_model_nonfinite_output_is_rejected(self):
        class BadSession:
            def run(self, outputs, inputs):
                return [np.full_like(inputs["magnitude"], np.nan)]
        signal = np.zeros((SEGMENT_SAMPLES, 2), dtype=np.float32)
        self.assertTrue(np.isfinite(istft(stft(signal))).all())
        with self.assertRaisesRegex(RuntimeError, "轻量模型输出无效"):
            separate_block(signal, BadSession())


if __name__ == "__main__":
    unittest.main()
