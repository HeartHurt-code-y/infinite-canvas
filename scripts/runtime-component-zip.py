"""Deterministic native component ZIPs; macOS links remain relative and contained."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import stat
import zipfile


def safe_path(relative):
    if not isinstance(relative, str) or not relative or len(relative.encode("utf-8")) > 1024 or re.search(r'[\\:\x00-\x1f<>"|?*]', relative):
        return False
    parts = relative.split("/")
    return len(parts) <= 32 and all(part not in ("", ".", "..") and not part.endswith((".", " ")) and not re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.I) for part in parts)


def source_entry(root, relative, symlink=False):
    parts = relative.split("/")
    if not safe_path(relative):
        raise ValueError("Unsafe ZIP path: " + relative)
    filename = root
    for index, part in enumerate(parts):
        filename /= part
        info = filename.lstat()
        if symlink and index == len(parts) - 1:
            if not stat.S_ISLNK(info.st_mode):
                raise ValueError("ZIP symlink source changed: " + relative)
            return filename
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("ZIP source contains reparse point: " + relative)
    if not stat.S_ISREG(info.st_mode) or not filename.resolve().is_relative_to(root.resolve()):
        raise ValueError("ZIP source is not a contained regular file: " + relative)
    return filename


def symlink_target(relative, target):
    if not isinstance(target, str) or not target or len(target.encode("utf-8")) > 1024 or re.search(r'[\\:\x00-\x1f<>"|?*]', target) or target.startswith("/") or "" in target.split("/"):
        raise ValueError("Unsafe ZIP symlink target: " + relative)
    destination = posixpath.normpath(posixpath.join(posixpath.dirname(relative), target))
    if not safe_path(destination):
        raise ValueError("ZIP symlink target escapes root: " + relative)
    return target.encode("utf-8")


def read_source_symlink(root, entry):
    filename = source_entry(root, entry["path"], symlink=True)
    target = os.readlink(filename)
    if target != entry["target"]:
        raise ValueError("ZIP symlink source changed: " + entry["path"])
    resolved = filename.resolve(strict=True)
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError("ZIP symlink resolves outside root: " + entry["path"])
    info = resolved.stat()
    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or (stat.S_ISDIR(info.st_mode) and filename.parent.resolve().is_relative_to(resolved)):
        raise ValueError("ZIP symlink target is special or cyclic: " + entry["path"])
    return symlink_target(entry["path"], target)


def transfer(source, target, expected):
    digest = hashlib.sha256()
    size = 0
    while chunk := source.read(1024 * 1024):
        digest.update(chunk)
        size += len(chunk)
        if target:
            target.write(chunk)
    if size != expected["size"] or digest.hexdigest() != expected["sha256"]:
        raise ValueError("ZIP payload mismatch: " + expected["path"])


def execute(spec, archive, verify=False):
    root = Path(spec["root"])
    info = root.lstat()
    if not root.is_dir() or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("ZIP root must be materialized")
    files = spec["files"]
    names = [entry["path"] for entry in files]
    if names != sorted(names) or len(set(name.casefold() for name in names)) != len(names):
        raise ValueError("ZIP inventory must be unique and sorted")
    links = {entry["path"] for entry in files if entry.get("type") == "symlink"}
    for entry in files:
        if not safe_path(entry["path"]) or entry.get("type", "file") not in ("file", "symlink") or not isinstance(entry.get("mode", 0o644), int) or entry.get("mode", 0o644) & ~0o777:
            raise ValueError("Invalid ZIP entry type or permissions: " + entry["path"])
        if any("/".join(entry["path"].split("/")[:index]) in links for index in range(1, len(entry["path"].split("/")))):
            raise ValueError("ZIP entry has a symlink ancestor: " + entry["path"])
        if entry["path"] in links:
            if spec.get("platform") not in ("darwin-aarch64", "darwin-x86_64"):
                raise ValueError("Only macOS component ZIPs can contain symlinks")
            payload = symlink_target(entry["path"], entry["target"])
            if entry["mode"] != 0o755 or len(payload) != entry["size"] or hashlib.sha256(payload).hexdigest() != entry["sha256"]:
                raise ValueError("ZIP symlink payload mismatch: " + entry["path"])
    with zipfile.ZipFile(archive, "r" if verify else "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as package:
        if verify:
            if package.namelist() != names:
                raise ValueError("ZIP members differ from inventory")
            for entry, member in zip(files, package.infolist()):
                expected_mode = (stat.S_IFLNK if entry["path"] in links else stat.S_IFREG) | entry.get("mode", 0o644)
                if member.file_size != entry["size"] or member.date_time != (1980, 1, 1, 0, 0, 0) or member.external_attr >> 16 != expected_mode or member.compress_type != zipfile.ZIP_DEFLATED or member.is_dir():
                    raise ValueError("ZIP metadata mismatch: " + entry["path"])
                with package.open(member) as source:
                    transfer(source, None, entry)
        else:
            for entry in files:
                linked = entry["path"] in links
                filename = None if linked else source_entry(root, entry["path"])
                if not linked and spec.get("platform", "").startswith("darwin-") and filename.stat().st_mode & 0o777 != entry["mode"]:
                    raise ValueError("ZIP source permissions changed: " + entry["path"])
                member = zipfile.ZipInfo(entry["path"], date_time=(1980, 1, 1, 0, 0, 0))
                member.create_system = 3
                member.compress_type = zipfile.ZIP_DEFLATED
                member.external_attr = ((stat.S_IFLNK if linked else stat.S_IFREG) | entry.get("mode", 0o644)) << 16
                member._compresslevel = 6
                if linked:
                    package.writestr(member, read_source_symlink(root, entry))
                else:
                    with filename.open("rb") as source, package.open(member, "w", force_zip64=entry["size"] >= 2**31) as target:
                        transfer(source, target, entry)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("spec")
    parser.add_argument("archive")
    parser.add_argument("--verify", action="store_true")
    arguments = parser.parse_args()
    execute(json.loads(Path(arguments.spec).read_text(encoding="utf-8")), arguments.archive, arguments.verify)
