import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash2 } from '../core/rng';

/**
 * Procedural foliage and rock geometries. Every geometry has exactly position + normal + colour
 * (non-indexed) so parts can be merged into ONE geometry per species. Colour is baked per vertex,
 * including a cheap ambient-occlusion gradient (darker toward the ground / canopy underside), which
 * removes the flat "plastic" look without any extra textures or lights.
 *
 * Each species has a high and a low level of detail; the renderer swaps between them by zoom.
 */
export interface LodGeometry {
  hi: THREE.BufferGeometry;
  lo: THREE.BufferGeometry;
}

const _c = new THREE.Color();
const _c2 = new THREE.Color();

/** Strips to position, converts to non-indexed, then bakes a vertical colour gradient with AO. */
function bake(
  geo: THREE.BufferGeometry, base: number, top = base, y0 = 0, y1 = 1, aoMin = 1, aoTo = 1,
): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const pos = g.attributes.position!;
  const arr = new Float32Array(pos.count * 3);
  _c.set(base);
  _c2.set(top);
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) - y0) / Math.max(1e-6, y1 - y0), 0, 1);
    const ao = aoMin + (1 - aoMin) * Math.min(1, t / aoTo);
    arr[i * 3] = THREE.MathUtils.lerp(_c.r, _c2.r, t) * ao;
    arr[i * 3 + 1] = THREE.MathUtils.lerp(_c.g, _c2.g, t) * ao;
    arr[i * 3 + 2] = THREE.MathUtils.lerp(_c.b, _c2.b, t) * ao;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Deterministic vertex jitter keyed on the (quantised) vertex position, so shared corners stay welded. */
function jitter(geo: THREE.BufferGeometry, amount: number, salt: number): THREE.BufferGeometry {
  const p = geo.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const kx = Math.round(p.getX(i) * 500), ky = Math.round(p.getY(i) * 500), kz = Math.round(p.getZ(i) * 500);
    p.setXYZ(
      i,
      p.getX(i) + (hash2(kx, kz, salt + ky) - 0.5) * amount,
      p.getY(i) + (hash2(ky, kx, salt + kz + 7) - 0.5) * amount,
      p.getZ(i) + (hash2(kz, ky, salt + kx + 13) - 0.5) * amount,
    );
  }
  return geo;
}

function blob(
  cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: number, top: number,
  salt: number, detail = 0, jit = 0.28, aoMin = 0.62,
): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  jitter(g, jit, salt);
  g.scale(rx, ry, rz).translate(cx, cy, cz);
  return bake(g, color, top, cy - ry, cy + ry, aoMin);
}

/** Tapered open tube between two points (trunks, branches, aerial roots). */
function limb(
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r0: number, r1: number, color: number,
  sides = 5, topColor = color,
): THREE.BufferGeometry {
  const a = new THREE.Vector3(x0, y0, z0), b = new THREE.Vector3(x1, y1, z1);
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return bake(g, color, topColor, Math.min(y0, y1), Math.max(y0, y1), 0.7);
}

/** A curved, tapering leaf strip (palm frond / reed blade) in the local +X direction, then rotated about Y. */
function frond(
  len: number, width: number, rise: number, droop: number, segs: number, yaw: number, ox: number, oy: number, oz: number,
  color: number, tip: number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const row = (s: number): [number, number, number, number] => {
    const along = len * s;
    const y = rise * s - droop * s * s;
    const w = width * Math.pow(1 - s, 0.7) + 0.015;
    return [along, y, w, s];
  };
  let prev = row(0);
  for (let k = 1; k <= segs; k++) {
    const cur = row(k / segs);
    const [a0, y0, w0] = prev, [a1, y1, w1] = cur;
    pos.push(a0, y0, w0, a1, y1, w1, a1, y1, -w1, a0, y0, w0, a1, y1, -w1, a0, y0, -w0);
    prev = cur;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.rotateY(yaw).translate(ox, oy, oz);
  // Gradient along the frond's height range: base colour at the stem, lighter at the tip.
  return bake(g, color, tip, oy - droop * 0.6, oy + rise * 0.6, 0.78);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts, false);
  if (!m) throw new Error('Failed to merge foliage geometry');
  parts.forEach((p) => p.dispose());
  m.computeVertexNormals();
  m.computeBoundingSphere();
  return m;
}

/**
 * Grass and reed blades are lit like the ground they grow from: every normal points up, and both
 * windings are emitted so a FrontSide material shows them from any angle. (With DoubleSide, three.js
 * flips the normal on back faces, which turned half the blades black against a low sun.)
 */
function bladesUp(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = src.attributes.position!, col = src.attributes.color!;
  const n = pos.count; // triangles, non-indexed
  const p = new Float32Array(n * 2 * 3), c = new Float32Array(n * 2 * 3), nm = new Float32Array(n * 2 * 3);
  for (let t = 0; t < n; t += 3) {
    for (let v = 0; v < 3; v++) {
      const a = t + v, b = t + (v === 1 ? 2 : v === 2 ? 1 : 0); // reversed winding copy
      p.set([pos.getX(a), pos.getY(a), pos.getZ(a)], a * 3);
      c.set([col.getX(a), col.getY(a), col.getZ(a)], a * 3);
      p.set([pos.getX(b), pos.getY(b), pos.getZ(b)], (n + a) * 3);
      c.set([col.getX(b), col.getY(b), col.getZ(b)], (n + a) * 3);
    }
  }
  for (let i = 0; i < n * 2; i++) nm.set([0, 1, 0], i * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nm, 3));
  g.computeBoundingSphere();
  src.dispose();
  return g;
}

// ───────────────────────────── species ─────────────────────────────

function palm(): LodGeometry {
  const hi: THREE.BufferGeometry[] = [];
  const H = 3.3, segs = 5;
  let px = 0, py = 0;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const nx = 0.42 * t * t, ny = H * t; // gently curved trunk
    hi.push(limb(px, py, 0, nx, ny, 0, 0.19 - 0.09 * ((i - 1) / segs), 0.19 - 0.09 * t, i % 2 ? 0x8d7452 : 0x80694a));
    px = nx; py = ny;
  }
  const fronds = 9;
  for (let i = 0; i < fronds; i++) {
    const yaw = (i / fronds) * Math.PI * 2 + (i % 3) * 0.12;
    const dead = i === 4;
    hi.push(frond(
      2.05 - (i % 3) * 0.12, 0.3, 0.75 + (i % 2) * 0.25, 1.6 + (i % 3) * 0.18, 4, yaw, px, py, 0,
      dead ? 0x7a6a3c : i % 2 ? 0x3f7d34 : 0x4c8c3a, dead ? 0x9a8650 : 0x7fb050,
    ));
  }
  const lo: THREE.BufferGeometry[] = [limb(0, 0, 0, px, py, 0, 0.17, 0.1, 0x86704e, 4)];
  for (let i = 0; i < 5; i++) lo.push(frond(2.0, 0.34, 0.8, 1.6, 1, (i / 5) * Math.PI * 2, px, py, 0, 0x498a38, 0x7fb050));
  return { hi: merge(hi), lo: merge(lo) };
}

function broadleaf(): LodGeometry {
  const hi: THREE.BufferGeometry[] = [
    limb(0, 0, 0, 0.05, 1.6, 0, 0.2, 0.13, 0x6d5338),
    limb(0.05, 1.5, 0, -0.6, 2.5, 0.2, 0.1, 0.06, 0x6d5338, 4),
    limb(0.05, 1.5, 0, 0.55, 2.4, -0.3, 0.1, 0.06, 0x6d5338, 4),
  ];
  const greens: [number, number][] = [[0x3f7330, 0x6fa244], [0x4a7f34, 0x79ac4a], [0x3a6b2e, 0x66983f], [0x52853a, 0x82b050]];
  const spots: [number, number, number, number][] = [
    [0, 3.0, 0, 1.25], [-0.85, 2.65, 0.2, 0.95], [0.8, 2.7, -0.25, 1.0], [0.1, 2.6, 0.9, 0.85], [-0.1, 3.5, -0.2, 0.8],
  ];
  spots.forEach(([x, y, z, r], i) => {
    const [c, t] = greens[i % greens.length]!;
    hi.push(blob(x, y, z, r, r * 0.82, r, c, t, 11 + i, 0, 0.3));
  });
  const lo = [
    limb(0, 0, 0, 0.05, 2.2, 0, 0.19, 0.12, 0x6d5338, 4),
    blob(0, 3.0, 0, 1.6, 1.25, 1.5, 0x477c33, 0x75a848, 31, 0, 0.3),
  ];
  return { hi: merge(hi), lo: merge(lo) };
}

function banyan(): LodGeometry {
  const hi: THREE.BufferGeometry[] = [limb(0, 0, 0, 0, 2.2, 0, 0.5, 0.32, 0x5f4a35, 6), limb(0, 1.8, 0, 1.0, 2.8, 0.2, 0.18, 0.1, 0x5f4a35, 4)];
  const spots: [number, number, number, number, number][] = [
    [0, 3.4, 0, 1.7, 1.0], [-1.7, 3.0, 0.4, 1.35, 0.85], [1.7, 3.1, -0.3, 1.4, 0.85], [0.3, 3.0, 1.8, 1.3, 0.8],
    [-0.5, 3.0, -1.8, 1.35, 0.8], [1.2, 3.7, 0.9, 1.0, 0.7], [-1.1, 3.8, -0.8, 1.0, 0.7],
  ];
  spots.forEach(([x, y, z, rxz, ry], i) => hi.push(blob(x, y, z, rxz, ry, rxz, i % 2 ? 0x36662c : 0x3d7230, i % 2 ? 0x5d9238 : 0x69a03f, 51 + i, 0, 0.3)));
  // Aerial prop roots dropping from the canopy: the banyan's recognisable feature.
  const roots: [number, number][] = [[1.5, 0.6], [-1.3, 1.1], [0.2, -1.7], [-1.9, -0.7], [1.0, 1.7]];
  roots.forEach(([x, z]) => hi.push(limb(x * 0.6, 2.8, z * 0.6, x, 0, z, 0.03, 0.09, 0x6a5440, 4)));
  const lo = [
    limb(0, 0, 0, 0, 2.3, 0, 0.45, 0.3, 0x5f4a35, 4),
    blob(0, 3.3, 0, 2.6, 1.2, 2.5, 0x3d7230, 0x679d3d, 71, 0, 0.3),
  ];
  return { hi: merge(hi), lo: merge(lo) };
}

function acacia(): LodGeometry {
  const hi: THREE.BufferGeometry[] = [
    limb(0, 0, 0, 0.1, 1.7, 0, 0.14, 0.09, 0x6f5a3c, 4),
    limb(0.1, 1.5, 0, -0.9, 2.5, 0.2, 0.07, 0.04, 0x6f5a3c, 3),
    limb(0.1, 1.5, 0, 0.9, 2.4, -0.2, 0.07, 0.04, 0x6f5a3c, 3),
    blob(-0.8, 2.75, 0.2, 1.35, 0.32, 1.2, 0x727f36, 0x9aa850, 91, 0, 0.22, 0.75),
    blob(0.85, 2.7, -0.2, 1.3, 0.3, 1.15, 0x6c7a34, 0x94a34d, 92, 0, 0.22, 0.75),
    blob(0.0, 3.0, 0.2, 1.1, 0.28, 1.0, 0x778540, 0xa0ad58, 93, 0, 0.22, 0.75),
  ];
  const lo = [limb(0, 0, 0, 0, 2.3, 0, 0.13, 0.09, 0x6f5a3c, 3), blob(0, 2.8, 0, 1.9, 0.38, 1.7, 0x738138, 0x9aa850, 95, 0, 0.2, 0.75)];
  return { hi: merge(hi), lo: merge(lo) };
}

function bush(): LodGeometry {
  const hi = [
    blob(0, 0.32, 0, 0.55, 0.42, 0.5, 0x4d7a32, 0x7aa545, 101, 0, 0.25, 0.55),
    blob(0.4, 0.26, 0.15, 0.4, 0.32, 0.4, 0x558238, 0x82ad4c, 102, 0, 0.25, 0.55),
    blob(-0.32, 0.24, -0.2, 0.36, 0.3, 0.38, 0x46722f, 0x729f42, 103, 0, 0.25, 0.55),
  ];
  const lo = [blob(0, 0.3, 0, 0.7, 0.42, 0.65, 0x4d7a32, 0x7aa545, 105, 0, 0.25, 0.55)];
  return { hi: merge(hi), lo: merge(lo) };
}

function reed(): LodGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const g = new THREE.BufferGeometry();
    const h = 1.0 + (i % 3) * 0.28, lean = 0.22 + (i % 2) * 0.12, w = 0.045;
    const bx = Math.cos(a) * 0.14, bz = Math.sin(a) * 0.14;
    const tx = bx + Math.cos(a) * lean, tz = bz + Math.sin(a) * lean;
    const nx = -Math.sin(a) * w, nz = Math.cos(a) * w;
    g.setAttribute('position', new THREE.Float32BufferAttribute([bx - nx, 0, bz - nz, bx + nx, 0, bz + nz, tx, h, tz], 3));
    parts.push(bake(g, 0x5f8236, 0xb5b46a, 0, 1.4, 0.7));
  }
  const m = bladesUp(merge(parts));
  return { hi: m, lo: m };
}

function grassTuft(): LodGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + (i % 2) * 0.3;
    const h = 0.38 + (i % 3) * 0.14, lean = 0.18 + (i % 2) * 0.1, w = 0.05;
    const bx = Math.cos(a) * 0.05, bz = Math.sin(a) * 0.05;
    const tx = bx + Math.cos(a) * lean, tz = bz + Math.sin(a) * lean;
    const nx = -Math.sin(a) * w, nz = Math.cos(a) * w;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([bx - nx, 0, bz - nz, bx + nx, 0, bz + nz, tx, h, tz], 3));
    parts.push(bake(g, 0x5a8433, 0xb2c064, 0, 0.55, 0.8));
  }
  const m = bladesUp(merge(parts));
  return { hi: m, lo: m };
}

function boulder(): LodGeometry {
  const make = (detail: number, salt: number): THREE.BufferGeometry => {
    const g = new THREE.IcosahedronGeometry(1, detail);
    jitter(g, detail ? 0.22 : 0.3, salt);
    g.scale(1, 0.72, 0.92).translate(0, 0.45, 0);
    return bake(g, 0x6f6859, 0xa39c8a, 0.05, 1.1, 0.55, 0.5);
  };
  return { hi: merge([make(1, 201)]), lo: merge([make(0, 203)]) };
}

function slab(): LodGeometry {
  const make = (segs: number, salt: number): THREE.BufferGeometry => {
    const g = new THREE.BoxGeometry(1.7, 0.5, 1.2, segs, 1, segs);
    jitter(g, 0.16, salt);
    g.translate(0, 0.24, 0);
    return bake(g, 0x7b7364, 0xb0a894, 0, 0.55, 0.6, 0.6);
  };
  return { hi: merge([make(2, 211)]), lo: merge([make(1, 213)]) };
}

export type FoliageKind = 'palm' | 'broadleaf' | 'banyan' | 'acacia' | 'bush' | 'reed' | 'grass' | 'boulder' | 'slab';

/** Builds every species once. Caller owns (and must dispose) the returned geometries. */
export function buildFoliageGeometries(): Record<FoliageKind, LodGeometry> {
  return {
    palm: palm(), broadleaf: broadleaf(), banyan: banyan(), acacia: acacia(), bush: bush(),
    reed: reed(), grass: grassTuft(), boulder: boulder(), slab: slab(),
  };
}
