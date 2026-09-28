"""Read a signed Tauri macOS updater archive without extracting its contents.

The caller must verify the updater Minisign signature before invoking this file.
Only app-tree metadata and SHA-256 digests are emitted; regular file bytes are
hashed in bounded chunks and never written to disk.
"""

import hashlib
import json
import sys
import tarfile


MAX_ENTRIES = 200_000
MAX_FILE_BYTES = 8 * 1024**3
MAX_TOTAL_BYTES = 20 * 1024**3


def fail(message):
    raise ValueError(f"macOS 完整包文件树无效：{message}")


def relative_name(name, app_name):
    if name in (".", "./"):
        return "."
    if name.startswith("./"):
        name = name[2:]
    name = name.rstrip("/")
    if name == app_name:
        return None
    if not name.startswith(app_name + "/"):
        fail(f"意外顶层路径：{name}")
    relative = name[len(app_name) + 1 :]
    parts = relative.split("/")
    if (
        not relative
        or len(relative.encode("utf-8")) > 1024
        or len(parts) > 32
        or any(part in ("", ".", "..") for part in parts)
        or "\\" in relative
        or ":" in relative
        or any(ord(character) < 32 or 0xD800 <= ord(character) <= 0xDFFF for character in relative)
    ):
        fail(f"路径不安全：{relative}")
    return relative


def inventory(archive_path, app_name):
    if app_name != "无限画布.app":
        fail("应用包名称不匹配")
    entries = []
    seen = set()
    root_seen = False
    container_root_seen = False
    total_bytes = 0
    with tarfile.open(archive_path, mode="r|gz") as archive:
        for member in archive:
            relative = relative_name(member.name, app_name)
            if relative == ".":
                if container_root_seen or not member.isdir() or member.mode & 0o7000:
                    fail("重复或异常归档根目录")
                container_root_seen = True
                continue
            if relative is None:
                if root_seen:
                    fail("重复应用包根目录")
                root_seen = True
                if not member.isdir() or member.mode & 0o7000:
                    fail("应用包根不是目录")
                continue
            folded = relative.casefold()
            if folded in seen:
                fail(f"重复路径：{relative}")
            seen.add(folded)
            if len(entries) >= MAX_ENTRIES:
                fail("文件数量超限")
            if member.mode & 0o7000:
                fail(f"特权权限位不允许：{relative}")
            if member.isdir():
                entries.append({"path": relative, "kind": "dir", "mode": member.mode & 0o777})
            elif member.issym():
                entries.append({"path": relative, "kind": "symlink", "target": member.linkname})
            elif member.isfile():
                if member.size < 0 or member.size > MAX_FILE_BYTES:
                    fail(f"文件大小超限：{relative}")
                total_bytes += member.size
                if total_bytes > MAX_TOTAL_BYTES:
                    fail("文件总大小超限")
                source = archive.extractfile(member)
                if source is None:
                    fail(f"无法读取文件：{relative}")
                digest = hashlib.sha256()
                with source:
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        digest.update(chunk)
                entries.append(
                    {
                        "path": relative,
                        "kind": "file",
                        "size": member.size,
                        "sha256": digest.hexdigest(),
                        "mode": member.mode & 0o777,
                    }
                )
            else:
                fail(f"不支持的 tar 条目类型：{relative}")
    entries.sort(key=lambda entry: entry["path"].encode("utf-8"))
    return entries


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: inventory-macos-updater-archive.py <archive.app.tar.gz> <appName.app>")
    try:
        json.dump(inventory(sys.argv[1], sys.argv[2]), sys.stdout, ensure_ascii=False, separators=(",", ":"))
    except (OSError, tarfile.TarError, ValueError) as error:
        sys.exit(str(error))
