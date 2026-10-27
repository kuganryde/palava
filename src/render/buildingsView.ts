import * as THREE from 'three';
import { BUILDING_DEFS, type BuildingType } from '../core/defs';
import type { BuildingState, GameState } from '../core/state';
import { footprintCenter } from '../systems/placement';
import { cellHeight, type Terrain } from '../world/terrain';
import { archMaterials } from './arch/archMaterials';
import { ConstructionSite, type PileKind } from './arch/construction';
import { createBuildingModel, type BuildingModel } from './buildingModels';

const ghostMats = {
  valid: new THREE.MeshBasicMaterial({ color: 0x4cd964, transparent: true, opacity: 0.55, depthWrite: false }),
  invalid: new THREE.MeshBasicMaterial({ color: 0xe5484d, transparent: true, opacity: 0.55, depthWrite: false }),
};

function groundY(terrain: Terrain, type: BuildingType, x0: number, z0: number): number {
  const def = BUILDING_DEFS[type];
  let max = -Infinity;
  for (let z = z0; z < z0 + def.d; z++) for (let x = x0; x < x0 + def.w; x++) max = Math.max(max, cellHeight(terrain, x, z));
  return max - 0.1;
}

/** Stone is the first thing delivered to grand works; the rest are timber jobs. */
const PILE: Record<BuildingType, PileKind> = { palace: 'stone', temple: 'stone', quarry: 'stone', barracks: 'timber', farm: 'timber', lumber: 'timber', stronghold: 'stone' };

interface Entry {
  type: BuildingType;
  x0: number;
  z0: number;
  model: BuildingModel;
  obj: THREE.Object3D;
  /** Present only while a procedural building is under construction. */
  site: ConstructionSite | null;
  prog: { value: number };
  materials: THREE.Material[];
}

export class BuildingsView {
  readonly group = new THREE.Group();
  private readonly models = new Map<number, Entry>();
  private ghost: { type: BuildingType; obj: THREE.Object3D } | null = null;
  private readonly selectRing: THREE.Mesh;

  constructor(private readonly terrain: Terrain) {
    this.selectRing = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.selectRing.renderOrder = 10;
    this.selectRing.visible = false;
    this.group.add(this.selectRing);
  }

  private create(b: BuildingState): Entry {
    const model = createBuildingModel(b.type, b.id);
    const obj = model.object;
    obj.userData.buildingId = b.id;
    this.place(obj, b);
    this.group.add(obj);
    return { type: b.type, x0: b.x0, z0: b.z0, model, obj, site: null, prog: { value: b.progress }, materials: [] };
  }

  /** Swap a finished-looking model onto grow-from-the-ground materials and add scaffolding, workers and a material pile. */
  private beginConstruction(e: Entry): void {
    if (!e.model.procedural || e.site) return;
    const mats = archMaterials();
    const byKey = new Map<string, THREE.Material>();
    const depth = mats.constructionDepth(e.prog);
    e.materials.push(depth);
    for (const { mesh, key } of e.model.meshes) {
      let m = byKey.get(key);
      if (!m) { m = mats.construction(key, e.prog); byKey.set(key, m); e.materials.push(m); }
      mesh.material = m;
      mesh.customDepthMaterial = depth;
    }
    const def = BUILDING_DEFS[e.type];
    e.site = new ConstructionSite(def.w, def.d, e.model.height, e.x0 * 7 + e.z0, PILE[e.type]);
    e.obj.add(e.site.group);
  }

  /** Back onto the shared, cheaper materials; the scaffold comes down. */
  private finishConstruction(e: Entry): void {
    if (e.site) { e.obj.remove(e.site.group); e.site.dispose(); e.site = null; }
    if (e.materials.length === 0) return;
    const mats = archMaterials();
    for (const { mesh, key } of e.model.meshes) { mesh.material = mats.get(key); mesh.customDepthMaterial = undefined as unknown as THREE.Material; }
    e.materials.forEach((m) => m.dispose());
    e.materials.length = 0;
  }

  private remove(e: Entry): void {
    this.finishConstruction(e);
    this.group.remove(e.obj);
  }

  /**
   * Reconcile 3D objects with game state. Under construction, procedural buildings rise stage by stage
   * (foundation, walls, roofs, finials) behind scaffolding with labourers; replacement models simply rise.
   * @param time wall-clock seconds (animates workers); @param still hold poses instead of animating
   */
  sync(state: GameState, selectedBuildingId: number | null, time = 0, still = false): void {
    const live = new Set<number>();
    for (const b of state.buildings) {
      live.add(b.id);
      let entry = this.models.get(b.id);
      if (entry && (entry.type !== b.type || entry.x0 !== b.x0 || entry.z0 !== b.z0)) { this.remove(entry); this.models.delete(b.id); entry = undefined; }
      if (!entry) { entry = this.create(b); this.models.set(b.id, entry); }
      entry.prog.value = b.progress;
      if (b.progress < 1) {
        if (entry.model.procedural) {
          this.beginConstruction(entry);
          entry.site?.update(b.progress, time, still);
        } else {
          entry.obj.scale.set(1, 0.12 + 0.88 * b.progress, 1);
        }
      } else {
        if (entry.site || entry.materials.length) this.finishConstruction(entry);
        if (!entry.model.procedural) entry.obj.scale.set(1, 1, 1);
      }
    }
    for (const [id, entry] of this.models) {
      if (!live.has(id)) { this.remove(entry); this.models.delete(id); }
    }
    const sel = selectedBuildingId === null ? undefined : state.buildings.find((b) => b.id === selectedBuildingId);
    if (sel) {
      const def = BUILDING_DEFS[sel.type];
      const c = footprintCenter(def, sel.x0, sel.z0);
      this.selectRing.visible = true;
      this.selectRing.position.set(c.x, groundY(this.terrain, sel.type, sel.x0, sel.z0) + 0.3, c.z);
      const r = Math.max(def.w, def.d) * 0.78;
      this.selectRing.scale.set(r, 1, r);
    } else {
      this.selectRing.visible = false;
    }
  }

  /** Id of the building under a ray (excludes the placement ghost), or null. */
  pick(raycaster: THREE.Raycaster): number | null {
    const roots = [...this.models.values()].map((m) => m.obj);
    const hit = raycaster.intersectObjects(roots, true)[0];
    for (let o: THREE.Object3D | null = hit?.object ?? null; o; o = o.parent) {
      const id = o.userData.buildingId;
      if (typeof id === 'number') return id;
    }
    return null;
  }

  private place(obj: THREE.Object3D, b: BuildingState): void {
    const def = BUILDING_DEFS[b.type];
    const c = footprintCenter(def, b.x0, b.z0);
    obj.position.set(c.x, groundY(this.terrain, b.type, b.x0, b.z0), c.z);
  }

  /** Translucent placement preview tinted by validity. Pass null to hide. */
  setGhost(type: BuildingType | null, x0 = 0, z0 = 0, valid = true): void {
    if (!type) {
      if (this.ghost) { this.group.remove(this.ghost.obj); this.ghost = null; }
      return;
    }
    if (!this.ghost || this.ghost.type !== type) {
      if (this.ghost) this.group.remove(this.ghost.obj);
      const obj = createBuildingModel(type, 0).object;
      obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; } });
      this.ghost = { type, obj };
      this.group.add(obj);
    }
    const def = BUILDING_DEFS[type];
    const c = footprintCenter(def, x0, z0);
    this.ghost.obj.position.set(c.x, groundY(this.terrain, type, x0, z0), c.z);
    const material = valid ? ghostMats.valid : ghostMats.invalid;
    this.ghost.obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = material; });
  }

  /** Release per-building GPU resources (shared geometry/textures are owned by the model cache). */
  dispose(): void {
    for (const e of this.models.values()) this.remove(e);
    this.models.clear();
    this.setGhost(null);
    this.group.remove(this.selectRing);
    this.selectRing.geometry.dispose();
    (this.selectRing.material as THREE.Material).dispose();
  }
}
