import * as THREE from 'three';
import { hash2 } from '../core/rng';
import { clamp, lerp, smoothstep } from '../core/math';
import { fbm } from '../core/noise';
import { biomeMapFor } from '../world/biome';
import { capitalCenter, WATER_LEVEL, type Terrain } from '../world/terrain';

// Natural, slightly desaturated ground palette (sRGB hex; THREE converts to linear working space).
const C = {
  grassLush: new THREE.Color(0x4e8434),
  grassMid: new THREE.Color(0x7b9a42),
  grassDry: new THREE.Color(0xb3a65c),
  forestFloor: new THREE.Color(0x3b5a2b),
  soil: new THREE.Color(0x8a6a48),
  laterite: new THREE.Color(0xa65e3a), // the red-brown ground of South India
  sand: new THREE.Color(0xdcc898),
  wetSand: new THREE.Color(0xa8946a),
  rock: new THREE.Color(0x7e7b72),
  rockDark: new THREE.Color(0x5a5850),
  highland: new THREE.Color(0x9b998c),
  moss: new THREE.Color(0x66794a),
  paved: new THREE.Color(0xcdb68a),
  seabedShallow: new THREE.Color(0x8aa58c),
  seabedDeep: new THREE.Color(0x2c5865),
};

const _soil = new THREE.Color();

/**
 * Terrain colour for a cell, blended from slope, elevation, moisture and biome fields.
 * Shared with the minimap so both always agree.
 */
export function terrainColor(t: Terrain, x: number, z: number, out = new THREE.Color()): THREE.Color {
  const n = t.size;
  const bm = biomeMapFor(t);
  const i = z * n + x;
  const h = t.heights[i]!;
  const slope = bm.slope[i]!;
  const moist = bm.moisture[i]!;
  const forest = bm.forest[i]!;
  const speck = hash2(x, z, t.seed + 5);

  if (h <= WATER_LEVEL) {
    // Seabed seen through the water: sandy shallows fading to deep teal.
    return out.copy(C.seabedShallow).lerp(C.seabedDeep, smoothstep(0, 3.2, WATER_LEVEL - h));
  }

  // Grass: dry gold to lush green by moisture, with low-frequency golden patches.
  out.copy(C.grassDry).lerp(C.grassMid, smoothstep(0.18, 0.5, moist)).lerp(C.grassLush, smoothstep(0.5, 0.9, moist));
  const patch = fbm(x * 0.09, z * 0.09, t.seed + 601);
  out.lerp(C.grassDry, smoothstep(0.56, 0.72, patch) * 0.4);

  // Bare soil / laterite patches, mostly where it is drier.
  const soilN = fbm(x * 0.07 + 20, z * 0.07, t.seed + 607);
  const soilW = smoothstep(0.58, 0.72, soilN) * (1 - smoothstep(0.35, 0.65, moist));
  _soil.copy(C.soil).lerp(C.laterite, hash2(x >> 2, z >> 2, t.seed + 9) * 0.8);
  out.lerp(_soil, soilW * 0.85);

  // Forest floor darkens under closed canopy.
  out.lerp(C.forestFloor, forest * 0.7);

  // Beach and wet sand at the waterline.
  out.lerp(C.sand, 1 - smoothstep(WATER_LEVEL + 0.25, WATER_LEVEL + 1.05, h));
  out.lerp(C.wetSand, 1 - smoothstep(WATER_LEVEL + 0.02, WATER_LEVEL + 0.4, h));

  // Rock on steep slopes, highland stone on tall ground.
  const rockW = smoothstep(0.55, 1.25, slope);
  out.lerp(_soil.copy(C.rock).lerp(C.rockDark, hash2(x, z, t.seed + 17) * 0.7), rockW);
  out.lerp(C.highland, smoothstep(7, 11, h) * 0.8);
  // Weathering: lichen/moss on moist rock, darker streaks along noise bands.
  const weather = fbm(x * 0.14 + 40, z * 0.14, t.seed + 611);
  out.lerp(C.moss, smoothstep(0.55, 0.75, weather) * smoothstep(0.35, 0.7, moist) * Math.max(rockW, smoothstep(6, 9, h)) * 0.6);
  out.multiplyScalar(1 - smoothstep(0.5, 0.8, 1 - weather) * 0.14 * Math.max(rockW, smoothstep(6, 9, h)));

  // Trodden/paved ground around the palace.
  const cap = capitalCenter(n);
  out.lerp(C.paved, (1 - smoothstep(5, 11, Math.hypot(x - cap.x, z - cap.z))) * 0.9);

  out.multiplyScalar(0.94 + speck * 0.12);
  return out;
}

/** Tileable greyscale detail (multiplied over the vertex colours): grain, clumps and blades at three scales. */
function createDetailTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const periodic = (x: number, y: number, period: number, salt: number): number => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const m = (a: number) => ((a % period) + period) % period;
    const a = hash2(m(x0), m(y0), salt), b = hash2(m(x0 + 1), m(y0), salt);
    const c = hash2(m(x0), m(y0 + 1), salt), d = hash2(m(x0 + 1), m(y0 + 1), salt);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size, ny = y / size;
      const v =
        0.5 * periodic(nx * 8, ny * 8, 8, 1) +
        0.3 * periodic(nx * 32, ny * 32, 32, 2) +
        0.2 * periodic(nx * 64, ny * 64, 64, 3);
      const g = clamp(0.7 + v * 0.45, 0, 1); // multiplier in ~0.7..1.0; the material colour (x1.12) re-centres it
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = Math.round(g * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export const DETAIL_TILE_WORLD = 9; // world units covered by one repeat of the detail texture

export function createTerrainMesh(t: Terrain): THREE.Mesh {
  const n = t.size;
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const c = new THREE.Color();
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      positions[i * 3] = x;
      positions[i * 3 + 1] = t.heights[i]!;
      positions[i * 3 + 2] = z;
      terrainColor(t, x, z, c);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      uvs[i * 2] = x / DETAIL_TILE_WORLD;
      uvs[i * 2 + 1] = z / DETAIL_TILE_WORLD;
    }
  }
  const indices: number[] = [];
  for (let z = 0; z < n - 1; z++) {
    for (let x = 0; x < n - 1; x++) {
      const a = z * n + x, b = a + 1, d = a + n, e = d + 1;
      // Alternate the diagonal to avoid a visible directional bias in the facets.
      if ((x + z) % 2 === 0) indices.push(a, d, b, b, d, e); else indices.push(a, d, e, a, e, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: createDetailTexture(), roughness: 0.97, metalness: 0 });
  mat.color.setRGB(1.12, 1.12, 1.12, THREE.LinearSRGBColorSpace);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

export function disposeTerrainMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  const m = mesh.material as THREE.MeshStandardMaterial;
  m.map?.dispose();
  m.dispose();
}
