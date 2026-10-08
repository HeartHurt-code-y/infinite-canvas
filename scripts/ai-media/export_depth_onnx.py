"""Build-only conversion of the licensed Video Depth Anything Small temporal model.

Production needs ONNX Runtime rather than Torch. Export retains the 32-frame
temporal model and dynamic spatial dimensions; it is not a per-image model.
"""

import argparse
import json
import inspect
import math
from pathlib import Path
import sys
import textwrap
import types


def make_exportable(model, torch):
    """Keep upstream interpolation numerics while removing Python shape coercions.

    These two build-only adapters are required by the legacy ONNX tracer. No
    architecture/parameters/temporal layer is replaced. Symbolic Resize uses
    DINO's exact bicubic scale factor, including the original 0.1 offset.
    """
    from video_depth_anything.motion_module import motion_module

    def rearrange_dynamic(value, pattern, **axes):
        # einops caches shape recipes during tracing. Explicit tensor reshapes
        # preserve dynamic H/W in all four upstream temporal layouts.
        if pattern == "b c f h w -> (b f) c h w":
            b, c, f, h, w = value.shape
            return value.permute(0, 2, 1, 3, 4).reshape(b * f, c, h, w)
        if pattern == "(b f) c h w -> b c f h w":
            bf, c, h, w = value.shape
            f = axes["f"]
            return value.reshape(bf // f, f, c, h, w).permute(0, 2, 1, 3, 4)
        if pattern == "(b f) d c -> (b d) f c":
            bf, d, c = value.shape
            f = axes["f"]
            return value.reshape(bf // f, f, d, c).permute(0, 2, 1, 3).reshape(bf // f * d, f, c)
        if pattern == "(b d) f c -> (b f) d c":
            bd, f, c = value.shape
            d = axes["d"]
            return value.reshape(bd // d, d, f, c).permute(0, 2, 1, 3).reshape(bd // d * f, d, c)
        raise RuntimeError("上游时序布局与转换器不兼容: " + pattern)

    original_rearrange = motion_module.rearrange
    motion_module.rearrange = rearrange_dynamic

    class DynamicPositionResize(torch.autograd.Function):
        @staticmethod
        def forward(ctx, grid, height, width):
            side = float(grid.shape[-1])
            scales = ((float(height // 14) + 0.1) / side, (float(width // 14) + 0.1) / side)
            return torch.nn.functional.interpolate(grid, scale_factor=scales, mode="bicubic", align_corners=False)

        @staticmethod
        def symbolic(graph, grid, height, width):
            def constant(value):
                return graph.op("Constant", value_t=torch.tensor(value, dtype=torch.float32))
            def scale(value):
                value = graph.op("Cast", value, to_i=1)
                value = graph.op("Floor", graph.op("Div", value, constant(14.0)))
                value = graph.op("Div", graph.op("Add", value, constant(0.1)), constant(37.0))
                axes = graph.op("Constant", value_t=torch.tensor([0], dtype=torch.int64))
                return graph.op("Unsqueeze", value, axes)
            scales = graph.op("Concat", constant([1.0, 1.0]), scale(height), scale(width), axis_i=0)
            empty = graph.op("Constant", value_t=torch.tensor([], dtype=torch.float32))
            return graph.op("Resize", grid, empty, scales, mode_s="cubic", coordinate_transformation_mode_s="half_pixel", cubic_coeff_a_f=-0.75)

    def positional(self, tokens, height, width):
        position = self.pos_embed.float()
        side = int(math.sqrt(position.shape[1] - 1))
        grid = position[:, 1:].reshape(1, side, side, 384).permute(0, 3, 1, 2)
        grid = DynamicPositionResize.apply(grid, height, width)
        return torch.cat((position[:, :1], grid.flatten(2).transpose(1, 2)), dim=1).to(tokens.dtype)

    model.pretrained.interpolate_pos_encoding = types.MethodType(positional, model.pretrained)
    forward = model.head.forward.__func__
    source = textwrap.dedent(inspect.getsource(forward))
    if "int(patch_h * 14)" not in source or "int(patch_w * 14)" not in source:
        raise RuntimeError("固定版本时序头与转换器不兼容")
    source = source.replace("int(patch_h * 14)", "patch_h * 14").replace("int(patch_w * 14)", "patch_w * 14")
    # Export one vectorized frame batch. Legacy ONNX tracing freezes some slice
    # shapes in the upstream Python micro-batch loop; convolutions are the same.
    source = source.replace("micro_batch_size=4", "micro_batch_size=32")
    namespace = dict(forward.__globals__)
    exec(compile(source, "<onnx-temporal-size-adapter>", "exec"), namespace)
    model.head.forward = types.MethodType(namespace[forward.__name__], model.head)
    return motion_module, original_rearrange, rearrange_dynamic


def restore_dynamic_temporal_layouts(filename, onnx):
    """Replace legacy-tracer shape constants with the actual temporal input shape.

    The legacy exporter freezes these intermediate reshape recipes even with
    dynamic axes. Only shape arithmetic is changed, not an inference operation
    or weight. Each graph pattern is checked against the pinned architecture.
    """
    import numpy as np
    graph = onnx.load(str(filename))
    producers = {value: node for node in graph.graph.node for value in node.output}
    helpers = {}
    replacements = {}
    for index in range(4):
        prefix = f"/head/motion_modules.{index}/temporal_transformer"
        entry = next(node for node in graph.graph.node if node.name == prefix + "/Reshape")
        shape = onnx.numpy_helper.to_array(producers[entry.input[1]].attribute[0].t)
        if len(shape) != 4 or shape[0] != 32:
            raise RuntimeError("ONNX 时序布局与固定版本不兼容")
        height, width = int(shape[2]), int(shape[3])
        pixels = height * width
        new = []
        def constant(name, value):
            value = np.asarray(value, dtype=np.int64)
            output = prefix + "/dynamic_" + str(len(new)) + "_" + name
            new.append(onnx.helper.make_node("Constant", [], [output], name=output, value=onnx.numpy_helper.from_array(value)))
            return output
        shape_name = prefix + "/dynamic_source_shape"
        new.append(onnx.helper.make_node("Shape", [entry.input[0]], [shape_name], name=shape_name))
        h_name, w_name = prefix + "/dynamic_height", prefix + "/dynamic_width"
        new.append(onnx.helper.make_node("Gather", [shape_name, constant("height_index", [3])], [h_name], name=h_name, axis=0))
        new.append(onnx.helper.make_node("Gather", [shape_name, constant("width_index", [4])], [w_name], name=w_name, axis=0))
        pixel_name, heads_name = prefix + "/dynamic_pixels", prefix + "/dynamic_pixel_heads"
        new.append(onnx.helper.make_node("Mul", [h_name, w_name], [pixel_name], name=pixel_name))
        new.append(onnx.helper.make_node("Mul", [pixel_name, constant("heads", [8])], [heads_name], name=heads_name))
        spatial_axes = {
            prefix + "/Constant": {2: h_name, 3: w_name},
            prefix + "/Constant_2": {1: h_name, 2: w_name},
            prefix + "/Constant_3": {3: h_name, 4: w_name},
        }
        for node in graph.graph.node:
            if not node.name.startswith(prefix + "/") or node.op_type != "Constant":
                continue
            values = onnx.numpy_helper.to_array(node.attribute[0].t)
            # baddbmm(beta=0) exports its unused empty input as an all-zero
            # batch-shaped addend. A scalar zero is numerically identical and
            # broadcasts to the actual number of spatial attention batches.
            if "/attention_blocks." in node.name and values.ndim == 3 and values.shape[1:] == (32, 32):
                if np.any(values != 0):
                    raise RuntimeError("ONNX beta=0 注意力常量与固定版本不兼容")
                replacements[node.name] = onnx.helper.make_node("Constant", [], list(node.output), name=node.name,
                    value=onnx.numpy_helper.from_array(np.array(0, dtype=values.dtype)))
                continue
            if values.ndim != 1 or not np.issubdtype(values.dtype, np.integer) or values.size > 5:
                continue
            dynamic = spatial_axes.get(node.name, {})
            if not dynamic:
                dynamic = {axis: pixel_name if int(value) == pixels else heads_name
                           for axis, value in enumerate(values) if int(value) in (pixels, pixels * 8)}
            if not dynamic:
                continue
            parts = [dynamic.get(axis) or constant(f"{node.name.rsplit('/', 1)[-1]}_{axis}", [int(value)])
                     for axis, value in enumerate(values)]
            replacements[node.name] = onnx.helper.make_node("Concat", parts, list(node.output), name=node.name, axis=0)
        helpers[prefix + "/Constant"] = new
    # A traced temporal tensor's static type also makes refinenet4's explicit
    # target size constant. Obtain it from the actual layer3 tensor, preserving
    # the exact upstream size=layer_3_rn.shape[2:] relationship.
    resize_prefix = "/head/refinenet4"
    resize_constant = producers.get(resize_prefix + "/Constant_3_output_0")
    if resize_constant is None or resize_constant.op_type != "Constant":
        raise RuntimeError("ONNX refinenet4 布局与固定版本不兼容")
    resize_shape = resize_prefix + "/dynamic_target_shape"
    resize_axes = resize_prefix + "/dynamic_target_axes"
    helpers[resize_constant.name] = [
        onnx.helper.make_node("Shape", ["/head/layer3_rn/Conv_output_0"], [resize_shape], name=resize_shape),
        onnx.helper.make_node("Constant", [], [resize_axes], name=resize_axes, value=onnx.numpy_helper.from_array(np.array([2, 3], dtype=np.int64))),
    ]
    replacements[resize_constant.name] = onnx.helper.make_node("Gather", [resize_shape, resize_axes], list(resize_constant.output), name=resize_constant.name, axis=0)
    rewritten = []
    for node in graph.graph.node:
        rewritten.extend(helpers.get(node.name, []))
        rewritten.append(replacements.get(node.name, node))
    del graph.graph.node[:]
    graph.graph.node.extend(rewritten)
    onnx.save(graph, str(filename))


def export(checkpoint, code_root, output):
    import numpy as np
    import torch
    import onnx
    import onnxruntime as ort

    sys.path.insert(0, str(Path(code_root).resolve()))
    from video_depth_anything.video_depth import VideoDepthAnything

    torch.set_num_threads(4)
    model = VideoDepthAnything(encoder="vits", features=64, out_channels=[48, 96, 192, 384])
    model.load_state_dict(torch.load(checkpoint, map_location="cpu", weights_only=True))
    model.eval()
    baseline = VideoDepthAnything(encoder="vits", features=64, out_channels=[48, 96, 192, 384])
    baseline.load_state_dict(model.state_dict())
    baseline.eval()
    motion_module, original_rearrange, rearrange_dynamic = make_exportable(model, torch)
    # A smaller tracing input bounds build-memory usage. The spatial dimensions
    # stay dynamic and production uses 252/392 input size, preserving model weights.
    torch.manual_seed(2026)
    example = torch.randn(1, 32, 3, 70, 98)
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    # Intel macOS uses the last supported Torch 2.2 release, whose exporter
    # predates the dynamo option. Both versions use the same legacy tracer.
    export_options = {"dynamo": False} if "dynamo" in inspect.signature(torch.onnx.export).parameters else {}
    with torch.inference_mode():
        torch.onnx.export(
            model, example, str(output), input_names=["frames"], output_names=["depth"],
            dynamic_axes={"frames": {3: "height", 4: "width"}, "depth": {2: "height", 3: "width"}},
            opset_version=17, do_constant_folding=True, **export_options,
        )
    restore_dynamic_temporal_layouts(output, onnx)
    onnx.checker.check_model(str(output))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    session = ort.InferenceSession(str(output), sess_options=options, providers=["CPUExecutionProvider"])
    results = []
    for shape in [(1, 32, 3, 70, 98), (1, 32, 3, 98, 70), (1, 32, 3, 84, 84), (1, 32, 3, 252, 252)]:
        print("Verifying temporal ONNX shape: " + str(shape), flush=True)
        value = torch.randn(*shape)
        motion_module.rearrange = original_rearrange
        try:
            with torch.inference_mode():
                expected = baseline(value).numpy()
        finally:
            motion_module.rearrange = rearrange_dynamic
        actual = session.run(["depth"], {"frames": value.numpy()})[0]
        absolute = float(np.abs(expected - actual).max())
        relative_rmse = float(np.sqrt(np.square(expected - actual).mean()) / max(float(np.sqrt(np.square(expected).mean())), 1e-9))
        if not np.isfinite(actual).all() or relative_rmse > 0.0002 or absolute > max(0.005, float(np.abs(expected).max()) * 0.0005):
            raise RuntimeError(f"ONNX 连续深度转换验证失败: {shape}, max={absolute}, rmse={relative_rmse}")
        results.append({"shape": shape, "maxAbsoluteError": absolute, "relativeRmse": relative_rmse})
    report = {"schemaVersion": 1, "model": "Video-Depth-Anything-Small", "license": "Apache-2.0",
              "opset": 17, "temporalFrames": 32, "dynamicSpatialDimensions": True,
              "torchVersion": torch.__version__, "onnxRuntimeVersion": ort.__version__, "verification": results}
    Path(str(output) + ".verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--code-root", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    export(args.checkpoint, args.code_root, args.output)
