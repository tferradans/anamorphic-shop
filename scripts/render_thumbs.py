"""Make each product's tile image, and compact 3D models for the viewer.

STLs are rendered with a small flat-shaded software renderer and rewritten as binary STL.
PDFs, Illustrator files, SVGs and images are rasterized. Products with none of those
(presets, LUTs) get no image, and the page falls back to line art.
"""
import io
import os
import re
import struct
import zipfile

import fitz
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageOps

SIZE = 480
SUPERSAMPLE = 3
APERTURE_DISC_SCALE = 0.72
AZIMUTH = np.radians(-35)
ELEVATION = np.radians(25)
BASE_COLOR = np.array([201, 205, 210], dtype=float)
LIGHT_A = np.array([-0.4, 0.5, 0.77])
LIGHT_B = np.array([0.7, -0.2, 0.3])
ASCII_VERTEX = re.compile(rb"vertex\s+(\S+)\s+(\S+)\s+(\S+)")
DOC_EXTENSIONS = [".pdf", ".ai", ".svg", ".png", ".jpg", ".jpeg", ".bmp", ".psd"]


def is_junk(path):
    """macOS leftovers inside older archives."""
    parts = path.replace("\\", "/").split("/")
    return "__MACOSX" in parts or parts[-1].startswith("._") or parts[-1] == ".DS_Store"


def read_source_files(source, drive):
    """Every file a product holds, as (name, bytes), looking inside zips and folders."""
    files = []
    for rel in source if isinstance(source, list) else [source]:
        full = os.path.join(drive, rel)
        if os.path.isdir(full):
            for folder, _, names in sorted(os.walk(full)):
                for name in sorted(names):
                    with open(os.path.join(folder, name), "rb") as fh:
                        files.append((name, fh.read()))
        elif rel.lower().endswith(".zip"):
            with zipfile.ZipFile(full) as archive:
                for name in sorted(archive.namelist()):
                    if not name.endswith("/"):
                        files.append((os.path.basename(name), archive.read(name)))
        else:
            with open(full, "rb") as fh:
                files.append((os.path.basename(rel), fh.read()))
    return [(n, d) for n, d in files if n and not is_junk(n)]


def parse_stl(data):
    """Triangles as an (n, 3, 3) float array, from binary or ASCII STL."""
    if len(data) > 84:
        count = struct.unpack("<I", data[80:84])[0]
        if 84 + count * 50 == len(data):
            record = np.dtype([("normal", "<3f4"), ("verts", "<9f4"), ("attr", "<u2")])
            return np.frombuffer(data, dtype=record, count=count, offset=84)["verts"].reshape(-1, 3, 3).astype(float)
    values = np.array(ASCII_VERTEX.findall(data), dtype=float)
    return values[: len(values) // 3 * 3].reshape(-1, 3, 3)


def turn(triangles, degrees):
    """Rotate for display only, e.g. {"x": 90} for a part exported Y-up. Applied in x, y, z order.

    The viewer keeps Z up and can't tip a model past overhead, so a part saved on its side
    or upside down has to be turned here. The download keeps the original orientation.
    """
    for axis in ("x", "y", "z"):
        if not degrees.get(axis):
            continue
        a = np.radians(degrees[axis])
        c, s = np.cos(a), np.sin(a)
        matrix = {"x": [[1, 0, 0], [0, c, -s], [0, s, c]], "y": [[c, 0, s], [0, 1, 0], [-s, 0, c]], "z": [[c, -s, 0], [s, c, 0], [0, 0, 1]]}[axis]
        triangles = triangles @ np.array(matrix).T
    return triangles


def write_binary_stl(triangles, path):
    tris = triangles.astype("<f4")
    edge1, edge2 = tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
    normals = np.cross(edge1, edge2)
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 0)
    record = np.dtype([("normal", "<3f4"), ("verts", "<9f4"), ("attr", "<u2")])
    out = np.zeros(len(tris), dtype=record)
    out["normal"] = normals
    out["verts"] = tris.reshape(-1, 9)
    with open(path, "wb") as fh:
        fh.write(b"\0" * 80 + struct.pack("<I", len(tris)) + out.tobytes())


def arrange_parts(parts):
    """Lay several parts out in a grid at their true relative sizes."""
    if len(parts) == 1:
        return parts[0]
    columns = int(np.ceil(np.sqrt(len(parts))))
    extents = np.array([p.reshape(-1, 3).max(0) - p.reshape(-1, 3).min(0) for p in parts])
    cell = extents[:, :2].max() * 1.15
    placed = []
    for i, part in enumerate(parts):
        points = part.reshape(-1, 3)
        center = (points.max(0) + points.min(0)) / 2
        offset = np.array([(i % columns) * cell, -(i // columns) * cell, 0]) - center
        placed.append(part + offset)
    return np.concatenate(placed)


def render_mesh(triangles, path):
    points = triangles.reshape(-1, 3)
    center = (points.max(0) + points.min(0)) / 2
    tris = triangles - center
    # Z is up in STL files. Spin around Z, then tip the camera down.
    ca, sa, ce, se = np.cos(AZIMUTH), np.sin(AZIMUTH), np.cos(ELEVATION), np.sin(ELEVATION)
    spin = np.array([[ca, -sa, 0], [sa, ca, 0], [0, 0, 1]])
    tip = np.array([[1, 0, 0], [0, se, ce], [0, -ce, se]])
    view = tris @ (tip @ spin).T

    normals = np.cross(view[:, 1] - view[:, 0], view[:, 2] - view[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 0)
    facing = normals[:, 2] > 0
    view, normals = view[facing], normals[facing]

    canvas = SIZE * SUPERSAMPLE
    span = (view[:, :, :2].max((0, 1)) - view[:, :, :2].min((0, 1))).max()
    scale = canvas * 0.86 / max(span, 1e-6)
    middle = (view[:, :, :2].max((0, 1)) + view[:, :, :2].min((0, 1))) / 2
    xy = (view[:, :, :2] - middle) * scale
    xy[:, :, 1] *= -1
    xy += canvas / 2

    shade = 0.26 + 0.62 * np.clip(normals @ (LIGHT_A / np.linalg.norm(LIGHT_A)), 0, 1) + 0.22 * np.clip(normals @ (LIGHT_B / np.linalg.norm(LIGHT_B)), 0, 1)
    colors = np.clip(BASE_COLOR * shade[:, None], 0, 255).astype(np.uint8)
    order = np.argsort(view[:, :, 2].mean(1))

    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for i in order:
        color = tuple(int(c) for c in colors[i]) + (255,)
        draw.polygon([tuple(p) for p in xy[i]], fill=color, outline=color)
    image.resize((SIZE, SIZE), Image.LANCZOS).save(path, optimize=True)


def autocrop(image):
    """Trim the blank page around artwork, so it fills the tile."""
    rgb = image.convert("RGB")
    bbox = ImageChops.difference(rgb, Image.new("RGB", rgb.size, rgb.getpixel((0, 0)))).getbbox()
    return image.crop(bbox) if bbox else image


def inline_svg_classes(data):
    """The renderer ignores <style> blocks, so move Illustrator's .stN rules onto their elements."""
    text = data.decode("utf-8", "replace")
    rules = dict(re.findall(r"\.(st\d+)\{([^}]*)\}", text))
    return re.sub(r'class="(st\d+)"', lambda m: f'style="{rules.get(m.group(1), "")}"', text).encode("utf-8")


def hex_color(value):
    return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))


def lens_cap_tile(image, background="#000000", ink_color=None, edge_color=None):
    """A round tile with light artwork on the background color, black unless a product sets one.

    Black ink with no background of its own is inverted. Art that is already a black disc
    keeps its look, with any cut-out text showing white. Light or colored art goes on the
    background as is. With ink_color, black becomes the background and white becomes the ink,
    and edge_color adds a vignette, fading the background to that color at the rim.
    """
    ground = hex_color(background)
    image = image.convert("RGBA")
    image.thumbnail((SIZE * 3, SIZE * 3), Image.LANCZOS)
    pixels = np.asarray(image, dtype=float)
    if pixels[..., 3].min() < 250:
        ink = pixels[..., 3] > 10
    else:
        ink = np.abs(pixels[..., :3] - pixels[0, 0, :3]).max(axis=2) > 16
    if not ink.any():
        raise ValueError("no artwork found")

    rows, columns = np.nonzero(ink)
    center_x = (columns.min() + columns.max() + 1) / 2
    center_y = (rows.min() + rows.max() + 1) / 2
    radius = np.hypot(columns - center_x, rows - center_y).max() + 1
    coverage = ink.sum() / (np.pi * radius ** 2)
    is_light = np.asarray(image.convert("L"), dtype=float)[ink].mean() > 90

    backdrop = ground + (255,) if is_light else (255, 255, 255, 255)
    flat = Image.new("RGBA", image.size, backdrop)
    flat.alpha_composite(image)
    flat = flat.convert("RGB")
    is_disc = not is_light and coverage > 0.5
    if not is_light and not is_disc:
        flat = ImageOps.invert(flat)
    if ink_color:
        amount = np.asarray(flat.convert("L"), dtype=float)[..., None] / 255
        paint = np.array(ground, dtype=float)
        if edge_color:
            y, x = np.indices(amount.shape[:2])
            falloff = np.clip(np.hypot(x - center_x, y - center_y) / radius, 0, 1)[..., None] ** 2
            paint = paint * (1 - falloff) + np.array(hex_color(edge_color)) * falloff
        mixed = paint * (1 - amount) + np.array(hex_color(ink_color)) * amount
        flat = Image.fromarray(mixed.round().astype(np.uint8))
    # A solid disc is trimmed just inside its edge. Everything else gets a little margin.
    radius *= 0.995 if is_disc else 1.05

    box = [round(v) for v in (center_x - radius, center_y - radius, center_x + radius, center_y + radius)]
    # Pasting rather than cropping, so a margin past the image's edge still gets the background.
    tile = Image.new("RGB", (box[2] - box[0], box[3] - box[1]), ground)
    tile.paste(flat, (-box[0], -box[1]))
    tile = tile.resize((SIZE, SIZE), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (SIZE * 4, SIZE * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, SIZE * 4 - 1, SIZE * 4 - 1), fill=255)
    tile.putalpha(mask.resize((SIZE, SIZE), Image.LANCZOS))
    return tile


def aperture_tile(data, color, path):
    """One disc from a cutting sheet, in the color, with its oval cut out. Uses the sheet's largest oval."""
    with fitz.open(stream=data, filetype="pdf") as doc:
        drawings = doc[0].get_drawings()
    # Discs and ovals are closed four-curve paths. Sheet labels are made of lines too, so they drop out.
    shapes = [d["rect"] for d in drawings if len(d["items"]) == 4 and all(i[0] == "c" for i in d["items"])]
    discs = [r for r in shapes if abs(r.width - r.height) < r.width * 0.01]
    ovals = [r for r in shapes if abs(r.width - r.height) >= r.width * 0.01]
    pairs = [(oval, disc) for oval in ovals for disc in discs if disc.contains(oval)]
    if not pairs:
        raise ValueError("no disc with an oval found")
    oval, disc = max(pairs, key=lambda pair: pair[0].width * pair[0].height)

    canvas = SIZE * 4
    margin = canvas * (1 - APERTURE_DISC_SCALE) / 2
    scale = canvas * APERTURE_DISC_SCALE / disc.width
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((margin, margin, canvas - margin, canvas - margin), fill=hex_color(color) + (255,))
    box = [margin + (oval.x0 - disc.x0) * scale, margin + (oval.y0 - disc.y0) * scale, margin + (oval.x1 - disc.x0) * scale, margin + (oval.y1 - disc.y0) * scale]
    draw.ellipse(box, fill=(0, 0, 0, 0))
    image.resize((SIZE, SIZE), Image.LANCZOS).save(path, optimize=True)


def render_document(name, data, path, cap_colors=None):
    extension = os.path.splitext(name)[1].lower()
    if extension == ".svg":
        data = inline_svg_classes(data)
    if extension in (".pdf", ".ai", ".svg"):
        with fitz.open(stream=data, filetype="svg" if extension == ".svg" else "pdf") as doc:
            page = doc[0]
            zoom = SIZE * 2 / max(page.rect.width, page.rect.height)
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=extension == ".svg")
            image = Image.open(io.BytesIO(pix.tobytes("png")))
        if extension != ".svg":
            image = autocrop(image)
    else:
        image = Image.open(io.BytesIO(data))
        image.load()
    image = image.convert("RGBA")
    if cap_colors is not None:
        image = lens_cap_tile(image, **cap_colors)
    else:
        image = on_paper_if_dark(image)
        image.thumbnail((SIZE, SIZE), Image.LANCZOS)
    image.save(path, optimize=True)


def on_paper_if_dark(image):
    """Dark artwork on a transparent background would vanish on the dark tile."""
    alpha = np.asarray(image.getchannel("A"), dtype=float) / 255
    if alpha.min() == 1 or alpha.sum() == 0:
        return image
    grey = np.asarray(image.convert("L"), dtype=float)
    if (grey * alpha).sum() / alpha.sum() > 90:
        return image
    paper = Image.new("RGBA", image.size, (242, 239, 232, 255))
    paper.alpha_composite(image)
    return paper


def build_visuals(item, drive, thumbs_dir, models_dir, part_name):
    """Returns (thumb path or None, [{name, path}]). Reuses earlier output unless the source changed."""
    files = read_source_files(item["source"], drive)
    stls = [(n, d) for n, d in files if n.lower().endswith(".stl")]
    thumb = os.path.join(thumbs_dir, item["id"] + ".png")
    models = []

    if stls:
        folder = os.path.join(models_dir, item["id"])
        os.makedirs(folder, exist_ok=True)
        meshes = []
        for index, (name, data) in enumerate(stls):
            triangles = turn(parse_stl(data), item.get("modelRotate", {}))
            meshes.append(triangles)
            path = os.path.join(folder, f"{index + 1}.stl")
            write_binary_stl(triangles, path)
            models.append({"name": part_name(name), "path": path})
        # A big set reads better as one part than as a crowd of small ones.
        chosen = [m for (name, _), m in zip(stls, meshes) if name == item.get("thumbSource")]
        render_mesh(chosen[0] if chosen else arrange_parts(meshes), thumb)
        return thumb, models

    if item.get("apertureColor"):
        # Illustrator files are PDF-compatible, so either works as the cutting sheet.
        sheets = [(name, data) for name, data in files if name.lower().endswith((".pdf", ".ai"))]
        sheet = next((data for name, data in sheets if name == item.get("thumbSource")), sheets[0][1])
        aperture_tile(sheet, item["apertureColor"], thumb)
        return thumb, models

    cap_colors = None
    if item.get("art") == "cap":
        cap_colors = {"background": item.get("capBackground", "#000000"), "ink_color": item.get("capInk"), "edge_color": item.get("capVignette")}
    # By default the first document wins, unless the product names the file to use.
    candidates = [(n, d) for n, d in files if n == item["thumbSource"]] if item.get("thumbSource") else files
    for extension in DOC_EXTENSIONS:
        for name, data in candidates:
            if name.lower().endswith(extension):
                try:
                    render_document(name, data, thumb, cap_colors)
                    return thumb, models
                except Exception as exc:  # Unreadable artwork just means line art on the tile.
                    print(f"  no image from {item['id']}/{name}: {exc}")
    if os.path.exists(thumb):
        os.remove(thumb)
    return None, models
