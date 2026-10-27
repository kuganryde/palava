import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { UnitKind } from '../../core/defs';

/**
 * Procedural unit models: placeholders for authored Blender skeletons, but fully rigged for the
 * GPU animator. Every vertex carries a joint id and that joint's pivot; the vertex shader swings
 * the parts about their pivots (see unitRig.ts). Models face +Z with their feet on y = 0.
 *
 * Joint ids (shared by every kind so one animator serves all):
 *   0 body   1 head/neck   2,3 arm or foreleg (L = +x, R = -x)   4,5 leg or hind leg (L, R)
 *   6 aux A (weapon arm of a rider, elephant trunk)   7 aux B (cape, tail, ears, quiver)
 */
export const J = { body: 0, head: 1, armL: 2, armR: 3, legL: 4, legR: 5, auxA: 6, auxB: 7 } as const;

type V3 = readonly [number, number, number];

const SKIN = 0xa8734a, SKIN_DARK = 0x8a5a38, CLOTH = 0xe8dcc0, BLUE = 0x2d4f9e, SAFFRON = 0xc4663a, GOLD = 0xe0b040,
  BRONZE = 0xb07a3a, WOOD = 0x6e4e2e, STEEL = 0xc9ccd2, LEATHER = 0x5a3a22, GREEN = 0x3f7f3a, IVORY = 0xefe6cf;

class Rig {
  private readonly parts: THREE.BufferGeometry[] = [];
  /** Joint substitutions (a mounted rider's legs and head ride the body instead of swinging). */
  remap: Partial<Record<number, number>> = {};

  /** Add a geometry already positioned in model space, owned by `joint` swinging about `pivot`. */
  add(geo: THREE.BufferGeometry, color: number, joint: number, pivot: V3 = [0, 0, 0]): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    joint = this.remap[joint] ?? joint;
    const n = g.getAttribute('position').count;
    const c = new THREE.Color(color);
    const col = new Float32Array(n * 3), jt = new Float32Array(n), pv = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      jt[i] = joint;
      pv[i * 3] = pivot[0]; pv[i * 3 + 1] = pivot[1]; pv[i * 3 + 2] = pivot[2];
    }
    for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aJoint', new THREE.BufferAttribute(jt, 1));
    g.setAttribute('aPivot', new THREE.BufferAttribute(pv, 3));
    this.parts.push(g);
    return this;
  }

  /** Limb hanging down from `pivot`: tapered cylinder, so rotating the joint swings it. */
  limb(pivot: V3, len: number, rTop: number, rBot: number, color: number, joint: number, seg = 6): this {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, len, seg).translate(pivot[0], pivot[1] - len / 2, pivot[2]), color, joint, pivot);
  }

  build(name: string): THREE.BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    if (!merged) throw new Error(`Failed to build ${name} geometry`);
    this.parts.forEach((g) => g.dispose());
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    merged.name = name;
    return merged;
  }
}

const sph = (r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, seg = 7): THREE.BufferGeometry =>
  new THREE.SphereGeometry(r, seg, Math.max(4, seg - 2)).scale(sx, sy, sz).translate(x, y, z);
const bx = (w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry =>
  new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const cy = (rT: number, rB: number, h: number, x: number, y: number, z: number, seg = 6): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(rT, rB, h, seg).translate(x, y, z);

/** Box/cylinder rotated about its own centre, then placed (rotating an already-translated geometry would swing it about the origin). */
const bxAt = (w: number, h: number, d: number, at: V3, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry =>
  new THREE.BoxGeometry(w, h, d).rotateX(rx).rotateY(ry).rotateZ(rz).translate(at[0], at[1], at[2]);
const cyAt = (rT: number, rB: number, h: number, at: V3, rx = 0, ry = 0, rz = 0, seg = 6): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(rT, rB, h, seg).rotateX(rx).rotateY(ry).rotateZ(rz).translate(at[0], at[1], at[2]);

interface Human {
  scale?: number;
  cloth?: number; sash?: number; skin?: number; hairColor?: number;
  headgear?: 'helm' | 'turban' | 'headcloth' | 'crown' | 'none';
  headColor?: number;
  armor?: boolean;
}

/** A standing Pallava-era man: dhoti, bare chest, sash; parts assigned to the shared joints. */
function human(r: Rig, o: Human, mount = 0): void {
  const skin = o.skin ?? SKIN, cloth = o.cloth ?? CLOTH, sash = o.sash ?? BLUE;
  const y0 = mount; // rider seat height
  // legs: thigh+shin in one tapered limb with a small foot
  for (const side of [1, -1]) {
    const pv: V3 = [side * 0.11, y0 + 0.78, 0];
    r.limb(pv, 0.78, 0.085, 0.055, skin, side > 0 ? J.legL : J.legR);
    r.add(bx(0.12, 0.06, 0.22, pv[0], y0 + 0.03, 0.05), SKIN_DARK, side > 0 ? J.legL : J.legR, pv);
  }
  // dhoti: wrapped hips and a hanging fold
  r.add(cy(0.2, 0.3, 0.46, 0, y0 + 0.6, 0, 8), cloth, J.body);
  r.add(bx(0.2, 0.34, 0.06, 0, y0 + 0.5, 0.26), cloth, J.body);
  r.add(cy(0.22, 0.22, 0.09, 0, y0 + 0.86, 0, 8), sash, J.body);
  // torso
  r.add(cy(0.2, 0.17, 0.55, 0, y0 + 1.1, 0, 7), skin, J.body);
  if (o.armor) {
    r.add(cy(0.225, 0.19, 0.4, 0, y0 + 1.13, 0, 8), BRONZE, J.body);
    r.add(cyAt(0.1, 0.1, 0.05, [0, y0 + 1.2, 0.2], Math.PI / 2, 0, 0, 8), GOLD, J.body);
  } else {
    r.add(bxAt(0.06, 0.62, 0.05, [0, y0 + 1.12, 0.17], 0, 0, 0.7), sash, J.body); // diagonal sash across the chest
  }
  // arms hang from shoulder pivots; left (+x) and right (-x)
  for (const side of [1, -1]) {
    const pv: V3 = [side * 0.27, y0 + 1.31, 0];
    const j = side > 0 ? J.armL : J.armR;
    r.limb(pv, 0.64, 0.065, 0.048, skin, j);
    r.add(sph(0.06, pv[0], pv[1] - 0.66, pv[2]), skin, j, pv); // hand
    if (o.armor) r.add(sph(0.1, pv[0], pv[1] + 0.01, 0, 1, 0.7, 1), BRONZE, j, pv); // shoulder guard
  }
  // head
  const hp: V3 = [0, y0 + 1.42, 0];
  r.add(cy(0.05, 0.06, 0.1, 0, y0 + 1.42, 0), skin, J.head, hp);
  r.add(sph(0.16, 0, y0 + 1.56, 0), skin, J.head, hp);
  r.add(bx(0.05, 0.05, 0.05, 0, y0 + 1.55, 0.16), SKIN_DARK, J.head, hp); // nose
  const hg = o.headgear ?? 'none', hc = o.headColor ?? WOOD;
  if (hg === 'helm') {
    r.add(new THREE.SphereGeometry(0.19, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, y0 + 1.58, 0), hc, J.head, hp);
    r.add(new THREE.ConeGeometry(0.04, 0.2, 5).translate(0, y0 + 1.84, 0), SAFFRON, J.head, hp); // plume
  } else if (hg === 'turban') {
    r.add(new THREE.TorusGeometry(0.15, 0.065, 5, 9).rotateX(Math.PI / 2).translate(0, y0 + 1.66, 0), hc, J.head, hp);
    r.add(sph(0.14, 0, y0 + 1.72, 0, 1, 0.8, 1), hc, J.head, hp);
  } else if (hg === 'headcloth') {
    r.add(new THREE.SphereGeometry(0.175, 7, 4, 0, Math.PI * 2, 0, Math.PI * 0.6).translate(0, y0 + 1.57, -0.01), hc, J.head, hp);
    r.add(bx(0.2, 0.14, 0.05, 0, y0 + 1.5, -0.17), hc, J.head, hp); // tail of the cloth
  } else if (hg === 'crown') {
    r.add(new THREE.CylinderGeometry(0.12, 0.17, 0.14, 8).translate(0, y0 + 1.7, 0), GOLD, J.head, hp);
    r.add(new THREE.ConeGeometry(0.06, 0.2, 6).translate(0, y0 + 1.87, 0), GOLD, J.head, hp);
    r.add(new THREE.SphereGeometry(0.19, 8, 4, 0, Math.PI * 2, 0, Math.PI / 3).translate(0, y0 + 1.58, 0), hc, J.head, hp);
  } else {
    r.add(sph(0.14, 0, y0 + 1.63, -0.04, 1, 0.7, 1), o.hairColor ?? 0x1c130d, J.head, hp); // hair
    r.add(sph(0.07, 0, y0 + 1.66, -0.15), o.hairColor ?? 0x1c130d, J.head, hp); // bun
  }
}

/** A blade held in a hand at the end of the arm with pivot `pv`, angled forward. */
function blade(r: Rig, pv: V3, joint: number, len = 0.72, steel = STEEL): void {
  const hand: V3 = [pv[0], pv[1] - 0.66, pv[2]];
  const b = new THREE.BoxGeometry(0.05, len, 0.014).translate(0, -len / 2 - 0.04, 0).rotateX(-0.6).translate(hand[0], hand[1], hand[2]);
  r.add(b, steel, joint, pv);
  r.add(bx(0.2, 0.035, 0.05, hand[0], hand[1] - 0.02, hand[2] + 0.015), GOLD, joint, pv); // cross-guard
  r.add(cy(0.022, 0.022, 0.14, hand[0], hand[1] + 0.03, hand[2] - 0.02, 5), LEATHER, joint, pv);
}

function infantry(): THREE.BufferGeometry {
  const r = new Rig();
  human(r, { headgear: 'helm', headColor: BRONZE, sash: BLUE, armor: false });
  blade(r, [-0.27, 1.31, 0], J.armR);
  // round shield on the left arm, boss and rim in gold
  const sp: V3 = [0.27, 1.31, 0];
  r.add(cyAt(0.27, 0.27, 0.05, [0.38, 0.85, 0.12], 0, 0, Math.PI / 2, 12), BLUE, J.armL, sp);
  r.add(sph(0.075, 0.41, 0.85, 0.12), GOLD, J.armL, sp);
  r.add(new THREE.TorusGeometry(0.27, 0.025, 4, 14).rotateY(Math.PI / 2).translate(0.38, 0.85, 0.12), GOLD, J.armL, sp);
  return r.build('unit:infantry');
}

function archer(): THREE.BufferGeometry {
  const r = new Rig();
  human(r, { headgear: 'turban', headColor: GREEN, sash: SAFFRON });
  const sp: V3 = [0.27, 1.31, 0];
  // recurve bow held out in front of the left hand
  r.add(new THREE.TorusGeometry(0.42, 0.022, 4, 12, Math.PI).rotateZ(-Math.PI / 2).translate(0.28, 0.82, 0.3), WOOD, J.armL, sp);
  r.add(bx(0.008, 0.84, 0.008, 0.28, 0.82, 0.3), CLOTH, J.armL, sp);
  // quiver and fletching across the back
  r.add(cyAt(0.07, 0.09, 0.5, [-0.1, 1.12, -0.22], 0, 0, 0.2), LEATHER, J.auxB, [0, 1.3, -0.2]);
  for (const dx of [-0.02, 0.03, 0.08]) r.add(new THREE.ConeGeometry(0.03, 0.1, 4).translate(-0.12 + dx, 1.42, -0.22), SAFFRON, J.auxB, [0, 1.3, -0.2]);
  return r.build('unit:archer');
}

function villager(): THREE.BufferGeometry {
  const r = new Rig();
  human(r, { headgear: 'headcloth', headColor: CLOTH, cloth: 0xd8c9a0, sash: SAFFRON, skin: 0x9a6a42 });
  // mattock: wooden haft with an iron blade, held low in the right hand
  const pv: V3 = [-0.27, 1.31, 0];
  const hand: V3 = [pv[0], pv[1] - 0.66, pv[2]];
  r.add(cyAt(0.022, 0.022, 0.95, [hand[0], hand[1] + 0.12, hand[2] + 0.12], 0.0, 0, 0, 5), WOOD, J.armR, pv);
  r.add(bx(0.07, 0.07, 0.3, hand[0], hand[1] + 0.58, hand[2] + 0.2), STEEL, J.armR, pv);
  // a basket of grain on the back
  r.add(new THREE.CylinderGeometry(0.15, 0.1, 0.2, 7).translate(0, 1.0, -0.26), 0xb89a5a, J.body);
  return r.build('unit:villager');
}

function commander(): THREE.BufferGeometry {
  const r = new Rig();
  human(r, { headgear: 'crown', headColor: BRONZE, sash: BLUE, armor: true, cloth: 0xf0e6cf });
  blade(r, [-0.27, 1.31, 0], J.armR, 0.7, 0xd8dbe0);
  // royal cape: a long plate hanging from the shoulders that trails when he moves
  r.add(bx(0.5, 0.9, 0.035, 0, 0.95, -0.2), BLUE, J.auxB, [0, 1.38, -0.2]);
  r.add(bx(0.5, 0.05, 0.04, 0, 0.5, -0.2), GOLD, J.auxB, [0, 1.38, -0.2]);
  // standard-bearer's pennant on a gilt staff
  r.add(cy(0.015, 0.015, 1.1, 0.12, 1.55, -0.28, 4), GOLD, J.body);
  r.add(bx(0.22, 0.14, 0.01, 0.23, 2.0, -0.28), SAFFRON, J.body);
  return r.build('unit:commander');
}

/** Horse: barrel body, neck and head on joint 1, four legs (2 FL, 3 FR, 4 BL, 5 BR), tail on joint 7. */
function horse(r: Rig, coat: number, mane: number): void {
  r.add(sph(0.4, 0, 1.0, 0, 0.85, 0.85, 1.6, 8), coat, J.body);
  r.add(sph(0.3, 0, 1.06, 0.5, 0.95, 1, 0.95), coat, J.body); // chest
  r.add(sph(0.3, 0, 1.04, -0.45, 0.95, 1, 0.95), coat, J.body); // rump
  const np: V3 = [0, 1.15, 0.55];
  r.add(cyAt(0.12, 0.17, 0.5, [0, 1.36, 0.74], 0.7), coat, J.head, np);
  r.add(bx(0.17, 0.2, 0.42, 0, 1.58, 0.98), coat, J.head, np); // head
  r.add(bx(0.13, 0.12, 0.12, 0, 1.52, 1.2), 0x3a2a20, J.head, np); // muzzle
  for (const s of [1, -1]) r.add(new THREE.ConeGeometry(0.035, 0.12, 4).translate(s * 0.06, 1.74, 0.82), coat, J.head, np); // ears
  r.add(bxAt(0.05, 0.42, 0.07, [0, 1.42, 0.64], 0.5), mane, J.head, np); // mane
  const legs: Array<[number, number, number]> = [[0.17, 0.5, J.armL], [-0.17, 0.5, J.armR], [0.17, -0.48, J.legL], [-0.17, -0.48, J.legR]];
  for (const [x, z, j] of legs) {
    const pv: V3 = [x, 0.85, z];
    r.limb(pv, 0.85, 0.075, 0.045, coat, j);
    r.add(cy(0.055, 0.06, 0.1, x, 0.05, z, 6), 0x2a1f18, j, pv); // hoof
  }
  const tp: V3 = [0, 1.15, -0.68];
  r.add(new THREE.ConeGeometry(0.08, 0.7, 5).rotateX(Math.PI - 0.5).translate(0, 0.8, -0.85), mane, J.auxB, tp);
}

function cavalry(): THREE.BufferGeometry {
  const r = new Rig();
  horse(r, 0x7b4a2a, 0x1c130d);
  // royal-blue saddle cloth with gold trim
  r.add(bx(0.72, 0.05, 0.62, 0, 1.31, -0.02), BLUE, J.body);
  r.add(bx(0.74, 0.02, 0.64, 0, 1.285, -0.02), GOLD, J.body);
  // The rider sits on the saddle. His legs, head and shield arm ride the body; his right arm (joint 6) swings the lance.
  const seat = 0.52;
  r.remap = { [J.legL]: J.body, [J.legR]: J.body, [J.head]: J.body, [J.armL]: J.body, [J.armR]: J.auxA };
  human(r, { headgear: 'helm', headColor: BRONZE, sash: SAFFRON }, seat);
  const hand = new THREE.Vector3(-0.27, seat + 1.31 - 0.66, 0.0);
  const dir = new THREE.Vector3(0, Math.cos(Math.PI / 2 - 0.2), Math.sin(Math.PI / 2 - 0.2));
  const pv: V3 = [-0.27, seat + 1.31, 0];
  const at = (k: number): V3 => [hand.x + dir.x * k, hand.y + dir.y * k, hand.z + dir.z * k];
  r.add(new THREE.CylinderGeometry(0.018, 0.018, 2.0, 5).rotateX(Math.PI / 2 - 0.2).translate(...at(0.6)), WOOD, J.auxA, pv);
  r.add(new THREE.ConeGeometry(0.04, 0.24, 5).rotateX(Math.PI / 2 - 0.2).translate(...at(1.72)), STEEL, J.auxA, pv);
  r.add(new THREE.ConeGeometry(0.07, 0.2, 5).rotateX(Math.PI / 2 - 0.2).translate(...at(1.4)), SAFFRON, J.auxA, pv); // pennon
  r.remap = {};
  return r.build('unit:cavalry');
}

function elephant(): THREE.BufferGeometry {
  const r = new Rig();
  const hide = 0x8b8780, hideDark = 0x6e6a64;
  r.add(sph(0.9, 0, 1.55, -0.1, 0.95, 0.9, 1.3, 9), hide, J.body); // barrel
  r.add(sph(0.7, 0, 1.7, 0.7, 1, 1, 0.9, 8), hide, J.body); // shoulders
  // head, ears, tusks and trunk (trunk is joint 6, ears joint 7)
  const hp: V3 = [0, 1.9, 0.95];
  r.add(sph(0.5, 0, 1.85, 1.3, 1, 1.05, 1.0, 8), hide, J.head, hp);
  r.add(bx(0.5, 0.18, 0.12, 0, 2.28, 1.35), GOLD, J.head, hp); // gilded forehead plate
  r.add(bx(0.44, 0.1, 0.1, 0, 2.2, 1.55), BLUE, J.head, hp);
  for (const s of [1, -1]) {
    r.add(new THREE.ConeGeometry(0.075, 0.9, 6).rotateX(Math.PI / 2 + 0.35).translate(s * 0.27, 1.38, 1.85), IVORY, J.head, hp);
    r.add(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 10).rotateZ(Math.PI / 2).scale(1, 1, 0.85).translate(s * 0.68, 1.95, 1.0), hideDark, J.auxB, [s * 0.5, 2.3, 1.05]);
  }
  const tr: V3 = [0, 1.7, 1.75];
  r.add(new THREE.CylinderGeometry(0.17, 0.22, 0.6, 7).translate(0, 1.45, 1.8), hide, J.auxA, tr);
  r.add(new THREE.CylinderGeometry(0.08, 0.17, 0.75, 7).rotateX(-0.45).translate(0, 0.85, 2.0), hide, J.auxA, tr);
  // legs, thick columns
  const legs: Array<[number, number, number]> = [[0.5, 0.75, J.armL], [-0.5, 0.75, J.armR], [0.5, -0.8, J.legL], [-0.5, -0.8, J.legR]];
  for (const [x, z, j] of legs) {
    const pv: V3 = [x, 1.25, z];
    r.limb(pv, 1.25, 0.22, 0.2, hide, j, 7);
    r.add(cy(0.22, 0.24, 0.12, x, 0.06, z, 7), hideDark, j, pv);
  }
  r.add(new THREE.ConeGeometry(0.06, 0.8, 5).rotateX(Math.PI - 0.15).translate(0, 1.1, -1.55), hideDark, J.auxB, [0, 1.8, -1.35]);
  // caparison, howdah with a canopy, and a seated driver
  r.add(bx(1.5, 0.08, 1.4, 0, 2.38, -0.15), BLUE, J.body);
  r.add(bx(1.54, 0.04, 1.44, 0, 2.34, -0.15), GOLD, J.body);
  r.add(bx(1.0, 0.1, 0.9, 0, 2.52, -0.15), WOOD, J.body);
  for (const x of [-0.45, 0.45]) for (const z of [-0.5, 0.2]) r.add(cy(0.03, 0.03, 0.8, x, 2.95, z, 5), GOLD, J.body);
  r.add(new THREE.ConeGeometry(0.85, 0.5, 4).rotateY(Math.PI / 4).translate(0, 3.6, -0.15), SAFFRON, J.body);
  r.add(sph(0.11, 0, 2.92, -0.15), SKIN, J.body); // rider's head
  r.add(cy(0.12, 0.14, 0.34, 0, 2.7, -0.15, 6), CLOTH, J.body);
  return r.build('unit:elephant');
}

const BUILDERS: Record<UnitKind, () => THREE.BufferGeometry> = { infantry, archer, villager, commander, cavalry, elephant };
export function buildUnitGeometry(kind: UnitKind): THREE.BufferGeometry { return BUILDERS[kind](); }

/** Per-kind rig behaviour the shader needs: quadruped gait, bow-draw attack. */
export const RIG_KIND: Record<UnitKind, { quad: boolean; archer: boolean; stride: { walk: number; run: number }; heavy: number }> = {
  infantry: { quad: false, archer: false, stride: { walk: 2.4, run: 3.6 }, heavy: 0 },
  archer: { quad: false, archer: true, stride: { walk: 2.4, run: 3.6 }, heavy: 0 },
  villager: { quad: false, archer: false, stride: { walk: 2.1, run: 3.2 }, heavy: 0 },
  commander: { quad: false, archer: false, stride: { walk: 2.6, run: 3.8 }, heavy: 0 },
  cavalry: { quad: true, archer: false, stride: { walk: 3.4, run: 5.6 }, heavy: 0.3 },
  elephant: { quad: true, archer: false, stride: { walk: 3.0, run: 4.4 }, heavy: 1 },
};
