import * as THREE from 'three';

/**
 * GPU skeletal animation for the procedural placeholder units. Every vertex carries a joint id and
 * pivot (see unitGeometry.ts); each instance carries a small animation record:
 *
 *   aAnim  = (clip, previous clip, blend 0..1, locomotion phase in cycles)
 *   aAnim2 = (seconds into clip, per-unit seed, 0, 0)
 *
 * The vertex shader evaluates the pose of the current and previous clip and blends them, so clips
 * cross-fade without any per-unit CPU skinning, mixers or allocation, and an army of any size is one
 * draw call per kind. Clip indices match CLIP in animController.ts.
 *
 * Rotation conventions (+Z forward, +Y up): a hanging limb rotated by NEGATIVE rx swings forward and
 * up; the whole body leaning forward is POSITIVE pitch.
 */

export interface RigOptions { quad: boolean; archer: boolean; heavy: number; halfWidth: number }

/** Shared animation uniforms (one object for every material). */
export const rigUniforms = {
  /** 1 = reduced motion: idle sway is switched off, locomotion stays so units remain readable. */
  uCalm: { value: 0 },
};

const GLSL_COMMON = /* glsl */ `
attribute float aJoint;
attribute vec3 aPivot;
attribute vec4 aAnim;
attribute vec4 aAnim2;
uniform float uHeavy;
uniform float uHalfW;
uniform float uCalm;
const float TAU = 6.2831853;
float ease(float x) { return x * x * (3.0 - 2.0 * x); }
float strikeArm(float u) {
  if (u < 0.45) return mix(-0.4, -2.7, ease(u / 0.45));
  if (u < 0.6) return mix(-2.7, -0.3, ease((u - 0.45) / 0.15));
  return mix(-0.3, -0.4, ease((u - 0.6) / 0.4));
}
float strikePulse(float u) { return ease(clamp(u / 0.45, 0.0, 1.0)) * (1.0 - ease(clamp((u - 0.45) / 0.3, 0.0, 1.0))); }

// Joint pose: (rx, ry, rz) in radians. j: 0 body, 1 head, 2/3 arm|foreleg L/R, 4/5 leg|hindleg L/R, 6 aux A, 7 aux B.
vec3 jointPose(int clip, int j, float ph, float ct, float sd) {
  vec3 r = vec3(0.0);
  if (j == 0) return r;
  float s = sin(TAU * ph), c = cos(TAU * ph);
  float calm = 1.0 - uCalm;
#ifdef QUAD
  if (clip == 0) {
    if (j == 1) { r.x = 0.05 * sin(ct * 0.9 + sd * 7.0) * calm; r.y = 0.12 * sin(ct * 0.4 + sd * 11.0) * calm; }
    else if (j == 7) r.z = 0.18 * sin(ct * 1.6 + sd * 3.0) * calm;
    else if (j == 6) r.x = 0.1 * sin(ct * 0.8 + sd * 5.0) * calm;
  } else if (clip == 1) {
    float A = 0.5 - 0.12 * uHeavy;
    if (j == 2 || j == 5) r.x = A * s; else if (j == 3 || j == 4) r.x = -A * s;
    else if (j == 1) r.x = 0.06 * c; else if (j == 7) r.z = 0.3 * s; else if (j == 6) r.x = (0.05 + 0.2 * uHeavy) * s;
  } else if (clip == 2) {
    float A = 0.95 - 0.4 * uHeavy;
    float s2 = sin(TAU * ph + 1.7);
    if (j == 2 || j == 3) r.x = A * s; else if (j == 4 || j == 5) r.x = A * s2;
    else if (j == 1) r.x = 0.14 * s; else if (j == 7) r.z = 0.45 * s; else if (j == 6) r.x = 0.3 * s;
  } else if (clip == 3) {
    float u = fract(ct * 0.9);
    float p = strikePulse(u);
    if (j == 1) r.x = -0.35 * p; else if (j == 2) r.x = -1.3 * p; else if (j == 3) r.x = -0.3 * p;
    else if (j == 6) r.x = strikeArm(u) * (0.35 + 0.5 * uHeavy); else if (j == 7) r.z = 0.4 * p;
  } else if (clip == 4 || clip == 5) {
    if (j == 1) r.x = 0.75; else if (j == 2) r.x = -0.7 * max(0.0, sin(TAU * ct * 0.8)); else if (j == 7) r.z = 0.2 * sin(ct * 2.0);
  } else {
    float d = ease(clamp(ct / 0.9, 0.0, 1.0));
    if (j == 2 || j == 3) r.x = -0.9 * d; else if (j == 4 || j == 5) r.x = 0.9 * d; else if (j == 1) r.x = 0.5 * d; else if (j == 6) r.x = 0.4 * d;
  }
#else
  if (clip == 0) {
    if (j == 1) { r.y = 0.25 * sin(ct * 0.6 + sd * 20.0) * calm; r.x = 0.03 * sin(ct * 1.2 + sd * 4.0) * calm; }
    else if (j == 2) r.x = 0.04 * sin(ct * 1.7 + sd * 9.0) * calm;
    else if (j == 3) r.x = 0.04 * sin(ct * 1.7 + sd * 9.0 + 2.0) * calm;
    else if (j == 7) r.x = 0.06 + 0.05 * sin(ct * 1.1 + sd * 5.0) * calm;
  } else if (clip == 1) {
    if (j == 4) r.x = 0.55 * s; else if (j == 5) r.x = -0.55 * s;
    else if (j == 2) r.x = -0.45 * s; else if (j == 3) r.x = 0.45 * s;
    else if (j == 7) r.x = 0.18 + 0.12 * s;
  } else if (clip == 2) {
    if (j == 4) r.x = 0.95 * s; else if (j == 5) r.x = -0.95 * s;
    else if (j == 2) r.x = -0.55 - 0.9 * s; else if (j == 3) r.x = -0.55 + 0.9 * s;
    else if (j == 1) r.x = -0.12; else if (j == 7) r.x = 0.55 + 0.2 * s;
  } else if (clip == 3) {
    float u = fract(ct * 1.1);
#ifdef ARCHER
    float draw = max(0.0, sin(TAU * ct * 0.9));
    if (j == 2) r.x = -1.5; else if (j == 3) r.x = -1.45 + 0.55 * draw;
    else if (j == 4) r.x = 0.3; else if (j == 5) r.x = -0.3; else if (j == 1) r.y = -0.2;
#else
    if (j == 3) r.x = strikeArm(u); else if (j == 2) r.x = -0.85;
    else if (j == 4) r.x = 0.35; else if (j == 5) r.x = -0.35; else if (j == 1) r.x = 0.1;
    else if (j == 7) r.x = 0.3 * strikePulse(u);
#endif
  } else if (clip == 4) {
    if (j == 3) r.x = -1.0 - 0.9 * sin(TAU * ct * 1.4); else if (j == 2) r.x = -0.7;
    else if (j == 1) r.x = 0.35; else if (j == 4) r.x = 0.25; else if (j == 5) r.x = -0.2;
  } else if (clip == 5) {
    if (j == 3) r.x = -1.3 - 0.8 * max(0.0, sin(TAU * ct * 1.8)); else if (j == 2) r.x = -0.6;
    else if (j == 1) r.x = 0.2; else if (j == 4) r.x = 0.15; else if (j == 5) r.x = -0.15;
  } else {
    float d = ease(clamp(ct / 0.7, 0.0, 1.0));
    if (j == 2) { r.x = -1.0 * d; r.z = 0.8 * d; } else if (j == 3) { r.x = -0.8 * d; r.z = -0.8 * d; }
    else if (j == 4) r.x = 0.4 * d; else if (j == 5) r.x = -0.3 * d; else if (j == 1) r.x = 0.4 * d;
  }
#endif
  return r;
}

// Whole-body pose: (pitch about X, roll about Z, vertical offset).
vec3 rootPose(int clip, float ph, float ct, float sd) {
  float s = sin(TAU * ph), c = cos(TAU * ph);
  float calm = 1.0 - uCalm;
  if (clip == 0) return vec3(0.0, 0.0, 0.012 * sin(ct * 1.9 + sd * 6.0) * calm);
#ifdef QUAD
  if (clip == 1) return vec3(0.02 * s, 0.0, 0.025 * abs(c) * (1.0 - 0.5 * uHeavy));
  if (clip == 2) return vec3(0.1 * sin(TAU * ph + 0.8), 0.0, 0.11 * abs(s) * (1.0 - 0.6 * uHeavy));
  if (clip == 3) return vec3(-0.1 * strikePulse(fract(ct * 0.9)), 0.0, 0.0);
  if (clip == 4 || clip == 5) return vec3(0.0);
#else
  if (clip == 1) return vec3(0.05, 0.0, 0.045 * abs(c));
  if (clip == 2) return vec3(0.22, 0.0, 0.09 * abs(c));
  if (clip == 3) return vec3(0.15 * strikePulse(fract(ct * 1.1)), 0.0, 0.0);
  if (clip == 4) return vec3(0.5, 0.0, 0.0);
  if (clip == 5) return vec3(0.2, 0.0, 0.0);
#endif
  float d = ease(clamp(ct / (0.7 + 0.3 * uHeavy), 0.0, 1.0));
  return vec3(0.0, 1.45 * d, uHalfW * d); // fall onto the side, resting on the ground
}

vec3 rotXYZ(vec3 p, vec3 a) {
  float cx = cos(a.x), sx = sin(a.x);
  p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
  float cy = cos(a.y), sy = sin(a.y);
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  float cz = cos(a.z), sz = sin(a.z);
  return vec3(p.x * cz - p.y * sz, p.x * sz + p.y * cz, p.z);
}

vec3 animate(vec3 pos) {
  int clipA = int(aAnim.x + 0.5), clipB = int(aAnim.y + 0.5);
  float bl = ease(clamp(aAnim.z, 0.0, 1.0));
  float ph = aAnim.w, ct = aAnim2.x, sd = aAnim2.y;
  int j = int(aJoint + 0.5);
  vec3 jr = mix(jointPose(clipB, j, ph, ct, sd), jointPose(clipA, j, ph, ct, sd), bl);
  vec3 p = rotXYZ(pos - aPivot, jr) + aPivot;
  vec3 rp = mix(rootPose(clipB, ph, ct, sd), rootPose(clipA, ph, ct, sd), bl);
  p = rotXYZ(p, vec3(rp.x, 0.0, rp.y));
  p.y += rp.z;
  return p;
}
`;

function header(o: RigOptions): string {
  return `${o.quad ? '#define QUAD\n' : ''}${o.archer ? '#define ARCHER\n' : ''}`;
}

/** Patch a built-in material's vertex shader so it animates the rig. Shared by colour and shadow materials. */
function patch(shader: { vertexShader: string; uniforms: Record<string, THREE.IUniform> }, o: RigOptions): void {
  shader.uniforms.uHeavy = { value: o.heavy };
  shader.uniforms.uHalfW = { value: o.halfWidth };
  shader.uniforms.uCalm = rigUniforms.uCalm;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${header(o)}${GLSL_COMMON}`)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed = animate(transformed);');
}

export function createRigMaterials(o: RigOptions): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  const key = `unit-rig-${o.quad ? 'q' : 'b'}${o.archer ? 'a' : ''}`;
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.82, metalness: 0.02 });
  material.onBeforeCompile = (shader) => patch(shader, o);
  material.customProgramCacheKey = () => key;
  // The sun's shadow pass must see the same animated pose, or shadows would show a stiff bind pose.
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => patch(shader, o);
  depth.customProgramCacheKey = () => `${key}-depth`;
  return { material, depth };
}
