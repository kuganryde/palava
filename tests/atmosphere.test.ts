import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Atmosphere } from '../src/render/atmosphere';
import { defaultSettings, QUALITY_PRESETS } from '../src/systems/settings';
import { DAY_LENGTH_SECONDS, START_TIME_OF_DAY } from '../src/world/environment';
import { generateTerrain } from '../src/world/terrain';

function rig() {
  const terrain = generateTerrain(1337);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 110, 330);
  const sun = new THREE.DirectionalLight(0xffffff, 1), moon = new THREE.DirectionalLight(0xffffff, 0);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(sun, sun.target, moon, moon.target, hemi);
  // Only toneMappingExposure is touched, so a plain object stands in for the WebGL renderer in Node.
  const renderer = { toneMappingExposure: 1 } as unknown as THREE.WebGLRenderer;
  const atmo = new Atmosphere({ terrain, scene, renderer, sun, moon, hemi });
  return { terrain, scene, sun, moon, hemi, renderer, atmo, target: new THREE.Vector3(70, 2.5, 74) };
}

describe('Atmosphere', () => {
  const settings = { ...defaultSettings(false), quality: 'high' as const };

  it('drives the light rig from simulation time: sun by day, moon by night', () => {
    const r = rig();
    r.atmo.update(DAY_LENGTH_SECONDS * (0.5 - START_TIME_OF_DAY), 1, r.target, settings); // noon
    expect(r.sun.intensity).toBeGreaterThan(2.4);
    expect(r.moon.intensity).toBe(0);
    expect(r.sun.position.y).toBeGreaterThan(80);
    const fog = r.scene.fog as THREE.Fog;
    expect(fog.far).toBeGreaterThan(fog.near);
    r.atmo.update(DAY_LENGTH_SECONDS * (1.0 - START_TIME_OF_DAY), 1, r.target, settings); // midnight (weather is dry at this sim time)
    expect(r.sun.intensity).toBe(0);
    expect(r.moon.intensity).toBeGreaterThan(0.5);
    expect(r.renderer.toneMappingExposure).toBeGreaterThan(1.1);
    r.atmo.dispose();
  });

  it('keeps the light rig centred on the camera target so shadows follow the view', () => {
    const r = rig();
    r.atmo.update(0, 0, r.target, settings);
    expect(r.sun.target.position.x).toBeCloseTo(70, 5);
    expect(r.sun.target.position.z).toBeCloseTo(74, 5);
    const off = r.sun.position.clone().sub(r.sun.target.position);
    expect(off.length()).toBeCloseTo(120, 3);
    r.atmo.dispose();
  });

  it('holds a fixed warm morning when day/night is off, and stays dry when weather is off', () => {
    const r = rig();
    const fixed = { ...settings, dayNight: false, weather: false };
    r.atmo.update(0, 0, r.target, fixed);
    const a = r.sun.intensity;
    r.atmo.update(DAY_LENGTH_SECONDS * 0.4, 0, r.target, fixed);
    expect(r.sun.intensity).toBeCloseTo(a, 6);
    expect(r.atmo.weather.rain).toBe(0);
    expect(r.atmo.timeOfDay).toBeCloseTo(START_TIME_OF_DAY, 6);
    r.atmo.dispose();
  });

  it('supports a debug override for hour and rain, and rain dims the sun', () => {
    const r = rig();
    r.atmo.override = { tod: 0.5, rain: 0 };
    r.atmo.update(10, 0, r.target, settings);
    const dry = r.sun.intensity;
    r.atmo.override = { tod: 0.5, rain: 1 };
    r.atmo.update(10, 0, r.target, settings);
    expect(r.sun.intensity).toBeLessThan(dry * 0.5);
    r.atmo.dispose();
  });

  it('applies quality presets to particle counts without throwing', () => {
    const r = rig();
    for (const q of ['low', 'medium', 'high'] as const) {
      r.atmo.setQuality(q);
      r.atmo.update(5, 5, r.target, { ...settings, quality: q });
    }
    expect(QUALITY_PRESETS.low.rainDrops).toBe(0);
    expect(QUALITY_PRESETS.high.rainDrops).toBeGreaterThan(QUALITY_PRESETS.medium.rainDrops);
    r.atmo.dispose();
  });

  it('removes its objects from the scene and disposes geometries on dispose', () => {
    const r = rig();
    const before = r.scene.children.length;
    expect(before).toBeGreaterThanOrEqual(10);
    const geos = new Set<THREE.BufferGeometry>();
    r.scene.traverse((o) => { const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined; if (g) geos.add(g); });
    expect(geos.size).toBeGreaterThanOrEqual(5); // sky, water surface, sea, rain, motes, birds
    let disposed = 0;
    for (const g of geos) g.addEventListener('dispose', () => disposed++);
    r.atmo.dispose();
    expect(disposed).toBe(geos.size);
    expect(r.scene.children.length).toBe(before - 5); // dome, water group, rain, motes, birds
  });
});
