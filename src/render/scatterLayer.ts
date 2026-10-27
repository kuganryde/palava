import * as THREE from 'three';

export interface ScatterItem {
  x: number;
  y: number;
  z: number;
  scale: number;
  rot: number;
  tint: number; // 0..1
  lean?: number;
  /** Vertical stretch relative to `scale` (1 = uniform). */
  stretchY?: number;
}

export interface ScatterLayerOptions {
  name: string;
  hi: THREE.BufferGeometry;
  lo: THREE.BufferGeometry;
  material: THREE.Material;
  items: readonly ScatterItem[];
  /** Colour multipliers blended by `tint`; keeps every instance subtly different. */
  tintA: THREE.Color;
  tintB: THREE.Color;
  castShadow: boolean;
  chunk?: number;
  yOffset?: number;
}

interface Chunk {
  mesh: THREE.InstancedMesh;
  total: number;
  items: ScatterItem[];
  hidden: Set<number>;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * One kind of scattered object (e.g. broadleaf trees) as a grid of InstancedMesh chunks.
 *
 * Why chunks: a single InstancedMesh is frustum-culled as one unit, so the whole forest would be
 * drawn even when only a corner is on screen. Chunks restore culling, and let LOD swap geometry
 * per layer. Items arrive pre-shuffled, so a prefix of each chunk is a uniform density subset.
 */
export class ScatterLayer {
  readonly group = new THREE.Group();
  private readonly chunks: Chunk[] = [];
  private detail: 0 | 1 = 0;
  private fraction = 1;
  private readonly hi: THREE.BufferGeometry;
  private readonly lo: THREE.BufferGeometry;
  private readonly yOffset: number;
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _ql = new THREE.Quaternion();
  private readonly _s = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  private static readonly FWD = new THREE.Vector3(1, 0, 0);
  readonly total: number;

  constructor(opts: ScatterLayerOptions) {
    this.hi = opts.hi;
    this.lo = opts.lo;
    this.total = opts.items.length;
    this.yOffset = opts.yOffset ?? 0;
    this.group.name = opts.name;
    const size = opts.chunk ?? 32;
    const buckets = new Map<number, ScatterItem[]>();
    for (const it of opts.items) {
      const k = Math.floor(it.x / size) * 4096 + Math.floor(it.z / size);
      let b = buckets.get(k);
      if (!b) { b = []; buckets.set(k, b); }
      b.push(it);
    }
    const color = new THREE.Color();
    const ca = opts.tintA, cb = opts.tintB;
    for (const items of buckets.values()) {
      const mesh = new THREE.InstancedMesh(this.hi, opts.material, items.length);
      mesh.name = opts.name;
      mesh.castShadow = opts.castShadow;
      mesh.receiveShadow = true;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      items.forEach((it, i) => {
        this.writeMatrix(mesh, i, it, true);
        mesh.setColorAt(i, color.copy(ca).lerp(cb, it.tint));
        minX = Math.min(minX, it.x); maxX = Math.max(maxX, it.x);
        minZ = Math.min(minZ, it.z); maxZ = Math.max(maxZ, it.z);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere(); // enables per-chunk frustum culling
      this.group.add(mesh);
      this.chunks.push({ mesh, total: items.length, items, hidden: new Set(), minX, maxX, minZ, maxZ });
    }
  }

  private writeMatrix(mesh: THREE.InstancedMesh, i: number, it: ScatterItem, visible: boolean): void {
    this._q.setFromAxisAngle(ScatterLayer.UP, it.rot);
    if (it.lean) this._q.multiply(this._ql.setFromAxisAngle(ScatterLayer.FWD, it.lean));
    this._p.set(it.x, it.y + this.yOffset, it.z);
    // A zero scale collapses the instance to a point: cheaper than re-packing the buffer, and reversible.
    if (visible) this._s.set(it.scale, it.scale * (it.stretchY ?? 1), it.scale); else this._s.set(0, 0, 0);
    mesh.setMatrixAt(i, this._m.compose(this._p, this._q, this._s));
  }

  /** Hides every instance whose position lies in the rectangle. Returns how many were newly hidden. */
  hideInRect(x0: number, z0: number, x1: number, z1: number): number {
    let n = 0;
    for (const c of this.chunks) {
      if (c.maxX < x0 || c.minX > x1 || c.maxZ < z0 || c.minZ > z1) continue;
      let touched = false;
      for (let i = 0; i < c.items.length; i++) {
        const it = c.items[i]!;
        if (it.x < x0 || it.x > x1 || it.z < z0 || it.z > z1 || c.hidden.has(i)) continue;
        c.hidden.add(i);
        this.writeMatrix(c.mesh, i, it, false);
        touched = true;
        n++;
      }
      if (touched) c.mesh.instanceMatrix.needsUpdate = true;
    }
    return n;
  }

  restoreAll(): void {
    for (const c of this.chunks) {
      if (c.hidden.size === 0) continue;
      for (const i of c.hidden) this.writeMatrix(c.mesh, i, c.items[i]!, true);
      c.hidden.clear();
      c.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  hiddenCount(): number {
    let n = 0;
    for (const c of this.chunks) n += c.hidden.size;
    return n;
  }

  /** Draw only this share of every chunk. */
  setFraction(f: number): void {
    const v = Math.max(0, Math.min(1, f));
    if (Math.abs(v - this.fraction) < 0.005) return;
    this.fraction = v;
    for (const c of this.chunks) c.mesh.count = Math.floor(c.total * v);
    this.group.visible = v > 0;
  }

  /** 0 = full detail, 1 = distant/low detail. Cheap: only swaps a geometry reference. */
  setDetail(level: 0 | 1): void {
    if (level === this.detail) return;
    this.detail = level;
    const g = level === 0 ? this.hi : this.lo;
    for (const c of this.chunks) c.mesh.geometry = g;
  }

  setCastShadow(v: boolean): void {
    for (const c of this.chunks) c.mesh.castShadow = v;
  }

  get drawn(): number {
    let n = 0;
    for (const c of this.chunks) n += c.mesh.count;
    return n;
  }

  get chunkCount(): number { return this.chunks.length; }

  /** Frees GPU buffers. Geometries/materials are shared and owned by the caller. */
  dispose(): void {
    for (const c of this.chunks) c.mesh.dispose();
    this.group.clear();
    this.chunks.length = 0;
  }
}
