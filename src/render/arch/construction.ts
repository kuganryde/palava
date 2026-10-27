import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { archMaterials } from './archMaterials';

/**
 * Everything that makes a building site read as "being built": timber scaffolding that climbs with the
 * work, a few labourers carrying loads and hammering, and a pile of stone or timber that is used up.
 * Geometry shared by all sites (people, load) is created once; scaffolding is built per site because it
 * depends on the footprint and tower height. Updating a site writes transforms in place (no allocation).
 */

export type PileKind = 'stone' | 'timber';

interface SharedParts {
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  load: THREE.BufferGeometry;
  skin: THREE.MeshStandardMaterial;
  cloths: THREE.MeshStandardMaterial[];
  loadMat: THREE.MeshStandardMaterial;
}
let shared: SharedParts | null = null;
function parts(): SharedParts {
  if (!shared) {
    shared = {
      body: new THREE.CylinderGeometry(0.075, 0.11, 0.46, 6).translate(0, 0.33, 0),
      head: new THREE.SphereGeometry(0.075, 6, 5).translate(0, 0.66, 0),
      load: new THREE.BoxGeometry(0.2, 0.14, 0.2).translate(0, 0.78, 0),
      skin: new THREE.MeshStandardMaterial({ color: 0x8a5a3a, roughness: 0.9 }),
      cloths: [0xe8e0cc, 0xb5532f, 0x2f4f93].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 })),
      loadMat: new THREE.MeshStandardMaterial({ color: 0xb59b72, roughness: 1 }),
    };
  }
  return shared;
}
export function disposeConstructionShared(): void {
  if (!shared) return;
  shared.body.dispose(); shared.head.dispose(); shared.load.dispose();
  shared.skin.dispose(); shared.loadMat.dispose(); shared.cloths.forEach((m) => m.dispose());
  shared = null;
}

interface Worker { root: THREE.Group; body: THREE.Mesh; load: THREE.Mesh; phase: number; hammer: boolean }

const LEVEL_SPACING = 1.0;

export class ConstructionSite {
  readonly group = new THREE.Group();
  private readonly poles: THREE.Mesh;
  private readonly planks: THREE.Mesh;
  private readonly levelTriangles: number[] = [];
  private readonly levelY: number[] = [];
  private readonly workers: Worker[] = [];
  private readonly pile: THREE.Group;
  private readonly hx: number;
  private readonly hz: number;
  private readonly height: number;
  private readonly perimeter: number;

  constructor(w: number, d: number, height: number, private readonly seed = 0, pileKind: PileKind = 'timber') {
    this.height = height + 0.6;
    this.hx = w / 2 - 0.12;
    this.hz = d / 2 - 0.12;
    this.perimeter = 2 * (2 * (this.hx + 0.5) + 2 * (this.hz + 0.5));
    this.group.name = 'construction-site';
    const timber = archMaterials().get('timber');

    // Poles: unit-spaced uprights around the perimeter plus a few diagonal braces on the long faces.
    const pg: THREE.BufferGeometry[] = [];
    const pole = (x: number, z: number): void => { pg.push(new THREE.BoxGeometry(0.07, this.height, 0.07).translate(x, this.height / 2, z)); };
    const nx = Math.max(2, Math.round((this.hx * 2) / 1.3)), nz = Math.max(2, Math.round((this.hz * 2) / 1.3));
    for (let i = 0; i <= nx; i++) { const x = -this.hx + (i / nx) * this.hx * 2; pole(x, this.hz); pole(x, -this.hz); }
    for (let j = 1; j < nz; j++) { const z = -this.hz + (j / nz) * this.hz * 2; pole(this.hx, z); pole(-this.hx, z); }
    for (const z of [this.hz, -this.hz]) {
      const diag = Math.hypot(this.hx * 2, this.height * 0.7);
      pg.push(new THREE.BoxGeometry(0.05, diag, 0.05).rotateZ(Math.atan2(this.hx * 2, this.height * 0.7)).translate(0, this.height * 0.35, z));
    }
    this.poles = new THREE.Mesh(mergeGeometries(pg)!, timber);
    pg.forEach((g) => g.dispose());
    this.poles.castShadow = true;

    // Working platforms, bottom to top, merged in order so a draw range reveals them level by level.
    const lg: THREE.BufferGeometry[] = [];
    for (let y = 0.8; y < this.height; y += LEVEL_SPACING) {
      const level: THREE.BufferGeometry[] = [];
      for (const z of [this.hz, -this.hz]) {
        level.push(new THREE.BoxGeometry(this.hx * 2 + 0.2, 0.06, 0.36).translate(0, y, z + (z > 0 ? 0.12 : -0.12)));
        level.push(new THREE.BoxGeometry(this.hx * 2 + 0.2, 0.05, 0.06).translate(0, y + 0.55, z)); // handrail
      }
      for (const x of [this.hx, -this.hx]) level.push(new THREE.BoxGeometry(0.36, 0.06, this.hz * 2 + 0.2).translate(x + (x > 0 ? 0.12 : -0.12), y, 0));
      const merged = mergeGeometries(level)!;
      level.forEach((g) => g.dispose());
      lg.push(merged);
      this.levelY.push(y);
      this.levelTriangles.push(((merged.index ? merged.index.count : merged.getAttribute('position').count)) / 3);
    }
    this.planks = new THREE.Mesh(mergeGeometries(lg)!, timber);
    lg.forEach((g) => g.dispose());
    this.planks.castShadow = true;
    this.group.add(this.poles, this.planks);

    // Labourers: one hammers at the front corner, the rest ferry loads round the perimeter.
    const p = parts();
    const count = w * d > 14 ? 4 : 3;
    for (let i = 0; i < count; i++) {
      const root = new THREE.Group();
      const body = new THREE.Mesh(p.body, p.cloths[(i + seed) % p.cloths.length]!);
      const head = new THREE.Mesh(p.head, p.skin);
      const load = new THREE.Mesh(p.load, p.loadMat);
      for (const m of [body, head, load]) { m.castShadow = true; }
      root.add(body, head, load);
      this.group.add(root);
      this.workers.push({ root, body, load, phase: i / count, hammer: i === 0 });
    }

    // Material pile at the front-left corner; shrinks as the work consumes it.
    this.pile = new THREE.Group();
    const mats = archMaterials();
    const pg2: THREE.BufferGeometry[] = [];
    if (pileKind === 'stone') {
      for (let i = 0; i < 6; i++) pg2.push(new THREE.BoxGeometry(0.42, 0.24, 0.3).rotateY((i % 3) * 0.3).translate((i % 3) * 0.44 - 0.4, 0.12 + Math.floor(i / 3) * 0.25, (i % 2) * 0.1));
    } else {
      for (let i = 0; i < 6; i++) pg2.push(new THREE.CylinderGeometry(0.1, 0.1, 0.9, 6).rotateZ(Math.PI / 2).translate(0, 0.1 + Math.floor(i / 3) * 0.18, (i % 3) * 0.2 - 0.2));
    }
    const pileMesh = new THREE.Mesh(mergeGeometries(pg2)!, pileKind === 'stone' ? mats.get('sandstone') : timber);
    pg2.forEach((g) => g.dispose());
    pileMesh.castShadow = true;
    this.pile.add(pileMesh);
    this.pile.position.set(-this.hx - 0.2, 0, this.hz + 0.55);
    this.group.add(this.pile);
  }

  /** @param still true for reduced motion: workers hold a pose instead of walking. */
  update(progress: number, time: number, still: boolean): void {
    const reach = progress * (this.height - 0.6) + 1.0;
    this.poles.scale.y = Math.min(1, Math.max(0.12, (reach + 0.4) / this.height));
    let shown = 0;
    for (let i = 0; i < this.levelY.length; i++) if (this.levelY[i]! <= reach) shown += this.levelTriangles[i]!;
    this.planks.geometry.setDrawRange(0, shown * 3);
    const k = Math.max(0.15, 1 - progress * 0.85);
    this.pile.scale.set(1, k, 1);

    const hx = this.hx + 0.5, hz = this.hz + 0.5;
    for (const wk of this.workers) {
      const r = wk.root;
      if (wk.hammer) {
        r.position.set(this.hx * 0.4, 0, this.hz + 0.45);
        r.rotation.y = Math.PI;
        wk.body.rotation.x = still ? 0.1 : Math.sin(time * 7 + this.seed) * 0.18;
        wk.load.visible = false;
        continue;
      }
      // walk the rectangle perimeter (front-left -> clockwise), heading along the path
      const raw = still ? wk.phase : (time * 0.5) / this.perimeter + wk.phase;
      const u = raw - Math.floor(raw); // positive modulo: safe for negative or huge times
      let s = u * this.perimeter;
      const sx = hx * 2, sz = hz * 2;
      let x: number, z: number, yaw: number;
      if (s < sx) { x = -hx + s; z = -hz; yaw = Math.PI / 2; }
      else if ((s -= sx) < sz) { x = hx; z = -hz + s; yaw = 0; }
      else if ((s -= sz) < sx) { x = hx - s; z = hz; yaw = -Math.PI / 2; }
      else { s -= sx; x = -hx; z = hz - s; yaw = Math.PI; }
      r.position.set(x, still ? 0 : Math.abs(Math.sin(time * 6 + wk.phase * 9)) * 0.035, z);
      r.rotation.y = yaw;
      wk.body.rotation.x = 0;
      wk.load.visible = wk.phase > 0.45;
    }
  }

  dispose(): void {
    this.poles.geometry.dispose();
    this.planks.geometry.dispose();
    this.pile.children.forEach((c) => (c as THREE.Mesh).geometry.dispose());
  }
}
