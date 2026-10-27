import { clamp, smoothstep } from '../core/math';
import { fbm } from '../core/noise';
import { capitalCenter, WATER_LEVEL, type Terrain } from './terrain';

/**
 * Derived, per-cell environment data (slope, distance to water, moisture, forest density, biome).
 * Pure and deterministic: it is recomputed from the terrain seed, never saved, and shared by the
 * terrain shader colours, the vegetation scatter and the minimap so they always agree.
 */
export const Biome = {
  Water: 0,
  Beach: 1,
  Grassland: 2,
  Scrub: 3,
  Forest: 4,
  Grove: 5, // moist palm groves along the coast and river banks
  Rock: 6,
  Highland: 7,
} as const;
export type BiomeId = (typeof Biome)[keyof typeof Biome];

export interface BiomeMap {
  readonly size: number;
  /** Largest height step to a 4-neighbour, in world units per cell. */
  readonly slope: Float32Array;
  /** Distance in cells to the nearest water cell (0 on water). */
  readonly waterDist: Float32Array;
  /** 0 (arid) .. 1 (saturated). */
  readonly moisture: Float32Array;
  /** 0 (open ground) .. 1 (closed forest). Intermediate values are forest edges. */
  readonly forest: Float32Array;
  readonly biome: Uint8Array;
}

const cache = new WeakMap<Terrain, BiomeMap>();

/** Memoised per terrain object (the terrain is immutable once generated). */
export function biomeMapFor(t: Terrain): BiomeMap {
  let m = cache.get(t);
  if (!m) { m = computeBiomes(t); cache.set(t, m); }
  return m;
}

/** Two-pass chamfer distance transform (1 for axis steps, 1.414 for diagonals). */
function distanceToWater(t: Terrain): Float32Array {
  const n = t.size;
  const d = new Float32Array(n * n);
  const FAR = 1e4;
  for (let i = 0; i < d.length; i++) d[i] = t.heights[i]! <= WATER_LEVEL ? 0 : FAR;
  const D = Math.SQRT2;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      if (z > 0) {
        v = Math.min(v, d[i - n]! + 1);
        if (x > 0) v = Math.min(v, d[i - n - 1]! + D);
        if (x < n - 1) v = Math.min(v, d[i - n + 1]! + D);
      }
      d[i] = v;
    }
  }
  for (let z = n - 1; z >= 0; z--) {
    for (let x = n - 1; x >= 0; x--) {
      const i = z * n + x;
      let v = d[i]!;
      if (x < n - 1) v = Math.min(v, d[i + 1]! + 1);
      if (z < n - 1) {
        v = Math.min(v, d[i + n]! + 1);
        if (x < n - 1) v = Math.min(v, d[i + n + 1]! + D);
        if (x > 0) v = Math.min(v, d[i + n - 1]! + D);
      }
      d[i] = v;
    }
  }
  return d;
}

export function computeBiomes(t: Terrain): BiomeMap {
  const n = t.size;
  const cap = capitalCenter(n);
  const slope = new Float32Array(n * n);
  const moisture = new Float32Array(n * n);
  const forest = new Float32Array(n * n);
  const biome = new Uint8Array(n * n);
  const waterDist = distanceToWater(t);
  const H = (x: number, z: number): number => t.heights[clamp(z, 0, n - 1) * n + clamp(x, 0, n - 1)]!;

  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const h = t.heights[i]!;
      const s = Math.max(Math.abs(H(x + 1, z) - h), Math.abs(H(x - 1, z) - h), Math.abs(H(x, z + 1) - h), Math.abs(H(x, z - 1) - h));
      slope[i] = s;

      // Moisture: wet near water, patchy elsewhere, drier on high ground.
      const wet = Math.exp(-waterDist[i]! / 12);
      const m = 0.62 * wet + 0.38 * fbm(x * 0.05 + 3, z * 0.05 + 8, t.seed + 401) - 0.12 * smoothstep(3, 9, h) + 0.1;
      moisture[i] = h <= WATER_LEVEL ? 1 : clamp(m, 0, 1);

      // Forest density: patchy noise biased by moisture, suppressed on slopes, peaks and the capital.
      const patch = fbm(x * 0.06, z * 0.06, t.seed + 409);
      let f = smoothstep(0.34, 0.54, patch * 0.78 + moisture[i]! * 0.5 - 0.1);
      f *= 1 - smoothstep(0.7, 1.1, s);
      f *= 1 - smoothstep(6, 8.5, h);
      f *= smoothstep(WATER_LEVEL + 0.3, WATER_LEVEL + 1.2, h);
      f *= smoothstep(15, 21, Math.hypot(x - cap.x, z - cap.z));
      forest[i] = f;

      let b: BiomeId;
      if (h <= WATER_LEVEL) b = Biome.Water;
      else if (h > 9) b = Biome.Highland;
      else if (s > 1.0 || h > 7.5) b = Biome.Rock;
      else if (h < WATER_LEVEL + 0.9) b = Biome.Beach;
      else if (f > 0.55) b = Biome.Forest;
      else if (moisture[i]! > 0.62 && waterDist[i]! < 10) b = Biome.Grove;
      else if (moisture[i]! < 0.3) b = Biome.Scrub;
      else b = Biome.Grassland;
      biome[i] = b;
    }
  }
  return { size: n, slope, waterDist, moisture, forest, biome };
}

/** Nearest-cell lookup helper clamped to the map. */
export function cellIndex(size: number, x: number, z: number): number {
  const ix = clamp(Math.round(x), 0, size - 1), iz = clamp(Math.round(z), 0, size - 1);
  return iz * size + ix;
}
