import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Test-only: builds a small skinned humanoid with Blender-style clip names, exports it to a real
 * binary GLB in memory, so the GLTFLoader pipeline can be exercised end to end without shipping or
 * inventing any asset file. Runs in the browser (GLTFExporter needs Blob/FileReader). Not imported by
 * the game, so it is never part of the production bundle.
 */
export async function buildSyntheticGlb(opts: { clips?: Array<'idle' | 'walk' | 'run' | 'attack' | 'death'>; skinned?: boolean } = {}): Promise<ArrayBuffer> {
  const wanted = opts.clips ?? ['idle', 'walk', 'run', 'attack', 'death'];
  const names = ['root', 'hips', 'spine', 'head', 'armL', 'armR', 'legL', 'legR'] as const;
  const bones: Record<string, THREE.Bone> = {};
  for (const n of names) { const b = new THREE.Bone(); b.name = n; bones[n] = b; }
  const at = (n: string, x: number, y: number, z: number): void => { bones[n]!.position.set(x, y, z); };
  at('root', 0, 0, 0); at('hips', 0, 0.9, 0); at('spine', 0, 0.2, 0); at('head', 0, 0.45, 0);
  at('armL', 0.26, 0.3, 0); at('armR', -0.26, 0.3, 0); at('legL', 0.12, 0, 0); at('legR', -0.12, 0, 0);
  bones.root!.add(bones.hips!); bones.hips!.add(bones.spine!, bones.legL!, bones.legR!); bones.spine!.add(bones.head!, bones.armL!, bones.armR!);
  const list = names.map((n) => bones[n]!);

  const parts: Array<{ geo: THREE.BufferGeometry; bone: string; color: number }> = [
    { geo: new THREE.BoxGeometry(0.34, 0.6, 0.2).translate(0, 1.25, 0), bone: 'spine', color: 0x2d4f9e },
    { geo: new THREE.SphereGeometry(0.15, 8, 6).translate(0, 1.82, 0), bone: 'head', color: 0xc08a5a },
    { geo: new THREE.BoxGeometry(0.12, 0.62, 0.12).translate(0.26, 1.2, 0), bone: 'armL', color: 0xc08a5a },
    { geo: new THREE.BoxGeometry(0.12, 0.62, 0.12).translate(-0.26, 1.2, 0), bone: 'armR', color: 0xc08a5a },
    { geo: new THREE.BoxGeometry(0.14, 0.9, 0.14).translate(0.12, 0.45, 0), bone: 'legL', color: 0xe8dcc0 },
    { geo: new THREE.BoxGeometry(0.14, 0.9, 0.14).translate(-0.12, 0.45, 0), bone: 'legR', color: 0xe8dcc0 },
  ];
  const geos = parts.map((p) => {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    const n = g.getAttribute('position').count;
    const idx = new Uint16Array(n * 4), w = new Float32Array(n * 4), col = new Float32Array(n * 3);
    const c = new THREE.Color(p.color);
    for (let i = 0; i < n; i++) { idx[i * 4] = names.indexOf(p.bone as never); w[i * 4] = 1; col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    return g;
  });
  const geometry = mergeGeometries(geos)!;

  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  let mesh: THREE.Mesh;
  if (opts.skinned === false) {
    mesh = new THREE.Mesh(geometry, material);
  } else {
    const sm = new THREE.SkinnedMesh(geometry, material);
    sm.add(bones.root!);
    sm.bind(new THREE.Skeleton(list));
    mesh = sm;
  }
  mesh.name = 'body';
  scene.add(mesh);

  const q = (x: number, y = 0, z = 0): number[] => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)).toArray();
  const track = (bone: string, times: number[], rx: number[]): THREE.QuaternionKeyframeTrack =>
    new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, rx.flatMap((a) => q(a)));
  const swing = (amp: number, dur: number): THREE.KeyframeTrack[] => {
    const t = [0, dur / 4, dur / 2, (3 * dur) / 4, dur];
    return [
      track('legL', t, [0, amp, 0, -amp, 0]), track('legR', t, [0, -amp, 0, amp, 0]),
      track('armL', t, [0, -amp, 0, amp, 0]), track('armR', t, [0, amp, 0, -amp, 0]),
    ];
  };
  const all: Record<string, () => THREE.AnimationClip> = {
    idle: () => new THREE.AnimationClip('Armature|Idle', 2, [track('head', [0, 1, 2], [0, 0.08, 0])]),
    walk: () => new THREE.AnimationClip('Armature|Walk_Cycle', 1, swing(0.5, 1)),
    run: () => new THREE.AnimationClip('Run', 0.6, swing(0.9, 0.6)),
    attack: () => new THREE.AnimationClip('Armature|Attack_01', 0.9, [track('armR', [0, 0.4, 0.55, 0.9], [0, -2.6, -0.3, 0])]),
    death: () => new THREE.AnimationClip('Death', 1, [track('hips', [0, 1], [0, -1.4])]),
  };
  const animations = wanted.map((n) => all[n]!());

  return new Promise<ArrayBuffer>((resolve, reject) => {
    new GLTFExporter().parse(scene, (r) => (r instanceof ArrayBuffer ? resolve(r) : reject(new Error('expected binary glb'))), reject, { binary: true, animations });
  });
}
