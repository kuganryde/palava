"""
Shared modelling kit for the procedural Blender assets (temple.py, palace.py): seeded RNG, tileable stone
textures, a bmesh-per-material builder with a transform stack, box / frustum / profile / lathe primitives,
box-projected UVs, Principled materials and the glTF export. Needs `pip install bpy`.
"""
from __future__ import annotations

import math
import os
import random
import sys
import tempfile
from contextlib import contextmanager

import bpy  # must come first: it registers the bmesh / mathutils modules
import bmesh  # noqa: E402
import numpy as np
from mathutils import Matrix, Vector  # noqa: E402

OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT_DIR, exist_ok=True)
TEX_DIR = tempfile.mkdtemp(prefix='palava_tex_')  # intermediate textures; the GLB embeds them, so nothing extra ships
rng = random.Random(7)  # fixed seed: the same script always yields the same asset

# --------------------------------------------------------------------------------------------------
# Textures (tileable sandstone/granite blocks with weathering) -> albedo + normal map
# --------------------------------------------------------------------------------------------------
TEX = 1024
COURSES = 8          # block rows per tile
TILE_WORLD = 2.0     # one texture tile covers 2 m, so a course is 0.25 m
ROOF_TILE_WORLD = 1.0  # one roof-tile texture repeat covers 1 m (5 tile columns, 4 overlapping rows)


def periodic_noise(n: int, beta: float, seed: int) -> np.ndarray:
    """1/f^beta noise that wraps seamlessly (filtered in the Fourier domain), scaled to 0..1."""
    r = np.random.default_rng(seed)
    f = np.fft.fft2(r.standard_normal((n, n)))
    fx = np.fft.fftfreq(n)[:, None]
    fy = np.fft.fftfreq(n)[None, :]
    rad = np.sqrt(fx * fx + fy * fy)
    rad[0, 0] = 1.0
    out = np.real(np.fft.ifft2(f / rad ** (beta / 2.0)))
    out -= out.min()
    return out / max(out.max(), 1e-9)


def blur_wrap(a: np.ndarray, k: int) -> np.ndarray:
    for _ in range(k):
        a = (a + np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1)) / 5.0
    return a


def make_textures() -> tuple[str, str]:
    n = TEX
    ys, xs = np.mgrid[0:n, 0:n]
    row_h = n // COURSES
    row = ys // row_h
    # Vertical joints: four blocks per row, each row shifted so joints never line up.
    shifts = np.array([rng.randrange(0, n) for _ in range(COURSES)])
    xs_s = (xs + shifts[row]) % n
    col_w = n // 4
    in_row_y = ys % row_h
    in_col_x = xs_s % col_w
    joint = 5
    mortar = (in_row_y < joint) | (in_col_x < joint)
    block_id = row * 4 + (xs_s // col_w)
    tint = np.array([rng.uniform(-1, 1) for _ in range(COURSES * 4)])[block_id]

    fine = periodic_noise(n, 2.2, 1)
    broad = periodic_noise(n, 3.2, 2)
    grit = periodic_noise(n, 0.8, 3)

    base = np.array([0.66, 0.58, 0.46])
    col = base[None, None, :] * (1.0 + 0.07 * tint[..., None] + 0.16 * (fine[..., None] - 0.5) + 0.05 * (grit[..., None] - 0.5))
    # Weathering: darker streaks in the broad field and a little green lichen where it is high.
    col *= (1.0 - 0.18 * np.clip(broad[..., None] - 0.45, 0, 1))
    lichen = np.clip((broad - 0.72) * 5.0, 0, 1)[..., None] * 0.28
    col = col * (1 - lichen) + np.array([0.40, 0.48, 0.30]) * lichen
    mort = blur_wrap(mortar.astype(float), 2)[..., None]
    col = col * (1 - 0.55 * mort) + np.array([0.30, 0.27, 0.22]) * 0.55 * mort

    # Height field: blocks stand proud of the joints, with fine pitting.
    h = 0.85 * (1.0 - blur_wrap(mortar.astype(float), 3)) + 0.12 * fine + 0.05 * grit
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    strength = 14.0
    nx, ny, nz = -gx * strength, -gy * strength, np.ones_like(h)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack([nx / ln, ny / ln, nz / ln], -1) * 0.5 + 0.5

    paths = []
    for name, arr in (("stone_albedo", col), ("stone_normal", normal)):
        img = bpy.data.images.new(name, n, n, alpha=False)
        rgba = np.concatenate([np.clip(arr, 0, 1), np.ones((n, n, 1))], -1)
        img.pixels.foreach_set(rgba.astype(np.float32).ravel())  # row 0 = bottom, matching ys above
        img.file_format = "JPEG"
        img.filepath_raw = os.path.join(TEX_DIR, name + ".jpg")
        scene = bpy.context.scene
        scene.render.image_settings.file_format = "JPEG"
        scene.render.image_settings.quality = 88
        img.save_render(img.filepath_raw, scene=scene)
        paths.append(img.filepath_raw)
        bpy.data.images.remove(img)
    return paths[0], paths[1]


def make_roof_textures() -> tuple[str, str]:
    """Terracotta half-round roof tiles: five columns and four overlapping rows per repeat -> albedo + normal."""
    n = 512
    ys, xs = np.mgrid[0:n, 0:n]
    u = xs / n
    v = ys / n
    cols, rows = 5, 4
    cu = (u * cols) % 1.0
    rv = (v * rows) % 1.0
    ridge = np.sin(np.pi * cu)                     # half-round profile across each tile
    step = 1.0 - rv                                # each row overlaps the one below: a soft ledge at the lower edge
    h = 0.62 * ridge + 0.38 * step
    tile_id = (np.floor(u * cols).astype(int) + cols * np.floor(v * rows).astype(int))
    tint = np.array([rng.uniform(-1, 1) for _ in range(cols * rows)])[tile_id]
    fine = periodic_noise(n, 2.4, 11)
    broad = periodic_noise(n, 3.4, 12)
    base = np.array([0.60, 0.26, 0.15])
    col = base[None, None, :] * (1.0 + 0.16 * tint[..., None] + 0.14 * (fine[..., None] - 0.5))
    shade = 0.55 + 0.45 * ridge * (0.6 + 0.4 * step)                # grooves and lower edges read darker
    col *= shade[..., None]
    moss = np.clip((broad - 0.7) * 5.0, 0, 1)[..., None] * 0.3
    col = col * (1 - moss) + np.array([0.30, 0.38, 0.22]) * moss
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * n / 60.0
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5 * n / 60.0
    nx, ny, nz = -gx * 3.0, -gy * 3.0, np.ones_like(h)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack([nx / ln, ny / ln, nz / ln], -1) * 0.5 + 0.5
    out = []
    for name, arr in (("roof_albedo", col), ("roof_normal", normal)):
        out.append(_save_jpg(name, np.clip(arr, 0, 1), n))
    return out[0], out[1]


def _save_jpg(name: str, arr: np.ndarray, n: int) -> str:
    img = bpy.data.images.new(name, n, n, alpha=False)
    rgba = np.concatenate([arr, np.ones((n, n, 1))], -1)
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.file_format = "JPEG"
    img.filepath_raw = os.path.join(TEX_DIR, name + ".jpg")
    scene = bpy.context.scene
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 88
    img.save_render(img.filepath_raw, scene=scene)
    path = img.filepath_raw
    bpy.data.images.remove(img)
    return path


# --------------------------------------------------------------------------------------------------
# Tiny modelling kit: bmesh per material, a transform stack, and box / frustum / profile / lathe helpers
# --------------------------------------------------------------------------------------------------
BMS: dict[str, bmesh.types.BMesh] = {}
_mat = ["stone"]


def _bm() -> bmesh.types.BMesh:
    """The bmesh for the material currently selected with `with material(...)`, created on first use."""
    if _mat[-1] not in BMS:
        BMS[_mat[-1]] = bmesh.new()
    return BMS[_mat[-1]]
_T = [Matrix.Identity(4)]


@contextmanager
def material(name: str):
    _mat.append(name)
    try:
        yield
    finally:
        _mat.pop()


@contextmanager
def xf(m: Matrix):
    _T.append(_T[-1] @ m)
    try:
        yield
    finally:
        _T.pop()


def at(x=0.0, y=0.0, z=0.0, rz=0.0) -> Matrix:
    return Matrix.Translation((x, y, z)) @ Matrix.Rotation(math.radians(rz), 4, "Z")


def V(bm, x, y, z):
    return bm.verts.new(_T[-1] @ Vector((x, y, z)))


def _face(bm, vs):
    try:
        bm.faces.new(vs)
    except ValueError:
        pass  # duplicate face from coincident shapes: harmless


def frustum(cx, cy, z0, sx0, sy0, sx1, sy1, h, bottom=False, top=True):
    """Box when (sx1, sy1) == (sx0, sy0); sizes are full widths."""
    bm = _bm()
    a, b, c, d = sx0 / 2, sy0 / 2, sx1 / 2, sy1 / 2
    v = [V(bm, cx - a, cy - b, z0), V(bm, cx + a, cy - b, z0), V(bm, cx + a, cy + b, z0), V(bm, cx - a, cy + b, z0),
         V(bm, cx - c, cy - d, z0 + h), V(bm, cx + c, cy - d, z0 + h), V(bm, cx + c, cy + d, z0 + h), V(bm, cx - c, cy + d, z0 + h)]
    for f in ([0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]):
        _face(bm, [v[i] for i in f])
    if top:
        _face(bm, [v[i] for i in (4, 5, 6, 7)])
    if bottom:
        _face(bm, [v[i] for i in (0, 3, 2, 1)])


def box(cx, cy, z0, sx, sy, h, **kw):
    frustum(cx, cy, z0, sx, sy, sx, sy, h, **kw)


def extrude_profile(profile, cx, cy, z0, length):
    """Extrude an (x, z) profile (counter-clockwise seen from -Y) along +Y: gable roofs, ramps, vaults."""
    bm = _bm()
    f = [V(bm, cx + px, cy - length / 2, z0 + pz) for px, pz in profile]
    b = [V(bm, cx + px, cy + length / 2, z0 + pz) for px, pz in profile]
    _face(bm, f)
    _face(bm, list(reversed(b)))
    n = len(profile)
    for i in range(n):
        j = (i + 1) % n
        _face(bm, [f[i], b[i], b[j], f[j]])


def lathe(profile, cx, cy, z0, segs=8):
    """Solid of revolution about Z from an (r, z) profile, bottom to top. r = 0 closes the ends."""
    bm = _bm()
    rings = []
    for r, z in profile:
        if r <= 1e-6:
            rings.append([V(bm, cx, cy, z0 + z)])
        else:
            rings.append([V(bm, cx + r * math.cos(2 * math.pi * k / segs), cy + r * math.sin(2 * math.pi * k / segs), z0 + z) for k in range(segs)])
    for i in range(len(rings) - 1):
        lo, hi = rings[i], rings[i + 1]
        for k in range(segs):
            k2 = (k + 1) % segs
            if len(lo) == 1 and len(hi) == 1:
                continue
            if len(lo) == 1:
                _face(bm, [lo[0], hi[k2], hi[k]])
            elif len(hi) == 1:
                _face(bm, [lo[k], lo[k2], hi[0]])
            else:
                _face(bm, [lo[k], lo[k2], hi[k2], hi[k]])



def assign_uvs(bm: bmesh.types.BMesh, mode: str) -> None:
    """Box-projected UVs. mode: 'stone' (random whole-course offsets), 'plain', or 'slope' (roof tiles run down the slope)."""
    layer = bm.loops.layers.uv.verify()
    bm.normal_update()
    for f in bm.faces:
        n = f.normal
        if mode == "slope" and (n.x * n.x + n.y * n.y) > 1e-4:
            # u runs along the eave, v up the slope, right-handed seen from outside (t x w = n).
            hn = Vector((n.x, n.y, 0.0)).normalized()
            t = Vector((-hn.y, hn.x, 0.0))
            w = n.cross(t)
            for loop in f.loops:
                p = loop.vert.co
                loop[layer].uv = (p.dot(t) / ROOF_TILE_WORLD, p.dot(w) / ROOF_TILE_WORLD)
            continue
        ax = max(range(3), key=lambda i: abs(n[i]))
        # Per-face offset by whole courses/blocks so repeated faces do not look identical.
        du = rng.random()
        dv = rng.randrange(COURSES) / COURSES if mode == "stone" else 0.0
        for loop in f.loops:
            p = loop.vert.co
            if ax == 0:       # +-X face: seen from outside, right = +Y for +X, -Y for -X
                u, v = (p.y if n.x > 0 else -p.y), p.z
            elif ax == 1:     # +-Y face: right = +X for -Y, -X for +Y
                u, v = (p.x if n.y < 0 else -p.x), p.z
            else:
                u, v = p.x, (p.y if n.z > 0 else -p.y)
            loop[layer].uv = (u / TILE_WORLD + du, v / TILE_WORLD + dv)


def principled(name, color, rough, metal, albedo=None, normal=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if albedo:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(albedo)
        t.image.colorspace_settings.name = "sRGB"
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    if normal:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(normal)
        t.image.colorspace_settings.name = "Non-Color"
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = 1.0
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def finish(basename: str, mats: dict, total_h: float) -> str:
    """UV-map every material's mesh, link the objects and export `<basename>.glb` into OUT_DIR."""
    tris = {}
    for key, bm in BMS.items():
        assign_uvs(bm, "stone" if key == "stone" else "slope" if key == "tile" else "plain")
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        tris[key] = sum(len(f.verts) - 2 for f in bm.faces)
        me = bpy.data.meshes.new(key)
        bm.to_mesh(me)
        bm.free()
        me.materials.append(mats[key])
        ob = bpy.data.objects.new(f"{basename}_{key}", me)
        bpy.context.scene.collection.objects.link(ob)
    path = os.path.join(OUT_DIR, basename + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", export_yup=True, export_apply=True, export_image_format="AUTO",
        export_cameras=False, export_lights=False, export_materials="EXPORT",
    )
    print(f"triangles: {tris} total={sum(tris.values())}  height={total_h:.1f} m  glb={os.path.getsize(path) / 1024:.0f} KiB -> {path}")
    return path
