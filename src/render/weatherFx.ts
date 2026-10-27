import * as THREE from 'three';
import { mulberry32 } from '../core/rng';

/**
 * Rain, drifting motes and birds. Rain and motes are animated entirely in the vertex shader from a
 * single time uniform (the drop positions are a pure function of a per-drop random seed), so there
 * is no per-particle JavaScript at all; birds update a dozen matrices per frame with preallocated
 * scratch objects.
 */

function seedAttribute(count: number, perVertex: 1 | 2, seed: number): THREE.BufferAttribute {
  const rand = mulberry32(seed);
  const arr = new Float32Array(count * perVertex * 4);
  for (let i = 0; i < count; i++) {
    const a = rand(), b = rand(), c = rand(), d = rand();
    for (let v = 0; v < perVertex; v++) arr.set([a, b, c, d], (i * perVertex + v) * 4);
  }
  return new THREE.BufferAttribute(arr, 4);
}

export class RainField {
  readonly object: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;

  constructor(private readonly maxCount: number) {
    const count = maxCount;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3)); // unused placeholder; GPU computes positions
    geo.setAttribute('aSeed', seedAttribute(count, 2, 0xa11ce));
    const ends = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) ends[i * 2 + 1] = 1;
    geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); // positions are generated in the shader, so never cull
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: {
        uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uIntensity: { value: 0 },
        uColor: { value: new THREE.Color(0.78, 0.84, 0.95) },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed; attribute float aEnd;
        uniform float uTime; uniform vec3 uCenter; uniform float uIntensity;
        varying float vA;
        void main() {
          const float EXT = 64.0; const float HGT = 40.0;
          float fall = 30.0 + aSeed.z * 9.0;
          float y = mod(aSeed.y * HGT - uTime * fall, HGT);
          vec3 p = vec3(uCenter.x + (aSeed.x - 0.5) * EXT, uCenter.y + y, uCenter.z + (aSeed.w - 0.5) * EXT);
          p.x += y * 0.12;                                   // gentle slant: a light, steady wind
          vec3 q = p + vec3(0.12, 1.0, 0.0) * (1.1 + aSeed.z * 0.5) * aEnd;
          vA = step(aSeed.w * 0.9973 + 0.0013, uIntensity) * (0.25 + 0.5 * aSeed.z) * (1.0 - aEnd * 0.6);
          gl_Position = projectionMatrix * viewMatrix * vec4(q, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vA;
        void main() { if (vA <= 0.001) discard; gl_FragColor = vec4(uColor, vA); }`,
    });
    this.object = new THREE.LineSegments(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
    this.object.visible = false;
    this.object.name = 'rain';
  }

  /** Draw only the first n drops (quality preset). */
  setCount(n: number): void {
    this.object.geometry.setDrawRange(0, Math.max(0, Math.min(this.maxCount, Math.floor(n))) * 2);
    this.drops = Math.max(0, Math.min(this.maxCount, Math.floor(n)));
  }
  private drops = 0;

  update(time: number, cx: number, cy: number, cz: number, intensity: number): void {
    this.object.visible = intensity > 0.02 && this.drops > 0;
    if (!this.object.visible) return;
    const u = this.material.uniforms;
    u.uTime!.value = time;
    (u.uCenter!.value as THREE.Vector3).set(cx, cy, cz);
    u.uIntensity!.value = intensity;
  }

  dispose(): void { this.object.geometry.dispose(); this.material.dispose(); }
}

/** Dust and pollen by day, soft fireflies at night; additive, tiny, and only near the camera. */
export class MoteField {
  readonly object: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private motes = 0;

  constructor(private readonly maxCount: number, pixelRatio = 1) {
    const count = maxCount;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aSeed', seedAttribute(count, 1, 0xf1fe));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: {
        uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uNight: { value: 0 }, uAmount: { value: 1 },
        uPx: { value: pixelRatio },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime; uniform vec3 uCenter; uniform float uNight; uniform float uAmount; uniform float uPx;
        varying float vA; varying float vNight;
        void main() {
          const float EXT = 46.0;
          vec3 p = vec3(uCenter.x + (aSeed.x - 0.5) * EXT, uCenter.y + 0.6 + aSeed.y * 6.5, uCenter.z + (aSeed.w - 0.5) * EXT);
          float t = uTime * (0.25 + aSeed.z * 0.3);
          p += vec3(sin(t + aSeed.x * 40.0) * 1.2, sin(t * 1.3 + aSeed.y * 30.0) * 0.5, cos(t * 0.9 + aSeed.w * 50.0) * 1.2);
          float pulse = mix(1.0, 0.35 + 0.65 * sin(uTime * (0.8 + aSeed.z) + aSeed.x * 60.0) * 0.5 + 0.325, uNight);
          vA = step(aSeed.z, uAmount) * pulse * mix(0.22, 0.9, uNight);
          vNight = uNight;
          gl_PointSize = (mix(2.2, 4.2, uNight) * (0.6 + aSeed.y)) * uPx;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vA; varying float vNight;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d) * vA;
          if (a < 0.01) discard;
          vec3 c = mix(vec3(1.0, 0.92, 0.7), vec3(0.75, 1.0, 0.45), vNight);
          gl_FragColor = vec4(c * a, a);
        }`,
    });
    this.object = new THREE.Points(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
    this.object.name = 'motes';
  }

  setCount(n: number): void {
    this.motes = Math.max(0, Math.min(this.maxCount, Math.floor(n)));
    this.object.geometry.setDrawRange(0, this.motes);
  }

  update(time: number, cx: number, cy: number, cz: number, night: number, amount: number, visible: boolean): void {
    this.object.visible = visible && amount > 0.01 && this.motes > 0;
    if (!this.object.visible) return;
    const u = this.material.uniforms;
    u.uTime!.value = time;
    (u.uCenter!.value as THREE.Vector3).set(cx, cy, cz);
    u.uNight!.value = night;
    u.uAmount!.value = amount;
  }

  setPixelRatio(r: number): void { this.material.uniforms.uPx!.value = r; }
  dispose(): void { this.object.geometry.dispose(); this.material.dispose(); }
}

/** A loose flock circling over the island by day. Silhouettes only: flapping is a vertex shader sine. */
export class BirdFlock {
  readonly object: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly time = { value: 0 };
  private readonly phase: Float32Array;
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3(1, 1, 1);
  private readonly _e = new THREE.Euler();

  private count: number;

  constructor(private readonly maxCount: number, private readonly mapSize: number) {
    const count = maxCount;
    this.count = count;
    const geo = new THREE.BufferGeometry();
    // Body + two wings as flat triangles lying in the XZ plane (nose towards +Z).
    const v = [
      0, 0, 0.45, -0.07, 0, -0.2, 0.07, 0, -0.2,
      -0.06, 0, 0.12, -1.0, 0, -0.12, -0.06, 0, -0.18,
      0.06, 0, 0.12, 0.06, 0, -0.18, 1.0, 0, -0.12,
    ];
    geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    this.material = new THREE.MeshBasicMaterial({ color: 0x23262e, side: THREE.DoubleSide, fog: true });
    const time = this.time;
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uBirdTime = time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uBirdTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float ph = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.3;
          transformed.y += abs(position.x) * sin(uBirdTime * 8.0 + ph) * 0.55;`);
    };
    this.object = new THREE.InstancedMesh(geo, this.material, Math.max(1, count));
    this.object.count = count;
    this.object.frustumCulled = false;
    this.object.name = 'birds';
    const rand = mulberry32(0xb12d);
    this.phase = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) this.phase.set([rand() * 6.28, 0.18 + rand() * 0.12, 16 + rand() * 18, 0.7 + rand() * 0.6], i * 4);
  }

  setCount(n: number): void {
    this.count = Math.max(0, Math.min(this.maxCount, Math.floor(n)));
    this.object.count = this.count;
  }

  update(timeSeconds: number, visible: boolean, reducedMotion: boolean): void {
    this.object.visible = visible && this.count > 0;
    if (!this.object.visible) return;
    this.time.value = reducedMotion ? 0 : timeSeconds;
    const t = reducedMotion ? 0 : timeSeconds;
    const cx = this.mapSize * 0.5, cz = this.mapSize * 0.5;
    for (let i = 0; i < this.count; i++) {
      const a0 = this.phase[i * 4]!, w = this.phase[i * 4 + 1]!, h = this.phase[i * 4 + 2]!, sc = this.phase[i * 4 + 3]!;
      // Two loose groups wheel around different centres at slightly different rates.
      const group = i % 2;
      const ang = a0 + t * w * (group ? -0.55 : 0.5);
      const R = (group ? 34 : 26) + (i % 5) * 3;
      const x = cx + (group ? 12 : -10) + Math.cos(ang) * R;
      const z = cz + (group ? -14 : 10) + Math.sin(ang) * R * 0.75;
      const heading = Math.atan2(-Math.sin(ang) * R * 0.75 * (group ? -1 : 1), Math.cos(ang) * R * (group ? -1 : 1));
      this._p.set(x, h + Math.sin(t * 0.4 + a0) * 1.2, z);
      this._q.setFromEuler(this._e.set(0, heading, Math.sin(t * 0.6 + a0) * 0.25));
      this._s.set(sc, sc, sc);
      this.object.setMatrixAt(i, this._m.compose(this._p, this._q, this._s));
    }
    this.object.instanceMatrix.needsUpdate = true;
  }

  dispose(): void { this.object.geometry.dispose(); this.material.dispose(); this.object.dispose(); }
}
