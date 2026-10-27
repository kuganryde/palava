import { lerp, smoothstep } from '../core/math';
import { fbm } from '../core/noise';
import { mulberry32 } from '../core/rng';
import { Biome, biomeMapFor, cellIndex, type BiomeMap } from './biome';
import { capitalCenter, heightAt, WATER_LEVEL, type Terrain } from './terrain';

export interface Prop {
  x: number;
  z: number;
  y: number;
  scale: number;
  rot: number;
  /** 0..1 per-instance colour variation, resolved to a real colour by the renderer. */
  tint: number;
}

export type TreeKind = 'palm' | 'broadleaf' | 'banyan' | 'acacia';
export interface Tree extends Prop {
  kind: TreeKind;
  /** Trunk tilt in radians (coastal palms lean). */
  lean: number;
}

export type RockKind = 'boulder' | 'slab';
export interface Rock extends Prop {
  kind: RockKind;
}

export interface Vegetation {
  // Every array is shuffled, so any prefix is a uniform random subset (quality presets draw a prefix).
  trees: Tree[];
  bushes: Prop[];
  rocks: Rock[];
  reeds: Prop[];
  grass: Prop[];
}

export interface VegetationLimits {
  trees: number;
  bushes: number;
  rocks: number;
  reeds: number;
  grass: number;
}
export const DEFAULT_LIMITS: VegetationLimits = { trees: 2000, bushes: 1100, rocks: 520, reeds: 650, grass: 5200 };

/** Radius around the capital kept free of trees (the palace plateau and its approach). */
export const CAPITAL_CLEAR = 17;

/** Uniform-grid spatial hash for minimum-spacing checks between scattered points. */
class SpacingGrid {
  private readonly cells = new Map<number, number[]>(); // cell -> flat [x, z, r, x, z, r, ...]
  constructor(private readonly cell = 4) {}
  private key(cx: number, cz: number): number { return cx * 73856093 ^ cz * 19349663; }
  /** Accepts the point when it keeps `(r + rOther) / 2` clearance from every stored point. */
  tryAdd(x: number, z: number, r: number): boolean {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.cells.get(this.key(cx + dx, cz + dz));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          const min = (r + list[i + 2]!) * 0.5;
          const ox = list[i]! - x, oz = list[i + 1]! - z;
          if (ox * ox + oz * oz < min * min) return false;
        }
      }
    }
    const k = this.key(cx, cz);
    let list = this.cells.get(k);
    if (!list) { list = []; this.cells.set(k, list); }
    list.push(x, z, r);
    return true;
  }
}

function shuffle<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

/**
 * Deterministic, biome-aware scatter. Instead of uniform random points it samples the forest-density
 * and moisture fields, so forests form patches with sparse, shrubby edges; coasts get leaning palms
 * and reeds; steep and high ground gets clustered boulders; open ground gets grass patches.
 */
export function placeVegetation(t: Terrain, limits: VegetationLimits = DEFAULT_LIMITS): Vegetation {
  const rand = mulberry32(t.seed ^ 0x9e3779b9);
  const bm = biomeMapFor(t);
  const cap = capitalCenter(t.size);
  const n = t.size;
  const out: Vegetation = { trees: [], bushes: [], rocks: [], reeds: [], grass: [] };
  const sample = (x: number, z: number) => {
    const i = cellIndex(n, x, z);
    return { i, b: bm.biome[i]!, f: bm.forest[i]!, m: bm.moisture[i]!, s: bm.slope[i]!, wd: bm.waterDist[i]! };
  };
  const dCapAt = (x: number, z: number): number => Math.hypot(x - cap.x, z - cap.z);
  const rnd = (a: number, b: number): number => a + (b - a) * rand();

  scatterTrees(t, bm, rand, out.trees, limits.trees, sample, dCapAt, rnd);
  scatterBushes(t, rand, out.bushes, limits.bushes, sample, dCapAt, rnd);
  scatterRocks(t, rand, out.rocks, limits.rocks, sample, dCapAt, rnd);
  scatterReeds(t, rand, out.reeds, limits.reeds, sample, rnd);
  scatterGrass(t, rand, out.grass, limits.grass, sample, dCapAt);

  shuffle(out.trees, rand);
  shuffle(out.bushes, rand);
  shuffle(out.rocks, rand);
  shuffle(out.reeds, rand);
  shuffle(out.grass, rand);
  return out;
}

type Sampler = (x: number, z: number) => { i: number; b: number; f: number; m: number; s: number; wd: number };
type DistFn = (x: number, z: number) => number;
type Range = (a: number, b: number) => number;

function scatterTrees(
  t: Terrain, _bm: BiomeMap, rand: () => number, out: Tree[], max: number, sample: Sampler, dCap: DistFn, rnd: Range,
): void {
  const grid = new SpacingGrid(4);
  const attempts = t.size * t.size * 4;
  for (let a = 0; a < attempts && out.length < max; a++) {
    const x = 2 + rand() * (t.size - 5), z = 2 + rand() * (t.size - 5);
    const y = heightAt(t, x, z);
    if (y <= WATER_LEVEL + 0.3) continue;
    if (dCap(x, z) <= CAPITAL_CLEAR) continue;
    const { b, f, m, s } = sample(x, z);
    if (s > 1.1 || y > 7.5) continue;

    let kind: TreeKind;
    let accept: number;
    let spacing: number;
    let scale: number;
    const u = rand();
    if (b === Biome.Forest) {
      // Interior: dense, mixed, large canopies. Banyans are rare and only in the wettest, densest parts.
      accept = 0.45 + 0.55 * f;
      kind = u < 0.1 && m > 0.55 && f > 0.65 ? 'banyan' : u < 0.35 ? 'palm' : 'broadleaf';
      spacing = lerp(3.1, 2.0, f);
      scale = 0.85 + 0.5 * f + rand() * 0.35;
    } else if (b === Biome.Grove) {
      accept = 0.5;
      kind = u < 0.82 ? 'palm' : 'broadleaf';
      spacing = 2.6;
      scale = 0.8 + rand() * 0.55;
    } else if (b === Biome.Beach) {
      accept = 0.1 * smoothstep(WATER_LEVEL + 0.3, WATER_LEVEL + 0.8, y);
      kind = 'palm';
      spacing = 4;
      scale = 0.75 + rand() * 0.4;
    } else if (b === Biome.Scrub) {
      accept = 0.07 + 0.1 * smoothstep(0.1, 0.4, f);
      kind = u < 0.7 ? 'acacia' : 'broadleaf';
      spacing = 4.2;
      scale = 0.7 + rand() * 0.5;
    } else if (b === Biome.Grassland) {
      // Forest edge: tree probability fades with the forest-density field; far from it only lone trees survive.
      accept = 0.05 + 0.6 * smoothstep(0.12, 0.45, f);
      kind = u < 0.2 ? 'palm' : u < 0.85 ? 'broadleaf' : 'acacia';
      spacing = lerp(5, 2.8, smoothstep(0.15, 0.5, f));
      scale = 0.65 + 0.55 * smoothstep(0.1, 0.55, f) + rand() * 0.3;
    } else {
      continue; // rock / highland: handled by the rock pass
    }
    if (rand() >= accept) continue;
    if (!grid.tryAdd(x, z, spacing)) continue;
    out.push({
      x, z, y, scale, rot: rand() * Math.PI * 2, tint: rand(), kind,
      lean: kind === 'palm' ? rnd(-0.22, 0.22) : 0,
    });
  }
}

function scatterBushes(
  t: Terrain, rand: () => number, out: Prop[], max: number, sample: Sampler, dCap: DistFn, rnd: Range,
): void {
  const grid = new SpacingGrid(4);
  const attempts = t.size * t.size * 3;
  for (let a = 0; a < attempts && out.length < max; a++) {
    const x = 2 + rand() * (t.size - 5), z = 2 + rand() * (t.size - 5);
    const y = heightAt(t, x, z);
    if (y <= WATER_LEVEL + 0.4 || dCap(x, z) <= 12) continue;
    const { b, f, s } = sample(x, z);
    if (s > 1.1) continue;
    // Understory is densest at the forest edge, sparser inside, plus dry scrub.
    let p: number;
    if (b === Biome.Forest) p = 0.18;
    else if (b === Biome.Grassland || b === Biome.Grove) p = 0.03 + 0.75 * smoothstep(0.08, 0.35, f) * (1 - smoothstep(0.5, 0.7, f));
    else if (b === Biome.Scrub) p = 0.22;
    else if (b === Biome.Highland || b === Biome.Rock) p = 0.04;
    else p = 0.02;
    if (rand() >= p || !grid.tryAdd(x, z, 1.4)) continue;
    out.push({ x, z, y, scale: rnd(0.7, 1.35), rot: rand() * Math.PI * 2, tint: rand() });
  }
}

function scatterRocks(
  t: Terrain, rand: () => number, out: Rock[], max: number, sample: Sampler, dCap: DistFn, rnd: Range,
): void {
  const attempts = t.size * t.size * 2;
  for (let a = 0; a < attempts && out.length < max; a++) {
    const cx = 2 + rand() * (t.size - 5), cz = 2 + rand() * (t.size - 5);
    const cy = heightAt(t, cx, cz);
    if (cy <= WATER_LEVEL + 0.1 || dCap(cx, cz) <= 11) continue;
    const { b, s } = sample(cx, cz);
    // Outcrops cluster on steep or high ground; a few lone rocks dot beaches and open ground.
    let p = 0.004;
    if (b === Biome.Rock || b === Biome.Highland || s > 0.9) p = 0.16;
    else if (b === Biome.Beach) p = 0.02;
    if (rand() >= p) continue;
    const members = p > 0.1 ? 2 + Math.floor(rand() * 5) : 1;
    const big = rnd(0.9, 1.9);
    for (let k = 0; k < members && out.length < max; k++) {
      const ang = rand() * Math.PI * 2, r = k === 0 ? 0 : rnd(0.5, 1.7);
      const x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r;
      const y = heightAt(t, x, z);
      if (y <= WATER_LEVEL) continue;
      out.push({
        x, z, y, scale: k === 0 ? big : big * rnd(0.3, 0.7), rot: rand() * Math.PI * 2, tint: rand(),
        kind: rand() < 0.3 ? 'slab' : 'boulder',
      });
    }
  }
}

function scatterReeds(t: Terrain, rand: () => number, out: Prop[], max: number, sample: Sampler, rnd: Range): void {
  const attempts = t.size * t.size * 3;
  for (let a = 0; a < attempts && out.length < max; a++) {
    const x = 2 + rand() * (t.size - 5), z = 2 + rand() * (t.size - 5);
    const y = heightAt(t, x, z);
    // The shallow shore band only: reeds stand at the waterline, partly in the water.
    if (y < WATER_LEVEL - 0.15 || y > WATER_LEVEL + 0.55) continue;
    const { wd } = sample(x, z);
    if (wd > 2.5) continue;
    // Patchy: reeds grow in beds, not evenly along the whole coast.
    if (fbm(x * 0.18, z * 0.18, t.seed + 503) < 0.52) continue;
    const bed = 3 + Math.floor(rand() * 4);
    for (let k = 0; k < bed && out.length < max; k++) {
      const px = x + rnd(-0.6, 0.6), pz = z + rnd(-0.6, 0.6);
      const py = heightAt(t, px, pz);
      if (py < WATER_LEVEL - 0.25 || py > WATER_LEVEL + 0.7) continue;
      out.push({ x: px, z: pz, y: py, scale: rnd(0.7, 1.3), rot: rand() * Math.PI * 2, tint: rand() });
    }
  }
}

function scatterGrass(t: Terrain, rand: () => number, out: Prop[], max: number, sample: Sampler, dCap: DistFn): void {
  const attempts = t.size * t.size * 5;
  for (let a = 0; a < attempts && out.length < max; a++) {
    const x = 2 + rand() * (t.size - 5), z = 2 + rand() * (t.size - 5);
    const y = heightAt(t, x, z);
    if (y <= WATER_LEVEL + 0.6 || dCap(x, z) <= 10) continue;
    const { b, m, s } = sample(x, z);
    if (s > 0.8 || b === Biome.Rock || b === Biome.Highland || b === Biome.Beach) continue;
    // Clumped by a low-frequency patch field, scaled by moisture (lush = more).
    const patch = fbm(x * 0.12, z * 0.12, t.seed + 521);
    const p = smoothstep(0.42, 0.62, patch) * (0.25 + 0.75 * m) * (b === Biome.Forest ? 0.5 : 1);
    if (rand() >= p) continue;
    out.push({ x, z, y, scale: 0.7 + rand() * 0.7, rot: rand() * Math.PI * 2, tint: rand() });
  }
}
