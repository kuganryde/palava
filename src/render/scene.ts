import * as THREE from 'three';
import { QUALITY_PRESETS, type Settings } from '../systems/settings';

export const PALETTE = {
  royalBlue: 0x2d4f9e,
  sandstone: 0xd9b98a,
  bronze: 0xb07a3a,
  terracotta: 0xc4663a,
  gold: 0xe0b040,
} as const;

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  moon: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  applySettings(s: Settings): void;
  setPixelRatio(ratio: number): void;
  dispose(): void;
}

/** Throws a user-presentable Error when WebGL is unavailable. */
export function createScene(canvas: HTMLCanvasElement, mapSize: number, settings: Settings): SceneContext {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: QUALITY_PRESETS[settings.quality].antialias, powerPreference: 'high-performance',
    });
  } catch {
    throw new Error('WebGL is not available in this browser or has been disabled.');
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const horizon = new THREE.Color(0xf2c48a);
  scene.fog = new THREE.Fog(horizon, 110, 330);

  // Lights. Colours, intensities and directions are driven every frame by Atmosphere (day/night, weather);
  // these are just sensible starting values and the shadow setup.
  const hemi = new THREE.HemisphereLight(0xbcd7f5, 0x8a6a3c, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffd9a0, 2.6);
  sun.position.set(mapSize * 0.5 - 60, 90, mapSize * 0.5 - 40);
  sun.target.position.set(mapSize * 0.5, 0, mapSize * 0.5);
  sun.castShadow = true;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  const sc = sun.shadow.camera;
  sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 260;
  // Moonlight: a dim cool fill with no shadows (a second shadow pass would double the cost for little gain).
  const moon = new THREE.DirectionalLight(0x9fb2e6, 0);
  moon.target.position.copy(sun.target.position);
  scene.add(sun, sun.target, moon, moon.target);

  const ctx: SceneContext = {
    renderer, scene, sun, moon, hemi,
    applySettings(s) {
      const preset = QUALITY_PRESETS[s.quality];
      const enabled = s.shadows && preset.shadowMapSize > 0;
      renderer.shadowMap.enabled = enabled;
      sun.castShadow = enabled;
      if (enabled && sun.shadow.mapSize.x !== preset.shadowMapSize) {
        sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      // Materials must recompile when shadows are toggled.
      scene.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true; });
    },
    setPixelRatio(ratio) { renderer.setPixelRatio(ratio); },
    dispose() { renderer.dispose(); },
  };
  ctx.applySettings(settings);
  return ctx;
}
