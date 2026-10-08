"""Deterministic Windows regular-file ZIP writer/verifier; never follows reparse points."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import zipfile


def regular_file(root, relative):
    parts = relative.split("/")
    if any(part in ("", ".", "..") or "\\" in part or ":" in part for part in parts):
        raise ValueError("Unsafe ZIP path: " + relative)
    filename = root
    for part in parts:
        filename /= part
        info = filename.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("ZIP source contains reparse point: " + relative)
    if not stat.S_ISREG(info.st_mode) or not filename.resolve().is_relative_to(root.resolve()):
        raise ValueError("ZIP source is not a contained regular file: " + relative)
    return filename


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
    with zipfile.ZipFile(archive, "r" if verify else "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as package:
        if verify:
            if package.namelist() != names:
                raise ValueError("ZIP members differ from inventory")
            for entry, member in zip(files, package.infolist()):
                expected_mode = stat.S_IFREG | entry.get("mode", 0o644)
                if member.file_size != entry["size"] or member.date_time != (1980, 1, 1, 0, 0, 0) or member.external_attr >> 16 != expected_mode or member.compress_type != zipfile.ZIP_DEFLATED or member.is_dir():
                    raise ValueError("ZIP metadata mismatch: " + entry["path"])
                with package.open(member) as source:
                    transfer(source, None, entry)
        else:
            for entry in files:
                filename = regular_file(root, entry["path"])
                member = zipfile.ZipInfo(entry["path"], date_time=(1980, 1, 1, 0, 0, 0))
                member.create_system = 3
                member.compress_type = zipfile.ZIP_DEFLATED
                member.external_attr = (stat.S_IFREG | entry.get("mode", 0o644)) << 16
                member._compresslevel = 6
                with filename.open("rb") as source, package.open(member, "w", force_zip64=entry["size"] >= 2**31) as target:
                    transfer(source, target, entry)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("spec")
    parser.add_argument("archive")
    parser.add_argument("--verify", action="store_true")
    arguments = parser.parse_args()
    execute(json.loads(Path(arguments.spec).read_text(encoding="utf-8")), arguments.archive, arguments.verify)
