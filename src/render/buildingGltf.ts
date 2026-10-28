import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BUILDING_DEFS, type BuildingType } from '../core/defs';
import { registerBuildingModel } from './buildingModels';
import { assertSameOrigin } from './units/gltfUnits';

/**
 * Authored building pipeline: a GLB (for example an export from Meshy or Blender) replaces the procedural
 * model of one building type. Models are scaled to fit the footprint, set on the ground at the footprint
 * centre, and checked for size before they are accepted. A missing or rejected file leaves the procedural
 * model in place, and the failure is returned to the caller, never swallowed.
 */

/** Meshy-style exports can be very dense; reject anything the instanced scene could not afford. */
export const MAX_TRIANGLES = 120_000;
/** Share of the footprint the model may fill, leaving a little room between neighbouring buildings. */
export const FOOTPRINT_FILL = 0.94;
/** Tallest a building may become relative to its footprint's larger side. */
export const MAX_HEIGHT_RATIO = 2.4;

export function countTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    n += g.index ? g.index.count / 3 : (g.getAttribute('position')?.count ?? 0) / 3;
  });
  return Math.floor(n);
}

/**
 * Normalise an authored model: uniform scale to fit the footprint (and the height limit), centred on x/z,
 * resting on y = 0. Pure geometry maths on the scene graph, so it runs without a GPU.
 */
export function fitToFootprint(root: THREE.Object3D, w: number, d: number): THREE.Object3D {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  if (!Number.isFinite(size.x + size.y + size.z) || size.x <= 0 || size.z <= 0 || size.y <= 0) throw new Error('model has no usable bounds');
  const scale = Math.min((w * FOOTPRINT_FILL) / size.x, (d * FOOTPRINT_FILL) / size.z, (Math.max(w, d) * MAX_HEIGHT_RATIO) / size.y);
  const centre = box.getCenter(new THREE.Vector3());
  const holder = new THREE.Group();
  holder.name = 'authored-building';
  root.position.set(-centre.x, -box.min.y, -centre.z);
  const inner = new THREE.Group();
  inner.add(root);
  inner.scale.setScalar(scale);
  holder.add(inner);
  return holder;
}

/** Drop cameras and lights an export may carry, and make the meshes cast and receive shadows. */
export function sanitize(root: THREE.Object3D): void {
  const drop: THREE.Object3D[] = [];
  root.traverse((o) => {
    if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) drop.push(o);
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });
  for (const o of drop) o.removeFromParent();
}

export type GltfLike = { scene: THREE.Object3D };
export type GltfLoadFn = (url: string) => Promise<GltfLike>;
const defaultLoad: GltfLoadFn = (url) => new GLTFLoader().loadAsync(url);

/** Load, validate and register a replacement model for one building type. */
export async function loadBuildingAsset(type: BuildingType, url: string, load: GltfLoadFn = defaultLoad): Promise<{ triangles: number }> {
  assertSameOrigin(url);
  const gltf = await load(url);
  const scene = gltf.scene;
  sanitize(scene);
  const triangles = countTriangles(scene);
  if (triangles === 0) throw new Error('model contains no meshes');
  if (triangles > MAX_TRIANGLES) throw new Error(`model has ${triangles} triangles (limit ${MAX_TRIANGLES}); decimate it first`);
  const def = BUILDING_DEFS[type];
  const template = fitToFootprint(scene, def.w, def.d);
  // Instances share geometry and materials; only the node tree is cloned.
  registerBuildingModel(type, () => template.clone(true));
  return { triangles };
}

export interface BuildingManifestResult { loaded: BuildingType[]; failed: Array<{ type: string; error: string }> }

/** Manifest: `{ "buildings": { "temple": "temple.glb" } }`, paths relative to the manifest, same origin only. */
export async function loadBuildingManifest(
  manifestUrl: string, opts: { fetchFn?: typeof fetch; load?: GltfLoadFn } = {},
): Promise<BuildingManifestResult> {
  assertSameOrigin(manifestUrl);
  const res = await (opts.fetchFn ?? fetch)(manifestUrl);
  if (!res.ok) throw new Error(`Building manifest not available (${res.status})`);
  const json: unknown = await res.json();
  const list = typeof json === 'object' && json !== null ? (json as { buildings?: unknown }).buildings : undefined;
  if (typeof list !== 'object' || list === null || Array.isArray(list)) throw new Error('Building manifest has no "buildings" object');
  const base = new URL(manifestUrl, typeof location !== 'undefined' ? location.href : 'http://localhost/');
  const out: BuildingManifestResult = { loaded: [], failed: [] };
  await Promise.all(Object.entries(list as Record<string, unknown>).map(async ([type, file]) => {
    try {
      if (!Object.hasOwn(BUILDING_DEFS, type)) throw new Error('unknown building type');
      if (typeof file !== 'string') throw new Error('model path must be a string');
      await loadBuildingAsset(type as BuildingType, new URL(file, base).href, opts.load);
      out.loaded.push(type as BuildingType);
    } catch (e) {
      out.failed.push({ type, error: e instanceof Error ? e.message : String(e) });
    }
  }));
  return out;
}
