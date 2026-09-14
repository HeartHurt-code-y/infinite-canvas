# SPDX-License-Identifier: GPL-3.0-or-later
# This Blender bridge script is distributed under tools/blender/LICENSE.
"""Render an app-authored white-model plan using Blender's bundled Python.

Only JSON data is accepted from the job. This fixed script creates an editable
scene copy and an opaque PNG sequence; the application owns video encoding.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import shutil
import sys
import traceback

import bpy
from mathutils import Vector

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


GEOMETRY_TYPES = {"MESH", "CURVE", "SURFACE", "META", "FONT", "CURVES", "VOLUME"}


def number(value, label, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label}必须是有限数值。")
    if minimum is not None and value < minimum or maximum is not None and value > maximum:
        raise ValueError(f"{label}超出允许范围。")
    return value


def integer(value, label, minimum, maximum):
    number(value, label, minimum, maximum)
    if int(value) != value:
        raise ValueError(f"{label}必须是整数。")
    return int(value)


def vector(value, label):
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(f"{label}需要三个坐标。")
    return tuple(number(axis, label, -100, 100) for axis in value)


def validate_request(request):
    if not isinstance(request, dict) or not isinstance(request.get("plan"), dict):
        raise ValueError("白模任务缺少场景方案。")
    plan = request["plan"]
    if plan.get("version") != 1:
        raise ValueError("不支持该白模场景方案版本。")
    duration = number(plan.get("durationSeconds"), "时长", 1, 30)
    fps = integer(plan.get("fps"), "帧率", 8, 30)
    width = integer(plan.get("width"), "画面宽度", 320, 1920)
    height = integer(plan.get("height"), "画面高度", 180, 1920)
    if width % 2 or height % 2:
        raise ValueError("视频宽高必须是偶数。")
    camera = plan.get("camera")
    if not isinstance(camera, dict) or camera.get("motion") not in {"static", "dolly", "truck", "orbit"}:
        raise ValueError("请选择有效的相机运动。")
    for key in ("start", "end", "target"):
        vector(camera.get(key), f"相机{key}")
    number(camera.get("orbitDegrees"), "环绕角度")
    number(camera.get("lens"), "相机焦距", 1)
    if not isinstance(plan.get("objects"), list):
        raise ValueError("白模对象列表无效。")
    identifiers = set()
    for index, actor in enumerate(plan["objects"]):
        if not isinstance(actor, dict):
            raise ValueError(f"对象 {index + 1} 无效。")
        identifier = actor.get("id")
        if not isinstance(identifier, str) or not identifier.strip() or identifier in identifiers:
            raise ValueError("白模对象必须使用不同的有效标识。")
        identifiers.add(identifier)
        if not isinstance(actor.get("name"), str) or not actor["name"].strip():
            raise ValueError("白模对象名称不能为空。")
        if actor.get("shape") not in {"box", "sphere", "cylinder", "person"}:
            raise ValueError("白模对象形状无效。")
        if not isinstance(actor.get("color"), str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", actor["color"]):
            raise ValueError("白模对象颜色需要使用 #rrggbb 格式。")
        number(actor.get("size"), "白模对象大小", 0.1, 10)
        keyframes = actor.get("keyframes")
        if not isinstance(keyframes, list) or not keyframes:
            raise ValueError("每个白模对象至少需要一个路径关键帧。")
        previous_time = -1
        for keyframe in keyframes:
            if not isinstance(keyframe, dict):
                raise ValueError("路径关键帧无效。")
            timestamp = number(keyframe.get("time"), "关键帧时间", 0, duration)
            if timestamp <= previous_time:
                raise ValueError("路径关键帧时间必须严格递增。")
            previous_time = timestamp
            vector(keyframe.get("position"), "对象位置")
            number(keyframe.get("yaw"), "对象朝向")
    source = request.get("sourceBlendPath")
    if source is not None and (not isinstance(source, str) or not source.strip()):
        raise ValueError("Blender 工程路径无效。")
    return plan, max(1, math.floor(duration * fps + 0.5))


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def progress(output, percent, message):
    write_json(output / "progress.json", {"progress": percent, "message": message})
    print(f"WHITE_MODEL_PROGRESS {percent} {message}", flush=True)


def srgb_to_linear(channel):
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def object_color(hex_color):
    return tuple(srgb_to_linear(int(hex_color[offset:offset + 2], 16) / 255) for offset in (1, 3, 5)) + (1,)


def primitive(shape, name, parent, position, scale, color):
    if shape == "box":
        bpy.ops.mesh.primitive_cube_add(size=1)
    elif shape == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=0.5)
    else:
        bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=0.5, depth=1)
    obj = bpy.context.object
    obj.name = name
    obj.parent = parent
    obj.location = position
    obj.scale = scale
    obj.color = color
    if shape != "box":
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    return obj


def create_actor(actor, fps):
    root = bpy.data.objects.new(actor["name"], None)
    bpy.context.scene.collection.objects.link(root)
    root.empty_display_type = "PLAIN_AXES"
    root["white_model_id"] = actor["id"]
    root["white_model_name"] = actor["name"]
    root["white_model_shape"] = actor["shape"]
    root["white_model_color"] = actor["color"]
    size = actor["size"]
    color = object_color(actor["color"])
    if actor["shape"] == "person":
        # A simple mannequin keeps the same bottom-origin placement as primitives.
        parts = [
            ("躯干", "cylinder", (0, 0, 0.56), (0.43, 0.3, 0.44)),
            ("头部", "sphere", (0, 0, 0.87), (0.26, 0.26, 0.26)),
            ("左臂", "cylinder", (-0.29, 0, 0.55), (0.12, 0.12, 0.42)),
            ("右臂", "cylinder", (0.29, 0, 0.55), (0.12, 0.12, 0.42)),
            ("左腿", "cylinder", (-0.12, 0, 0.21), (0.17, 0.17, 0.42)),
            ("右腿", "cylinder", (0.12, 0, 0.21), (0.17, 0.17, 0.42)),
        ]
        for suffix, shape, location, scale in parts:
            primitive(shape, f"{actor['name']} · {suffix}", root,
                      tuple(value * size for value in location),
                      tuple(value * size for value in scale), color)
    else:
        primitive(actor["shape"], f"{actor['name']} · 模型", root,
                  (0, 0, size / 2), (size, size, size), color)
    for keyframe in actor["keyframes"]:
        frame = 1 + keyframe["time"] * fps
        root.location = keyframe["position"]
        root.rotation_euler = (0, 0, math.radians(keyframe["yaw"]))
        root.keyframe_insert(data_path="location", frame=frame)
        root.keyframe_insert(data_path="rotation_euler", frame=frame)


def point_camera(camera, target):
    direction = target - camera.location
    if direction.length < 0.00001:
        raise ValueError("相机位置不能与观察目标重合。")
    up = "Y" if abs(direction.normalized().z) < 0.9999 else "X"
    camera.rotation_mode = "QUATERNION"
    camera.rotation_quaternion = direction.to_track_quat("-Z", up)


def create_camera(plan, frame_count):
    options = plan["camera"]
    start, end, target = (Vector(options[key]) for key in ("start", "end", "target"))
    bpy.ops.object.camera_add(location=start)
    camera = bpy.context.object
    camera.name = "白模摄影机"
    camera.data.lens = options["lens"]
    camera.data.clip_start = 0.01
    camera.data.clip_end = 1000
    bpy.context.scene.camera = camera
    offset = start - target
    # Bake camera orientation per frame so dolly/orbit keeps looking at the target.
    for frame in range(1, frame_count + 2):
        factor = min(1, (frame - 1) / (plan["durationSeconds"] * plan["fps"]))
        if options["motion"] == "orbit":
            angle = math.radians(options["orbitDegrees"]) * factor
            camera.location = target + Vector((
                offset.x * math.cos(angle) - offset.y * math.sin(angle),
                offset.x * math.sin(angle) + offset.y * math.cos(angle),
                offset.z,
            ))
        elif options["motion"] in {"dolly", "truck"}:
            camera.location = start.lerp(end, factor)
        else:
            camera.location = start
        point_camera(camera, target)
        camera.keyframe_insert(data_path="location", frame=frame)
        camera.keyframe_insert(data_path="rotation_quaternion", frame=frame)


def create_scene(plan, frame_count):
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    for actor in plan["objects"]:
        create_actor(actor, plan["fps"])
    bpy.ops.mesh.primitive_plane_add(size=240, location=(0, 0, -0.015))
    bpy.context.object.name = "白模地面"
    bpy.context.object.color = (0.16, 0.16, 0.16, 1)
    create_camera(plan, frame_count)
    bpy.context.scene.frame_start = 1


def visible_geometry():
    def visit(layer):
        if layer.exclude or layer.collection.hide_render:
            return
        for obj in layer.collection.objects:
            if obj.type in GEOMETRY_TYPES and not obj.hide_render:
                yield obj
        for child in layer.children:
            yield from visit(child)
    return list(visit(bpy.context.view_layer.layer_collection))


def clean_guides():
    hidden = 0
    for obj in bpy.context.scene.objects:
        # Ordinary viewport overlays never appear in Workbench camera renders.
        # Do not delete empties, rig bones, curves or constraints used by animation.
        explicit_guide = obj.get("white_model_guide") is True
        wire_helper = obj.type in GEOMETRY_TYPES and obj.display_type in {"WIRE", "BOUNDS"}
        if (explicit_guide or wire_helper) and not obj.hide_render:
            obj.hide_render = True
            hidden += 1
    return hidden


def import_scene(source, project_path):
    path = Path(source).expanduser()
    if not path.is_absolute() or path.suffix.lower() != ".blend" or not path.is_file():
        raise ValueError("请选择存在的本地 .blend 工程文件。")
    if path.resolve() == project_path.resolve():
        raise ValueError("输出工程不能覆盖导入的原始工程。")
    result = bpy.ops.wm.open_mainfile(filepath=str(path.resolve()), load_ui=False, use_scripts=False)
    if "FINISHED" not in result:
        raise RuntimeError("Blender 工程未能打开。")
    scene = bpy.context.scene
    if scene.camera is None or scene.camera.type != "CAMERA":
        raise ValueError("导入工程的活动场景没有摄影机，请先在 Blender 中设置活动摄影机。")
    bpy.ops.file.make_paths_absolute()
    try:
        packed = bpy.ops.file.pack_all()
        if "FINISHED" not in packed:
            raise RuntimeError("资源打包未完成")
    except Exception as error:
        raise RuntimeError(f"无法打包导入工程的外部资源；请在 Blender 中修复资源路径后重试。{error}") from error


def configure_render(plan, output, frame_count, imported):
    scene = bpy.context.scene
    scene.frame_end = scene.frame_start + frame_count - 1
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = plan["width"]
    scene.render.resolution_y = plan["height"]
    scene.render.resolution_percentage = 100
    scene.render.fps = plan["fps"]
    scene.render.fps_base = 1
    scene.render.film_transparent = False
    scene.render.use_border = False
    scene.render.use_crop_to_border = False
    scene.render.use_compositing = False
    scene.render.use_sequencer = False
    scene.render.use_stamp = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 15
    scene.render.use_file_extension = True
    scene.render.filepath = str(output / "frames" / "frame_")
    scene.display.shading.light = "STUDIO"
    # Preserve professional scene coloring and our own per-object colors on reimport.
    if not imported:
        scene.display.shading.color_type = "OBJECT"
    scene.display.shading.background_type = "VIEWPORT"
    scene.display.shading.background_color = (0.055, 0.055, 0.055)
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.show_object_outline = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.frame_set(scene.frame_start)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    input_path = Path(arguments.input)
    output = Path(arguments.output)
    if not input_path.is_absolute() or not output.is_absolute():
        raise ValueError("任务输入与输出必须使用绝对路径。")
    output.mkdir(parents=True, exist_ok=True)
    try:
        request = json.loads(input_path.read_text(encoding="utf-8-sig"))
        plan, frame_count = validate_request(request)
        if bpy.app.version < (4, 5, 0):
            raise RuntimeError("白模渲染需要 Blender 4.5 或更新版本；当前集成已在 4.5 LTS 验证。")
        progress(output, 3, "正在准备 Blender 白模场景")
        project_path = output / "scene.blend"
        source = request.get("sourceBlendPath")
        if source:
            import_scene(source, project_path)
        else:
            create_scene(plan, frame_count)
        hidden_guides = clean_guides()
        if not visible_geometry():
            raise ValueError("活动场景中没有可渲染的可见几何体。")
        frames_dir = output / "frames"
        frames_dir.mkdir(exist_ok=True)
        configure_render(plan, output, frame_count, bool(source))
        scene = bpy.context.scene
        result = bpy.ops.wm.save_as_mainfile(filepath=str(project_path), copy=True, relative_remap=True)
        if "FINISHED" not in result or not project_path.is_file():
            raise RuntimeError("无法保存白模工程副本。")
        progress(output, 8, f"白模场景已就绪，已排除 {hidden_guides} 个辅助对象")
        frame_start = scene.frame_start
        for index in range(1, frame_count + 1):
            scene.frame_set(frame_start + index - 1)
            frame_path = frames_dir / f"frame_{index:06d}.png"
            scene.render.filepath = str(frame_path)
            render = bpy.ops.render.render(write_still=True)
            if "FINISHED" not in render or not frame_path.is_file() or frame_path.stat().st_size == 0:
                raise RuntimeError(f"第 {index} 帧渲染未产生有效 PNG 文件。")
            if index == 1:
                shutil.copyfile(frame_path, output / "preview.png")
            progress(output, 8 + math.floor(index / frame_count * 84),
                     f"正在渲染白模动画：{index}/{frame_count} 帧")
        result = {
            "frameCount": frame_count,
            "fps": plan["fps"],
            "width": plan["width"],
            "height": plan["height"],
            "projectPath": str(project_path),
            "previewPath": str(output / "preview.png"),
        }
        write_json(output / "result.json", result)
        progress(output, 94, "白模帧序列已完成，正在等待视频编码")
        print("WHITE_MODEL_RESULT " + json.dumps(result, ensure_ascii=False), flush=True)
    except Exception as error:
        progress(output, 0, f"白模渲染失败：{error}")
        traceback.print_exc()
        raise


if __name__ == "__main__":
    main()
