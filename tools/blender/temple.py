"""
Procedural Pallava-style temple (Shore Temple / Dravida vimana inspired), built headless with Blender's `bpy`.

Run:  python3 tools/blender/temple.py [output_dir]      (needs `pip install bpy`)

Why procedural: the model is reproducible, reviewable in a diff, has no third-party licence, and every
dimension is a named constant. Detail comes from geometry (moulded plinth, tiered shrines, lion pillars,
Nandi bulls, yali frieze) plus a tileable stone albedo and a matching normal map, so the mesh stays well
under the game's triangle budget. Units: 1 unit ~ 1 m. Front (entrance) is -Y in Blender, which the glTF
exporter turns into +Z, the game's entrance side.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402  (must precede kit's bmesh import)
from kit import at, box, extrude_profile, finish, frustum, lathe, make_textures, material, principled, xf  # noqa: E402

# --------------------------------------------------------------------------------------------------
# Architectural pieces
# --------------------------------------------------------------------------------------------------
def kuta(cx, cy, z0, s):
    """Square miniature shrine with a two-stage roof and a gold finial (the repeating Dravida motif)."""
    w = 0.5 * s
    box(cx, cy, z0, w, w, 0.34 * s)
    # corner pilasters make it read as a shrine rather than a cube
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(cx + sx * w * 0.5, cy + sy * w * 0.5, z0, 0.07 * s, 0.07 * s, 0.34 * s)
    frustum(cx, cy, z0 + 0.34 * s, w * 1.12, w * 1.12, w * 0.8, w * 0.8, 0.07 * s)
    frustum(cx, cy, z0 + 0.41 * s, w * 0.8, w * 0.8, w * 0.52, w * 0.52, 0.15 * s)
    frustum(cx, cy, z0 + 0.56 * s, w * 0.52, w * 0.52, w * 0.16, w * 0.16, 0.14 * s)
    with material("gold"):
        lathe([(0.0, 0.0), (0.05 * s, 0.03 * s), (0.04 * s, 0.1 * s), (0.0, 0.16 * s)], cx, cy, z0 + 0.7 * s, 6)


def sala(cx, cy, z0, s, rz=0.0):
    """Barrel-vaulted shrine (sala) with a stepped gable end, ridge along the local Y axis."""
    w, ln = 0.46 * s, 0.7 * s
    with xf(at(cx, cy, 0, rz)):
        box(0, 0, z0, w, ln, 0.26 * s)
        prof = [(-w / 2 * 1.1, 0), (w / 2 * 1.1, 0), (w / 2 * 0.9, 0.16 * s), (w * 0.3, 0.3 * s), (0, 0.36 * s), (-w * 0.3, 0.3 * s), (-w / 2 * 0.9, 0.16 * s)]
        extrude_profile(prof, 0, 0, z0 + 0.26 * s, ln * 1.1)
        # arched niche on the front gable end
        with material("dark"):
            box(0, -ln / 2 - 0.005, z0 + 0.04 * s, 0.17 * s, 0.02 * s, 0.17 * s)
        with material("gold"):
            lathe([(0.0, 0.0), (0.04 * s, 0.02 * s), (0.0, 0.09 * s)], 0, ln * 0.52, z0 + 0.26 * s + 0.35 * s, 6)
            lathe([(0.0, 0.0), (0.04 * s, 0.02 * s), (0.0, 0.09 * s)], 0, -ln * 0.52, z0 + 0.26 * s + 0.35 * s, 6)


def pilaster(cx, cy, z0, h, w, depth, rz=0.0):
    """Wall pilaster with a base, a shaft and a bracketed capital; built on the front (-Y) face, then rotated."""
    with xf(at(cx, cy, 0, rz)):
        box(0, 0, z0, w * 1.25, depth * 1.3, 0.12)
        box(0, 0, z0 + 0.12, w, depth, h - 0.34)
        frustum(0, 0, z0 + h - 0.22, w, depth, w * 1.35, depth * 1.4, 0.1)
        box(0, 0, z0 + h - 0.12, w * 1.6, depth * 1.6, 0.12)


def niche(cx, cy, z0, w, h, rz=0.0):
    """Framed devakoshta niche with a dark recess and a small gabled crown."""
    with xf(at(cx, cy, 0, rz)):
        t = 0.09
        box(-w / 2 + t / 2, 0, z0, t, 0.13, h)
        box(w / 2 - t / 2, 0, z0, t, 0.13, h)
        box(0, 0, z0 + h, w + 0.12, 0.15, 0.1)
        with material("dark"):
            box(0, 0.035, z0 + 0.04, w - 2 * t, 0.04, h - 0.04)
        extrude_profile([(-w / 2 - 0.1, 0), (w / 2 + 0.1, 0), (0, 0.32)], 0, 0.0, z0 + h + 0.1, 0.18)


def tier_ring(hk, z0, s, intermediates):
    """One vimana tier: sloped cornice (kapota) and a ring of miniature shrines on its upper surface."""
    box(0, 0, z0, hk * 2, hk * 2, 0.1)
    frustum(0, 0, z0 + 0.1, hk * 2, hk * 2, (hk - 0.34 * s) * 2, (hk - 0.34 * s) * 2, 0.2 * s)
    top = z0 + 0.1 + 0.2 * s
    m = hk - 0.3 * s
    for sx in (-1, 1):
        for sy in (-1, 1):
            kuta(sx * m, sy * m, top, s)
    sala(0, -m, top, s, 0)
    sala(0, m, top, s, 180)
    sala(-m, 0, top, s, -90)
    sala(m, 0, top, s, 90)
    if intermediates:
        for t in (-0.5, 0.5):
            for edge in range(4):
                a = t * m
                if edge == 0:
                    kuta(a, -m, top, s * 0.8)
                elif edge == 1:
                    kuta(a, m, top, s * 0.8)
                elif edge == 2:
                    kuta(-m, a, top, s * 0.8)
                else:
                    kuta(m, a, top, s * 0.8)
    return top


def lion_pillar(cx, cy, z0, z1):
    """Pallava signature: a column standing on a seated lion (yali) with a bracketed capital."""
    box(cx, cy, z0, 0.62, 0.9, 0.14)
    with xf(at(cx, cy, 0, 0)):
        box(0, 0.05, z0 + 0.14, 0.38, 0.62, 0.34)                     # haunches and body
        box(0, -0.2, z0 + 0.14, 0.34, 0.26, 0.5)                      # raised chest
        box(0, -0.34, z0 + 0.5, 0.34, 0.3, 0.3)                       # head
        frustum(0, -0.24, z0 + 0.6, 0.5, 0.3, 0.4, 0.3, 0.22)          # mane
        box(-0.12, -0.38, z0 + 0.14, 0.09, 0.14, 0.2)                 # forepaws
        box(0.12, -0.38, z0 + 0.14, 0.09, 0.14, 0.2)
    zb = z0 + 0.82
    lathe([(0.2, 0), (0.2, 0.15), (0.17, 0.3), (0.17, z1 - zb - 0.5), (0.2, z1 - zb - 0.42), (0.27, z1 - zb - 0.3), (0.3, z1 - zb - 0.2)], cx, cy, zb, 8)
    box(cx, cy, z1 - 0.22, 0.7, 0.7, 0.1)
    frustum(cx, cy, z1 - 0.12, 0.5, 0.5, 0.86, 0.5, 0.12)


def nandi(cx, cy, z0, rz):
    """Seated bull (Nandi), ~140 triangles, set on the plinth corners the way the Shore Temple's wall carries them."""
    with xf(at(cx, cy, 0, rz)):
        box(0, 0, z0, 0.7, 1.0, 0.08)                                  # plinth slab
        box(0, 0.05, z0 + 0.08, 0.46, 0.7, 0.34)                       # body
        frustum(0, -0.18, z0 + 0.42, 0.4, 0.3, 0.24, 0.22, 0.14)        # hump
        box(0, -0.38, z0 + 0.2, 0.26, 0.28, 0.34)                      # neck/head
        box(0, -0.52, z0 + 0.22, 0.2, 0.14, 0.18)                      # muzzle
        box(-0.16, -0.34, z0 + 0.5, 0.05, 0.05, 0.1)                   # horns
        box(0.16, -0.34, z0 + 0.5, 0.05, 0.05, 0.1)
        box(-0.16, -0.38, z0 + 0.46, 0.06, 0.06, 0.06)
        box(0.16, -0.38, z0 + 0.46, 0.06, 0.06, 0.06)
        for lx in (-0.14, 0.14):
            box(lx, -0.34, z0 + 0.08, 0.09, 0.12, 0.14)                # forelegs
            box(lx, 0.32, z0 + 0.08, 0.1, 0.12, 0.2)                   # haunches


# --------------------------------------------------------------------------------------------------
# Assemble
# --------------------------------------------------------------------------------------------------
def build() -> float:
    # ---- Plinth (upapitha / jagati / kumuda mouldings) ----
    box(0, 0, 0, 10.0, 10.0, 0.5, bottom=True)
    box(0, 0, 0.5, 9.3, 9.3, 0.38)
    frustum(0, 0, 0.88, 9.3, 9.3, 8.7, 8.7, 0.18)      # chamfer
    box(0, 0, 1.06, 8.7, 8.7, 0.34)                    # frieze band (carried by the yali blocks below)
    box(0, 0, 1.4, 9.0, 9.0, 0.14)                     # projecting cornice
    frustum(0, 0, 1.54, 9.0, 9.0, 8.5, 8.5, 0.1)
    plinth_top = 1.64
    # Yali / gana frieze: small relief blocks marching round the band
    n = 15
    for i in range(n):
        t = -4.0 + 8.0 * (i + 0.5) / n
        for rz in (0, 90, 180, 270):
            with xf(at(0, 0, 0, rz)):
                box(t, -4.42, 1.12, 0.3, 0.12, 0.22)
                box(t, -4.45, 1.34, 0.18, 0.1, 0.06)

    # ---- Front stairs with flanking balustrades ----
    steps = 5
    rise = (plinth_top - 0.0) / steps
    for i in range(steps):
        d = 0.38
        y_front = -4.6 - (steps - i) * d
        box(0, y_front + d / 2 + 0.0, 0.0, 2.6, d + 0.02, rise * (i + 1) if i else rise, bottom=False)
    for sx in (-1, 1):
        extrude_profile([(-0.2, 0), (0.2, 0), (0.2, plinth_top + 0.35), (-0.2, plinth_top + 0.35 - 0.1)], sx * 1.5, -4.6 - steps * 0.38 / 2 + 0.2, 0, steps * 0.38 + 0.2)
        box(sx * 1.5, -4.6 - steps * 0.38 - 0.1, 0, 0.5, 0.35, plinth_top * 0.35)

    # ---- Mandapa (columned porch) ----
    zc = plinth_top
    z_ceiling = zc + 2.2
    for px in (-2.1, -0.7, 0.7, 2.1):
        lion_pillar(px, -3.7, zc, z_ceiling)
    for px in (-2.1, 2.1):
        lion_pillar(px, -2.2, zc, z_ceiling)
    box(0, -2.95, z_ceiling, 5.6, 3.3, 0.26)           # roof slab
    frustum(0, -2.95, z_ceiling + 0.26, 5.9, 3.6, 5.4, 3.1, 0.2)
    # kudu-style row of miniature shrines along the mandapa's front eave
    for i in range(7):
        kuta(-2.4 + i * 0.8, -4.55, z_ceiling + 0.46, 0.6) if i % 2 == 0 else sala(-2.4 + i * 0.8, -4.55, z_ceiling + 0.46, 0.6, 0)
    kuta(-2.55, -1.55, z_ceiling + 0.46, 0.7)
    kuta(2.55, -1.55, z_ceiling + 0.46, 0.7)

    # ---- Garbhagriha (sanctum) ----
    cy, half = 1.1, 2.05
    wall_h = 3.7
    z0 = plinth_top
    box(0, cy, z0, half * 2, half * 2, wall_h)
    box(0, cy, z0 - 0.0, half * 2 + 0.3, half * 2 + 0.3, 0.2)  # moulded base
    # pilasters and niches on each face
    for rz in (0, 90, 180, 270):
        with xf(at(0, cy, 0, rz)):
            for px in (-1.55, 1.55):
                pilaster(px, -half - 0.05, z0, wall_h, 0.4, 0.14)
            if rz != 0:
                niche(0, -half - 0.04, z0 + 0.7, 0.9, 1.5)
                for px in (-0.95, 0.95):
                    pilaster(px, -half - 0.04, z0, wall_h * 0.8, 0.2, 0.1)
    # sanctum doorway on the front face
    with xf(at(0, cy, 0, 0)):
        with material("dark"):
            box(0, -half - 0.02, z0 + 0.0, 0.9, 0.06, 1.9)
        box(-0.6, -half - 0.08, z0, 0.2, 0.2, 2.1)
        box(0.6, -half - 0.08, z0, 0.2, 0.2, 2.1)
        box(0, -half - 0.08, z0 + 2.1, 1.7, 0.22, 0.2)
        extrude_profile([(-0.95, 0), (0.95, 0), (0.0, 0.5)], 0, -half - 0.08, z0 + 2.3, 0.2)

    # ---- Vimana: four tapering tiers ----
    z = z0 + wall_h
    hk = half + 0.3
    for k in range(4):
        s = 0.88 ** k * 1.05
        z = tier_ring(hk, z, s, intermediates=k < 2)
        wall_half = hk - 0.64 * s
        wh = 1.25 * 0.93 ** k
        box(0, cy * 0 + 0, z, wall_half * 2, wall_half * 2, wh)
        # a pilaster on every face of the next band
        for rz in (0, 90, 180, 270):
            with xf(at(0, 0, 0, rz)):
                for px in (-wall_half * 0.62, wall_half * 0.62):
                    pilaster(px, -wall_half - 0.02, z, wh, 0.2 * s, 0.07)
                niche(0, -wall_half - 0.02, z + 0.12, 0.5 * s, wh - 0.34)
        z += wh
        hk = wall_half + 0.12

    # ---- Griva, shikhara and kalasa ----
    box(0, 0, z, hk * 1.4, hk * 1.4, 0.45)
    lathe([(hk * 0.62, 0.0), (hk * 0.7, 0.12), (hk * 0.66, 0.36), (hk * 0.5, 0.58), (hk * 0.3, 0.74), (0.0, 0.82)], 0, 0, z + 0.45, 8)
    zt = z + 0.45 + 0.8
    with material("gold"):
        lathe([(0.0, 0.0), (0.22, 0.02), (0.26, 0.1), (0.14, 0.18), (0.12, 0.26), (0.22, 0.42), (0.26, 0.56), (0.14, 0.68), (0.06, 0.8), (0.07, 1.0), (0.0, 1.3)], 0, 0, zt, 10)

    # ---- Nandi bulls at the plinth corners, facing outward along the diagonals ----
    for rz, (sx, sy) in zip((45, 135, 225, 315), ((1, -1), (-1, -1), (-1, 1), (1, 1))):
        nandi(sx * 3.75, sy * 3.75, plinth_top, rz + 180)
    return zt + 1.3



def main() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    albedo, normal = make_textures()
    total_h = build()
    mats = {
        "stone": principled("PallavaStone", (0.66, 0.58, 0.46), 0.88, 0.0, albedo, normal),
        "gold": principled("TempleGold", (0.95, 0.66, 0.16), 0.38, 0.45),
        "dark": principled("Doorway", (0.035, 0.028, 0.024), 1.0, 0.0),
    }
    finish("temple", mats, total_h)


if __name__ == "__main__":
    main()
