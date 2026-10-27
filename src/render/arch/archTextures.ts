import * as THREE from 'three';
import { clamp, lerp } from '../../core/math';
import { hash2 } from '../../core/rng';

/**
 * Procedural surface textures for the architecture: albedo + height (used as a bump map) for stone
 * courses, plaster, clay pantiles, timber and thatch. Generated in code from hashed noise, so there
 * are no image files to ship or to go missing; each is a small tiling DataTexture.
 */
export type SurfaceKind = 'stone' | 'plaster' | 'tile' | 'timber' | 'thatch' | 'earth';

/** World units covered by one repeat of each texture (used to scale UVs consistently across parts). */
export const TEXEL_WORLD: Record<SurfaceKind, number> = { stone: 2, plaster: 2.4, tile: 1, timber: 1.2, thatch: 1.2, earth: 2 };

export interface SurfaceTextures {
  map: THREE.DataTexture;
  bump: THREE.DataTexture;
}

type Pixel = (u: number, v: number, x: number, y: number) => [number, number, number, number]; // r,g,b (0..1) and height (0..1)

/** Tileable value noise: lattice indices wrap at `period`, so the texture repeats seamlessly. */
function pnoise(x: number, y: number, period: number, salt: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const m = (a: number): number => ((a % period) + period) % period;
  const a = hash2(m(x0), m(y0), salt), b = hash2(m(x0 + 1), m(y0), salt);
  const c = hash2(m(x0), m(y0 + 1), salt), d = hash2(m(x0 + 1), m(y0 + 1), salt);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
const fbmP = (u: number, v: number, base: number, salt: number): number =>
  0.55 * pnoise(u * base, v * base, base, salt) + 0.3 * pnoise(u * base * 2, v * base * 2, base * 2, salt + 1) + 0.15 * pnoise(u * base * 4, v * base * 4, base * 4, salt + 2);

function bake(size: number, pixel: Pixel, bumpContrast = 1): SurfaceTextures {
  const albedo = new Uint8Array(new ArrayBuffer(size * size * 4));
  const height = new Uint8Array(new ArrayBuffer(size * size * 4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, h] = pixel(x / size, y / size, x, y);
      const o = (y * size + x) * 4;
      albedo[o] = Math.round(clamp(r, 0, 1) * 255);
      albedo[o + 1] = Math.round(clamp(g, 0, 1) * 255);
      albedo[o + 2] = Math.round(clamp(b, 0, 1) * 255);
      albedo[o + 3] = 255;
      const hv = Math.round(clamp(0.5 + (h - 0.5) * bumpContrast, 0, 1) * 255);
      height[o] = height[o + 1] = height[o + 2] = hv;
      height[o + 3] = 255;
    }
  }
  const mk = (data: Uint8Array<ArrayBuffer>, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(albedo, true), bump: mk(height, false) };
}

/** Ashlar masonry: 8 courses per repeat, running bond, per-block tint, chiselled face noise and recessed mortar. */
function stone(size: number): SurfaceTextures {
  const COURSES = 8;
  return bake(size, (u, v) => {
    const course = Math.floor(v * COURSES);
    const cv = v * COURSES - course;
    const blocksPerCourse = 3 + Math.floor(hash2(course, 7, 11) * 2); // 3 or 4 blocks, so joints never line up between courses
    const shift = hash2(course, 3, 5);
    const bu = (u + shift) * blocksPerCourse;
    const block = Math.floor(bu);
    const bf = bu - block;
    const id = hash2(((block % blocksPerCourse) + blocksPerCourse) % blocksPerCourse, course, 23);
    const mortarV = Math.min(cv, 1 - cv), mortarU = Math.min(bf, 1 - bf) / blocksPerCourse * COURSES * 0.5;
    const joint = Math.min(mortarV, mortarU);
    const mortar = clamp(1 - joint / 0.06, 0, 1);
    const face = fbmP(u, v, 16, 31) * 0.5 + fbmP(u, v, 48, 41) * 0.5;
    const tint = 0.86 + id * 0.22;
    const base = [0.74, 0.69, 0.6] as const; // warm granite-sandstone
    const weather = fbmP(u, v, 6, 51); // slow staining
    const k = tint * (0.9 + face * 0.2) * (0.92 + weather * 0.14);
    const m = mortar * 0.55;
    return [lerp(base[0] * k, 0.5, m), lerp(base[1] * k, 0.47, m), lerp(base[2] * k, 0.42, m), (1 - mortar) * (0.62 + face * 0.34) + mortar * 0.1];
  }, 1.3);
}

/** Limewashed plaster / dressed sandstone: soft mottling and faint vertical rain streaks. */
function plaster(size: number): SurfaceTextures {
  return bake(size, (u, v) => {
    const mott = fbmP(u, v, 5, 61);
    const fine = pnoise(u * 64, v * 64, 64, 71);
    const streak = pnoise(u * 28, v * 3, 28, 81); // stretched along v = vertical drip marks
    const k = 0.92 + mott * 0.12 - streak * 0.07 + (fine - 0.5) * 0.05;
    return [0.93 * k, 0.86 * k, 0.72 * k, 0.5 + (fine - 0.5) * 0.4 + (mott - 0.5) * 0.2];
  }, 0.8);
}

/** Clay pantiles: curved columns with overlapping rows; each tile has its own fired-colour variation. */
function tile(size: number): SurfaceTextures {
  const COLS = 5, ROWS = 6;
  return bake(size, (u, v) => {
    const cu = u * COLS, cv = v * ROWS;
    const col = Math.floor(cu), row = Math.floor(cv);
    const fu = cu - col, fv = cv - row;
    const id = hash2(col, row, 91);
    const curve = Math.sin(fu * Math.PI);                     // convex pantile profile across the tile
    const lap = fv;                                              // each row overlaps the one below, rising along its length
    const shadow = Math.pow(1 - fv, 3) * 0.35;                   // dark lip where the next row overlaps
    const wear = fbmP(u, v, 8, 101);
    const k = (0.82 + id * 0.3) * (0.78 + curve * 0.22) * (1 - shadow) * (0.94 + wear * 0.1);
    const moss = clamp((wear - 0.62) * 2, 0, 1) * 0.35;
    return [
      lerp(0.78 * k, 0.4 * k, moss), lerp(0.36 * k, 0.45 * k, moss), lerp(0.2 * k, 0.22 * k, moss),
      curve * 0.55 + lap * 0.45 - shadow * 0.5,
    ];
  }, 1.6);
}

/** Dark seasoned timber: long grain along u, a few knots, subtle plank joints. */
function timber(size: number): SurfaceTextures {
  return bake(size, (u, v) => {
    const grain = pnoise(u * 3, v * 36, 36, 111);
    const fine = pnoise(u * 12, v * 90, 90, 121);
    const plank = Math.floor(v * 4);
    const id = hash2(plank, 5, 131);
    const seam = clamp(1 - Math.min((v * 4) % 1, 1 - ((v * 4) % 1)) / 0.04, 0, 1);
    const k = (0.78 + id * 0.3) * (0.82 + grain * 0.3) * (0.95 + fine * 0.1) * (1 - seam * 0.4);
    return [0.42 * k, 0.29 * k, 0.18 * k, 0.5 + (grain - 0.5) * 0.5 - seam * 0.3];
  }, 1.0);
}

/** Straw thatch: dense streaks along v with golden/grey variation. */
function thatch(size: number): SurfaceTextures {
  return bake(size, (u, v) => {
    const streak = pnoise(u * 48, v * 6, 48, 141);
    const band = pnoise(u * 5, v * 5, 5, 151);
    const fine = pnoise(u * 96, v * 96, 96, 161);
    const k = 0.78 + streak * 0.38 + (fine - 0.5) * 0.12;
    return [0.76 * k * (0.94 + band * 0.1), 0.62 * k * (0.94 + band * 0.1), 0.34 * k, 0.4 + streak * 0.5];
  }, 1.1);
}

/** Packed earth / bunds: warm brown mottling with pebbly grain. */
function earth(size: number): SurfaceTextures {
  return bake(size, (u, v) => {
    const mott = fbmP(u, v, 6, 171);
    const grain = pnoise(u * 60, v * 60, 60, 181);
    const k = 0.78 + mott * 0.3 + (grain - 0.5) * 0.12;
    return [0.52 * k, 0.37 * k, 0.24 * k, 0.4 + mott * 0.3 + (grain - 0.5) * 0.3];
  }, 0.9);
}

export function createSurfaceTextures(kind: SurfaceKind, size = 256): SurfaceTextures {
  switch (kind) {
    case 'stone': return stone(size);
    case 'plaster': return plaster(size);
    case 'tile': return tile(size);
    case 'timber': return timber(size);
    case 'thatch': return thatch(size);
    case 'earth': return earth(size);
  }
}
