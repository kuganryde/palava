import { clamp, lerp, smoothstep } from '../core/math';
import { fbm } from '../core/noise';

/**
 * Pure heightfield terrain (no Three.js): deterministic from a seed so it is
 * testable, never needs to be saved (only the seed is), and can drive
 * pathfinding, placement and rendering from one source of truth.
 *
 * World units: 1 cell == 1 world unit. Cell (i, j) sits at world (i, j).
 */
export const WATER_LEVEL = 0;
export const DEFAULT_SIZE = 128;

export interface Terrain {
  readonly size: number;
  readonly seed: number;
  readonly heights: Float32Array; // size*size, index = z*size + x
  readonly maxHeight: number;
}

export function capitalCenter(size: number): { x: number; z: number } {
  return { x: Math.round(size * 0.55), z: Math.round(size * 0.58) };
}

export function generateTerrain(seed = 1337, size = DEFAULT_SIZE): Terrain {
  if (!Number.isInteger(size) || size < 32 || size > 512) throw new RangeError(`Invalid terrain size: ${size}`);
  const heights = new Float32Array(size * size);
  const cap = capitalCenter(size);
  const cx = cap.x / (size - 1), cz = cap.z / (size - 1);
  let maxH = -Infinity;
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const nx = x / (size - 1), nz = z / (size - 1);
      let h = 2.2 + (fbm(x * 0.045, z * 0.045, seed) - 0.5) * 5;
      // Rocky highlands in the north-west.
      const m = 1 - smoothstep(0.05, 0.32, Math.hypot(nx - 0.18, nz - 0.2));
      h += m * (6 + fbm(x * 0.08, z * 0.08, seed + 7) * 10);

      // Island silhouette: a rounded (p=3 superellipse) outline whose edge is domain-warped by
      // low-frequency noise, so the coast has headlands, bays and inlets instead of a square cut-off.
      const wx = (fbm(x * 0.03 + 50, z * 0.03 + 11, seed + 211) - 0.5) * 0.2;
      const wz = (fbm(x * 0.03 + 12, z * 0.03 + 77, seed + 223) - 0.5) * 0.2;
      const ex = Math.abs(nx - 0.5 + wx), ez = Math.abs(nz - 0.5 + wz);
      const edge = Math.cbrt(ex * ex * ex + ez * ez * ez) * 2;
      // Finer coastal erosion: small-scale noise bites into the shoreline band only.
      const erosion = (fbm(x * 0.16, z * 0.16, seed + 241) - 0.5) * 0.22;
      const coast = edge + erosion * smoothstep(0.55, 0.85, edge);

      // Inland relief fades out toward the sea so beaches stay gentle.
      const inland = 1 - smoothstep(0.5, 0.78, coast);
      // Rolling hills (ridged noise) in broad zones.
      const hillZone = smoothstep(0.38, 0.62, fbm(x * 0.02 + 5, z * 0.02 + 9, seed + 313));
      const ridge = 1 - Math.abs(fbm(x * 0.06 + 9, z * 0.06 + 3, seed + 317) * 2 - 1);
      h += (ridge - 0.45) * 3.4 * hillZone * inland;
      // Rocky outcrops: stepped, strata-like bumps where a sparse noise field peaks.
      const o = fbm(x * 0.11, z * 0.11, seed + 331);
      if (o > 0.64) {
        const tier = Math.floor(fbm(x * 0.35, z * 0.35, seed + 337) * 3);
        h += smoothstep(0.64, 0.72, o) * (1.1 + 0.55 * tier) * inland;
      }

      // Ocean falloff, deeper to the east (coastal backdrop).
      h -= smoothstep(0.72, 1.0, coast) * 9;
      h -= smoothstep(0.62, 0.92, nx) * 5;
      // A meandering river from the highlands to the southern sea.
      const rx = 0.27 + 0.05 * Math.sin(nz * 6 + seed * 0.3);
      h -= (1 - smoothstep(0, 0.03, Math.abs(nx - rx))) * 3.6 * smoothstep(0.2, 0.3, nz);
      // Flat plateau for the capital.
      const w = 1 - smoothstep(0.07, 0.15, Math.hypot(nx - cx, nz - cz));
      h = lerp(h, 2.6, w);
      heights[z * size + x] = h;
      if (h > maxH) maxH = h;
    }
  }
  return { size, seed, heights, maxHeight: maxH };
}

export function inBounds(t: Terrain, x: number, z: number): boolean {
  return x >= 0 && z >= 0 && x <= t.size - 1 && z <= t.size - 1;
}

export function cellHeight(t: Terrain, ix: number, iz: number): number {
  const x = clamp(ix, 0, t.size - 1), z = clamp(iz, 0, t.size - 1);
  return t.heights[z * t.size + x]!;
}

/** Bilinear height sample at world (x, z); clamps outside the map. */
export function heightAt(t: Terrain, x: number, z: number): number {
  const fx = clamp(x, 0, t.size - 1), fz = clamp(z, 0, t.size - 1);
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, t.size - 1), z1 = Math.min(z0 + 1, t.size - 1);
  const tx = fx - x0, tz = fz - z0;
  const h = t.heights;
  const n = t.size;
  return lerp(lerp(h[z0 * n + x0]!, h[z0 * n + x1]!, tx), lerp(h[z1 * n + x0]!, h[z1 * n + x1]!, tx), tz);
}

/**
 * Ray vs heightfield by marching + bisection. Used for ground picking so we
 * never raycast a 32k-triangle mesh. Returns the first hit above the map, or null.
 */
export function intersectRay(
  t: Terrain,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist = 800,
): { x: number; y: number; z: number } | null {
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-9) || !Number.isFinite(len)) return null;
  dx /= len; dy /= len; dz /= len;
  let tStart = 0;
  const top = t.maxHeight + 1;
  if (oy > top) {
    if (dy >= 0) return null; // pointing away from the terrain
    tStart = (top - oy) / dy;
  }
  const step = 0.5;
  let prevT = tStart;
  for (let s = tStart; s <= maxDist; s += step) {
    const x = ox + dx * s, y = oy + dy * s, z = oz + dz * s;
    if (inBounds(t, x, z) && y <= heightAt(t, x, z)) {
      let lo = prevT, hi = s;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        const mx = ox + dx * mid, my = oy + dy * mid, mz = oz + dz * mid;
        if (inBounds(t, mx, mz) && my <= heightAt(t, mx, mz)) hi = mid; else lo = mid;
      }
      const px = ox + dx * hi, py = oy + dy * hi, pz = oz + dz * hi;
      return { x: px, y: py, z: pz };
    }
    prevT = s;
  }
  return null;
}
