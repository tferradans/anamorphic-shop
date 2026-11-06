"""Extrude the Panasonic LA7200 attachment's Illustrator outline into an STL.

Usage: python make_la7200_stl.py <project folder>
The AI file holds two closed paths at real scale: the outer plate and the round opening.
The result is the plate with that hole through it, THICKNESS_MM thick, saved to
<project>/Generated, where products.src.json picks it up.
"""
import math
import os
import sys

import fitz
import numpy as np

from render_thumbs import write_binary_stl

SOURCE = "Google Drive/3D Prints and Parts/PanasonicLA7200_attachment.ai"
OUTPUT = "Generated/PanasonicLA7200_attachment.stl"
THICKNESS_MM = 6.0
PT_TO_MM = 25.4 / 72
CURVE_STEPS = 64
LINE_STEPS = 4


def flatten(items):
    """One closed path as an (n, 2) array in mm, without repeating the first point."""
    points = []
    for item in items:
        if item[0] == "l":
            a, b = item[1], item[2]
            for s in range(LINE_STEPS):
                t = s / LINE_STEPS
                points.append((a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t))
        elif item[0] == "c":
            p0, p1, p2, p3 = item[1:5]
            for s in range(CURVE_STEPS):
                t = s / CURVE_STEPS
                u = 1 - t
                points.append((
                    u**3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t**3 * p3.x,
                    u**3 * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t**3 * p3.y,
                ))
        else:
            raise ValueError(f"unexpected path item {item[0]}")
    loop = np.array(points) * PT_TO_MM
    loop[:, 1] *= -1  # PDF pages count y downward.
    return loop


def counter_clockwise(loop):
    x, y = loop[:, 0], loop[:, 1]
    area = np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y) / 2
    return loop if area > 0 else loop[::-1]


def cap(outer, inner, center):
    """Triangles between two loops, walking both by angle around the hole's center."""
    angle = lambda p: math.atan2(p[1] - center[1], p[0] - center[0])
    start_o = min(range(len(outer)), key=lambda i: abs(angle(outer[i])))
    start_i = min(range(len(inner)), key=lambda i: abs(angle(inner[i])))
    outer = np.roll(outer, -start_o, axis=0)
    inner = np.roll(inner, -start_i, axis=0)
    unwrapped = lambda loop: np.mod(np.arctan2(loop[:, 1] - center[1], loop[:, 0] - center[0]), 2 * np.pi)
    a_o, a_i = np.append(unwrapped(outer), 2 * np.pi), np.append(unwrapped(inner), 2 * np.pi)
    if a_o[0] > np.pi:
        a_o[0] -= 2 * np.pi
    if a_i[0] > np.pi:
        a_i[0] -= 2 * np.pi
    tris = []
    o = i = 0
    n_o, n_i = len(outer), len(inner)
    while o < n_o or i < n_i:
        advance_outer = i >= n_i or (o < n_o and a_o[o + 1] <= a_i[i + 1])
        if advance_outer:
            tris.append((outer[o % n_o], outer[(o + 1) % n_o], inner[i % n_i]))
            o += 1
        else:
            tris.append((inner[i % n_i], outer[o % n_o], inner[(i + 1) % n_i]))
            i += 1
    return tris


def wall(loop, z0, z1, outward):
    tris = []
    for a, b in zip(loop, np.roll(loop, -1, axis=0)):
        pa0, pb0, pa1, pb1 = [*a, z0], [*b, z0], [*a, z1], [*b, z1]
        if outward:
            tris += [(pa0, pb0, pb1), (pa0, pb1, pa1)]
        else:
            tris += [(pb0, pa0, pa1), (pb0, pa1, pb1)]
    return tris


def main(project):
    with fitz.open(os.path.join(project, SOURCE)) as doc:
        drawings = doc[0].get_drawings()
    if len(drawings) != 2:
        raise ValueError(f"expected 2 paths, found {len(drawings)}")
    # The hole is the path made only of curves, and it's the smaller one.
    drawings.sort(key=lambda d: d["rect"].width)
    hole = counter_clockwise(flatten(drawings[0]["items"]))
    plate = counter_clockwise(flatten(drawings[1]["items"]))
    center = (hole.max(0) + hole.min(0)) / 2

    tris = []
    for a, b, c in cap(plate, hole, center):
        tris.append(([*a, THICKNESS_MM], [*b, THICKNESS_MM], [*c, THICKNESS_MM]))  # Top faces up.
        tris.append(([*a, 0.0], [*c, 0.0], [*b, 0.0]))  # Bottom faces down.
    tris += wall(plate, 0.0, THICKNESS_MM, outward=True)
    tris += wall(hole, 0.0, THICKNESS_MM, outward=False)
    triangles = np.array(tris, dtype=float)

    out = os.path.join(project, OUTPUT)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write_binary_stl(triangles, out)
    report(triangles, plate, hole)
    print("wrote", out, os.path.getsize(out), "bytes")


def report(triangles, plate, hole):
    """Prove the solid is printable: closed, correctly facing, and the right volume."""
    edges = {}
    for tri in np.round(triangles, 5):
        points = [tuple(p) for p in tri]
        for a, b in zip(points, points[1:] + points[:1]):
            edges[(a, b)] = edges.get((a, b), 0) + 1
    unmatched = sum(1 for (a, b), n in edges.items() if edges.get((b, a), 0) != n)
    volume = np.einsum("ij,ij->i", triangles[:, 0], np.cross(triangles[:, 1], triangles[:, 2])).sum() / 6
    shoelace = lambda loop: abs(np.sum(loop[:, 0] * np.roll(loop[:, 1], -1) - np.roll(loop[:, 0], -1) * loop[:, 1])) / 2
    expected = (shoelace(plate) - shoelace(hole)) * THICKNESS_MM
    size = triangles.reshape(-1, 3).max(0) - triangles.reshape(-1, 3).min(0)
    print("triangles:", len(triangles))
    print("size mm:", np.round(size, 2), "| hole diameter mm:", np.round(hole.max(0) - hole.min(0), 2))
    print("unmatched edges (0 = watertight):", unmatched)
    print(f"volume mm3: {volume:.0f}, expected {expected:.0f} (positive = faces point outward)")


if __name__ == "__main__":
    main(sys.argv[1])
