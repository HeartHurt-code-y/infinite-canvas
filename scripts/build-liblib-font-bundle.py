"""Prepare offline runtime metadata and a ZIP of the original 136 font entries.

Preparation dependency: fonttools==4.60.1 (no Python dependency in the desktop app).
Run prepare-liblib-fonts.mjs first, then this script with --fonttools and --archive.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--fonttools", type=Path, help="Optional local fontTools package directory")
parser.add_argument("--archive", type=Path, required=True)
args = parser.parse_args()
if args.fonttools:
    sys.path.insert(0, str(args.fonttools.resolve()))
from fontTools.ttLib import TTFont, newTable
from fontTools.varLib.instancer import instantiateVariableFont

DIRECTORY = ROOT / "src-tauri/resources/fonts/liblib-extended"
source = json.loads((DIRECTORY / "downloaded.json").read_text(encoding="utf-8"))
if len(source["fonts"]) != 136:
    raise ValueError("Expected the original 136 font entries")


def sha256(path):
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def name_value(font, name_id):
    names = [name for name in font["name"].names if name.nameID == name_id]
    names.sort(key=lambda name: (name.langID != 0x409, name.platformID != 3))
    for name in names:
        try:
            value = name.toUnicode().strip()
        except (UnicodeError, LookupError):
            continue
        if value:
            return value
    return ""


def inspect_file(path, relative):
    with TTFont(path, lazy=True, recalcTimestamp=False) as font:
        family = name_value(font, 1)
        if not family or any(char in family for char in ",\\{}\n\r"):
            raise ValueError(f"Unsupported family name in {path.name}: {family!r}")
        if "fvar" in font:
            raise ValueError(f"Runtime instance is still variable: {path.name}")
        weight = font["OS/2"].usWeightClass
        if not 100 <= weight <= 900:
            raise ValueError(f"Unsupported font weight {weight} in {path.name}")
        return {"weight": weight, "family": family, "file": relative,
                "sha256": sha256(path), "bytes": path.stat().st_size}


def open_source(path):
    font = TTFont(path, lazy=False, recalcTimestamp=False)
    repairs = []
    try:
        font["OS/2"]
    except Exception:
        raw = font.reader["OS/2"]
        # Two original fonts declare OS/2 v5 but contain exactly a v4 table.
        # Preserve original bytes in the archive; repair only the runtime copy.
        if len(raw) != 96 or int.from_bytes(raw[:2], "big") != 5:
            raise
        table = newTable("OS/2")
        table.decompile(b"\x00\x04" + raw[2:], font)
        font["OS/2"] = table
        repairs.append("Corrected OS/2 version 5 to version 4 for its 96-byte table; original file unchanged")
    return font, repairs


entries, provenance, prepared = [], [], {}
(DIRECTORY / "instances").mkdir(exist_ok=True)
for index, item in enumerate(source["fonts"]):
    original = DIRECTORY / item["file"]
    if sha256(original) != item["sha256"]:
        raise ValueError(f"Source hash mismatch: {item['familyName']}")
    if item["sha256"] not in prepared:
        font, repairs = open_source(original)
        with font:
            raw_weight = font["OS/2"].usWeightClass
            notes = {"copyright": name_value(font, 0), "license": name_value(font, 13),
                     "licenseUrl": name_value(font, 14), "embeddingFlags": font["OS/2"].fsType,
                     "runtimePreparation": repairs}
            axes = {axis.axisTag: axis for axis in font["fvar"].axes} if "fvar" in font else {}
            variants = []
            if axes:
                weight_axis = axes.get("wght")
                weights = [value for value in range(100, 901, 100)
                           if weight_axis and weight_axis.minValue <= value <= weight_axis.maxValue]
                if not weights:
                    weights = [raw_weight]
                for weight in weights:
                    coordinates = {tag: axis.defaultValue for tag, axis in axes.items()}
                    if weight_axis:
                        coordinates["wght"] = weight
                    instance = instantiateVariableFont(font, coordinates, inplace=False,
                                                       updateFontNames=False, static=True, downgradeCFF2="CFF2" in font)
                    extension = ".otf" if instance.sfntVersion == "OTTO" else ".ttf"
                    temporary = DIRECTORY / "instances" / f"{item['sha256']}-{weight}{extension}"
                    instance.save(temporary)
                    identifier = sha256(temporary)
                    target = temporary.with_name(identifier + extension)
                    if target.exists():
                        temporary.unlink()
                    else:
                        temporary.replace(target)
                    variants.append(inspect_file(target, target.relative_to(DIRECTORY).as_posix()))
                    instance.close()
            elif repairs:
                temporary = DIRECTORY / "instances" / f"{item['sha256']}-repaired.ttf"
                font.save(temporary)
                target = temporary.with_name(sha256(temporary) + ".ttf")
                if target.exists():
                    temporary.unlink()
                else:
                    temporary.replace(target)
                variants.append(inspect_file(target, target.relative_to(DIRECTORY).as_posix()))
            else:
                variants.append(inspect_file(original, item["file"]))
            variants.sort(key=lambda variant: variant["weight"])
            default = min(variants, key=lambda variant: abs(variant["weight"] - raw_weight))["weight"]
            prepared[item["sha256"]] = (variants, default, notes)
    variants, default, notes = prepared[item["sha256"]]
    entries.append({"id": item["id"], "family": item["familyName"], "group": item["group"],
                    "chinese": bool(set(item.get("scripts", [])) & {"hans", "hant"}),
                    "defaultWeight": default, "variants": variants})
    provenance.append({**item, **notes})
    if (index + 1) % 16 == 0 or index + 1 == 136:
        print(f"Prepared {index+1}/136", flush=True)

manifest = {"version": 1, "source": source["source"], "sourceSha256": source["sourceSha256"],
            "entries": entries}
(DIRECTORY / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(DIRECTORY / "PROVENANCE.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
readme = ("LibTV extension fonts: 136 catalog entries\n\n"
          "originals/ contains the byte-for-byte source files (content-addressed and deduplicated).\n"
          "source.json maps each original public catalog entry to its original URL.\n"
          "PROVENANCE.json retains source hashes, copyright, license metadata and embedding flags.\n"
          "manifest.json maps entries to static font files used by both preview and export.\n"
          "instances/ contains static instances only when a source font was variable.\n"
          "The ZIP includes one named original font file for each of the 136 catalog entries.\n")
(DIRECTORY / "README.txt").write_text(readme, encoding="utf-8")
args.archive.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(args.archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    archive_fonts = []
    for index, item in enumerate(source["fonts"]):
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", item["familyName"])
        extension = Path(item["file"]).suffix.lower()
        member = f"fonts/{index+1:03d}_{name}{extension}"
        archive.write(DIRECTORY / item["file"], member)
        archive_fonts.append({"id": item["id"], "family": item["familyName"], "file": member,
                              "sha256": item["sha256"], "bytes": item["bytes"], "source": item["assetUrl"]})
    archive.writestr("fonts-manifest.json", json.dumps({"version": 1, "fonts": archive_fonts}, ensure_ascii=False, indent=2))
    for name in ["source.json", "PROVENANCE.json"]:
        archive.write(DIRECTORY / name, name)
    archive.writestr("README.txt", "136 original extension-font entries from the public LibTV catalog.\n\n"
                     "fonts/ contains all 136 named original font files, including the two catalog entries sharing one source file.\n"
                     "fonts-manifest.json maps every ZIP member to its original URL, byte length and SHA-256.\n"
                     "source.json preserves the public catalog snapshot. PROVENANCE.json preserves embedded copyright and license metadata.\n"
                     "These are original files. Static instances and compatibility repairs for this desktop app are stored separately in the project resources.\n")
with zipfile.ZipFile(args.archive) as archive:
    if len(archive_fonts) != 136 or len(set(archive.namelist())) != len(archive.namelist()):
        raise ValueError("Incomplete or ambiguous font archive")
    for item in archive_fonts:
        digest = hashlib.sha256()
        with archive.open(item["file"]) as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        if digest.hexdigest() != item["sha256"]:
            raise ValueError(f"Archive hash mismatch: {item['id']}")
print(json.dumps({"entries": len(entries), "originalFiles": len(prepared),
                  "variableFonts": sum(len(value[0]) > 1 for value in prepared.values()),
                  "runtimeVariants": sum(len(entry["variants"]) for entry in entries),
                  "zip": str(args.archive), "zipBytes": args.archive.stat().st_size}, ensure_ascii=False), flush=True)
