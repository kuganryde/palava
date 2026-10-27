import * as THREE from 'three';
import { heightAt, WATER_LEVEL, type Terrain } from '../world/terrain';

const PAD = 32; // water extends this many cells beyond the map edge before the flat outer sea takes over

/**
 * Sea and river surface. One mesh on the same 1-cell grid as the terrain, with a per-vertex signed
 * depth (water level minus ground height). The shader uses that depth for:
 *  - colour: turquoise shallows blending to deep blue,
 *  - a shoreline foam band that pulses in and out,
 *  - alpha: nearly clear at the beach, opaque in deep water,
 * and analytic wave normals drive a restrained sun glint and a fresnel sky reflection. No planar
 * reflection pass and no extra render targets, so the cost is one draw call.
 */
export class WaterView {
  readonly group = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly outer: THREE.Mesh;
  private readonly surface: THREE.Mesh;
  private readonly outerMaterial: THREE.MeshBasicMaterial;

  constructor(terrain: Terrain) {
    const size = terrain.size;
    const segs = size - 1 + PAD * 2;
    const geo = new THREE.PlaneGeometry(segs, segs, segs, segs);
    geo.rotateX(-Math.PI / 2);
    geo.translate(size / 2 - 0.5, 0, size / 2 - 0.5);
    const pos = geo.attributes.position!;
    const depth = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      // heightAt clamps outside the map to the (deep) edge cells, which is what we want for the open sea.
      depth[i] = WATER_LEVEL - heightAt(terrain, pos.getX(i), pos.getZ(i));
    }
    geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uShallow: { value: new THREE.Color(0x3fa3a0) },
          uDeep: { value: new THREE.Color(0x14527e) },
          uSky: { value: new THREE.Color(0xcfe0ea) },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uSunColor: { value: new THREE.Color(1, 1, 1) },
          uSunAmt: { value: 1 },
          uRain: { value: 0 },
          uWaveAmp: { value: 1 },
        },
      ]),
      vertexShader: /* glsl */ `
        attribute float aDepth;
        varying float vDepth; varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() {
          vDepth = aDepth;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uShallow; uniform vec3 uDeep; uniform vec3 uSky;
        uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uSunAmt; uniform float uRain; uniform float uWaveAmp;
        varying float vDepth; varying vec3 vWorld;
        #include <fog_pars_fragment>
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        // Height field of the swell: two drifting octaves. Normals come from finite differences of it.
        float swell(vec2 p) {
          return noise(p * 0.55 + vec2(uTime * 0.11, uTime * 0.07)) * 0.6 + noise(p * 1.35 - vec2(uTime * 0.17, -uTime * 0.12)) * 0.4;
        }
        void main() {
          vec2 p = vWorld.xz;
          float e = 0.12;
          float h0 = swell(p);
          vec3 n = normalize(vec3((swell(p - vec2(e, 0.0)) - swell(p + vec2(e, 0.0))) * uWaveAmp * 1.6, 1.0,
                                  (swell(p - vec2(0.0, e)) - swell(p + vec2(0.0, e))) * uWaveAmp * 1.6));
          // Rain adds a fine ripple layer.
          n = normalize(n + vec3(noise(p * 6.0 + uTime * 2.0) - 0.5, 0.0, noise(p * 6.0 - uTime * 2.0 + 9.0) - 0.5) * 0.35 * uRain);

          float d = vDepth + (h0 - 0.5) * 0.18 * uWaveAmp;   // waves lap the shoreline in and out
          vec3 col = mix(uShallow, uDeep, smoothstep(0.1, 3.4, d));

          vec3 V = normalize(cameraPosition - vWorld);
          float fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.0);
          col = mix(col, uSky, clamp(fres * 0.55, 0.0, 0.5));          // sky reflection, deliberately capped
          vec3 R = reflect(-uSunDir, n);
          float glint = pow(max(dot(R, V), 0.0), 90.0);
          col += uSunColor * glint * 0.55 * uSunAmt;                  // restrained sun glint

          // Foam: a band hugging the waterline that advances and retreats, plus lacy noise breakup.
          float pulse = 0.5 + 0.5 * sin(uTime * 0.9 + h0 * 6.0);
          float band = smoothstep(0.0, 0.08, d) * (1.0 - smoothstep(0.12, 0.34 + 0.22 * pulse, d));
          float lace = smoothstep(0.38, 0.7, noise(p * 3.2 + uTime * 0.25));
          float foam = clamp(band * (0.5 + 0.7 * lace), 0.0, 1.0);
          col = mix(col, vec3(0.96, 0.97, 0.94) * (0.35 + 0.65 * max(uSunAmt, 0.35)), foam * 0.75);

          float alpha = mix(0.28, 0.93, smoothstep(0.0, 1.3, d));
          alpha = max(alpha, foam * 0.8);
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });

    this.surface = new THREE.Mesh(geo, this.material);
    this.surface.renderOrder = 1;
    this.surface.name = 'water';
    this.surface.frustumCulled = false;
    this.surface.position.y = -0.05;

    // Flat deep-sea plane far below the shoreline mesh so the horizon is solid water, not sky.
    this.outerMaterial = new THREE.MeshBasicMaterial({ color: 0x14527e, fog: true });
    this.outer = new THREE.Mesh(new THREE.PlaneGeometry(size * 8, size * 8).rotateX(-Math.PI / 2), this.outerMaterial);
    this.outer.position.set(size / 2, -0.12, size / 2);
    this.outer.name = 'sea';
    this.group.add(this.outer, this.surface);
  }

  /** Shared surface height (the old gentle tide bob, still available for reduced-motion off). */
  setLevel(y: number): void { this.surface.position.y = y; }
  get level(): number { return this.surface.position.y; }

  update(
    time: number, shallow: THREE.Color, deep: THREE.Color, sky: THREE.Color, sunDir: THREE.Vector3, sunColor: THREE.Color,
    sunAmt: number, rain: number, waveAmp: number,
  ): void {
    const u = this.material.uniforms;
    u.uTime!.value = time;
    (u.uShallow!.value as THREE.Color).copy(shallow);
    (u.uDeep!.value as THREE.Color).copy(deep);
    (u.uSky!.value as THREE.Color).copy(sky);
    (u.uSunDir!.value as THREE.Vector3).copy(sunDir);
    (u.uSunColor!.value as THREE.Color).copy(sunColor);
    u.uSunAmt!.value = sunAmt;
    u.uRain!.value = rain;
    u.uWaveAmp!.value = waveAmp;
    this.outerMaterial.color.copy(deep);
  }

  dispose(): void {
    this.surface.geometry.dispose();
    this.outer.geometry.dispose();
    this.material.dispose();
    this.outerMaterial.dispose();
    this.group.clear();
  }
}
