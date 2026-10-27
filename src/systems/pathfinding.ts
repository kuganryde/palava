import { WATER_LEVEL, type Terrain } from '../world/terrain';

export interface NavGrid {
  readonly size: number;
  readonly blocked: Uint8Array; // 1 = impassable
}
export interface Point { x: number; z: number }

const MIN_LAND = 0.3; // cells below this height above water are impassable (shoreline)
const MAX_STEP = 1.2; // max height delta to a 4-neighbour before a cell counts as a cliff
const MAX_ITER = 60000; // A* safety valve so a pathological request can never freeze the tab

export function buildNavGrid(t: Terrain): NavGrid {
  const n = t.size;
  const blocked = new Uint8Array(n * n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const h = t.heights[z * n + x]!;
      let b = h <= WATER_LEVEL + MIN_LAND || x < 1 || z < 1 || x > n - 2 || z > n - 2;
      if (!b) {
        const nb = [t.heights[z * n + x - 1]!, t.heights[z * n + x + 1]!, t.heights[(z - 1) * n + x]!, t.heights[(z + 1) * n + x]!];
        for (const v of nb) if (Math.abs(v - h) > MAX_STEP) { b = true; break; }
      }
      blocked[z * n + x] = b ? 1 : 0;
    }
  }
  return { size: n, blocked };
}

export function isBlocked(nav: NavGrid, x: number, z: number): boolean {
  const ix = Math.round(x), iz = Math.round(z);
  if (ix < 0 || iz < 0 || ix >= nav.size || iz >= nav.size) return true;
  return nav.blocked[iz * nav.size + ix] === 1;
}

export function setBlockedRect(nav: NavGrid, x0: number, z0: number, w: number, d: number, value: boolean): void {
  for (let z = z0; z < z0 + d; z++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x >= 0 && z >= 0 && x < nav.size && z < nav.size) nav.blocked[z * nav.size + x] = value ? 1 : 0;
    }
  }
}

/** Nearest walkable cell centre to (x, z) by expanding rings, or null. */
export function nearestWalkable(nav: NavGrid, x: number, z: number, maxRadius = 16): Point | null {
  const cx = Math.round(x), cz = Math.round(z);
  if (!isBlocked(nav, cx, cz)) return { x: cx, z: cz };
  for (let r = 1; r <= maxRadius; r++) {
    let best: Point | null = null, bestD = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const px = cx + dx, pz = cz + dz;
        if (isBlocked(nav, px, pz)) continue;
        const d = Math.hypot(px - x, pz - z);
        if (d < bestD) { bestD = d; best = { x: px, z: pz }; }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Conservative line-of-sight: samples the segment every 0.25 cells. */
export function lineOfSight(nav: NavGrid, ax: number, az: number, bx: number, bz: number): boolean {
  const len = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(len / 0.25));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (isBlocked(nav, ax + (bx - ax) * t, az + (bz - az) * t)) return false;
  }
  return true;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number { return this.keys.length; }
  push(key: number, val: number): void {
    const k = this.keys, v = this.vals;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= key) break;
      k[i] = k[p]!; v[i] = v[p]!;
      i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const k = this.keys, v = this.vals;
    const top = v[0]!;
    const lk = k.pop()!, lv = v.pop()!;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1]! < k[c]!) c++;
        if (k[c]! >= lk) break;
        k[i] = k[c]!; v[i] = v[c]!;
        i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

const SQRT2 = Math.SQRT2;
const DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

/**
 * 8-direction A* with no corner cutting, followed by line-of-sight smoothing.
 * Returns waypoints excluding the start, or null when unreachable.
 * If the goal cell is blocked, the nearest walkable cell is used instead.
 */
export function findPath(nav: NavGrid, sx: number, sz: number, gx: number, gz: number): Point[] | null {
  const n = nav.size;
  const start = nearestWalkable(nav, sx, sz, 6);
  const exactGoal = !isBlocked(nav, gx, gz);
  const goal = nearestWalkable(nav, gx, gz, 16);
  if (!start || !goal) return null;
  const s = start.z * n + start.x, g = goal.z * n + goal.x;
  const finalPoint: Point = exactGoal ? { x: gx, z: gz } : { x: goal.x, z: goal.z };
  if (s === g) return [finalPoint];

  const gCost = new Float32Array(n * n).fill(Infinity);
  const parent = new Int32Array(n * n).fill(-1);
  const closed = new Uint8Array(n * n);
  const heap = new MinHeap();
  const h = (x: number, z: number): number => {
    const dx = Math.abs(x - goal.x), dz = Math.abs(z - goal.z);
    return dx + dz + (SQRT2 - 2) * Math.min(dx, dz);
  };
  gCost[s] = 0;
  heap.push(h(start.x, start.z), s);
  let iter = 0, found = false;
  while (heap.size > 0 && iter++ < MAX_ITER) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === g) { found = true; break; }
    const cx = cur % n, cz = (cur / n) | 0;
    for (const [dx, dz, cost] of DIRS) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const ni = nz * n + nx;
      if (closed[ni] || nav.blocked[ni]) continue;
      if (dx !== 0 && dz !== 0 && (nav.blocked[cz * n + nx] || nav.blocked[nz * n + cx])) continue; // no corner cutting
      const ng = gCost[cur]! + cost;
      if (ng < gCost[ni]!) {
        gCost[ni] = ng;
        parent[ni] = cur;
        heap.push(ng + h(nx, nz), ni);
      }
    }
  }
  if (!found) return null;

  const cells: Point[] = [];
  for (let c = g; c !== -1; c = parent[c]!) cells.push({ x: c % n, z: (c / n) | 0 });
  cells.reverse(); // start ... goal

  // Greedy line-of-sight smoothing.
  const out: Point[] = [];
  let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    while (j > i + 1 && !lineOfSight(nav, cells[i]!.x, cells[i]!.z, cells[j]!.x, cells[j]!.z)) j--;
    out.push(cells[j]!);
    i = j;
  }
  out[out.length - 1] = finalPoint;
  return out;
}
