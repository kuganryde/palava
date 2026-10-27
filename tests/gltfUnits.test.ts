import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  assertSameOrigin, CLIP_ALIASES, pickClip, prepareAsset, resolveClips, SkinnedPool, TARGET_HEIGHT, UnitAssetLibrary,
} from '../src/render/units/gltfUnits';
import { CLIPS } from '../src/render/units/animController';

const clipNamed = (names: string[]): THREE.AnimationClip[] => names.map((n) => new THREE.AnimationClip(n, 1, []));

/** A tiny skinned character built directly (no exporter needed in Node). */
function fakeGltf(height = 3, animNames = ['Idle', 'Walk', 'Run']): { scene: THREE.Group; animations: THREE.AnimationClip[] } {
  const root = new THREE.Bone(), tip = new THREE.Bone();
  tip.position.set(0, height, 0); root.add(tip);
  const geo = new THREE.BoxGeometry(0.5, height, 0.5).translate(0, height / 2, 0);
  const n = geo.getAttribute('position').count;
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(n * 4), 4));
  const w = new Float32Array(n * 4); for (let i = 0; i < n; i++) w[i * 4] = 1;
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
  mesh.add(root); mesh.bind(new THREE.Skeleton([root, tip]));
  const scene = new THREE.Group(); scene.add(mesh);
  return { scene, animations: clipNamed(animNames) };
}

describe('clip name resolution', () => {
  it('maps Blender-style names, case and punctuation insensitively', () => {
    const { map, missing } = resolveClips(clipNamed(['Armature|Idle', 'Walk_Cycle', 'RUN', 'Attack_01', 'Death']));
    expect(CLIPS.map((c) => map[c])).toEqual([0, 1, 2, 3, undefined, undefined, 4]);
    expect(missing).toEqual(['gather', 'build']);
  });
  it('accepts aliases and never assigns one clip to two game clips', () => {
    const { map } = resolveClips(clipNamed(['Stand', 'Gallop', 'Harvest', 'Hammer', 'Die']));
    expect(map.idle).toBe(0); expect(map.run).toBe(1); expect(map.gather).toBe(2); expect(map.build).toBe(3); expect(map.death).toBe(4);
    const used = Object.values(map);
    expect(new Set(used).size).toBe(used.length);
  });
  it('prefers an exact match over a substring match', () => {
    const { map } = resolveClips(clipNamed(['walk_to_run', 'Walk', 'Idle']));
    expect(map.walk).toBe(1);
  });
  it('has aliases for every clip', () => { for (const c of CLIPS) expect(CLIP_ALIASES[c].length).toBeGreaterThan(0); });
  it('falls back along the chain and ends at idle', () => {
    const only = { idle: 'I', walk: 'W' } as const;
    expect(pickClip(only, 'run')).toBe('W');
    expect(pickClip(only, 'attack')).toBe('I');
    expect(pickClip(only, 'death')).toBe('I');
    expect(pickClip({ build: 'B', idle: 'I' }, 'gather')).toBe('B');
    expect(pickClip({}, 'walk')).toBeNull();
  });
});

describe('asset validation and normalisation', () => {
  it('scales to the game height and puts the feet on the ground', () => {
    const asset = prepareAsset('infantry', fakeGltf(3));
    const box = new THREE.Box3().setFromObject(asset.scene);
    expect(box.max.y - box.min.y).toBeCloseTo(TARGET_HEIGHT.infantry, 3);
    expect(box.min.y).toBeCloseTo(0, 3);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 3);
    expect(asset.missing).toEqual(['attack', 'gather', 'build', 'death']);
    asset.dispose();
  });
  it('rejects a model with no skin, no idle clip, or no height, with a clear message', () => {
    const rigid = { scene: new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry())), animations: clipNamed(['Idle']) };
    expect(() => prepareAsset('villager', rigid)).toThrow(/skinned mesh/);
    expect(() => prepareAsset('villager', fakeGltf(2, ['Walk']))).toThrow(/idle/);
    const flat = fakeGltf(1); flat.scene.scale.set(1, 0, 1);
    expect(() => prepareAsset('villager', flat)).toThrow(/height/);
  });
  it('only loads same-origin or blob URLs', () => {
    expect(() => assertSameOrigin('/models/a.glb', 'http://localhost:5173/')).not.toThrow();
    expect(() => assertSameOrigin('blob:http://localhost:5173/abc', 'http://localhost:5173/')).not.toThrow();
    expect(() => assertSameOrigin('https://evil.example/a.glb', 'http://localhost:5173/')).toThrow(/another origin/);
    expect(() => assertSameOrigin('http://', 'http://localhost:5173/')).toThrow();
  });
});

describe('skinned pool', () => {
  it('recycles characters, respects its cap, and cross-fades by clip', () => {
    const asset = prepareAsset('infantry', fakeGltf(2, ['Idle', 'Walk']));
    const pool = new SkinnedPool(asset, 2);
    const a = pool.acquire(1)!, b = pool.acquire(2)!;
    expect(pool.acquire(3)).toBeNull();
    expect(pool.acquire(1)).toBe(a);
    pool.play(a, 'idle', 0.016);
    expect(a.current).toBe('idle');
    pool.play(a, 'walk', 0.016, 1.3);
    expect(a.current).toBe('walk');
    expect(a.actions.walk!.timeScale).toBeCloseTo(1.3, 5);
    pool.play(a, 'attack', 0.016); // missing clip falls back to idle without throwing
    expect(a.current).toBe('idle');
    pool.retain(new Set([2]));
    expect(pool.size).toBe(1);
    expect(a.root.visible).toBe(false);
    const c = pool.acquire(3)!;
    expect(c).toBe(a); // the released character is reused, not re-cloned
    expect(b.root.visible).toBe(true);
    pool.dispose(); asset.dispose();
  });
  it('library replaces and disposes assets and bumps its version', () => {
    const lib = new UnitAssetLibrary();
    const v0 = lib.version;
    lib.set(prepareAsset('infantry', fakeGltf()));
    expect(lib.has('infantry')).toBe(true);
    expect(lib.version).toBeGreaterThan(v0);
    lib.set(prepareAsset('infantry', fakeGltf()));
    expect(lib.kinds()).toEqual(['infantry']);
    lib.dispose();
    expect(lib.kinds()).toEqual([]);
  });
});
