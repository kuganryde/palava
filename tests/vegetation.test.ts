import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildFoliageGeometries, type FoliageKind } from '../src/render/foliageGeometry';
import { ScatterLayer } from '../src/render/scatterLayer';
import { VegetationView } from '../src/render/vegetationView';
import { QUALITY_PRESETS } from '../src/systems/settings';
import { Biome, biomeMapFor, cellIndex } from '../src/world/biome';
import { capitalCenter, generateTerrain, heightAt, WATER_LEVEL } from '../src/world/terrain';
import { CAPITAL_CLEAR, placeVegetation } from '../src/world/vegetation';

const t = generateTerrain(1337);
const veg = placeVegetation(t);
const bm = biomeMapFor(t);

describe('biome-aware vegetation scatter', () => {
  it('is deterministic', () => {
    const b = placeVegetation(t);
    expect(b.trees.length).toBe(veg.trees.length);
    expect(b.trees[0]).toEqual(veg.trees[0]);
    expect(b.grass[10]).toEqual(veg.grass[10]);
    expect(b.rocks.length).toBe(veg.rocks.length);
  });

  it('places several tree silhouettes with varied canopy scales', () => {
    const kinds = new Set(veg.trees.map((x) => x.kind));
    expect(kinds.has('palm')).toBe(true);
    expect(kinds.has('broadleaf')).toBe(true);
    expect(kinds.size).toBeGreaterThanOrEqual(3);
    const scales = veg.trees.map((x) => x.scale);
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.4);
  });

  it('respects water, slope and the cleared capital zone', () => {
    const cap = capitalCenter(t.size);
    for (const p of veg.trees) {
      expect(p.y).toBeGreaterThan(WATER_LEVEL);
      expect(Math.hypot(p.x - cap.x, p.z - cap.z)).toBeGreaterThan(CAPITAL_CLEAR - 0.001);
      expect(bm.slope[cellIndex(t.size, p.x, p.z)]).toBeLessThanOrEqual(1.1);
      expect(p.y).toBeCloseTo(heightAt(t, p.x, p.z), 5);
    }
    for (const p of [...veg.grass, ...veg.bushes]) expect(Math.hypot(p.x - cap.x, p.z - cap.z)).toBeGreaterThan(9.9);
  });

  it('keeps natural spacing: no two trees overlap their trunks', () => {
    let minD = Infinity;
    const ts = veg.trees;
    for (let i = 0; i < ts.length; i++) {
      for (let j = i + 1; j < ts.length; j++) minD = Math.min(minD, Math.hypot(ts[i]!.x - ts[j]!.x, ts[i]!.z - ts[j]!.z));
    }
    expect(minD).toBeGreaterThan(1.0);
  });

  it('is denser in forest than in open grassland, with a sparse edge in between', () => {
    const count = (lo: number, hi: number) => {
      let cells = 0;
      for (let i = 0; i < bm.forest.length; i++) {
        const b = bm.biome[i];
        if (b === Biome.Water || b === Biome.Rock || b === Biome.Highland) continue;
        if (bm.forest[i]! >= lo && bm.forest[i]! < hi) cells++;
      }
      let trees = 0;
      for (const p of veg.trees) {
        const f = bm.forest[cellIndex(t.size, p.x, p.z)]!;
        if (f >= lo && f < hi) trees++;
      }
      return { cells, trees, density: trees / Math.max(1, cells) };
    };
    const open = count(0, 0.05), edge = count(0.2, 0.5), core = count(0.7, 1.01);
    expect(core.cells).toBeGreaterThan(100);
    expect(edge.cells).toBeGreaterThan(100);
    expect(core.density).toBeGreaterThan(edge.density);
    expect(edge.density).toBeGreaterThan(open.density);
  });

  it('puts reeds only at the shoreline and boulders on steep or high ground', () => {
    for (const r of veg.reeds) {
      expect(r.y).toBeGreaterThanOrEqual(WATER_LEVEL - 0.3);
      expect(r.y).toBeLessThanOrEqual(WATER_LEVEL + 0.8);
    }
    const rocky = veg.rocks.filter((r) => {
      const i = cellIndex(t.size, r.x, r.z);
      return bm.slope[i]! > 0.6 || bm.biome[i] === Biome.Rock || bm.biome[i] === Biome.Highland;
    });
    expect(rocky.length / veg.rocks.length).toBeGreaterThan(0.6);
  });

  it('respects the caps and shuffles so a prefix is a uniform subset', () => {
    const small = placeVegetation(t, { trees: 50, bushes: 20, rocks: 30, reeds: 10, grass: 100 });
    expect(small.trees.length).toBeLessThanOrEqual(50);
    expect(small.grass.length).toBeLessThanOrEqual(100);
    // The first quarter of the trees must span the map, not cluster in one corner.
    const q = veg.trees.slice(0, Math.floor(veg.trees.length / 4));
    const xs = q.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(t.size * 0.4);
  });
});

describe('foliage geometry', () => {
  const geos = buildFoliageGeometries();
  const kinds = Object.keys(geos) as FoliageKind[];

  it('builds position/normal/colour-only, finite, non-empty geometry for every species and LOD', () => {
    for (const k of kinds) {
      for (const g of [geos[k].hi, geos[k].lo]) {
        expect(g.attributes.position!.count).toBeGreaterThan(0);
        expect(g.attributes.position!.count % 3).toBe(0);
        expect(g.attributes.color!.count).toBe(g.attributes.position!.count);
        expect(g.attributes.normal).toBeDefined();
        expect(g.index).toBeNull();
        for (const v of g.attributes.position!.array) expect(Number.isFinite(v)).toBe(true);
        for (const v of g.attributes.color!.array) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1.0001); }
      }
    }
  });

  it('keeps low-detail meshes cheaper than high-detail ones for trees', () => {
    for (const k of ['palm', 'broadleaf', 'banyan', 'acacia'] as const) {
      expect(geos[k].lo.attributes.position!.count).toBeLessThan(geos[k].hi.attributes.position!.count);
    }
  });

  it('keeps tree meshes within a sane height for the 1-unit-per-cell world', () => {
    for (const k of ['palm', 'broadleaf', 'banyan', 'acacia'] as const) {
      const box = new THREE.Box3().setFromBufferAttribute(geos[k].hi.attributes.position as THREE.BufferAttribute);
      expect(box.min.y).toBeGreaterThan(-0.5);
      expect(box.max.y).toBeGreaterThan(2.5);
      expect(box.max.y).toBeLessThan(6);
    }
  });
});

describe('ScatterLayer / VegetationView', () => {
  it('chunks instances, honours fractions and swaps LOD geometry', () => {
    const geos = buildFoliageGeometries();
    const items = veg.trees.slice(0, 300).map((p) => ({ ...p }));
    const layer = new ScatterLayer({
      name: 'test', hi: geos.broadleaf.hi, lo: geos.broadleaf.lo, material: new THREE.MeshBasicMaterial(), items,
      tintA: new THREE.Color(1, 1, 1), tintB: new THREE.Color(1, 1, 1), castShadow: true,
    });
    expect(layer.total).toBe(300);
    expect(layer.drawn).toBe(300);
    expect(layer.chunkCount).toBeGreaterThan(1);
    layer.setFraction(0.5);
    expect(layer.drawn).toBeGreaterThan(130);
    expect(layer.drawn).toBeLessThan(170);
    layer.setFraction(0);
    expect(layer.drawn).toBe(0);
    expect(layer.group.visible).toBe(false);
    layer.setFraction(1);
    layer.setDetail(1);
    expect((layer.group.children[0] as THREE.InstancedMesh).geometry).toBe(geos.broadleaf.lo);
    layer.setDetail(0);
    expect((layer.group.children[0] as THREE.InstancedMesh).geometry).toBe(geos.broadleaf.hi);
    layer.dispose();
    expect(layer.drawn).toBe(0);
  });

  it('hides instances inside a rectangle without changing the others, and restores them', () => {
    const geos = buildFoliageGeometries();
    const items = veg.trees.slice(0, 400).map((p) => ({ ...p }));
    const layer = new ScatterLayer({
      name: 'hide', hi: geos.palm.hi, lo: geos.palm.lo, material: new THREE.MeshBasicMaterial(), items,
      tintA: new THREE.Color(1, 1, 1), tintB: new THREE.Color(1, 1, 1), castShadow: false,
    });
    const target = items[0]!;
    const inside = items.filter((i) => i.x >= target.x - 6 && i.x <= target.x + 6 && i.z >= target.z - 6 && i.z <= target.z + 6).length;
    expect(inside).toBeGreaterThanOrEqual(1);
    const hidden = layer.hideInRect(target.x - 6, target.z - 6, target.x + 6, target.z + 6);
    expect(hidden).toBe(inside);
    expect(layer.hiddenCount()).toBe(inside);
    expect(layer.hideInRect(target.x - 6, target.z - 6, target.x + 6, target.z + 6)).toBe(0); // idempotent
    // Hidden instances are collapsed to zero scale; others keep a non-degenerate matrix.
    const m = new THREE.Matrix4(), s = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Quaternion();
    let zero = 0, live = 0;
    for (const mesh of layer.group.children as THREE.InstancedMesh[]) {
      for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, m); m.decompose(p, q, s); if (s.lengthSq() === 0) zero++; else live++; }
    }
    expect(zero).toBe(inside);
    expect(live).toBe(items.length - inside);
    layer.restoreAll();
    expect(layer.hiddenCount()).toBe(0);
    let zero2 = 0;
    for (const mesh of layer.group.children as THREE.InstancedMesh[]) {
      for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, m); m.decompose(p, q, s); if (s.lengthSq() === 0) zero2++; }
    }
    expect(zero2).toBe(0);
    layer.dispose();
  });

  it('clearRect removes trees under a building footprint, restoreAll brings them back', () => {
    const view = new VegetationView(veg);
    const tree = veg.trees[0]!;
    const before = view.hiddenTotal();
    view.clearRect(Math.floor(tree.x) - 1, Math.floor(tree.z) - 1, 3, 3);
    expect(view.hiddenTotal()).toBeGreaterThan(before);
    view.restoreAll();
    expect(view.hiddenTotal()).toBe(0);
    view.dispose();
  });

  it('applies quality presets, fades small props by zoom, and disposes GPU resources', () => {
    const view = new VegetationView(veg);
    view.setQuality(QUALITY_PRESETS.high, true);
    view.update(1.4, 0, false);
    const high = view.drawnProps;
    view.setQuality(QUALITY_PRESETS.low, false);
    const low = view.drawnProps;
    expect(low).toBeLessThan(high);
    expect(view.drawnTrees).toBeLessThan(veg.trees.length);

    // Zoomed far out the grass/reed layers disappear entirely; zoomed in they return.
    view.setQuality(QUALITY_PRESETS.high, true);
    view.update(0.6, 0, false);
    const far = view.drawnProps;
    view.update(1.6, 0, false);
    expect(view.drawnProps).toBeGreaterThan(far);

    // Dispose must free the shared geometries (a 'dispose' event fires per geometry).
    const meshes: THREE.InstancedMesh[] = [];
    view.group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) meshes.push(o as THREE.InstancedMesh); });
    expect(meshes.length).toBeGreaterThan(5);
    const geos = new Set(meshes.map((m) => m.geometry));
    let disposed = 0;
    for (const g of geos) g.addEventListener('dispose', () => disposed++);
    view.dispose();
    expect(disposed).toBeGreaterThanOrEqual(geos.size);
    expect(view.group.children.length).toBe(0);
  });
});
