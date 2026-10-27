import * as THREE from 'three';

/**
 * Procedural sky dome: zenith/horizon gradient, a soft sun glow and disc, a small moon and a
 * sprinkling of stars that fade in at night. Everything is a handful of uniforms, so a day/night
 * change costs a few uniform writes and no texture uploads.
 */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(mapSize: number) {
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uSunAmt: { value: 1 },
        uStars: { value: 0 },
        uMoonAmt: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uMoonDir;
        uniform vec3 uSunColor; uniform float uSunAmt; uniform float uStars; uniform float uMoonAmt;
        varying vec3 vDir;
        float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, pow(h, 0.7)));
          // Below the horizon: fade to the horizon colour so the dome has no dark seam under the sea.
          col = mix(uHorizon, col, step(0.0, d.y));
          float s = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (pow(s, 6.0) * 0.28 + pow(s, 64.0) * 0.5) * uSunAmt;
          col += uSunColor * smoothstep(0.9993, 0.9997, s) * 1.6 * uSunAmt;
          float m = max(dot(d, uMoonDir), 0.0);
          col += vec3(0.82, 0.88, 1.0) * smoothstep(0.9990, 0.9994, m) * 1.1 * uMoonAmt;
          col += vec3(0.5, 0.6, 0.9) * pow(m, 40.0) * 0.12 * uMoonAmt;
          // Stars: sparse hashed cells, twinkle-free (restrained), only above the horizon.
          vec3 sp = floor(d * 140.0);
          float star = step(0.9965, hash(sp)) * smoothstep(0.05, 0.3, d.y);
          col += vec3(0.9, 0.93, 1.0) * star * uStars * 0.85;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const geo = new THREE.SphereGeometry(450, 32, 16);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.set(mapSize / 2, 0, mapSize / 2);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'sky';
  }

  update(
    zenith: THREE.Color, horizon: THREE.Color, sunDir: THREE.Vector3, moonDir: THREE.Vector3, sunColor: THREE.Color,
    sunAmt: number, moonAmt: number, stars: number,
  ): void {
    const u = this.material.uniforms;
    (u.uZenith!.value as THREE.Color).copy(zenith);
    (u.uHorizon!.value as THREE.Color).copy(horizon);
    (u.uSunDir!.value as THREE.Vector3).copy(sunDir);
    (u.uMoonDir!.value as THREE.Vector3).copy(moonDir);
    (u.uSunColor!.value as THREE.Color).copy(sunColor);
    u.uSunAmt!.value = sunAmt;
    u.uMoonAmt!.value = moonAmt;
    u.uStars!.value = stars;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
