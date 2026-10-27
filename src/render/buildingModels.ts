import * as THREE from 'three';
import type { BuildingType } from '../core/defs';
import type { MatKey } from './arch/archMaterials';
import { ModelBuilder, type BuiltModel } from './arch/modelBuilder';
import { RECIPES } from './arch/recipes';

/**
 * Building model registry. Every building is produced here, so an authored Blender export can replace
 * any procedural model without touching game logic:
 *
 *   registerBuildingModel('temple', () => loadedGltf.scene.clone());
 *
 * Contract for replacement models: origin at the footprint centre on the ground plane, +Y up, +Z is
 * the entrance side, footprint fits inside BUILDING_DEFS[type].w x .d units. Replacements do not take
 * part in the procedural construction animation; they fall back to a simple rise from the ground.
 *
 * No model files are bundled or assumed to exist: with nothing registered, the procedural Pallava
 * models below are used.
 */
export type BuildingModelFactory = (type: BuildingType) => THREE.Object3D;

const overrides = new Map<BuildingType, BuildingModelFactory>();
export function registerBuildingModel(type: BuildingType, factory: BuildingModelFactory): void {
  overrides.set(type, factory);
}
export function clearBuildingModelOverrides(): void { overrides.clear(); }

export interface BuildingModel {
  object: THREE.Object3D;
  height: number;
  /** True for the built-in models, which support the shader-driven construction animation. */
  procedural: boolean;
  /** Every mesh with its material key (empty for replacement models). */
  meshes: Array<{ mesh: THREE.Mesh; key: MatKey }>;
}

/** Geometry is built once per (type, variant) and shared by every instance of it. */
const cache = new Map<string, BuiltModel>();

/** Number of distinct architectural variants a type has (e.g. temples with 3, 4 or 5 tiers). */
export const VARIANT_COUNT: Record<BuildingType, number> = { palace: 1, temple: 3, barracks: 2, farm: 2, lumber: 2, quarry: 2, stronghold: 1 };

export function builtModel(type: BuildingType, variant = 0): BuiltModel {
  const v = ((Math.floor(variant) % VARIANT_COUNT[type]) + VARIANT_COUNT[type]) % VARIANT_COUNT[type];
  const key = `${type}:${v}`;
  let m = cache.get(key);
  if (!m) {
    const b = new ModelBuilder();
    RECIPES[type](b, v);
    m = b.build(`building:${type}:${v}`);
    cache.set(key, m);
  }
  return m;
}

/** Create an instance (override first, procedural fallback). Instances share geometry and materials. */
export function createBuildingModel(type: BuildingType, variant = 0): BuildingModel {
  const factory = overrides.get(type);
  if (factory) {
    const object = factory(type);
    const box = new THREE.Box3().setFromObject(object);
    return { object, height: Number.isFinite(box.max.y) ? box.max.y : 2, procedural: false, meshes: [] };
  }
  const built = builtModel(type, variant);
  const object = built.object.clone();
  const meshes: BuildingModel['meshes'] = [];
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && typeof mesh.userData.mat === 'string') meshes.push({ mesh, key: mesh.userData.mat as MatKey });
  });
  return { object, height: built.height, procedural: true, meshes };
}

export function disposeBuildingModels(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}
