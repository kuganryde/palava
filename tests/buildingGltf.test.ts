import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILDING_DEFS } from '../src/core/defs';
import { clearBuildingModelOverrides, createBuildingModel } from '../src/render/buildingModels';
import {
  MAX_TRIANGLES, countTriangles, fitToFootprint, loadBuildingAsset, loadBuildingManifest, sanitize,
} from '../src/render/buildingGltf';

afterEach(() => clearBuildingModelOverrides());

/** A tall off-centre box standing in for an authored export (arbitrary scale and origin). */
function fakeScene(w = 30, h = 80, d = 20): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial());
  m.position.set(100, 500, -40);
  g.add(m);
  return g;
}

describe('fitToFootprint', () => {
  it('fits the footprint, rests on the ground and centres on x/z', () => {
    const def = BUILDING_DEFS.temple;
    const fitted = fitToFootprint(fakeScene(), def.w, def.d);
    fitted.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(fitted);
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    expect(box.min.y).toBeCloseTo(0, 5);
    expect(size.x).toBeLessThanOrEqual(def.w + 1e-6);
    expect(size.z).toBeLessThanOrEqual(def.d + 1e-6);
    expect(size.y).toBeLessThanOrEqual(Math.max(def.w, def.d) * 2.4 + 1e-6);
    expect(c.x).toBeCloseTo(0, 5);
    expect(c.z).toBeCloseTo(0, 5);
  });
  it('rejects empty models', () => {
    expect(() => fitToFootprint(new THREE.Group(), 5, 5)).toThrow(/bounds/);
  });
});

describe('sanitize', () => {
  it('removes lights and cameras and enables shadows', () => {
    const g = fakeScene();
    g.add(new THREE.PointLight(), new THREE.PerspectiveCamera());
    sanitize(g);
    let lights = 0, shadows = 0;
    g.traverse((o) => { if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) lights++; if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).castShadow) shadows++; });
    expect(lights).toBe(0);
    expect(shadows).toBe(1);
  });
});

describe('loadBuildingAsset', () => {
  it('registers an override that createBuildingModel then uses', async () => {
    const { triangles } = await loadBuildingAsset('temple', 'http://localhost/models/temple.glb', async () => ({ scene: fakeScene() }));
    expect(triangles).toBe(12);
    const m = createBuildingModel('temple');
    expect(m.procedural).toBe(false);
    expect(m.height).toBeGreaterThan(1);
    // Two instances are independent nodes but share geometry.
    const a = createBuildingModel('temple').object, b = createBuildingModel('temple').object;
    expect(a).not.toBe(b);
  });
  it('rejects oversized and empty models and leaves the procedural model in place', async () => {
    const dense = new THREE.Group();
    dense.add(new THREE.Mesh(new THREE.SphereGeometry(5, 600, 400)));
    expect(countTriangles(dense)).toBeGreaterThan(MAX_TRIANGLES);
    await expect(loadBuildingAsset('temple', 'http://localhost/a.glb', async () => ({ scene: dense }))).rejects.toThrow(/triangles/);
    await expect(loadBuildingAsset('temple', 'http://localhost/a.glb', async () => ({ scene: new THREE.Group() }))).rejects.toThrow(/no meshes/);
    expect(createBuildingModel('temple').procedural).toBe(true);
  });
  it('refuses another origin', async () => {
    await expect(loadBuildingAsset('temple', 'https://evil.example/t.glb', async () => ({ scene: fakeScene() }))).rejects.toThrow(/another origin/);
  });
});

describe('loadBuildingManifest', () => {
  const okFetch = (body: unknown) => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
  it('loads known types and reports unknown or malformed entries', async () => {
    const r = await loadBuildingManifest('http://localhost/models/buildings.json', {
      fetchFn: okFetch({ buildings: { temple: 'temple.glb', castle: 'x.glb', farm: 7, __proto__x: 'y.glb' } }),
      load: async () => ({ scene: fakeScene() }),
    });
    expect(r.loaded).toEqual(['temple']);
    expect(r.failed.map((f) => f.type).sort()).toEqual(['__proto__x', 'castle', 'farm']);
  });
  it('throws on a manifest without buildings', async () => {
    await expect(loadBuildingManifest('http://localhost/m.json', { fetchFn: okFetch({ units: {} }) })).rejects.toThrow(/buildings/);
  });
  it('throws when the manifest is missing', async () => {
    const f = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(loadBuildingManifest('http://localhost/m.json', { fetchFn: f })).rejects.toThrow(/404/);
  });
});
