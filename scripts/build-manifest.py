"""Build files/, images, 3D models and products.json from products.src.json.

Usage: python build-manifest.py <project folder>
The project folder holds 'Google Drive', 'Book PDFs fixed' and 'youtube'. Hand-edit
products.src.json only. Sizes, formats, contents, images and video links are filled in
here. A product's name defaults to its cleaned-up filename; set "name" to override it.
Video links come from what each description links to, and only public videos are
written, because this repo is public. The exception is an unlisted video chosen by hand
in a product's "videos".
"""
import csv
import json
import os
import re
import shutil
import sys
import zipfile

import fitz

from render_thumbs import build_visuals, is_junk

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COVER_WIDTH = 900
BONUS_RELEASE = "https://github.com/tferradans/anamorphic-shop/releases/download/bonus-v1/"
SCANNED_FOLDERS = ["3D Prints and Parts", "3D Prints and Parts/Aperture Discs", "Plugins and Presets"]


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def friendly_name(filename, keep_version=False):
    """'FrontClamp_Vistascope16-77mm.stl' becomes 'Front Clamp Vistascope 16-77mm'."""
    stem = os.path.splitext(os.path.basename(filename))[0]
    stem = re.sub(r"[_ ]STL$", "", stem, flags=re.I)
    if not keep_version:
        stem = re.sub(r"[_ ]v\d+(\.\d+)*(?=$|_)", "", stem, flags=re.I)
    stem = stem.replace("_", " ")
    stem = re.sub(r"(?<!\bMc)(?<=[a-z])(?=[A-Z])", " ", stem)
    stem = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", stem)
    stem = re.sub(r"(?<=[a-z])(?=\d)", " ", stem)
    stem = re.sub(r"(?<=\d)(?=[A-Z][a-z])", " ", stem)
    stem = re.sub(r"(?<![A-Za-z])f (?=\d)", "f/", stem)  # 'Leica 35mm f2.8' reads as f/2.8
    stem = re.sub(r"\s+", " ", stem).strip()
    return stem[:1].upper() + stem[1:]


def item_name(item):
    if item.get("name"):
        return item["name"]
    source = item["source"]
    return friendly_name(source[0] if isinstance(source, list) else source)


def zip_paths(out, paths, drive):
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for rel in paths:
            full = os.path.join(drive, rel)
            if os.path.isdir(full):
                for folder, _, names in os.walk(full):
                    for name in names:
                        path = os.path.join(folder, name)
                        if not is_junk(path):
                            archive.write(path, os.path.relpath(path, full))
            else:
                archive.write(full, os.path.basename(full))


def describe_zip(path):
    with zipfile.ZipFile(path) as archive:
        names = [n for n in archive.namelist() if not n.endswith("/") and not is_junk(n)]
    kinds = sorted({os.path.splitext(n)[1].lstrip(".").upper() for n in names if os.path.splitext(n)[1]})
    count = f"{len(names)} file" + ("" if len(names) == 1 else "s")
    return f"{count}: {', '.join(kinds[:3])}" if kinds else count


def build_file(item, drive, out_dir):
    """Place one item's download in files/ and return (path, downloadName)."""
    source = item["source"]
    if isinstance(source, list) or os.path.isdir(os.path.join(drive, source)):
        paths = source if isinstance(source, list) else [source]
        out = os.path.join(out_dir, item["id"] + ".zip")
        zip_paths(out, paths, drive)
        return out, item.get("downloadName", item["id"] + ".zip")
    extension = os.path.splitext(source)[1].lower()
    out = os.path.join(out_dir, item["id"] + extension)
    shutil.copyfile(os.path.join(drive, source), out)
    return out, item.get("downloadName", os.path.basename(source))


def make_cover(pdf, out):
    """Placeholder cover from the PDF's first page, until the real mockups arrive."""
    with fitz.open(pdf) as doc:
        page = doc[0]
        scale = COVER_WIDTH / page.rect.width
        page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(out, jpg_quality=85)


def video_maps(youtube):
    with open(os.path.join(youtube, "descriptions.json"), encoding="utf-8") as fh:
        videos = {v["videoId"]: v for v in json.load(fh)["videos"]}
    public = {i for i, v in videos.items() if v.get("privacy") == "VIDEO_PRIVACY_PUBLIC"}

    by_drive = {}
    for row in read_csv(os.path.join(youtube, "link-scan.csv")):
        if row["driveId"] and row["videoId"] in public:
            by_drive.setdefault(row["driveId"], []).append(row["videoId"])
    for row in read_csv(os.path.join(youtube, "short-links.csv")):
        if row["driveId"]:
            for video in row["videoIds"].split():
                if video in public:
                    by_drive.setdefault(row["driveId"], []).append(video)

    by_book = {"on-a-budget": [], "anamorfake-it": []}
    for row in read_csv(os.path.join(youtube, "link-actions.csv")):
        if row["videoId"] in public:
            if "?book=on-a-budget" in row["newUrl"]:
                by_book["on-a-budget"].append(row["videoId"])
            elif "?book=anamorfake-it" in row["newUrl"]:
                by_book["anamorfake-it"].append(row["videoId"])
    return videos, by_drive, by_book


def unique(values):
    return list(dict.fromkeys(values))


def rel(path):
    return os.path.relpath(path, REPO).replace(os.sep, "/")


def remove_stale(items, files_dir, thumbs_dir, models_dir):
    """Generated output of products that no longer exist shouldn't get published."""
    keep = {os.path.normpath(os.path.join(REPO, i["file"])) for i in items}
    keep.update(os.path.normpath(os.path.join(REPO, i["thumb"])) for i in items if i["thumb"])
    for folder in (files_dir, thumbs_dir):
        for name in os.listdir(folder):
            path = os.path.normpath(os.path.join(folder, name))
            if os.path.isfile(path) and path not in keep:
                print("removed stale", rel(path))
                os.remove(path)
    ids = {i["id"] for i in items}
    for name in os.listdir(models_dir):
        if name not in ids:
            print("removed stale", f"models/{name}")
            shutil.rmtree(os.path.join(models_dir, name))


def main(project):
    drive = os.path.join(project, "Google Drive")
    with open(os.path.join(REPO, "products.src.json"), encoding="utf-8") as fh:
        src = json.load(fh)
    videos, by_drive, by_book = video_maps(os.path.join(project, "youtube"))
    public = {i for i, v in videos.items() if v.get("privacy") == "VIDEO_PRIVACY_PUBLIC"}
    held_back = []

    files_dir = os.path.join(REPO, "files")
    books_dir = os.path.join(files_dir, "books")
    covers_dir = os.path.join(REPO, "img", "books")
    thumbs_dir = os.path.join(REPO, "img", "items")
    models_dir = os.path.join(REPO, "models")
    for folder in (files_dir, books_dir, covers_dir, thumbs_dir, models_dir):
        os.makedirs(folder, exist_ok=True)

    used, referenced, items, books = set(), set(), [], []
    for item in src["items"]:
        path, download = build_file(item, drive, files_dir)
        source = item["source"]
        used.update(source if isinstance(source, list) else [source])
        # Drive files that are exact copies of what this product already contains.
        used.update(item.get("alsoCovers", []))
        fmt =os.path.splitext(path)[1].lstrip(".").upper()
        contents = item.get("contents") or (describe_zip(path) if fmt == "ZIP" else "1 file")
        # A product's chosen "videos" come first, so the card plays them. Links found in
        # descriptions follow, so those videos still open this product.
        # Unlisted is fine for a video chosen by hand: choosing it is the decision to show it.
        chosen = item.get("videos", [])
        viewable = {v for v in chosen if v in public or videos.get(v, {}).get("privacy") == "VIDEO_PRIVACY_UNLISTED"}
        held_back.extend((item["id"], v) for v in chosen if v not in viewable)
        linked = unique([v for v in chosen if v in viewable] + [v for d in item.get("driveIds", []) for v in by_drive.get(d, [])])
        referenced.update(linked)
        # A version can be all that tells two parts apart (J9_V1, J9_V2), so parts keep theirs.
        thumb, models = build_visuals(item, drive, thumbs_dir, models_dir, lambda name: friendly_name(name, keep_version=True))
        if item.get("thumbFile"):
            thumb = os.path.join(REPO, item["thumbFile"])
        items.append({
            "id": item["id"],
            "name": item_name(item),
            "category": item["category"],
            "art": item.get("art", "part"),
            "format": fmt,
            "size": os.path.getsize(path),
            "contents": contents,
            "description": item.get("description", ""),
            "file": rel(path),
            "downloadName": download,
            "thumb": rel(thumb) if thumb else None,
            "models": [{"name": m["name"], "file": rel(m["path"])} for m in models],
            "tags": item.get("tags", []),
            "videos": linked,
        })
        # Merged products keep their old ids, so links in videos and PDFs still open them,
        # leading with the old product's video and part.
        if item.get("aliases"):
            names = {m["name"] for m in models}
            for old_id, alias in item["aliases"].items():
                if alias["part"] not in names or alias["video"] not in linked:
                    raise SystemExit(f"{item['id']}: alias {old_id} names a part or video it doesn't have")
            items[-1]["aliases"] = item["aliases"]
        # Outside links shown on the card, like the adapter a part fits.
        if item.get("links"):
            items[-1]["links"] = item["links"]
        # Part names are searchable, so a lens inside a set finds the set.
        if len(models) > 1:
            items[-1]["parts"] = [m["name"] for m in models]

    for book in src["books"]:
        pdf_src = os.path.join(project, "Book PDFs fixed", book["pdfSource"])
        pdf = os.path.join(books_dir, book["id"] + ".pdf")
        shutil.copyfile(pdf_src, pdf)
        cover = os.path.join(covers_dir, book["id"] + ".jpg")
        make_cover(pdf, cover)
        with fitz.open(pdf) as doc:
            pages = len(doc)
        # Too big for the repo, so these live on a GitHub Release. See scripts/split_bonus.py.
        bonus = [
            {"url": BONUS_RELEASE + name, "size": os.path.getsize(os.path.join(project, "Generated", "bonus", name))}
            for name in book.get("bonusFiles", [])
        ]
        linked = unique(by_book.get(book["id"], []))
        referenced.update(linked)
        books.append({
            "id": book["id"],
            "title": book["title"],
            "fullTitle": book.get("fullTitle", book["title"]),
            "color": book["color"],
            "cover": rel(cover),
            "pdf": rel(pdf),
            "downloadName": book["pdfSource"],
            "pdfSize": os.path.getsize(pdf),
            "pages": pages,
            "displayPages": book.get("displayPages", pages),
            "spreads": book.get("spreads", False),
            "tagline": book.get("tagline", ""),
            "description": book["description"],
            "bonus": bonus,
            "videos": linked,
        })

    manifest = {
        "categories": src["categories"],
        "books": books,
        "items": items,
        "videoTitles": {v: videos[v]["title"] for v in sorted(referenced)},
    }
    with open(os.path.join(REPO, "products.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
    remove_stale(items, files_dir, thumbs_dir, models_dir)
    used.update(src.get("excludedFiles", []))

    print(f"{len(items)} items, {len(books)} books, {len(referenced)} public videos linked")
    print("items with a video:", sum(1 for i in items if i["videos"]))
    print("chosen videos held back because they aren't public:", held_back)
    print("items with 3D:", sum(1 for i in items if i["models"]), "| with image:", sum(1 for i in items if i["thumb"]))
    print("items with line art only:", [i["id"] for i in items if not i["thumb"]])
    print("items with no description:", [i["id"] for i in items if not i["description"]])
    size_of = lambda folder: sum(os.path.getsize(os.path.join(d, n)) for d, _, names in os.walk(folder) for n in names)
    print("MB: files", round((size_of(files_dir) - size_of(books_dir)) / 1e6, 1), "| books", round(size_of(books_dir) / 1e6, 1), "| models", round(size_of(models_dir) / 1e6, 1), "| images", round(size_of(os.path.join(REPO, "img")) / 1e6, 1))
    orphans = []
    for folder in SCANNED_FOLDERS:
        for name in sorted(os.listdir(os.path.join(drive, folder))):
            path = f"{folder}/{name}"
            # A .rar counts as used when its extracted folder is the source.
            if os.path.isfile(os.path.join(drive, path)) and path not in used and os.path.splitext(path)[0] not in used:
                orphans.append(path)
    print("source files with no product:", orphans)
    print("\nNames (* = set by hand in products.src.json):")
    for raw, item in zip(src["items"], items):
        print(f"  {'*' if raw.get('name') else ' '} {item['name']}")


if __name__ == "__main__":
    main(sys.argv[1])
