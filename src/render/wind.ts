import * as THREE from 'three';

/**
 * Shared wind state. One uniform object is referenced by every foliage material, so the whole
 * world sways from a single per-frame write (no per-instance CPU work, no allocations).
 */
export const windUniforms = {
  uWindTime: { value: 0 },
  uWindStrength: { value: 1 },
};

/**
 * Adds a vertex-shader sway to a standard material. Displacement grows with the square of the height
 * above `base`, so trunks and ground stay put while canopies, fronds and blade tips move. Each
 * instance is phase-shifted by its world position, so the wind reads as moving gusts rather than
 * every tree swaying in lockstep.
 */
export function applyWind(material: THREE.MeshStandardMaterial, base: number, amp: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windUniforms.uWindTime;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime;\nuniform float uWindStrength;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec2 wp = vec2(0.0);
          #ifdef USE_INSTANCING
            wp = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
          #endif
          float hgt = max(position.y - ${base.toFixed(3)}, 0.0);
          float ph = uWindTime * 1.3 + wp.x * 0.23 + wp.y * 0.17;
          float g = sin(ph) * 0.65 + sin(ph * 2.7 + wp.y * 0.5) * 0.35;
          float w = hgt * hgt * ${amp.toFixed(4)} * uWindStrength;
          transformed.x += g * w;
          transformed.z += cos(ph * 0.83) * 0.6 * w;
        }`,
      );
  };
  // Different base/amp pairs must not share a compiled program.
  material.customProgramCacheKey = () => `wind-${base}-${amp}`;
}

/**
 * Flag/banner ripple: cloth is a plane whose uv.x runs 0 (at the pole) to 1 (free edge), so the
 * displacement grows away from the pole. Same shared wind uniforms as foliage.
 */
export function applyBannerWave(material: THREE.Material): void {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uWindTime = windUniforms.uWindTime;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime;\nuniform float uWindStrength;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float k = uv.x;
          transformed.z += sin(uWindTime * 3.2 + k * 7.0 + position.y * 2.0) * 0.11 * k * (0.35 + uWindStrength * 0.65);
          transformed.y += sin(uWindTime * 2.1 + k * 5.0) * 0.025 * k * uWindStrength;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'banner-wave';
}
