import * as THREE from 'three';
import { BUILDING_DEFS } from '../core/defs';
import type { CombatEvent, GameState } from '../core/state';
import { footprintCenter } from '../systems/placement';
import { heightAt, type Terrain } from '../world/terrain';

const MAX_ARROWS = 64;
const ARROW_SPEED = 30; // world units per second
const FLASH_SECONDS = 0.18;

interface Arrow { active: boolean; age: number; dur: number; sx: number; sy: number; sz: number; ex: number; ey: number; ez: number; hitId: number; arc: number }

/**
 * Visual feedback for combat events from the simulation: arrows in flight (one InstancedMesh, a fixed
 * pool, zero per-frame allocation) and brief hit flashes. Purely cosmetic: it only reads `state.events`,
 * so the simulation stays deterministic and testable without a renderer.
 */
export class CombatFx {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private readonly arrows: Arrow[] = Array.from({ length: MAX_ARROWS }, () => ({ active: false, age: 0, dur: 0, sx: 0, sy: 0, sz: 0, ex: 0, ey: 0, ez: 0, hitId: 0, arc: 0 }));
  /** Unit id -> seconds of white hit-flash left. Read by UnitsView. */
  readonly flashes = new Map<number, number>();
  private seen = -1;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly fwd = new THREE.Vector3(0, 0, 1);

  constructor(private readonly terrain: Terrain) {
    const geo = new THREE.BoxGeometry(0.05, 0.05, 0.9);
    geo.translate(0, 0, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xe9dcb4 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_ARROWS);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.group.add(this.mesh);
  }

  private pos(state: GameState, id: number, out: { x: number; y: number; z: number }): boolean {
    const u = state.units.find((x) => x.id === id);
    if (u) { out.x = u.x; out.z = u.z; out.y = heightAt(this.terrain, u.x, u.z) + 1.0; return true; }
    const b = state.buildings.find((x) => x.id === id);
    if (b) {
      const c = footprintCenter(BUILDING_DEFS[b.type], b.x0, b.z0);
      out.x = c.x; out.z = c.z; out.y = heightAt(this.terrain, c.x, c.z) + 1.4;
      return true;
    }
    return false;
  }

  private readonly a = { x: 0, y: 0, z: 0 };
  private readonly b = { x: 0, y: 0, z: 0 };

  private spawn(state: GameState, e: CombatEvent): void {
    const hasTo = this.pos(state, e.to, this.b);
    if (!hasTo) return;
    if (!e.ranged) { this.flashes.set(e.to, FLASH_SECONDS); return; }
    if (!this.pos(state, e.from, this.a)) return;
    const slot = this.arrows.find((x) => !x.active);
    if (!slot) return; // pool full: drop the visual, never the gameplay
    const dist = Math.hypot(this.b.x - this.a.x, this.b.z - this.a.z);
    Object.assign(slot, {
      active: true, age: 0, dur: Math.max(0.12, dist / ARROW_SPEED), hitId: e.to, arc: Math.min(2.4, dist * 0.12),
      sx: this.a.x, sy: this.a.y, sz: this.a.z, ex: this.b.x, ey: this.b.y, ez: this.b.z,
    });
  }

  update(state: GameState, dt: number, reducedMotion: boolean): void {
    // New events since the last frame (events are appended in time order).
    const ev = state.events;
    if (ev) {
      for (const e of ev) {
        if (e.t <= this.seen) continue;
        if (!reducedMotion || !e.ranged) this.spawn(state, e); else this.flashes.set(e.to, FLASH_SECONDS);
      }
      if (ev.length) this.seen = ev[ev.length - 1]!.t;
    }
    // A fresh game restarts sim time at 0: forget old timestamps so events are not ignored.
    if (this.seen > state.time + 1) this.seen = -1;

    let n = 0;
    for (const a of this.arrows) {
      if (!a.active) continue;
      a.age += dt;
      const k = Math.min(1, a.age / a.dur);
      this.p.set(a.sx + (a.ex - a.sx) * k, a.sy + (a.ey - a.sy) * k + Math.sin(k * Math.PI) * a.arc, a.sz + (a.ez - a.sz) * k);
      // tangent of the arc for orientation
      this.dir.set(a.ex - a.sx, (a.ey - a.sy) + Math.cos(k * Math.PI) * Math.PI * a.arc, a.ez - a.sz).normalize();
      this.q.setFromUnitVectors(this.fwd, this.dir);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
      if (k >= 1) { a.active = false; this.flashes.set(a.hitId, FLASH_SECONDS); }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;

    for (const [id, t] of this.flashes) {
      const left = t - dt;
      if (left <= 0) this.flashes.delete(id); else this.flashes.set(id, left);
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
