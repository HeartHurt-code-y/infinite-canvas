# SPDX-License-Identifier: GPL-3.0-or-later
# This Blender bridge script is distributed under tools/blender/LICENSE.
"""Render an app-authored white-model plan using Blender's bundled Python.

Only JSON data is accepted from the job. The application bakes every frame of
camera and actor motion itself (the same evaluator drives its real-time
viewport), so this fixed script merely turns the baked samples into keyframes,
builds the geometry, saves an editable scene copy and renders an opaque PNG
sequence; the application owns video encoding.
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
from mathutils import Quaternion, Vector

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


GEOMETRY_TYPES = {"MESH", "CURVE", "SURFACE", "META", "FONT", "CURVES", "VOLUME"}
SHAPES = {"box", "sphere", "cylinder", "person"}
POSES = {"stand", "sit", "kneel", "crouch", "reach", "arms_up"}
JOINT_COUNT = 17
# Joint sphere radii and bone segments (start, end, radius) as fractions of body height.
# Must stay identical to src/lib/whiteModelScene.ts so the viewport matches the render.
JOINT_RADIUS = [
    0.06, 0.06, 0.03, 0.075, 0.036, 0.03, 0.03, 0.036, 0.03, 0.03,
    0.05, 0.045, 0.045, 0.05, 0.045, 0.045, 0.022,
]
JOINT_NAMES = [
    "骨盆", "胸腔", "颈部", "头部", "左肩", "左肘", "左腕", "右肩", "右肘", "右腕",
    "左髋", "左膝", "左踝", "右髋", "右膝", "右踝", "面部",
]
SEGMENTS = [
    (0, 1, 0.085), (1, 2, 0.03), (2, 3, 0.03), (4, 7, 0.035), (10, 13, 0.045),
    (4, 5, 0.032), (5, 6, 0.028), (7, 8, 0.032), (8, 9, 0.028),
    (10, 11, 0.05), (11, 12, 0.04), (13, 14, 0.05), (14, 15, 0.04),
]


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


def vector(value, label, limit=100):
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(f"{label}需要三个坐标。")
    return tuple(number(axis, label, -limit, limit) for axis in value)


def series(value, label, expected_length, limit):
    if not isinstance(value, list) or len(value) != expected_length:
        raise ValueError(f"{label}的烘焙数据长度与帧数不符。")
    for entry in value:
        number(entry, label, -limit, limit)
    return value


def increasing_times(frames, label, duration):
    if not isinstance(frames, list) or not frames:
        raise ValueError(f"{label}至少需要一个关键帧。")
    previous = -1
    for frame in frames:
        if not isinstance(frame, dict):
            raise ValueError(f"{label}关键帧无效。")
        timestamp = number(frame.get("time"), f"{label}关键帧时间", 0, duration)
        if timestamp <= previous:
            raise ValueError(f"{label}关键帧时间必须严格递增。")
        previous = timestamp


def validate_motion(motion):
    if not isinstance(motion, dict) or motion.get("kind") not in {"auto", "pose", "clip"}:
        raise ValueError("白模角色的动作来源无效。")
    if motion["kind"] == "pose" and motion.get("pose") not in POSES:
        raise ValueError("白模角色的姿势预设无效。")
    if motion["kind"] == "clip":
        clip = motion.get("clip")
        if not isinstance(clip, dict):
            raise ValueError("动捕片段无效。")
        integer(clip.get("fps"), "动捕片段帧率", 1, 120)
        integer(clip.get("frameCount"), "动捕片段帧数", 1, 100000)
        if not isinstance(clip.get("joints"), str) or not isinstance(clip.get("sourceName"), str):
            raise ValueError("动捕片段数据无效。")
        number(motion.get("startTime"), "动捕起始时间", -3600, 3600)
        number(motion.get("speed"), "动捕速度", 0.01, 100)
        if not isinstance(motion.get("loop"), bool):
            raise ValueError("动捕循环设置无效。")


def validate_request(request):
    if not isinstance(request, dict) or not isinstance(request.get("plan"), dict):
        raise ValueError("白模任务缺少场景方案。")
    plan = request["plan"]
    if plan.get("version") != 2:
        raise ValueError("不支持该白模场景方案版本，请更新应用后重新渲染。")
    duration = number(plan.get("durationSeconds"), "时长", 1, 30)
    fps = integer(plan.get("fps"), "帧率", 8, 30)
    width = integer(plan.get("width"), "画面宽度", 320, 1920)
    height = integer(plan.get("height"), "画面高度", 180, 1920)
    if width % 2 or height % 2:
        raise ValueError("视频宽高必须是偶数。")
    frame_count = max(1, math.floor(duration * fps + 0.5))
    camera = plan.get("camera")
    if not isinstance(camera, dict):
        raise ValueError("请设置有效的机位。")
    number(camera.get("lens"), "相机焦距", 1)
    if camera.get("interpolation") not in {"linear", "smooth"}:
        raise ValueError("机位插值方式无效。")
    increasing_times(camera.get("keyframes"), "机位", duration)
    for keyframe in camera["keyframes"]:
        vector(keyframe.get("position"), "机位位置")
        vector(keyframe.get("target"), "机位注视点")
    follow = camera.get("follow")
    if follow is not None and (
        not isinstance(follow, dict)
        or not isinstance(follow.get("actorId"), str)
        or follow.get("mode") not in {"aim", "track"}
    ):
        raise ValueError("机位跟随设置无效。")
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
        if actor.get("shape") not in SHAPES:
            raise ValueError("白模对象形状无效。")
        if not isinstance(actor.get("color"), str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", actor["color"]):
            raise ValueError("白模对象颜色需要使用 #rrggbb 格式。")
        number(actor.get("size"), "白模对象大小", 0.1, 10)
        if actor.get("facing") not in {"path", "manual"}:
            raise ValueError("白模对象朝向模式无效。")
        increasing_times(actor.get("keyframes"), f"「{actor['name']}」路径", duration)
        for keyframe in actor["keyframes"]:
            vector(keyframe.get("position"), "对象位置")
            number(keyframe.get("yaw"), "对象朝向")
        validate_motion(actor.get("motion"))
    if follow is not None and follow["actorId"] not in identifiers:
        raise ValueError("机位跟随的角色不存在。")
    source = request.get("sourceBlendPath")
    if source is not None and (not isinstance(source, str) or not source.strip()):
        raise ValueError("Blender 工程路径无效。")
    bake = request.get("bake")
    if not source:
        if not isinstance(bake, dict):
            raise ValueError("白模任务缺少逐帧烘焙数据。")
        if bake.get("frameCount") != frame_count:
            raise ValueError("烘焙帧数与片长、帧率不一致。")
        series(bake.get("camera"), "机位", frame_count * 6, 100)
        baked_objects = bake.get("objects")
        if not isinstance(baked_objects, list) or len(baked_objects) != len(plan["objects"]):
            raise ValueError("烘焙对象数量与场景方案不一致。")
        for actor, baked in zip(plan["objects"], baked_objects):
            if not isinstance(baked, dict) or baked.get("id") != actor["id"]:
                raise ValueError("烘焙对象顺序与场景方案不一致。")
            series(baked.get("root"), f"「{actor['name']}」根变换", frame_count * 4, 100000)
            for frame in range(frame_count):
                for axis in range(3):
                    number(baked["root"][frame * 4 + axis], "对象位置", -100, 100)
            if actor["shape"] == "person":
                series(baked.get("joints"), f"「{actor['name']}」关节", frame_count * JOINT_COUNT * 3, 20)
            elif baked.get("joints") is not None:
                raise ValueError("几何体不应携带关节数据。")
    return plan, bake, frame_count


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


class Meshes:
    """Unit meshes shared by every joint sphere and bone cylinder."""

    def __init__(self):
        self.sphere = None
        self.cylinder = None

    def unit_sphere(self):
        if self.sphere is None:
            bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=1)
            self.sphere = self._take("白模关节球")
        return self.sphere

    def unit_cylinder(self):
        if self.cylinder is None:
            bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=1, depth=1)
            self.cylinder = self._take("白模骨段")
        return self.cylinder

    @staticmethod
    def _take(name):
        template = bpy.context.object
        mesh = template.data
        mesh.name = name
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        bpy.data.objects.remove(template, do_unlink=True)
        return mesh


def link_object(name, mesh, parent, color):
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    obj.color = color
    return obj


def ensure_action(obj):
    obj.animation_data_create()
    action = bpy.data.actions.new(f"{obj.name} · 动画")
    obj.animation_data.action = action
    # Blender 4.4+ slotted actions: bind the object to its own slot when the API exists.
    slots = getattr(action, "slots", None)
    if slots is not None:
        try:
            obj.animation_data.action_slot = slots.new(id_type="OBJECT", name=obj.name)
        except Exception:  # pragma: no cover - older 4.x builds without slot API
            pass
    return action


def bake_channels(obj, action, data_path, per_frame):
    """Write one keyframe per frame for every component of `data_path`.

    `per_frame` is a list (frame order) of equal-length sequences (channel values).
    Frame numbering starts at 1 to match the render range.
    """
    channel_count = len(per_frame[0])
    for index in range(channel_count):
        fcurve = action.fcurves.new(data_path=data_path, index=index)
        fcurve.keyframe_points.add(len(per_frame))
        flat = [0.0] * (len(per_frame) * 2)
        for frame, values in enumerate(per_frame):
            flat[2 * frame] = frame + 1
            flat[2 * frame + 1] = values[index]
        fcurve.keyframe_points.foreach_set("co", flat)
        for point in fcurve.keyframe_points:
            point.interpolation = "LINEAR"
        fcurve.update()


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


def create_person(actor, root, joints, frame_count, meshes):
    height = actor["size"]
    color = object_color(actor["color"])
    frames = []
    for frame in range(frame_count):
        base = frame * JOINT_COUNT * 3
        frames.append([
            Vector(joints[base + joint * 3:base + joint * 3 + 3]) for joint in range(JOINT_COUNT)
        ])
    for joint in range(JOINT_COUNT):
        radius = JOINT_RADIUS[joint] * height
        sphere = link_object(f"{actor['name']} · {JOINT_NAMES[joint]}", meshes.unit_sphere(), root, color)
        sphere.scale = (radius, radius, radius)
        action = ensure_action(sphere)
        bake_channels(sphere, action, "location", [tuple(frames[frame][joint]) for frame in range(frame_count)])
    for index, (start, end, radius_ratio) in enumerate(SEGMENTS):
        radius = radius_ratio * height
        bone = link_object(
            f"{actor['name']} · 骨段 {index + 1}（{JOINT_NAMES[start]}→{JOINT_NAMES[end]}）",
            meshes.unit_cylinder(), root, color,
        )
        bone.rotation_mode = "QUATERNION"
        locations, rotations, scales = [], [], []
        previous = None
        for frame in range(frame_count):
            a = frames[frame][start]
            b = frames[frame][end]
            direction = b - a
            length = direction.length
            rotation = direction.to_track_quat("Z", "Y") if length > 1e-6 else Quaternion((1, 0, 0, 0))
            if previous is not None and previous.dot(rotation) < 0:
                rotation = -rotation
            previous = rotation
            locations.append(tuple((a + b) / 2))
            rotations.append(tuple(rotation))
            scales.append((radius, radius, max(length, 1e-4)))
        action = ensure_action(bone)
        bake_channels(bone, action, "location", locations)
        bake_channels(bone, action, "rotation_quaternion", rotations)
        bake_channels(bone, action, "scale", scales)


def create_actor(actor, baked, frame_count, meshes):
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
        create_person(actor, root, baked["joints"], frame_count, meshes)
    else:
        primitive(actor["shape"], f"{actor['name']} · 模型", root,
                  (0, 0, size / 2), (size, size, size), color)
    samples = baked["root"]
    locations = [tuple(samples[frame * 4:frame * 4 + 3]) for frame in range(frame_count)]
    rotations = [(0.0, 0.0, math.radians(samples[frame * 4 + 3])) for frame in range(frame_count)]
    action = ensure_action(root)
    bake_channels(root, action, "location", locations)
    bake_channels(root, action, "rotation_euler", rotations)


def look_at(position, target):
    direction = target - position
    if direction.length < 0.00001:
        raise ValueError("相机位置不能与观察目标重合。")
    up = "Y" if abs(direction.normalized().z) < 0.9999 else "X"
    return direction.to_track_quat("-Z", up)


def create_camera(plan, samples, frame_count):
    options = plan["camera"]
    bpy.ops.object.camera_add(location=tuple(samples[0:3]))
    camera = bpy.context.object
    camera.name = "白模摄影机"
    camera.data.lens = options["lens"]
    camera.data.sensor_fit = "AUTO"
    camera.data.sensor_width = 36
    camera.data.clip_start = 0.01
    camera.data.clip_end = 1000
    camera.rotation_mode = "QUATERNION"
    bpy.context.scene.camera = camera
    locations, rotations = [], []
    previous = None
    for frame in range(frame_count):
        position = Vector(samples[frame * 6:frame * 6 + 3])
        target = Vector(samples[frame * 6 + 3:frame * 6 + 6])
        rotation = look_at(position, target)
        if previous is not None and previous.dot(rotation) < 0:
            rotation = -rotation
        previous = rotation
        locations.append(tuple(position))
        rotations.append(tuple(rotation))
    action = ensure_action(camera)
    bake_channels(camera, action, "location", locations)
    bake_channels(camera, action, "rotation_quaternion", rotations)


def create_scene(plan, bake, frame_count):
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    meshes = Meshes()
    for actor, baked in zip(plan["objects"], bake["objects"]):
        create_actor(actor, baked, frame_count, meshes)
    bpy.ops.mesh.primitive_plane_add(size=240, location=(0, 0, -0.015))
    bpy.context.object.name = "白模地面"
    bpy.context.object.color = (0.16, 0.16, 0.16, 1)
    create_camera(plan, bake["camera"], frame_count)
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
        plan, bake, frame_count = validate_request(request)
        if bpy.app.version < (4, 5, 0):
            raise RuntimeError("白模渲染需要 Blender 4.5 或更新版本；当前集成已在 4.5 LTS 验证。")
        progress(output, 3, "正在准备 Blender 白模场景")
        project_path = output / "scene.blend"
        source = request.get("sourceBlendPath")
        if source:
            import_scene(source, project_path)
        else:
            create_scene(plan, bake, frame_count)
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
