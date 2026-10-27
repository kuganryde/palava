import * as THREE from 'three';
import { BUILDING_DEFS, MAX_UNITS, UNIT_DEFS, UNIT_KINDS, type UnitKind } from '../core/defs';
import type { GameState, UnitState } from '../core/state';
import { heightAt, type Terrain } from '../world/terrain';
import { AnimController, CLIP, CLIPS, chooseClip, type ChooseContext } from './units/animController';
import { SkinnedPool, type UnitAssetLibrary } from './units/gltfUnits';
import { buildUnitGeometry, RIG_KIND } from './units/unitGeometry';
import { createRigMaterials, rigUniforms } from './units/unitRig';

/** Half-width of each body, for resting a fallen unit on the ground. */
const HALF_WIDTH: Record<UnitKind, number> = { infantry: 0.3, archer: 0.3, villager: 0.28, commander: 0.3, cavalry: 0.45, elephant: 0.95 };

/**
 * All troops of a kind share ONE InstancedMesh (one draw call per kind, regardless of army size).
 * Positions are interpolated between the last two fixed simulation steps so motion stays smooth at
 * any frame rate. Poses are animated on the GPU from a handful of per-instance numbers (clip,
 * blend, phase), so there is no per-unit skeleton on the CPU.
 */
export class UnitsView {
  readonly group = new THREE.Group();
  private readonly meshes: Record<UnitKind, THREE.InstancedMesh>;
  private readonly anim: Record<UnitKind, { a: THREE.InstancedBufferAttribute; b: THREE.InstancedBufferAttribute }>;
  private readonly rings: THREE.InstancedMesh;
  private readonly controller = new AnimController();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly tint = new THREE.Color();
  private readonly live = new Set<number>();
  private readonly ctx: ChooseContext = { hp: 1, moving: false, pathLength: 0, nearby: 'none', canWork: false };
  private lastTime = -1;
  private library: UnitAssetLibrary | null = null;
  private libraryVersion = -1;
  pools = new Map<UnitKind, SkinnedPool>();
  /** Authored (skinned) characters drawn last frame, per kind; the rest use the procedural placeholder. */
  readonly skinnedCounts: Record<UnitKind, number> = { infantry: 0, archer: 0, villager: 0, commander: 0, cavalry: 0, elephant: 0 };
  /** Instances drawn per kind last frame (diagnostics). */
  readonly counts: Record<UnitKind, number> = { infantry: 0, archer: 0, villager: 0, commander: 0, cavalry: 0, elephant: 0 };

  constructor(private readonly terrain: Terrain) {
    const meshes = {} as Record<UnitKind, THREE.InstancedMesh>;
    const anim = {} as Record<UnitKind, { a: THREE.InstancedBufferAttribute; b: THREE.InstancedBufferAttribute }>;
    for (const kind of UNIT_KINDS) {
      const rk = RIG_KIND[kind];
      const geometry = buildUnitGeometry(kind);
      const { material, depth } = createRigMaterials({ quad: rk.quad, archer: rk.archer, heavy: rk.heavy, halfWidth: HALF_WIDTH[kind] });
      const mesh = new THREE.InstancedMesh(geometry, material, MAX_UNITS);
      const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_UNITS * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const b = new THREE.InstancedBufferAttribute(new Float32Array(MAX_UNITS * 4), 4).setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aAnim', a);
      geometry.setAttribute('aAnim2', b);
      mesh.customDepthMaterial = depth;
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // instances span the map; the per-mesh bounding sphere would be wrong
      mesh.name = `units:${kind}`;
      meshes[kind] = mesh; anim[kind] = { a, b };
      this.disposables.push(geometry, material, depth, mesh);
      this.group.add(mesh);
    }
    this.meshes = meshes;
    this.anim = anim;
    this.rings = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.42, 0.55, 20).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.95, depthTest: false }),
      MAX_UNITS,
    );
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 9;
    this.group.add(this.rings);
    this.disposables.push(this.rings.geometry, this.rings.material as THREE.Material, this.rings);
  }

  /** Current interpolated world position of a unit (shared by rendering, picking and the minimap). */
  renderPosition(u: UnitState, alpha: number, out = new THREE.Vector3()): THREE.Vector3 {
    const x = u.px + (u.x - u.px) * alpha, z = u.pz + (u.z - u.pz) * alpha;
    return out.set(x, heightAt(this.terrain, x, z), z);
  }

  /** Use authored GLB/GLTF characters for every kind the library has; other kinds keep the placeholder. */
  setAssets(library: UnitAssetLibrary | null): void {
    this.library = library;
    this.libraryVersion = -1;
  }

  private syncPools(): void {
    const v = this.library?.version ?? 0;
    if (v === this.libraryVersion) return;
    this.libraryVersion = v;
    for (const pool of this.pools.values()) { this.group.remove(pool.group); pool.dispose(); }
    this.pools.clear();
    if (!this.library) return;
    for (const kind of this.library.kinds()) {
      const pool = new SkinnedPool(this.library.get(kind)!);
      this.pools.set(kind, pool);
      this.group.add(pool.group);
    }
  }

  /** Test/debug: force a clip on a unit (null releases it). Attack and death have no sim trigger yet. */
  setClipOverride(id: number, clip: number | null): void {
    const s = this.controller.get(id);
    if (s) s.override = clip ?? -1;
  }

  /** What the nearest building says about a villager's surroundings: building work, or tending a producer. */
  private nearby(u: UnitState, state: GameState): ChooseContext['nearby'] {
    let best: ChooseContext['nearby'] = 'none';
    for (const b of state.buildings) {
      const def = BUILDING_DEFS[b.type];
      const dx = Math.max(b.x0 - u.x, 0, u.x - (b.x0 + def.w)), dz = Math.max(b.z0 - u.z, 0, u.z - (b.z0 + def.d));
      const dist = Math.hypot(dx, dz);
      if (b.progress < 1 && dist < 2.4) return 'construction';
      if ((b.type === 'farm' || b.type === 'lumber' || b.type === 'quarry') && b.progress >= 1 && dist < 2.0) best = 'production';
    }
    return best;
  }

  update(state: GameState, selected: ReadonlySet<number>, alpha: number, timeSeconds: number, reducedMotion: boolean): void {
    const dt = this.lastTime < 0 ? 0 : timeSeconds - this.lastTime;
    this.lastTime = timeSeconds;
    rigUniforms.uCalm.value = reducedMotion ? 1 : 0;
    this.syncPools();
    for (const k of UNIT_KINDS) this.skinnedCounts[k] = 0;
    const idx: Record<UnitKind, number> = { infantry: 0, archer: 0, villager: 0, commander: 0, cavalry: 0, elephant: 0 };
    this.live.clear();
    let ringN = 0;
    for (const u of state.units) {
      const kind = u.kind;
      const mesh = this.meshes[kind];
      const i = idx[kind]++;
      if (i >= MAX_UNITS) continue;
      this.live.add(u.id);
      this.renderPosition(u, alpha, this.p);

      const c = this.ctx;
      c.hp = u.hp; c.moving = u.path.length > 0; c.pathLength = u.path.length;
      c.canWork = kind === 'villager';
      c.nearby = c.canWork && !c.moving ? this.nearby(u, state) : 'none';
      const st = this.controller.step(u.id, chooseClip(c), this.p.x, this.p.z, dt, RIG_KIND[kind].stride);

      // Authored skinned character, if this kind has one and the pool has room.
      const pool = this.pools.get(kind);
      const skinned = pool?.acquire(u.id) ?? null;
      if (pool && skinned) {
        idx[kind]--; // not drawn by the placeholder mesh
        skinned.root.position.copy(this.p);
        skinned.root.rotation.y = u.facing;
        pool.play(skinned, CLIPS[st.clip]!, dt, UNIT_DEFS[kind].speed / 3.2);
        this.skinnedCounts[kind]++;
        if (selected.has(u.id) && ringN < MAX_UNITS) {
          const k = Math.max(1, UNIT_DEFS[kind].radius / 0.35 * 0.85);
          this.s.set(k, 1, k);
          this.m.compose(this.p.setY(this.p.y + 0.08), this.q.identity(), this.s);
          this.rings.setMatrixAt(ringN++, this.m);
        }
        continue;
      }
      const { a, b } = this.anim[kind];
      a.setXYZW(i, st.clip, st.prev, st.blend, st.phase);
      b.setXYZW(i, st.clipTime, st.seed, 0, 0);

      // Fallen units rest slightly lower; everything else stands on the terrain.
      const s = kind === 'villager' ? 0.92 : kind === 'commander' ? 1.1 : 1;
      this.s.set(s, s, s);
      this.q.setFromAxisAngle(this.up, u.facing);
      this.m.compose(this.p, this.q, this.s);
      mesh.setMatrixAt(i, this.m);
      // small per-unit tint so a crowd does not look cloned
      const v = 0.9 + 0.2 * st.seed;
      mesh.setColorAt(i, this.tint.setRGB(v, v, v));

      if (selected.has(u.id) && ringN < MAX_UNITS) {
        const k = Math.max(1, UNIT_DEFS[kind].radius / 0.35 * 0.85);
        this.p.setY(this.p.y + 0.08);
        this.s.set(k, 1, k);
        this.m.compose(this.p, this.q.identity(), this.s);
        this.rings.setMatrixAt(ringN++, this.m);
      }
    }
    for (const kind of UNIT_KINDS) {
      const mesh = this.meshes[kind];
      mesh.count = Math.min(idx[kind], MAX_UNITS);
      this.counts[kind] = mesh.count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.anim[kind].a.needsUpdate = true;
      this.anim[kind].b.needsUpdate = true;
    }
    if (this.controller.size > this.live.size) this.controller.prune(this.live);
    for (const pool of this.pools.values()) pool.retain(this.live);
    this.rings.count = ringN;
    this.rings.instanceMatrix.needsUpdate = true;
  }

  /** Free GPU buffers and shader programs. */
  dispose(): void {
    for (const pool of this.pools.values()) pool.dispose();
    this.pools.clear();
    for (const d of this.disposables) d.dispose();
    this.group.clear();
    this.controller.clear();
  }
}

export { CLIP };
