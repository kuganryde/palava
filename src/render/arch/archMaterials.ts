import * as THREE from 'three';
import { applyBannerWave, applyWind } from '../wind';
import { createSurfaceTextures, type SurfaceKind } from './archTextures';

export type MatKey =
  | 'stone' | 'sandstone' | 'plaster' | 'tile' | 'timber' | 'thatch' | 'earth'
  | 'bronze' | 'gold' | 'cloth' | 'dark' | 'water' | 'rice' | 'rock';

/** Surface texture used by each material (metals, cloth and the like have none). */
export const MATERIAL_SURFACE: Partial<Record<MatKey, SurfaceKind>> = {
  stone: 'stone', sandstone: 'stone', plaster: 'plaster', tile: 'tile', timber: 'timber', thatch: 'thatch', earth: 'earth', rock: 'stone',
};

/**
 * Shared physically based materials for every building: carved stone, limewashed sandstone, clay tile,
 * seasoned timber, thatch, bronze and gilt metal, royal-blue cloth. Roughness and metalness follow the
 * real surfaces (matte stone and clay, brushed bronze, polished gilt) rather than one plastic default.
 * Textures are created lazily, once, and shared by every model.
 */
export class ArchMaterials {
  private readonly mats = new Map<MatKey, THREE.MeshStandardMaterial>();
  private readonly tex = new Map<SurfaceKind, ReturnType<typeof createSurfaceTextures>>();
  private env: THREE.Texture | null = null;

  private textures(kind: SurfaceKind): ReturnType<typeof createSurfaceTextures> {
    let t = this.tex.get(kind);
    if (!t) { t = createSurfaceTextures(kind); this.tex.set(kind, t); }
    return t;
  }

  private make(key: MatKey): THREE.MeshStandardMaterial {
    const surface = MATERIAL_SURFACE[key];
    const t = surface ? this.textures(surface) : null;
    const textured = (color: number, roughness: number, bumpScale: number): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({ color, map: t!.map, bumpMap: t!.bump, bumpScale, roughness, metalness: 0 });
    let m: THREE.MeshStandardMaterial;
    switch (key) {
      case 'stone': m = textured(0xffffff, 0.92, 2.4); break;
      case 'sandstone': m = textured(0xf4dcb2, 0.88, 1.8); break;
      case 'plaster': m = textured(0xffffff, 0.96, 0.9); break;
      case 'tile': m = textured(0xffffff, 0.72, 3.0); break;
      case 'timber': m = textured(0xffffff, 0.78, 1.2); break;
      case 'thatch': m = textured(0xffffff, 1, 1.5); break;
      case 'earth': m = textured(0xffffff, 1, 1.0); break;
      case 'rock': m = textured(0xb8b0a2, 1, 3.0); break;
      case 'bronze': m = new THREE.MeshStandardMaterial({ color: 0xa8743a, metalness: 0.85, roughness: 0.4 }); break;
      case 'gold': m = new THREE.MeshStandardMaterial({ color: 0xdcae3c, metalness: 0.92, roughness: 0.3 }); break;
      case 'cloth': m = new THREE.MeshStandardMaterial({ color: 0x25479a, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }); applyBannerWave(m); break;
      case 'dark': m = new THREE.MeshStandardMaterial({ color: 0x140e0a, roughness: 1, metalness: 0 }); break;
      case 'water': m = new THREE.MeshStandardMaterial({ color: 0x3f86a8, roughness: 0.06, metalness: 0.15 }); break;
      case 'rice': m = new THREE.MeshStandardMaterial({ color: 0x6fae3c, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }); applyWind(m, 0, 0.9); break;
    }
    if (this.env && (key === 'bronze' || key === 'gold' || key === 'water')) { m.envMap = this.env; m.envMapIntensity = key === 'water' ? 0.9 : 1.1; }
    m.name = `arch:${key}`;
    return m;
  }

  get(key: MatKey): THREE.MeshStandardMaterial {
    let m = this.mats.get(key);
    if (!m) { m = this.make(key); this.mats.set(key, m); }
    return m;
  }

  /** Reflection source for the metals and water (a PMREM of a plain sky gradient; see envMap.ts). */
  setEnvironment(env: THREE.Texture | null): void {
    this.env = env;
    for (const [key, m] of this.mats) {
      if (key === 'bronze' || key === 'gold' || key === 'water') { m.envMap = env; m.envMapIntensity = key === 'water' ? 0.9 : 1.1; m.needsUpdate = true; }
    }
  }

  /**
   * A per-building copy of a material that grows its pieces upward as `progress` passes each piece's
   * construction stage window. Pieces carry `aStage = (start, end, baseY)`; a piece scales from its own
   * base between start and end, and collapses to nothing before start. Programs are shared between all
   * copies (same cache key); only the uniform differs.
   */
  construction(key: MatKey, progress: { value: number }): THREE.MeshStandardMaterial {
    const m = this.get(key).clone();
    if (this.env && (key === 'bronze' || key === 'gold' || key === 'water')) m.envMap = this.env;
    const base = this.get(key).onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      base?.call(m, shader, renderer);
      shader.uniforms.uProg = progress;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aStage;\nuniform float uProg;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          {
            float r = clamp((uProg - aStage.x) / max(aStage.y - aStage.x, 0.001), 0.0, 1.0);
            r = r * r * (3.0 - 2.0 * r);
            if (r < 0.003) { transformed = vec3(0.0); }   // not started yet: collapse to a point (no flat artefacts)
            else { transformed.y = aStage.z + (transformed.y - aStage.z) * r; }
          }`,
        );
    };
    const prevKey = this.get(key).customProgramCacheKey;
    m.customProgramCacheKey = () => `arch-construct-${key}-${prevKey ? prevKey.call(m) : ''}`;
    return m;
  }

  /**
   * Shadow-pass twin of construction(): without it the sun's shadow map would show the finished
   * building while the visible mesh is still half-grown.
   */
  constructionDepth(progress: { value: number }): THREE.MeshDepthMaterial {
    const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uProg = progress;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aStage;\nuniform float uProg;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          {
            float r = clamp((uProg - aStage.x) / max(aStage.y - aStage.x, 0.001), 0.0, 1.0);
            r = r * r * (3.0 - 2.0 * r);
            if (r < 0.003) { transformed = vec3(0.0); }
            else { transformed.y = aStage.z + (transformed.y - aStage.z) * r; }
          }`,
        );
    };
    m.customProgramCacheKey = () => 'arch-construct-depth';
    return m;
  }

  dispose(): void {
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    for (const t of this.tex.values()) { t.map.dispose(); t.bump.dispose(); }
    this.tex.clear();
  }
}

let shared: ArchMaterials | null = null;
export function archMaterials(): ArchMaterials {
  if (!shared) shared = new ArchMaterials();
  return shared;
}
export function disposeArchMaterials(): void {
  shared?.dispose();
  shared = null;
}
