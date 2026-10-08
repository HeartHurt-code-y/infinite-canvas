"""Build-only, bounded ZIP packaging of the exact verified component inventory."""
import argparse
import hashlib
import json
from pathlib import Path
import uuid
import zipfile


def package(root, output, expected_manifest):
    root = root.resolve(strict=True)
    output = output.absolute()
    if output.exists() or output.is_relative_to(root):
        raise ValueError("组件包输出位置无效或已存在")
    manifest_bytes = (root / "runtime-manifest.json").read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != expected_manifest:
        raise ValueError("组件清单在打包前发生变化")
    manifest = json.loads(manifest_bytes)
    inventory_bytes = (root / "files-manifest.json").read_bytes()
    if hashlib.sha256(inventory_bytes).hexdigest() != manifest["inventory"]["sha256"]:
        raise ValueError("组件清单校验失败")
    inventory = json.loads(inventory_bytes)
    if len(inventory) != manifest["inventory"]["count"]:
        raise ValueError("组件文件数量不匹配")
    temporary = output.with_name(output.name + "." + str(uuid.uuid4()) + ".partial")
    try:
        with temporary.open("xb") as target, zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
            archive.writestr("runtime-manifest.json", manifest_bytes)
            archive.writestr("files-manifest.json", inventory_bytes)
            for entry in inventory:
                parts = entry["path"].split("/")
                if entry.get("type") != "file" or any(part in ("", ".", "..") for part in parts) or "\\" in entry["path"] or ":" in entry["path"]:
                    raise ValueError("组件文件路径无效")
                filename = root / entry["path"]
                if filename.is_symlink() or not filename.resolve(strict=True).is_relative_to(root):
                    raise ValueError("组件文件路径越界")
                digest = hashlib.sha256()
                size = 0
                with filename.open("rb") as source, archive.open(entry["path"], "w", force_zip64=True) as destination:
                    while block := source.read(1024 * 1024):
                        digest.update(block)
                        size += len(block)
                        destination.write(block)
                if size != entry["bytes"] or digest.hexdigest() != entry["sha256"]:
                    raise ValueError("组件文件在打包时发生变化")
        # Never overwrite an existing distribution, even if a competing build finished.
        output.hardlink_to(temporary)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    arguments = parser.parse_args()
    package(arguments.root, arguments.output, arguments.manifest_sha256)
