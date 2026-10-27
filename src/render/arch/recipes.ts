import * as THREE from 'three';
import { hash2 } from '../../core/rng';
import type { BuildingType } from '../../core/defs';
import { ModelBuilder } from './modelBuilder';

/**
 * Pallava building recipes. Vocabulary used here: adhisthana (moulded plinth), vimana (shrine tower of
 * stacked talas), kuta/sala (corner and mid-face miniature roofs), kudu (horseshoe window motif),
 * griva/stupi/kalasa (neck, crown and finial), mandapa (pillared hall), prakara (compound wall), yali
 * (rearing-lion pillar bases). Coordinates: origin = footprint centre, y = 0 ground, entrance on +Z.
 * Every recipe stays inside its BUILDING_DEFS footprint (checked by tests).
 *
 * Construction windows: 0-0.2 foundation, 0.2-0.55 walls, 0.5-0.9 roofs and upper works, 0.85-1 finish.
 */

/** Deterministic jittered rock: a low-poly icosahedron with seeded vertex noise, so no two boulders match. */
function rock(seed: number, r: number, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = 0.78 + 0.44 * hash2(Math.round(x * 40), Math.round(y * 40) + Math.round(z * 40) * 131, seed);
    pos.setXYZ(i, x * k * sx, y * k * sy, z * k * sz);
  }
  g.computeVertexNormals();
  return g;
}

/** Moulded stone base. Returns the y of its top. Tiers are [width, depth, height]. */
function plinth(b: ModelBuilder, tiers: ReadonlyArray<readonly [number, number, number]>, cz = 0): number {
  b.window(0, 0.2);
  b.box('stone', tiers[0]![0], 1.0 + tiers[0]![2], tiers[0]![1], 0, -0.8, cz);
  let y = tiers[0]![2] + 0.2;
  for (let i = 1; i < tiers.length; i++) { b.box(i % 2 ? 'sandstone' : 'stone', tiers[i]![0], tiers[i]![2], tiers[i]![1], 0, y, cz); y += tiers[i]![2]; }
  return y;
}

/** A miniature hip-roofed aedicule (kuta) used on tower corners. */
function kuta(b: ModelBuilder, x: number, y: number, z: number, s: number): void {
  b.box('stone', s, s * 0.9, s, x, y, z);
  b.hipRoof('tile', s * 1.35, s * 1.35, s * 0.8, 0, x, y + s * 0.9, z);
}

/** One storey of a vimana. Returns the y of its top. */
function tala(b: ModelBuilder, s: number, h: number, y: number, cx: number, cz: number, front = 1): number {
  b.box('sandstone', s, h, s, cx, y, cz);
  b.box('stone', s + 0.1, h * 0.14, s + 0.1, cx, y, cz); // moulded base
  b.box('stone', s + 0.26, 0.09, s + 0.26, cx, y + h, cz); // cornice (kapota)
  b.box('stone', s + 0.14, 0.06, s + 0.14, cx, y + h + 0.09, cz); // drip course
  b.detail(true);
  const o = s / 2 + 0.03;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kuta(b, cx + sx * (s / 2 + 0.02), y + h + 0.15, cz + sz * (s / 2 + 0.02), 0.24 * Math.min(1, s / 1.6 + 0.4));
  b.kudu('stone', s * 0.26, h * 0.62, cx, y + h * 0.18, cz + o * front);
  b.kudu('stone', s * 0.26, h * 0.62, cx + o, y + h * 0.18, cz, Math.PI / 2);
  b.kudu('stone', s * 0.26, h * 0.62, cx - o, y + h * 0.18, cz, -Math.PI / 2);
  b.kudu('stone', s * 0.26, h * 0.62, cx, y + h * 0.18, cz - o * front, Math.PI);
  for (const [dx, dz, r] of [[0, 1, 0], [0, -1, Math.PI], [1, 0, Math.PI / 2], [-1, 0, -Math.PI / 2]] as const) {
    // sala: a small barrel roof over the middle of each face, on the cornice
    b.barrel('tile', s * 0.3, 0.2, 0.36, cx + dx * (s / 2 + 0.05), y + h + 0.15, cz + dz * (s / 2 + 0.05), r === 0 || r === Math.PI ? 0 : Math.PI / 2, 6);
  }
  b.detail(false);
  return y + h + 0.15;
}

/** Octagonal neck, tapered crown and gilt kalasa. Returns the top y. */
function crown(b: ModelBuilder, y: number, r: number, cx: number, cz: number): number {
  b.cyl('sandstone', r * 0.78, r, r * 0.8, cx, y, cz, 8);
  b.cyl('stone', r * 0.5, r * 0.8, r * 0.9, cx, y + r * 0.8, cz, 8);
  b.detail(true);
  b.lathe('gold', [[0, 0], [0.1, 0.03], [0.15, 0.12], [0.1, 0.24], [0.05, 0.29], [0.07, 0.34], [0.035, 0.44], [0, 0.55]], cx, y + r * 1.7, cz, 8);
  b.detail(false);
  return y + r * 1.7 + 0.55;
}

function palace(b: ModelBuilder): void {
  const top = plinth(b, [[5.8, 5.8, 0.2], [5.6, 5.6, 0.12], [5.4, 5.4, 0.2]]); // ≈0.52
  // hall
  b.window(0.2, 0.52);
  b.box('plaster', 4.4, 1.7, 3.0, 0, top, -0.5);
  b.box('stone', 4.5, 0.22, 3.1, 0, top, -0.5);
  b.box('timber', 4.5, 0.16, 3.1, 0, top + 1.7, -0.5);
  for (const x of [-2.2, 2.2]) for (const z of [-2.0, 1.0]) b.box('stone', 0.24, 1.8, 0.24, x, top, z);
  b.box('dark', 0.95, 1.3, 0.06, 0, top, 1.02);
  b.box('stone', 1.2, 0.16, 0.12, 0, top + 1.3, 1.03);
  b.detail(true);
  for (const x of [-1.5, 1.5]) b.kudu('stone', 0.62, 0.95, x, top + 0.45, 1.0);
  for (const x of [-1.5, 1.5]) b.kudu('stone', 0.62, 0.95, x, top + 0.45, -2.02, Math.PI);
  b.detail(false);
  // pillared portico
  b.window(0.3, 0.6);
  for (let i = 0; i < 5; i++) b.pillar(-1.8 + i * 0.9, 1.9, top, 1.65, true);
  b.box('timber', 4.3, 0.2, 0.42, 0, top + 1.65, 1.9);
  b.box('stone', 4.6, 0.1, 1.5, 0, top - 0.02, 1.7);
  // roofs
  b.window(0.5, 0.82);
  b.hipRoof('tile', 5.1, 3.9, 1.15, 2.8, 0, top + 1.86, -0.5);
  b.hipRoof('tile', 4.7, 1.6, 0.5, 3.6, 0, top + 1.86, 1.75);
  // shrine tower over the hall
  b.window(0.58, 0.95);
  let y = top + 1.86 + 0.3;
  const sizes = [2.0, 1.55, 1.1];
  sizes.forEach((s, i) => { y = tala(b, s, 0.72 - i * 0.05, y, 0, -0.5); });
  crown(b, y, 0.42, 0, -0.5);
  // finishing: banners, lamp posts, steps
  b.window(0.85, 1);
  b.steps('stone', 1.9, 3, 0.17, 0.1, 0, 0, 3.0);
  b.banner(-2.55, 2.5, top, 1.9);
  b.banner(2.55, 2.5, top, 1.9);
  b.detail(true);
  for (const x of [-1.2, 1.2]) { b.cyl('bronze', 0.05, 0.06, 0.6, x, top, 2.62, 6); b.cyl('bronze', 0.15, 0.06, 0.1, x, top + 0.6, 2.62, 8); }
  b.detail(false);
}

function temple(b: ModelBuilder, variant: number): void {
  const talas = 3 + (variant % 3);
  const top = plinth(b, [[4.8, 4.8, 0.16], [4.5, 4.5, 0.16], [4.6, 4.6, 0.06]]); // ≈0.58
  // prakara: low compound wall on three sides, with a gap at the front
  b.window(0.15, 0.4);
  b.box('stone', 4.3, 0.34, 0.2, 0, top, -2.2);
  b.box('stone', 0.2, 0.34, 3.6, -2.15, top, -0.4);
  b.box('stone', 0.2, 0.34, 3.6, 2.15, top, -0.4);
  b.detail(true);
  for (const x of [-2.15, 2.15]) for (const z of [-2.2, 1.4]) {
    b.box('stone', 0.34, 0.14, 0.34, x, top + 0.34, z); // nandi on the corner
    b.add('stone', new THREE.SphereGeometry(0.15, 6, 5).scale(1, 0.8, 1.2).translate(x, top + 0.58, z));
  }
  b.detail(false);
  // vimana
  b.window(0.2, 0.55);
  const vz = -0.55;
  const first = 2.7;
  let y = top;
  b.box('dark', 0.55, 0.9, 0.06, 0, top, vz + first / 2 + 0.02);
  const tops: number[] = [];
  for (let i = 0; i < talas; i++) {
    const s = first - i * 0.42;
    const h = 0.78 - i * 0.05;
    b.window(0.2 + (i / talas) * 0.5, 0.35 + ((i + 1) / talas) * 0.55);
    y = tala(b, s, h, y, 0, vz);
    tops.push(y);
  }
  b.window(0.85, 1);
  crown(b, y, 0.5 - talas * 0.02, 0, vz);
  // mandapa: open pillared porch with a barrel roof
  b.window(0.3, 0.7);
  for (const x of [-0.95, 0.95]) for (const z of [1.2, 2.1]) b.pillar(x, z, top, 1.4, z > 2);
  b.box('timber', 2.3, 0.18, 1.2, 0, top + 1.4, 1.65);
  b.window(0.55, 0.85);
  b.barrel('tile', 2.5, 0.8, 1.5, 0, top + 1.58, 1.65, 0, 10);
  b.window(0.85, 1);
  b.steps('stone', 1.6, 3, 0.19, 0.1, 0, 0, 2.5);
  b.detail(true);
  b.banner(1.55, 2.2, top, 1.5, 0.5);
  b.detail(false);
}

function barracks(b: ModelBuilder, variant: number): void {
  const top = plinth(b, [[3.9, 2.9, 0.16], [3.7, 2.7, 0.16]]);
  b.window(0.2, 0.55);
  b.box('plaster', 3.1, 1.2, 1.9, 0, top, -0.2);
  b.box('stone', 3.2, 0.18, 2.0, 0, top, -0.2);
  b.box('timber', 3.2, 0.12, 2.0, 0, top + 1.2, -0.2);
  b.box('dark', 0.8, 1.0, 0.06, 0, top, 0.77);
  b.detail(true);
  for (const x of [-1.2, 1.2]) { b.box('timber', 0.34, 0.34, 0.05, x, top + 0.55, 0.76); b.box('dark', 0.2, 0.2, 0.06, x, top + 0.62, 0.765); }
  for (let i = 0; i < 4; i++) b.box('timber', 0.1, 1.2, 0.1, -1.5 + i * 1.0, top, 0.78); // framing posts
  b.detail(false);
  // veranda
  b.window(0.35, 0.65);
  for (let i = 0; i < 4; i++) b.box('timber', 0.12, 1.2, 0.12, -1.5 + i * 1.0, top, 1.3);
  b.box('timber', 3.3, 0.14, 0.2, 0, top + 1.2, 1.3);
  // roofs
  b.window(0.5, 0.85);
  b.hipRoof('tile', 3.9, 2.8, 0.95, 2.2, 0, top + 1.32, -0.15);
  b.hipRoof('tile', 3.5, 0.9, 0.3, 3.0, 0, top + 1.3, 1.1);
  // finish: weapon rack, dummy, shield and banner
  b.window(0.85, 1);
  const side = variant % 2 ? -1 : 1;
  b.detail(true);
  b.box('timber', 0.9, 0.08, 0.08, -side * 1.2, top + 0.85, 1.05);
  for (const x of [-0.35, -0.1, 0.15, 0.4]) b.cyl('timber', 0.015, 0.015, 1.1, -side * 1.2 + x, top + 0.04, 1.08, 4);
  for (const x of [-0.35, -0.1, 0.15, 0.4]) b.cyl('bronze', 0.0, 0.035, 0.12, -side * 1.2 + x, top + 1.14, 1.08, 4);
  b.cyl('timber', 0.04, 0.05, 1.0, side * 1.35, top, 1.08, 5);
  b.box('timber', 0.6, 0.06, 0.06, side * 1.35, top + 0.75, 1.08);
  b.cyl('bronze', 0.2, 0.2, 0.04, 0, top + 1.45, 0.78, 10);
  b.detail(false);
  b.banner(side * 1.6, 1.25, top, 1.9);
}

function farm(b: ModelBuilder, variant: number): void {
  b.window(0, 0.15);
  b.box('earth', 3.9, 0.4, 3.9, 0, -0.3, 0);
  const cells: Array<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const hut = variant % 2 ? 0 : 1; // which back corner holds the granary
  cells.forEach(([cx, cz], idx) => {
    const x = cx * 0.97, z = cz * 0.97;
    if (idx === hut && cz < 0) return;
    b.window(0.1, 0.4);
    b.box('earth', 1.8, 0.14, 0.12, x, 0.1, z - 0.84); b.box('earth', 1.8, 0.14, 0.12, x, 0.1, z + 0.84);
    b.box('earth', 0.12, 0.14, 1.56, x - 0.84, 0.1, z); b.box('earth', 0.12, 0.14, 1.56, x + 0.84, 0.1, z);
    b.window(0.2, 0.5);
    b.box('water', 1.58, 0.05, 1.58, x, 0.1, z);
    b.window(0.45, 0.95);
    b.detail(true);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const rx = x - 0.54 + i * 0.36 + (hash2(i, j, idx + 7) - 0.5) * 0.08, rz = z - 0.54 + j * 0.36 + (hash2(j, i, idx + 3) - 0.5) * 0.08;
      for (const a of [0, Math.PI / 2]) b.add('rice', new THREE.PlaneGeometry(0.2, 0.34, 1, 2).translate(0, 0.17, 0).rotateY(a + hash2(i, j, 9) * 0.6).translate(rx, 0.15, rz));
    }
    b.detail(false);
  });
  // granary on stilts
  const hx = (hut ? 1 : -1) * 0.97, hz = -0.97;
  b.window(0.3, 0.6);
  for (const dx of [-0.42, 0.42]) for (const dz of [-0.42, 0.42]) b.box('timber', 0.1, 0.6, 0.1, hx + dx, 0.1, hz + dz);
  b.box('timber', 1.1, 0.1, 1.1, hx, 0.7, hz);
  b.box('plaster', 0.95, 0.7, 0.95, hx, 0.8, hz);
  b.box('dark', 0.3, 0.45, 0.04, hx, 0.85, hz + 0.49);
  b.window(0.6, 0.9);
  b.hipRoof('thatch', 1.55, 1.55, 0.7, 0.5, hx, 1.5, hz);
  b.window(0.85, 1);
  b.detail(true);
  b.box('timber', 0.3, 0.05, 0.05, hx, 0.4, hz + 0.9); // ladder
  for (const dx of [-0.1, 0.1]) b.box('timber', 0.03, 1.0, 0.03, hx + dx, 0.1, hz + 0.78);
  for (const [x, z] of [[-0.1, 1.9], [0.1, 1.9]] as const) b.lathe('tile', [[0, 0], [0.12, 0.03], [0.16, 0.14], [0.1, 0.26], [0.07, 0.3]], x - 1.55 + 0.0, 0.1, z - 0.2, 8);
  b.cyl('timber', 0.04, 0.05, 1.2, 1.9, 0.0, 0.0, 5); // shaduf: post, balance pole, bucket
  b.box('timber', 1.1, 0.05, 0.05, 1.9, 1.15, 0.0, 0.4);
  b.cyl('bronze', 0.08, 0.06, 0.12, 1.55, 0.65, -0.12, 7);
  b.detail(false);
}

function lumber(b: ModelBuilder, variant: number): void {
  b.window(0, 0.15);
  b.box('earth', 2.9, 0.3, 2.9, 0, -0.2, 0);
  const sx = variant % 2 ? -1 : 1;
  // open shed
  b.window(0.15, 0.5);
  for (const x of [-0.9, 0.9]) for (const z of [-0.95, 0.15]) b.box('timber', 0.14, 1.5, 0.14, sx * 0.1 + x * 0.9, 0.1, z - 0.3);
  b.box('timber', 2.0, 0.12, 0.14, sx * 0.1, 1.55, -1.25); b.box('timber', 2.0, 0.12, 0.14, sx * 0.1, 1.55, -0.15);
  b.window(0.5, 0.85);
  b.hipRoof('thatch', 2.5, 1.9, 0.7, 1.6, sx * 0.1, 1.6, -0.7);
  // trestle and planks under the shed
  b.window(0.3, 0.7);
  b.box('timber', 1.2, 0.1, 0.4, sx * 0.1, 0.55, -0.7);
  for (const x of [-0.45, 0.45]) b.box('timber', 0.08, 0.5, 0.4, sx * 0.1 + x, 0.1, -0.7);
  b.detail(true);
  for (let i = 0; i < 4; i++) b.box('timber', 0.9, 0.05, 0.3, -sx * 0.9, 0.1 + i * 0.06, -0.9 + hash2(i, 2, 5) * 0.04);
  b.detail(false);
  // log pile in front (the first thing a visitor sees)
  b.window(0.1, 0.9);
  const rows = [4, 3, 2];
  rows.forEach((n, r) => { for (let i = 0; i < n; i++) b.add('timber', new THREE.CylinderGeometry(0.15, 0.15, 1.5, 7).rotateZ(Math.PI / 2).translate(-sx * 0.2 + (i - (n - 1) / 2) * 0.0, 0.17 + r * 0.26, 0.9 + (i - (n - 1) / 2) * 0.32)); });
  b.window(0.85, 1);
  b.detail(true);
  b.cyl('timber', 0.22, 0.25, 0.4, sx * 1.1, 0.0, 0.8, 8); // chopping block
  b.box('timber', 0.05, 0.5, 0.05, sx * 1.1, 0.4, 0.8, 0.6);
  b.box('bronze', 0.16, 0.12, 0.04, sx * 1.1 + 0.07, 0.8, 0.8);
  b.detail(false);
}

function quarry(b: ModelBuilder, variant: number): void {
  const sx = variant % 2 ? -1 : 1;
  b.window(0, 0.2);
  b.box('earth', 2.9, 0.3, 2.9, 0, -0.2, 0);
  // the rock face: a few big jittered boulders stacked against the back
  b.window(0.05, 0.6);
  b.add('rock', rock(11, 0.8, 1.5, 1.05, 1.0).translate(-sx * 0.3, 0.55, -0.8));
  b.add('rock', rock(23, 0.7, 1.2, 1.05, 0.9).translate(sx * 0.75, 0.5, -1.0));
  b.add('rock', rock(37, 0.6, 1.0, 1.15, 0.9).translate(-sx * 0.8, 1.0, -1.05));
  b.detail(true);
  b.add('rock', rock(51, 0.38, 1, 0.8, 1).translate(-sx * 1.1, 0.2, 0.2));
  b.add('rock', rock(61, 0.3, 1, 0.8, 1).translate(sx * 0.4, 0.16, -0.2));
  b.detail(false);
  // cut terrace and dressed blocks
  b.window(0.3, 0.9);
  b.box('sandstone', 1.5, 0.3, 0.9, -sx * 0.1, 0.1, -0.1);
  b.box('sandstone', 1.1, 0.3, 0.7, -sx * 0.1, 0.4, -0.05);
  for (let i = 0; i < 3; i++) for (let j = 0; j <= i; j++) b.box('sandstone', 0.42, 0.26, 0.3, sx * (0.65 + i * 0.0) + (j - i / 2) * 0.0, 0.1 + (2 - i) * 0.27, 0.95 + (j - i / 2) * 0.35, (hash2(i, j, 4) - 0.5) * 0.2);
  // a-frame hoist
  b.window(0.7, 1);
  const hx = -sx * 1.0;
  b.add('timber', new THREE.CylinderGeometry(0.05, 0.06, 1.9, 5).rotateZ(0.32).translate(hx - 0.3, 1.0, 0.9));
  b.add('timber', new THREE.CylinderGeometry(0.05, 0.06, 1.9, 5).rotateZ(-0.32).translate(hx + 0.3, 1.0, 0.9));
  b.box('timber', 1.2, 0.07, 0.07, hx, 1.82, 0.9);
  b.cyl('dark', 0.012, 0.012, 0.8, hx, 1.0, 0.9, 4);
  b.box('sandstone', 0.3, 0.22, 0.22, hx, 0.78, 0.9);
  b.detail(true);
  for (const dx of [0.05, 0.14]) b.box('bronze', 0.03, 0.22, 0.03, sx * 1.2 + dx, 0.1, 0.7, 0.3);
  b.detail(false);
}

export type Recipe = (b: ModelBuilder, variant: number) => void;
export const RECIPES: Record<BuildingType, Recipe> = { palace, temple, barracks, farm, lumber, quarry };
