import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { archMaterials, MATERIAL_SURFACE, type MatKey } from './archMaterials';
import { TEXEL_WORLD } from './archTextures';

/** One merged mesh of a model, with the material key it was built for (so construction can swap it). */
export interface BuiltMesh { mesh: THREE.Mesh; key: MatKey }

export interface BuiltModel {
  /** LOD object: full detail close up, simplified beyond LOD_DISTANCE. */
  object: THREE.LOD;
  hi: BuiltMesh[];
  lo: BuiltMesh[];
  height: number;
  /** XZ extent of everything the model draws (used to test that it fits its footprint). */
  bounds: THREE.Box3;
  triangles: { hi: number; lo: number };
  dispose(): void;
}

export const LOD_DISTANCE = 80;

interface Part { key: MatKey; geo: THREE.BufferGeometry; detail: boolean }

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3(), _t = new THREE.Vector3(), _s = new THREE.Vector3();

/**
 * Project texture coordinates per triangle onto the plane of the face: u runs along the horizontal
 * tangent, v up the slope. Walls, sloping roofs and flat tops all get undistorted, world-scaled
 * texture without hand-authored UVs, and adjacent parts line up (courses of stone meet across pieces).
 */
function surfaceUV(geo: THREE.BufferGeometry, scale: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 3) {
    _a.fromBufferAttribute(pos, i); _b.fromBufferAttribute(pos, i + 1); _c.fromBufferAttribute(pos, i + 2);
    _n.subVectors(_b, _a).cross(_s.subVectors(_c, _a));
    if (_n.lengthSq() < 1e-14) continue; // degenerate sliver: leave uv at 0
    _n.normalize();
    if (Math.abs(_n.y) > 0.92) _t.set(1, 0, 0); // flat top/bottom: u = x
    else _t.set(_n.z, 0, -_n.x).normalize();
    _s.crossVectors(_n, _t); // slope direction (points up the face for walls and roofs)
    if (Math.abs(_n.y) > 0.92) _s.set(0, 0, _n.y > 0 ? 1 : -1); // flat: v = z
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? _a : k === 1 ? _b : _c;
      uv[(i + k) * 2] = p.dot(_t) / scale;
      uv[(i + k) * 2 + 1] = p.dot(_s) / scale;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Flip winding when most faces of a (roughly convex) shape face inward, so hand-built meshes light correctly. */
export function ensureOutward(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const centre = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) centre.add(_a.fromBufferAttribute(pos, i));
  centre.divideScalar(Math.max(1, pos.count));
  let score = 0;
  for (let i = 0; i < pos.count; i += 3) {
    _a.fromBufferAttribute(pos, i); _b.fromBufferAttribute(pos, i + 1); _c.fromBufferAttribute(pos, i + 2);
    _n.subVectors(_b, _a).cross(_s.subVectors(_c, _a));
    const mid = _t.copy(_a).add(_b).add(_c).divideScalar(3).sub(centre);
    score += Math.sign(_n.dot(mid)) * Math.min(1, _n.length());
  }
  if (score < 0) {
    const arr = pos.array as Float32Array;
    for (let i = 0; i < pos.count; i += 3) for (let k = 0; k < 3; k++) {
      const t = arr[(i + 1) * 3 + k]!; arr[(i + 1) * 3 + k] = arr[(i + 2) * 3 + k]!; arr[(i + 2) * 3 + k] = t;
    }
  }
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

/**
 * Assembles a building from primitives. Parts are placed in model space (origin = footprint centre,
 * y = 0 at ground, +Z is the entrance side), tagged with a construction window, merged per material
 * and emitted at two levels of detail. Parts flagged `detail` (carvings, finials, small props) are
 * omitted from the far level.
 */
export class ModelBuilder {
  private readonly parts: Part[] = [];
  private s0 = 0;
  private s1 = 1;
  private detailOnly = false;

  /** Subsequent parts appear while construction progress is between a and b (0..1). */
  window(a: number, b: number): this { this.s0 = a; this.s1 = b; return this; }
  /** Subsequent parts are fine detail, dropped in the distant LOD. */
  detail(on: boolean): this { this.detailOnly = on; return this; }

  /** Add any geometry already positioned in model space. */
  add(key: MatKey, geo: THREE.BufferGeometry): this {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const surface = MATERIAL_SURFACE[key];
    if (surface) surfaceUV(g, TEXEL_WORLD[surface]); else if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    g.computeBoundingBox();
    const baseY = g.boundingBox!.min.y;
    const n = g.getAttribute('position').count;
    const stage = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { stage[i * 3] = this.s0; stage[i * 3 + 1] = this.s1; stage[i * 3 + 2] = baseY; }
    g.setAttribute('aStage', new THREE.BufferAttribute(stage, 3));
    this.parts.push({ key, geo: g, detail: this.detailOnly });
    return this;
  }

  private static place(geo: THREE.BufferGeometry, x: number, y: number, z: number, rotY = 0, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
    if (sx !== 1 || sy !== 1 || sz !== 1) geo.scale(sx, sy, sz);
    if (rotY) geo.rotateY(rotY);
    geo.translate(x, y, z);
    return geo;
  }

  /** Box standing on y0, centred on (cx, cz). */
  box(key: MatKey, w: number, h: number, d: number, cx: number, y0: number, cz: number, rotY = 0): this {
    return this.add(key, ModelBuilder.place(new THREE.BoxGeometry(w, h, d), cx, y0 + h / 2, cz, rotY));
  }

  /** Cylinder/frustum standing on y0. */
  cyl(key: MatKey, rTop: number, rBot: number, h: number, cx: number, y0: number, cz: number, seg = 8, rotY = 0): this {
    return this.add(key, ModelBuilder.place(new THREE.CylinderGeometry(rTop, rBot, h, seg), cx, y0 + h / 2, cz, rotY));
  }

  /** Square frustum (a stepped pyramid course): base w0×d0 tapering to w1×d1. */
  frustum(key: MatKey, w0: number, d0: number, w1: number, d1: number, h: number, cx: number, y0: number, cz: number): this {
    const v: number[] = [];
    const b = [[-w0 / 2, -d0 / 2], [w0 / 2, -d0 / 2], [w0 / 2, d0 / 2], [-w0 / 2, d0 / 2]] as const;
    const t = [[-w1 / 2, -d1 / 2], [w1 / 2, -d1 / 2], [w1 / 2, d1 / 2], [-w1 / 2, d1 / 2]] as const;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const a = [b[i]![0], 0, b[i]![1]], bb = [b[j]![0], 0, b[j]![1]], c = [t[j]![0], h, t[j]![1]], d = [t[i]![0], h, t[i]![1]];
      v.push(...a, ...bb, ...c, ...a, ...c, ...d);
    }
    v.push(t[0]![0], h, t[0]![1], t[2]![0], h, t[2]![1], t[1]![0], h, t[1]![1], t[0]![0], h, t[0]![1], t[3]![0], h, t[3]![1], t[2]![0], h, t[2]![1]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    return this.add(key, ModelBuilder.place(ensureOutward(g), cx, y0, cz));
  }

  /**
   * Hipped roof: rectangular eaves w×d rising to a ridge of length `ridge` along X (0 = pyramid).
   * The underside is closed by a thin soffit so the overhang does not read as a hollow shell.
   */
  hipRoof(key: MatKey, w: number, d: number, h: number, ridge: number, cx: number, y0: number, cz: number, rotY = 0): this {
    const r = Math.min(ridge, w) / 2;
    const P = (x: number, y: number, z: number): number[] => [x, y, z];
    const c = [P(-w / 2, 0, -d / 2), P(w / 2, 0, -d / 2), P(w / 2, 0, d / 2), P(-w / 2, 0, d / 2)];
    const t0 = P(-r, h, 0), t1 = P(r, h, 0);
    const v: number[] = [];
    v.push(...c[3]!, ...c[2]!, ...t1, ...c[3]!, ...t1, ...t0);        // front (+z)
    v.push(...c[1]!, ...c[0]!, ...t0, ...c[1]!, ...t0, ...t1);        // back
    v.push(...c[0]!, ...c[3]!, ...t0);                                 // left hip
    v.push(...c[2]!, ...c[1]!, ...t1);                                 // right hip
    v.push(...c[0]!, ...c[1]!, ...c[2]!, ...c[0]!, ...c[2]!, ...c[3]!); // soffit
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    return this.add(key, ModelBuilder.place(ensureOutward(g), cx, y0, cz, rotY));
  }

  /** Extrude a 2D outline (x right, y up) along Z by `depth`, centred on z. Used for gables, barrel roofs and arches. */
  prism(key: MatKey, outline: ReadonlyArray<readonly [number, number]>, depth: number, cx: number, y0: number, cz: number, rotY = 0, holes: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = []): this {
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
    g.translate(0, 0, -depth / 2);
    return this.add(key, ModelBuilder.place(g, cx, y0, cz, rotY));
  }

  /** Barrel-vaulted roof (a "shala"): semi-elliptical section w×h, running `len` along Z. */
  barrel(key: MatKey, w: number, h: number, len: number, cx: number, y0: number, cz: number, rotY = 0, seg = 8): this {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= seg; i++) { const a = Math.PI - (i / seg) * Math.PI; pts.push([Math.cos(a) * w / 2, Math.sin(a) * h]); }
    return this.prism(key, pts, len, cx, y0, cz, rotY);
  }

  /** Triangular gable end/roof prism. */
  gable(key: MatKey, w: number, h: number, len: number, cx: number, y0: number, cz: number, rotY = 0): this {
    return this.prism(key, [[-w / 2, 0], [w / 2, 0], [0, h]], len, cx, y0, cz, rotY);
  }

  /** Lathe-turned finial/pot from [radius, y] profile points. */
  lathe(key: MatKey, profile: ReadonlyArray<readonly [number, number]>, cx: number, y0: number, cz: number, seg = 10, sy = 1): this {
    const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg);
    return this.add(key, ModelBuilder.place(g, cx, y0, cz, 0, 1, sy, 1));
  }

  /** Kudu: the horseshoe-arch window motif of Pallava shrines. A dark opening in a raised stone frame on the +Z face of a wall. */
  kudu(frame: MatKey, w: number, h: number, cx: number, y0: number, cz: number, rotY = 0, depth = 0.08): this {
    const outline = ModelBuilder.horseshoe(w, h);
    const inner = ModelBuilder.horseshoe(w * 0.58, h * 0.74).map(([x, y]) => [x, y + h * 0.05] as const);
    this.prism(frame, outline, depth, cx, y0, cz, rotY, [inner]);
    // dark recess set slightly behind the frame face
    return this.prism('dark', inner, depth * 0.5, cx, y0, cz - 0.001, rotY);
  }

  /** Horseshoe outline: flat sill, near-vertical jambs and a slightly pointed round head. Counter-clockwise. */
  private static horseshoe(w: number, h: number): Array<readonly [number, number]> {
    const r = w * 0.5;
    const cy = h - r * 1.15;
    const pts: Array<readonly [number, number]> = [[-w / 2, 0], [w / 2, 0]];
    const steps = 6;
    for (let i = 0; i <= steps; i++) { const a = (i / steps) * Math.PI; pts.push([Math.cos(a) * r, cy + Math.sin(a) * r * 1.15]); }
    return pts;
  }

  /** Octagonal carved pillar: square base, tapered shaft, bracket capital. Optionally a seated lion (yali) at the foot. */
  pillar(x: number, z: number, y0: number, h: number, yali = false, key: MatKey = 'stone'): this {
    this.box(key, 0.34, 0.14, 0.34, x, y0, z);
    this.cyl(key, 0.1, 0.13, h - 0.34, x, y0 + 0.14, z, 8);
    this.detail(true);
    this.box(key, 0.3, 0.1, 0.3, x, y0 + h - 0.2, z);
    this.box(key, 0.44, 0.1, 0.44, x, y0 + h - 0.1, z);
    if (yali) {
      // seated lion: haunches, chest and head, facing the viewer
      this.box(key, 0.2, 0.2, 0.26, x, y0 + 0.14, z + 0.2);
      this.add(key, ModelBuilder.place(new THREE.SphereGeometry(0.11, 6, 5), x, y0 + 0.36, z + 0.3));
    }
    return this.detail(false);
  }

  /** Straight stair of `n` steps climbing toward -Z from a base at z, each step `rise` high and `run` deep. */
  steps(key: MatKey, w: number, n: number, rise: number, run: number, cx: number, y0: number, zFront: number): this {
    for (let i = 0; i < n; i++) this.box(key, w, rise * (i + 1), run, cx, y0, zFront - i * run - run / 2);
    return this;
  }

  /** Flag on a pole: bronze pole plus a rippling cloth. */
  banner(x: number, z: number, y0: number, h: number, cloth = 0.7): this {
    this.cyl('bronze', 0.035, 0.045, h, x, y0, z, 5);
    this.add('gold', ModelBuilder.place(new THREE.SphereGeometry(0.06, 6, 5), x, y0 + h + 0.04, z));
    const g = new THREE.PlaneGeometry(cloth, cloth * 0.55, 6, 1);
    g.translate(cloth / 2 + 0.03, 0, 0); // pole at uv.x = 0, free edge at 1
    return this.add('cloth', ModelBuilder.place(g, x, y0 + h - cloth * 0.32, z));
  }

  bounds(): THREE.Box3 {
    const b = new THREE.Box3();
    for (const p of this.parts) { p.geo.computeBoundingBox(); b.union(p.geo.boundingBox!); }
    return b;
  }

  /** Merge into the final LOD model. Geometry is owned by the model; call dispose() when done. */
  build(name: string): BuiltModel {
    const mats = archMaterials();
    const level = (includeDetail: boolean): BuiltMesh[] => {
      const byKey = new Map<MatKey, THREE.BufferGeometry[]>();
      for (const p of this.parts) {
        if (p.detail && !includeDetail) continue;
        let list = byKey.get(p.key);
        if (!list) { list = []; byKey.set(p.key, list); }
        list.push(p.geo);
      }
      const out: BuiltMesh[] = [];
      for (const [key, list] of byKey) {
        const geo = mergeGeometries(list, false);
        if (!geo) continue;
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mats.get(key));
        mesh.castShadow = key !== 'water' && key !== 'rice' && key !== 'cloth';
        mesh.receiveShadow = true;
        mesh.name = `${name}:${key}`;
        mesh.userData.mat = key; // survives Object3D.clone(), so instances can swap to construction materials
        out.push({ mesh, key });
      }
      return out;
    };
    const hi = level(true), lo = level(false);
    const hiGroup = new THREE.Group(), loGroup = new THREE.Group();
    hi.forEach((m) => hiGroup.add(m.mesh));
    lo.forEach((m) => loGroup.add(m.mesh));
    const lod = new THREE.LOD();
    lod.name = name;
    lod.addLevel(hiGroup, 0);
    lod.addLevel(loGroup, LOD_DISTANCE);
    const bounds = this.bounds();
    const count = (l: BuiltMesh[]): number => l.reduce((a, m) => a + m.mesh.geometry.getAttribute('position').count / 3, 0);
    const parts = this.parts;
    return {
      object: lod, hi, lo, height: bounds.max.y, bounds,
      triangles: { hi: count(hi), lo: count(lo) },
      dispose() {
        for (const m of hi) m.mesh.geometry.dispose();
        for (const m of lo) m.mesh.geometry.dispose();
        for (const p of parts) p.geo.dispose();
      },
    };
  }
}
