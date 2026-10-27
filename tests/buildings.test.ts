import { afterAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BUILDING_DEFS, type BuildingType } from '../src/core/defs';
import { disposeArchMaterials } from '../src/render/arch/archMaterials';
import { ConstructionSite, disposeConstructionShared } from '../src/render/arch/construction';
import { builtModel, createBuildingModel, disposeBuildingModels, VARIANT_COUNT } from '../src/render/buildingModels';

const TYPES = Object.keys(BUILDING_DEFS) as BuildingType[];

afterAll(() => { disposeBuildingModels(); disposeArchMaterials(); disposeConstructionShared(); });

describe('procedural Pallava models', () => {
  for (const type of TYPES) {
    for (let v = 0; v < VARIANT_COUNT[type]; v++) {
      it(`${type}#${v}: finite geometry, fits its footprint, sits on the ground`, () => {
        const def = BUILDING_DEFS[type];
        const m = builtModel(type, v);
        for (const level of [m.hi, m.lo]) {
          expect(level.length).toBeGreaterThan(0);
          for (const { mesh } of level) {
            const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
            for (let i = 0; i < pos.array.length; i++) expect(Number.isFinite(pos.array[i])).toBe(true);
            const stage = mesh.geometry.getAttribute('aStage') as THREE.BufferAttribute;
            expect(stage.count).toBe(pos.count);
          }
        }
        // footprint: model extent stays within the placement footprint plus a small eave overhang
        expect(m.bounds.max.x).toBeLessThanOrEqual(def.w / 2 + 0.5);
        expect(m.bounds.min.x).toBeGreaterThanOrEqual(-def.w / 2 - 0.5);
        expect(m.bounds.max.z).toBeLessThanOrEqual(def.d / 2 + 0.5);
        expect(m.bounds.min.z).toBeGreaterThanOrEqual(-def.d / 2 - 0.5);
        // starts below ground (foundation) and has real height
        expect(m.bounds.min.y).toBeLessThan(0);
        expect(m.height).toBeGreaterThan(1);
        expect(m.height).toBeLessThan(10);
      });
    }
    it(`${type}: far LOD is simpler than near LOD and both stay modest`, () => {
      const t = builtModel(type, 0).triangles;
      expect(t.lo).toBeLessThanOrEqual(t.hi);
      expect(t.hi).toBeLessThan(20000);
    });
  }

  it('is deterministic', () => {
    const a = builtModel('temple', 1), b = builtModel('temple', 1);
    expect(a).toBe(b); // cached
    disposeBuildingModels();
    const c = builtModel('temple', 1);
    expect(c.triangles).toEqual(a.triangles);
    expect(c.height).toBeCloseTo(a.height, 6);
  });

  it('temples differ by tier count and grow taller with more tiers', () => {
    const h = [0, 1, 2].map((v) => builtModel('temple', v).height);
    expect(h[1]).toBeGreaterThan(h[0]!);
    expect(h[2]).toBeGreaterThan(h[1]!);
  });

  it('wraps out-of-range and negative variants safely', () => {
    expect(builtModel('temple', 7).height).toBeCloseTo(builtModel('temple', 1).height, 6);
    expect(builtModel('temple', -1).height).toBeCloseTo(builtModel('temple', 2).height, 6);
    expect(builtModel('palace', 99)).toBe(builtModel('palace', 0));
  });

  it('instances share geometry and tag meshes with a material key', () => {
    const a = createBuildingModel('barracks', 0), b = createBuildingModel('barracks', 0);
    expect(a.object).not.toBe(b.object);
    expect(a.meshes.length).toBeGreaterThan(0);
    const ga = new Set(a.meshes.map((m) => m.mesh.geometry)), gb = new Set(b.meshes.map((m) => m.mesh.geometry));
    for (const g of ga) expect(gb.has(g)).toBe(true);
    for (const { mesh, key } of a.meshes) expect(mesh.name.endsWith(`:${key}`)).toBe(true);
  });

  it('construction stages never decrease with height and span the whole 0..1 range', () => {
    for (const type of TYPES) {
      const m = builtModel(type, 0);
      let lo = 1, hi = 0;
      for (const { mesh } of m.hi) {
        const s = mesh.geometry.getAttribute('aStage') as THREE.BufferAttribute;
        for (let i = 0; i < s.count; i++) {
          expect(s.getX(i)).toBeGreaterThanOrEqual(0);
          expect(s.getY(i)).toBeLessThanOrEqual(1);
          expect(s.getY(i)).toBeGreaterThan(s.getX(i));
          lo = Math.min(lo, s.getX(i)); hi = Math.max(hi, s.getY(i));
        }
      }
      expect(lo).toBeLessThanOrEqual(0.05);
      expect(hi).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('outward-wound roofs face away from the building centre (lit correctly)', () => {
    const m = builtModel('palace', 0);
    const roof = m.hi.find((x) => x.key === 'tile')!.mesh.geometry;
    const n = roof.getAttribute('normal') as THREE.BufferAttribute;
    let up = 0;
    for (let i = 0; i < n.count; i++) if (n.getY(i) > 0) up++;
    expect(up / n.count).toBeGreaterThan(0.5);
  });
});

describe('construction site', () => {
  it('reveals scaffolding level by level as work progresses', () => {
    const s = new ConstructionSite(5, 5, 6, 1, 'stone');
    const draw = (): number => s.group.children.find((c) => (c as THREE.Mesh).isMesh && c !== undefined && (c as THREE.Mesh).geometry.drawRange !== undefined && c === s.group.children[1])!
      ? (s.group.children[1] as THREE.Mesh).geometry.drawRange.count : 0;
    s.update(0, 0, true);
    const a = draw();
    s.update(0.5, 0, true);
    const b = draw();
    s.update(1, 0, true);
    const c = draw();
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThanOrEqual(b);
    s.dispose();
  });

  it('keeps workers finite and near the site for any time, including huge or negative', () => {
    const s = new ConstructionSite(4, 3, 3, 2, 'timber');
    for (const t of [0, 1.7, 1e5, -33]) {
      s.update(0.4, t, false);
      s.group.traverse((o) => {
        expect(Number.isFinite(o.position.x + o.position.y + o.position.z + o.rotation.x + o.rotation.y)).toBe(true);
        expect(Math.abs(o.position.x)).toBeLessThan(4);
        expect(Math.abs(o.position.z)).toBeLessThan(4);
      });
    }
    s.dispose();
  });

  it('shrinks the material pile as it is used', () => {
    const s = new ConstructionSite(3, 3, 2, 3, 'stone');
    s.update(0, 0, true);
    const pile = s.group.children[s.group.children.length - 1]!;
    const start = pile.scale.y;
    s.update(1, 0, true);
    expect(pile.scale.y).toBeLessThan(start);
    expect(pile.scale.y).toBeGreaterThan(0);
    s.dispose();
  });
});
