import * as THREE from 'three';
import { smoothstep } from '../core/math';
import type { QualityPreset } from '../systems/settings';
import type { Vegetation } from '../world/vegetation';
import { buildFoliageGeometries, type FoliageKind, type LodGeometry } from './foliageGeometry';
import { ScatterLayer, type ScatterItem } from './scatterLayer';
import { applyWind, windUniforms } from './wind';

type LayerKey = FoliageKind;

/** Tint multipliers are authored as plain 0xRRGGBB but used as LINEAR factors (no sRGB decode), so ~0xffffff means "unchanged". */
const lin = (hex: number): THREE.Color =>
  new THREE.Color().setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, THREE.LinearSRGBColorSpace);

/**
 * All vegetation and rock props. Layers are instanced and chunked (see ScatterLayer); materials and
 * geometries are created once and shared. Quality presets scale how many instances are drawn, and
 * the camera zoom drives LOD (geometry swap, fading small props out when zoomed far away).
 */
export class VegetationView {
  readonly group = new THREE.Group();
  private readonly layers = new Map<LayerKey, ScatterLayer>();
  private readonly geos: Record<FoliageKind, LodGeometry>;
  private readonly materials: THREE.Material[] = [];
  private quality = { tree: 1, rock: 1, bush: 1, reed: 1, grass: 1 };
  private zoom = 1;
  private shadows = true;

  constructor(veg: Vegetation) {
    this.geos = buildFoliageGeometries();

    const foliage = (base: number, amp: number, side: THREE.Side = THREE.DoubleSide): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, side });
      applyWind(m, base, amp);
      this.materials.push(m);
      return m;
    };
    const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
    this.materials.push(rockMat);

    const treeItems = (kind: string): ScatterItem[] =>
      veg.trees.filter((t) => t.kind === kind).map((t) => ({ ...t, stretchY: 0.92 + t.tint * 0.2 }));

    const add = (key: LayerKey, items: ScatterItem[], mat: THREE.Material, shadow: boolean, a: number, b: number, yOffset = 0): void => {
      const geo = this.geos[key];
      this.layers.set(key, new ScatterLayer({
        name: key, hi: geo.hi, lo: geo.lo, material: mat, items, castShadow: shadow, tintA: lin(a), tintB: lin(b), yOffset,
        chunk: key === 'grass' || key === 'reed' ? 24 : 32,
      }));
    };
    // Trunk-and-canopy species: sway starts above the trunk base (0.8) so stems stay planted.
    add('palm', treeItems('palm'), foliage(1.2, 0.012), true, 0xdad6c4, 0xfff4dc, -0.05);
    add('broadleaf', treeItems('broadleaf'), foliage(1.4, 0.006), true, 0xd6dcc2, 0xfdf3d4, -0.05);
    add('banyan', treeItems('banyan'), foliage(2.0, 0.003), true, 0xe0e0cc, 0xf6f0d8, -0.05);
    add('acacia', treeItems('acacia'), foliage(1.6, 0.007), true, 0xdcd8bc, 0xfff0d0, -0.05);
    add('bush', veg.bushes, foliage(0.2, 0.05), false, 0xd2dcc0, 0xfff2d2);
    add('reed', veg.reeds, foliage(0.1, 0.12, THREE.FrontSide), false, 0xd8e0c4, 0xfff4d8);
    add('grass', veg.grass, foliage(0.05, 0.4, THREE.FrontSide), false, 0xd0dcb4, 0xfff0c8);
    add('boulder', veg.rocks.filter((r) => r.kind === 'boulder').map((r) => ({ ...r, stretchY: 0.8 + r.tint * 0.5 })), rockMat, true, 0xc8c2b8, 0xfff4e6, -0.12);
    add('slab', veg.rocks.filter((r) => r.kind === 'slab'), rockMat, true, 0xc8c2b8, 0xfff4e6, -0.06);

    for (const l of this.layers.values()) this.group.add(l.group);
    this.applyLod();
  }

  /** Quality preset: draw a fraction of each layer, and limit shadow casters on Low. */
  setQuality(p: QualityPreset, shadowsOn: boolean): void {
    this.quality = { tree: p.treeFraction, rock: p.rockFraction, bush: p.bushFraction, reed: p.reedFraction, grass: p.grassFraction };
    this.shadows = shadowsOn;
    for (const k of ['palm', 'broadleaf', 'banyan', 'acacia', 'boulder', 'slab'] as const) this.layers.get(k)?.setCastShadow(shadowsOn);
    this.applyLod();
  }

  /**
   * Called every frame (cheap, allocation-free). Zoom is the orthographic camera zoom:
   * small = zoomed out. Far away: swap to the low-detail meshes and fade out tiny props that would
   * be sub-pixel anyway. Close in: full detail, grass and reeds appear.
   */
  update(zoom: number, timeSeconds: number, reducedMotion: boolean): void {
    windUniforms.uWindTime.value = reducedMotion ? 0 : timeSeconds;
    windUniforms.uWindStrength.value = reducedMotion ? 0 : 1;
    if (Math.abs(zoom - this.zoom) > 0.01) {
      this.zoom = zoom;
      this.applyLod();
    }
  }

  private applyLod(): void {
    const z = this.zoom, q = this.quality;
    const detail: 0 | 1 = z < 0.85 ? 1 : 0;
    for (const k of ['palm', 'broadleaf', 'banyan', 'acacia', 'bush', 'boulder', 'slab'] as const) this.layers.get(k)?.setDetail(detail);
    for (const k of ['palm', 'broadleaf', 'banyan', 'acacia'] as const) this.layers.get(k)?.setFraction(q.tree);
    this.layers.get('boulder')?.setFraction(q.rock);
    this.layers.get('slab')?.setFraction(q.rock);
    this.layers.get('bush')?.setFraction(q.bush * (0.35 + 0.65 * smoothstep(0.6, 0.95, z)));
    this.layers.get('reed')?.setFraction(q.reed * smoothstep(0.7, 1.0, z));
    this.layers.get('grass')?.setFraction(q.grass * smoothstep(0.9, 1.25, z));
  }

  /**
   * Hides props under a building footprint so nothing grows through walls. Canopies are wide, so
   * trees get a larger margin than ground cover. Reversible with restoreAll() (new game / load).
   */
  clearRect(x0: number, z0: number, w: number, d: number): void {
    const area = (m: number): [number, number, number, number] => [x0 - m, z0 - m, x0 + w + m, z0 + d + m];
    for (const k of ['palm', 'broadleaf', 'banyan', 'acacia'] as const) this.layers.get(k)?.hideInRect(...area(1.6));
    for (const k of ['bush', 'boulder', 'slab', 'reed', 'grass'] as const) this.layers.get(k)?.hideInRect(...area(0.7));
  }

  hiddenTotal(): number {
    let n = 0;
    for (const l of this.layers.values()) n += l.hiddenCount();
    return n;
  }

  restoreAll(): void {
    for (const l of this.layers.values()) l.restoreAll();
  }

  get drawnTrees(): number {
    let n = 0;
    for (const k of ['palm', 'broadleaf', 'banyan', 'acacia'] as const) n += this.layers.get(k)?.drawn ?? 0;
    return n;
  }

  get drawnProps(): number {
    let n = 0;
    for (const l of this.layers.values()) n += l.drawn;
    return n;
  }

  get shadowCasting(): boolean { return this.shadows; }

  dispose(): void {
    for (const l of this.layers.values()) l.dispose();
    this.layers.clear();
    for (const g of Object.values(this.geos)) { g.hi.dispose(); if (g.lo !== g.hi) g.lo.dispose(); }
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    this.group.clear();
  }
}
