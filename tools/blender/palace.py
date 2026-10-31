"""
Procedural Pallava royal palace (a pillared hall under terracotta hip roofs, crowned by a tiered tower),
built headless with Blender's `bpy`. Companion to temple.py; both share kit.py.

Run:  python3 tools/blender/palace.py [output_dir]      (needs `pip install bpy`)

Units: 1 unit ~ 1 m. Front (entrance) is -Y in Blender, which the glTF exporter turns into +Z, the game's
entrance side. The palace footprint is square (6x6 cells), so the model is roughly square too.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402  (must precede kit's bmesh import)
from kit import at, box, extrude_profile, finish, frustum, lathe, make_roof_textures, make_textures, material, principled, xf  # noqa: E402
from temple import kuta, lion_pillar, nandi, niche, pilaster, sala, tier_ring  # noqa: E402

# Layout (metres)
PLINTH_HALF = 6.1
HALL_CX, HALL_CY = 0.0, 0.9
HALL_HX, HALL_HY = 3.9, 3.3        # half extents of the hall walls
HALL_H = 4.2                       # wall height above the plinth
VER_CY = 0.7                       # verandah centre; colonnade runs 4.6 m each side, front row at y = -3.5
VER_X = 4.6
PILLAR_H = 2.9


def plain_pillar(cx, cy, z0, z1):
    box(cx, cy, z0, 0.62, 0.62, 0.2)
    lathe([(0.19, 0), (0.19, 0.12), (0.16, 0.28), (0.16, z1 - z0 - 0.2 - 0.5), (0.19, z1 - z0 - 0.2 - 0.42), (0.26, z1 - z0 - 0.2 - 0.3), (0.29, z1 - z0 - 0.2 - 0.2)], cx, cy, z0 + 0.2, 8)
    box(cx, cy, z1 - 0.22, 0.66, 0.66, 0.1)
    frustum(cx, cy, z1 - 0.12, 0.5, 0.5, 0.8, 0.5, 0.12)


def banner(cx, cy, z0, height, flip=1):
    """Tall pole with a gold ball and a swallow-tailed blue pennant."""
    with material("dark"):
        lathe([(0.1, 0), (0.1, 0.25), (0.06, 0.4), (0.06, height)], cx, cy, z0, 6)
    with material("gold"):
        lathe([(0.0, 0.0), (0.1, 0.05), (0.12, 0.16), (0.0, 0.3)], cx, cy, z0 + height, 6)
    with material("cloth"):
        with xf(at(cx, cy, 0, 0)):
            extrude_profile([(0, -0.9), (1.5 * flip, -0.9), (1.05 * flip, -0.45), (1.5 * flip, 0.0), (0, 0.0)][::flip], 0, 0, z0 + height - 0.2, 0.05)


def build() -> float:
    # ---- Moulded plinth ----
    box(0, 0, 0, 12.2, 12.2, 0.5, bottom=True)
    box(0, 0, 0.5, 11.4, 11.4, 0.4)
    frustum(0, 0, 0.9, 11.4, 11.4, 10.8, 10.8, 0.18)
    box(0, 0, 1.08, 10.8, 10.8, 0.32)
    box(0, 0, 1.4, 11.0, 11.0, 0.12)
    frustum(0, 0, 1.52, 11.0, 11.0, 10.5, 10.5, 0.1)
    zc = 1.62
    n = 17
    for i in range(n):
        t = -4.8 + 9.6 * (i + 0.5) / n
        for rz in (0, 90, 180, 270):
            with xf(at(0, 0, 0, rz)):
                box(t, -5.52, 1.12, 0.3, 0.12, 0.22)
                box(t, -5.55, 1.34, 0.18, 0.1, 0.06)

    # ---- Front stairs with balustrades ----
    steps, d = 5, 0.4
    rise = zc / steps
    for i in range(steps):
        box(0, -5.4 - (steps - i) * d + d / 2, 0.0, 3.6, d + 0.02, rise * (i + 1))
    for sx in (-1, 1):
        extrude_profile([(-0.22, 0), (0.22, 0), (0.22, zc + 0.4), (-0.22, zc + 0.3)], sx * 2.1, -5.4 - steps * d / 2 + 0.2, 0, steps * d + 0.2)
        box(sx * 2.1, -5.4 - steps * d - 0.1, 0, 0.55, 0.35, zc * 0.35)

    # ---- Hall (sanctum of the court) ----
    box(HALL_CX, HALL_CY, zc, HALL_HX * 2 + 0.3, HALL_HY * 2 + 0.3, 0.2)  # moulded base
    box(HALL_CX, HALL_CY, zc, HALL_HX * 2, HALL_HY * 2, HALL_H)
    faces = ((0, HALL_HY, HALL_HX), (90, HALL_HX, HALL_HY), (180, HALL_HY, HALL_HX), (270, HALL_HX, HALL_HY))  # rz, offset, half span
    for rz, off, span in faces:
        with xf(at(HALL_CX, HALL_CY, 0, rz)):
            for px in (-span + 0.35, span - 0.35):
                pilaster(px, -off - 0.05, zc, HALL_H, 0.45, 0.16)
            if rz == 0:
                for px in (-1.25, 1.25):
                    pilaster(px, -off - 0.05, zc, HALL_H * 0.8, 0.28, 0.12)
                for px in (-2.5, 2.5):
                    niche(px, -off - 0.04, zc + 1.0, 0.8, 1.5)
            else:
                for px in ((-2.0, 0.0, 2.0) if span > 3.5 else (-1.6, 1.6)):
                    niche(px, -off - 0.04, zc + 1.0, 0.8, 1.5)
    # Great doorway on the front face
    with xf(at(HALL_CX, HALL_CY, 0, 0)):
        with material("dark"):
            box(0, -HALL_HY - 0.02, zc, 1.4, 0.06, 2.7)
        box(-0.85, -HALL_HY - 0.1, zc, 0.24, 0.24, 2.9)
        box(0.85, -HALL_HY - 0.1, zc, 0.24, 0.24, 2.9)
        box(0, -HALL_HY - 0.1, zc + 2.9, 2.3, 0.26, 0.24)
        extrude_profile([(-1.3, 0), (1.3, 0), (0.0, 0.7)], 0, -HALL_HY - 0.1, zc + 3.14, 0.22)

    # ---- Colonnade (verandah) with lion pillars at the centre of the front ----
    front_y = -3.5
    xs = [-VER_X + 2 * VER_X * i / 7 for i in range(8)]
    for i, px in enumerate(xs):
        (lion_pillar if 2 <= i <= 5 else plain_pillar)(px, front_y, zc, zc + PILLAR_H)
    for sx in (-1, 1):
        for j in range(5):
            plain_pillar(sx * VER_X, -2.0 + 1.55 * j, zc, zc + PILLAR_H)
    zb = zc + PILLAR_H
    box(0, front_y, zb, VER_X * 2 + 0.7, 0.4, 0.3)                     # front beam
    for sx in (-1, 1):
        box(sx * VER_X, VER_CY + 0.7, zb, 0.4, 8.0, 0.3)               # side beams

    # ---- Roofs: verandah lean-to and the hall's hip, both in terracotta ----
    with material("tile"):
        frustum(0, VER_CY, zb + 0.3, 10.8, 8.9, HALL_HX * 2 + 0.05, HALL_HY * 2 + 0.05, zc + HALL_H - (zb + 0.3), top=False)
        frustum(HALL_CX, HALL_CY, zc + HALL_H, HALL_HX * 2 + 0.7, HALL_HY * 2 + 0.7, 5.0, 0.45, 2.1)
    # Gold ridge finials and a corner kuta on each verandah corner, salas mid-edge
    zr = zc + HALL_H + 2.1
    with material("gold"):
        for sx in (-1, 1):
            lathe([(0.0, 0.0), (0.2, 0.05), (0.26, 0.24), (0.1, 0.5), (0.0, 0.7)], sx * 2.5, HALL_CY, zr, 8)
    for sx in (-1, 1):
        for sy_y in (-3.6 + 0.4, 5.0 - 0.4):
            kuta(sx * 4.75, sy_y + 0.0, zb + 0.5, 1.2)
    sala(0, -3.85, zb + 0.5, 1.4, 0)
    sala(0, 5.2, zb + 0.5, 1.4, 180)
    sala(-4.95, VER_CY, zb + 0.5, 1.4, -90)
    sala(4.95, VER_CY, zb + 0.5, 1.4, 90)

    # ---- Central tower: base block, three tiers, shikhara and kalasa ----
    with xf(at(HALL_CX, HALL_CY, 0, 0)):
        z = zc + HALL_H
        box(0, 0, z, 3.6, 3.6, 2.9)
        z += 2.9
        hk = 2.15
        for k in range(3):
            s = 0.9 ** k * 1.0
            z = tier_ring(hk, z, s, intermediates=k < 1)
            wall_half = hk - 0.64 * s
            wh = 1.15 * 0.93 ** k
            box(0, 0, z, wall_half * 2, wall_half * 2, wh)
            for rz in (0, 90, 180, 270):
                with xf(at(0, 0, 0, rz)):
                    for px in (-wall_half * 0.62, wall_half * 0.62):
                        pilaster(px, -wall_half - 0.02, z, wh, 0.2 * s, 0.07)
                    niche(0, -wall_half - 0.02, z + 0.12, 0.5 * s, wh - 0.34)
            z += wh
            hk = wall_half + 0.12
        box(0, 0, z, hk * 1.4, hk * 1.4, 0.45)
        lathe([(hk * 0.62, 0.0), (hk * 0.7, 0.12), (hk * 0.66, 0.36), (hk * 0.5, 0.58), (hk * 0.3, 0.74), (0.0, 0.82)], 0, 0, z + 0.45, 8)
        zt = z + 0.45 + 0.8
        with material("gold"):
            lathe([(0.0, 0.0), (0.22, 0.02), (0.26, 0.1), (0.14, 0.18), (0.12, 0.26), (0.22, 0.42), (0.26, 0.56), (0.14, 0.68), (0.06, 0.8), (0.07, 1.0), (0.0, 1.3)], 0, 0, zt, 10)

    # ---- Nandi guardians on the plinth corners, banner poles flanking the stairs ----
    for rz, (sx, sy) in zip((45, 135, 225, 315), ((1, -1), (-1, -1), (-1, 1), (1, 1))):
        nandi(sx * 5.0, sy * 5.0, zc, rz + 180)
    banner(-3.1, -4.9, zc, 5.6, 1)
    banner(3.1, -4.9, zc, 5.6, -1)
    return zt + 1.3


def main() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    albedo, normal = make_textures()
    roof_albedo, roof_normal = make_roof_textures()
    total_h = build()
    mats = {
        "stone": principled("PalaceStone", (0.66, 0.58, 0.46), 0.88, 0.0, albedo, normal),
        "tile": principled("TerracottaTile", (0.6, 0.26, 0.15), 0.78, 0.0, roof_albedo, roof_normal),
        "gold": principled("PalaceGold", (0.95, 0.66, 0.16), 0.38, 0.45),
        "dark": principled("DoorwayAndWood", (0.06, 0.04, 0.03), 1.0, 0.0),
        "cloth": principled("RoyalBlue", (0.08, 0.17, 0.48), 0.92, 0.0),
    }
    finish("palace", mats, total_h)


if __name__ == "__main__":
    main()
