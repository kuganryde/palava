import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { UNIT_KINDS, type UnitKind } from '../../core/defs';
import { BLEND_SECONDS, CLIP, CLIPS, type ClipName } from './animController';

/**
 * Authored character pipeline: Blender (or any DCC) exports skinned GLB/GLTF characters with named
 * animation clips; this module validates them, normalises size and origin, maps clip names to the
 * game's seven clips, and animates crowds of them with AnimationMixers.
 *
 * Nothing here assumes a file exists. Assets are only used after an explicit, successful
 * `loadUnitAsset()` (or `loadUnitManifest()`); a failed or missing asset leaves that unit kind on
 * its procedural placeholder, and the failure is reported to the caller rather than swallowed.
 *
 * Authoring contract (documented in the README): one skinned character per file; feet at the origin,
 * +Y up, facing +Z; animation clips named like idle / walk / run / attack / gather / build / death
 * (aliases below are accepted, case-insensitive).
 */

/** Accepted clip names per game clip, most specific first. */
export const CLIP_ALIASES: Readonly<Record<ClipName, readonly string[]>> = {
  idle: ['idle', 'stand', 'standing', 'rest'],
  walk: ['walk', 'walking', 'trot'],
  run: ['run', 'running', 'gallop', 'charge'],
  attack: ['attack', 'strike', 'slash', 'swing', 'shoot', 'fight'],
  gather: ['gather', 'harvest', 'chop', 'work', 'farm'],
  build: ['build', 'hammer', 'construct'],
  death: ['death', 'die', 'dying', 'dead', 'fall'],
};

/** When a clip is missing, fall back along this chain (ends at idle, which is required). */
export const CLIP_FALLBACKS: Readonly<Record<ClipName, readonly ClipName[]>> = {
  idle: [], walk: ['idle'], run: ['walk', 'idle'], attack: ['idle'], gather: ['build', 'idle'], build: ['gather', 'idle'], death: ['idle'],
};

/** Target standing heights (world units) so any export scale becomes game scale. */
export const TARGET_HEIGHT: Readonly<Record<UnitKind, number>> = { infantry: 1.7, archer: 1.7, villager: 1.55, commander: 1.95, cavalry: 2.3, elephant: 3.3 };

/** Skinned characters beyond this many per kind fall back to the cheap instanced placeholder. */
export const SKINNED_CAP = 48;

export type ClipMap = Partial<Record<ClipName, THREE.AnimationClip>>;

/** Map authored clip names onto the game's clips. Pure. */
export function resolveClips(clips: readonly { name: string }[]): { map: Partial<Record<ClipName, number>>; missing: ClipName[] } {
  const norm = (n: string): string => n.toLowerCase().replace(/[^a-z]/g, '');
  const map: Partial<Record<ClipName, number>> = {};
  const used = new Set<number>();
  for (const name of CLIPS) {
    // exact alias match first, then "contains" (e.g. "Armature|Walk_Cycle")
    for (const mode of ['exact', 'contains'] as const) {
      if (map[name] !== undefined) break;
      for (const alias of CLIP_ALIASES[name]) {
        const i = clips.findIndex((c, idx) => !used.has(idx) && (mode === 'exact' ? norm(c.name) === alias : norm(c.name).includes(alias)));
        if (i >= 0) { map[name] = i; used.add(i); break; }
      }
    }
  }
  return { map, missing: CLIPS.filter((c) => map[c] === undefined) };
}

/** The clip to actually play for a wanted clip, applying the fallback chain. Returns null if even idle is absent. */
export function pickClip<T>(available: Partial<Record<ClipName, T>>, want: ClipName): T | null {
  const direct = available[want];
  if (direct !== undefined) return direct;
  for (const f of CLIP_FALLBACKS[want]) { const v = available[f]; if (v !== undefined) return v; }
  return available.idle ?? null;
}

export interface UnitAsset {
  kind: UnitKind;
  scene: THREE.Object3D;
  clips: ClipMap;
  /** Game clips the file did not provide (they fall back along CLIP_FALLBACKS). */
  missing: ClipName[];
  dispose(): void;
}

/** Validate and normalise a loaded glTF. Throws a descriptive Error if it cannot serve as a unit. */
export function prepareAsset(kind: UnitKind, gltf: Pick<GLTF, 'scene' | 'animations'>): UnitAsset {
  const scene = gltf.scene;
  let skinned = 0;
  scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned++; });
  if (skinned === 0) throw new Error(`${kind}: model has no skinned mesh (export with an armature and skin weights)`);
  const { map, missing } = resolveClips(gltf.animations);
  if (map.idle === undefined) throw new Error(`${kind}: model needs at least an "idle" animation (found: ${gltf.animations.map((a) => a.name).join(', ') || 'none'})`);
  const clips: ClipMap = {};
  for (const name of CLIPS) { const i = map[name]; if (i !== undefined) clips[name] = gltf.animations[i]!; }

  // Normalise: scale to the game's height for this kind and put the feet on y = 0, centred on x/z.
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const h = box.max.y - box.min.y;
  if (!Number.isFinite(h) || h <= 1e-4) throw new Error(`${kind}: model has no measurable height`);
  const k = TARGET_HEIGHT[kind] / h;
  const wrapper = new THREE.Group();
  wrapper.name = `unit-asset:${kind}`;
  scene.scale.multiplyScalar(k);
  scene.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(scene);
  scene.position.set(-(b2.min.x + b2.max.x) / 2, -b2.min.y, -(b2.min.z + b2.max.z) / 2);
  wrapper.add(scene);
  wrapper.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; /* skinned bounds are bind-pose */ }
  });
  return {
    kind, scene: wrapper, clips, missing,
    dispose() {
      wrapper.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          for (const v of Object.values(mat)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
          mat.dispose();
        }
      });
    },
  };
}

/** Load one GLB/GLTF. Rejects with a clear message on network, parse or validation failure. */
export async function loadUnitAsset(kind: UnitKind, url: string, loader: GLTFLoader = new GLTFLoader()): Promise<UnitAsset> {
  assertSameOrigin(url);
  const gltf = await loader.loadAsync(url);
  return prepareAsset(kind, gltf);
}

/**
 * Only same-origin model URLs are loaded: glTF parsing is a large attack surface and a page URL
 * parameter must not be able to point it at an arbitrary host.
 */
export function assertSameOrigin(url: string, base = typeof location !== 'undefined' ? location.href : 'http://localhost/'): void {
  let u: URL;
  try { u = new URL(url, base); } catch { throw new Error(`Invalid model URL: ${url}`); }
  const origin = new URL(base).origin;
  if (u.origin !== origin && u.protocol !== 'blob:' && u.protocol !== 'data:') throw new Error(`Refusing to load a model from another origin: ${u.origin}`);
}

export interface ManifestResult { loaded: UnitKind[]; failed: Array<{ kind: string; error: string }> }

/**
 * Optional manifest: `{ "units": { "infantry": "infantry.glb", ... } }`, URLs relative to the manifest.
 * Provided by whoever hosts the game; the engine never guesses a path.
 */
export async function loadUnitManifest(manifestUrl: string, library: UnitAssetLibrary, fetchFn: typeof fetch = fetch): Promise<ManifestResult> {
  assertSameOrigin(manifestUrl);
  const res = await fetchFn(manifestUrl);
  if (!res.ok) throw new Error(`Model manifest not available (${res.status})`);
  const json: unknown = await res.json();
  const units = typeof json === 'object' && json !== null ? (json as { units?: unknown }).units : undefined;
  if (typeof units !== 'object' || units === null) throw new Error('Model manifest has no "units" object');
  const out: ManifestResult = { loaded: [], failed: [] };
  const base = new URL(manifestUrl, typeof location !== 'undefined' ? location.href : 'http://localhost/');
  await Promise.all(Object.entries(units as Record<string, unknown>).map(async ([kind, file]) => {
    try {
      if (!(UNIT_KINDS as readonly string[]).includes(kind)) throw new Error('unknown unit kind');
      if (typeof file !== 'string') throw new Error('model path must be a string');
      library.set(await loadUnitAsset(kind as UnitKind, new URL(file, base).href));
      out.loaded.push(kind as UnitKind);
    } catch (e) {
      out.failed.push({ kind, error: e instanceof Error ? e.message : String(e) });
    }
  }));
  return out;
}

/** Loaded authored assets by kind. A kind without an asset keeps its procedural model. */
export class UnitAssetLibrary {
  private readonly assets = new Map<UnitKind, UnitAsset>();
  /** Bumped when assets change, so views know to rebuild their pools. */
  version = 0;
  set(asset: UnitAsset): void {
    this.assets.get(asset.kind)?.dispose();
    this.assets.set(asset.kind, asset);
    this.version++;
  }
  get(kind: UnitKind): UnitAsset | undefined { return this.assets.get(kind); }
  has(kind: UnitKind): boolean { return this.assets.has(kind); }
  kinds(): UnitKind[] { return [...this.assets.keys()]; }
  dispose(): void { for (const a of this.assets.values()) a.dispose(); this.assets.clear(); this.version++; }
}

/** One skinned character with its mixer and clip actions. */
export interface SkinnedUnit {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<ClipName, THREE.AnimationAction>>;
  current: ClipName | null;
}

/** A recycling pool of skinned characters of one kind. */
export class SkinnedPool {
  readonly group = new THREE.Group();
  private readonly free: SkinnedUnit[] = [];
  readonly used = new Map<number, SkinnedUnit>();

  constructor(private readonly asset: UnitAsset, private readonly cap = SKINNED_CAP) {
    this.group.name = `skinned:${asset.kind}`;
  }

  get size(): number { return this.used.size; }
  get capacity(): number { return this.cap; }
  has(id: number): boolean { return this.used.has(id); }
  get(id: number): SkinnedUnit | undefined { return this.used.get(id); }

  /** Claim a character for a unit id, or null when the pool is full (caller uses the placeholder). */
  acquire(id: number): SkinnedUnit | null {
    const existing = this.used.get(id);
    if (existing) return existing;
    if (this.used.size >= this.cap) return null;
    let u = this.free.pop();
    if (!u) {
      const root = cloneSkinned(this.asset.scene);
      const mixer = new THREE.AnimationMixer(root);
      const actions: SkinnedUnit['actions'] = {};
      for (const name of CLIPS) {
        const clip = this.asset.clips[name];
        if (!clip) continue;
        const a = mixer.clipAction(clip);
        if (name === 'death') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; } else a.setLoop(THREE.LoopRepeat, Infinity);
        actions[name] = a;
      }
      u = { root, mixer, actions, current: null };
      this.group.add(root);
    }
    u.root.visible = true;
    this.used.set(id, u);
    return u;
  }

  release(id: number): void {
    const u = this.used.get(id);
    if (!u) return;
    this.used.delete(id);
    u.root.visible = false;
    u.mixer.stopAllAction();
    u.current = null;
    this.free.push(u);
  }

  /** Release every id not in `live`. */
  retain(live: ReadonlySet<number>): void {
    for (const id of [...this.used.keys()]) if (!live.has(id)) this.release(id);
  }

  /**
   * Switch a character to `want` with a cross-fade, then advance its mixer by dt. Locomotion speed is
   * scaled so feet match ground speed (`rate` = unit speed / authored speed).
   */
  play(u: SkinnedUnit, want: ClipName, dt: number, rate = 1): void {
    const next = pickClip(u.actions, want);
    if (next && u.current !== null && u.actions[u.current] === next) {
      // same action already playing (fallback may map several game clips to one action)
    } else if (next) {
      const prev = u.current !== null ? u.actions[u.current] : undefined;
      next.reset().play();
      if (prev && prev !== next) prev.crossFadeTo(next, BLEND_SECONDS, false); else next.fadeIn(BLEND_SECONDS);
      u.current = want;
      // the actual key in actions that `next` came from
      for (const name of CLIPS) if (u.actions[name] === next) { u.current = name; break; }
    }
    if (u.current) u.actions[u.current]!.timeScale = u.current === 'walk' || u.current === 'run' ? Math.max(0.2, rate) : 1;
    u.mixer.update(dt);
  }

  dispose(): void {
    for (const u of [...this.used.values(), ...this.free]) { u.mixer.stopAllAction(); u.mixer.uncacheRoot(u.root); }
    this.used.clear(); this.free.length = 0;
    this.group.clear();
  }
}

export { CLIP };
