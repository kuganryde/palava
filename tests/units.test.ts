import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { formationSpacing, TRAINABLE, UNIT_DEFS, UNIT_KINDS } from '../src/core/defs';
import { generateTerrain } from '../src/world/terrain';
import { commandMove, createNewGame, placeBuilding, recruitUnit, stepSimulation } from '../src/systems/simulation';
import { parseSave, serializeState } from '../src/systems/save';
import { validatePlacement } from '../src/systems/placement';
import { capitalCenter } from '../src/world/terrain';
import {
  AnimController, BLEND_SECONDS, CLIP, chooseClip, hash01, MAX_DT, RUN_PATH_POINTS, type ChooseContext,
} from '../src/render/units/animController';
import { buildUnitGeometry, RIG_KIND } from '../src/render/units/unitGeometry';

const terrain = generateTerrain(1337);
const ctx = (o: Partial<ChooseContext> = {}): ChooseContext => ({ hp: 100, moving: false, pathLength: 0, nearby: 'none', canWork: false, ...o });
const STRIDE = { walk: 2.4, run: 3.6 };

describe('clip selection', () => {
  it('idles, walks, runs on long marches, and dies at 0 hp', () => {
    expect(chooseClip(ctx())).toBe(CLIP.idle);
    expect(chooseClip(ctx({ moving: true, pathLength: 3 }))).toBe(CLIP.walk);
    expect(chooseClip(ctx({ moving: true, pathLength: RUN_PATH_POINTS + 1 }))).toBe(CLIP.run);
    expect(chooseClip(ctx({ hp: 0, moving: true, pathLength: 30 }))).toBe(CLIP.death);
  });
  it('only workers build or gather, and only while standing still', () => {
    expect(chooseClip(ctx({ canWork: true, nearby: 'construction' }))).toBe(CLIP.build);
    expect(chooseClip(ctx({ canWork: true, nearby: 'production' }))).toBe(CLIP.gather);
    expect(chooseClip(ctx({ canWork: false, nearby: 'construction' }))).toBe(CLIP.idle);
    expect(chooseClip(ctx({ canWork: true, nearby: 'construction', moving: true, pathLength: 2 }))).toBe(CLIP.walk);
  });
});

describe('animation controller', () => {
  it('blends over BLEND_SECONDS when the clip changes and settles at 1', () => {
    const c = new AnimController();
    const s = c.step(1, CLIP.idle, 0, 0, 0.016, STRIDE);
    expect(s.blend).toBe(1);
    c.step(1, CLIP.walk, 0, 0, 0.016, STRIDE);
    expect(s.clip).toBe(CLIP.walk);
    expect(s.prev).toBe(CLIP.idle);
    expect(s.blend).toBeGreaterThan(0);
    expect(s.blend).toBeLessThan(0.2);
    for (let t = 0; t < BLEND_SECONDS + 0.05; t += 0.016) c.step(1, CLIP.walk, 0, 0, 0.016, STRIDE);
    expect(s.blend).toBe(1);
  });

  it('advances the gait by distance, so feet do not slide, and stands still when not moving', () => {
    const c = new AnimController();
    const s = c.step(2, CLIP.walk, 0, 0, 0.016, STRIDE);
    const start = s.phase;
    // walk exactly one stride in small steps (the controller caps per-frame travel to ignore teleports)
    for (let i = 1; i <= 6; i++) c.step(2, CLIP.walk, (STRIDE.walk / 6) * i, 0, 0.016, STRIDE);
    expect(s.phase).toBeCloseTo(start, 5);
    for (let i = 1; i <= 3; i++) c.step(2, CLIP.walk, STRIDE.walk + (STRIDE.walk / 6) * i, 0, 0.016, STRIDE); // half a stride more
    expect(((s.phase - start + 1) % 1)).toBeCloseTo(0.5, 5);
    const frozen = s.phase;
    c.step(2, CLIP.idle, STRIDE.walk * 1.5, 0, 5, STRIDE);
    c.step(2, CLIP.idle, STRIDE.walk * 1.5, 0, 5, STRIDE);
    expect(s.phase).toBeCloseTo(frozen, 6);
  });

  it('does not spin the legs on a teleport (load, new game)', () => {
    const c = new AnimController();
    const s = c.step(3, CLIP.walk, 0, 0, 0.016, STRIDE);
    const p0 = s.phase;
    c.step(3, CLIP.walk, 5000, 5000, 0.016, STRIDE);
    const moved = (s.phase - p0 + 1) % 1;
    expect(moved).toBeLessThan(1);
    expect(Number.isFinite(s.phase)).toBe(true);
  });

  it('is robust to bad time steps', () => {
    const c = new AnimController();
    const s = c.step(4, CLIP.idle, 0, 0, 0.016, STRIDE);
    for (const dt of [NaN, -1, Infinity, 1e9]) c.step(4, CLIP.idle, 0, 0, dt, STRIDE);
    expect(Number.isFinite(s.clipTime)).toBe(true);
    expect(s.clipTime).toBeLessThanOrEqual(MAX_DT * 4 + 0.1);
    expect(s.blend).toBeLessThanOrEqual(1);
    expect(s.blend).toBeGreaterThanOrEqual(0);
  });

  it('restarts clip time on a new clip and keeps death final', () => {
    const c = new AnimController();
    const s = c.step(5, CLIP.attack, 0, 0, 0.05, STRIDE);
    for (let i = 0; i < 20; i++) c.step(5, CLIP.attack, 0, 0, 0.05, STRIDE);
    expect(s.clipTime).toBeGreaterThan(0.9);
    c.step(5, CLIP.death, 0, 0, 0.05, STRIDE);
    expect(s.clipTime).toBeLessThan(0.1);
    c.step(5, CLIP.idle, 0, 0, 0.05, STRIDE); // a stale "idle" must not resurrect a dead unit
    expect(s.clip).toBe(CLIP.death);
    c.get(5)!.override = CLIP.idle; // only an explicit test override may
    c.step(5, CLIP.death, 0, 0, 0.05, STRIDE);
    expect(s.clip).toBe(CLIP.idle);
  });

  it('prunes removed units and de-synchronises seeds', () => {
    const c = new AnimController();
    for (let i = 1; i <= 50; i++) c.step(i, CLIP.idle, 0, 0, 0.016, STRIDE);
    expect(new Set([...Array(50).keys()].map((i) => c.get(i + 1)!.seed)).size).toBeGreaterThan(40);
    c.prune(new Set([1, 2, 3]));
    expect(c.size).toBe(3);
    for (let i = 0; i < 1000; i++) { const h = hash01(i); expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThan(1); }
  });
});

describe('unit data', () => {
  it('every kind has sane stats and a trainer building', () => {
    expect(UNIT_KINDS).toHaveLength(6);
    for (const k of UNIT_KINDS) {
      const d = UNIT_DEFS[k];
      expect(d.kind).toBe(k);
      expect(d.hp).toBeGreaterThan(0);
      expect(d.speed).toBeGreaterThan(0);
      expect(d.radius).toBeGreaterThan(0);
      expect(TRAINABLE[d.trainedAt]).toContain(k);
    }
    expect(UNIT_DEFS.elephant.hp).toBeGreaterThan(UNIT_DEFS.infantry.hp);
    expect(UNIT_DEFS.cavalry.speed).toBeGreaterThan(UNIT_DEFS.infantry.speed);
  });

  it('spaces formations wider for large animals, never tighter than the default', () => {
    expect(formationSpacing(['infantry', 'archer'])).toBe(1.6);
    expect(formationSpacing(['infantry', 'elephant'])).toBeGreaterThan(2.5);
    expect(formationSpacing([])).toBe(1.6);
  });
});

describe('training and saving the new units', () => {
  it('the palace trains villagers and commanders, the barracks trains soldiers and mounts', () => {
    const { state, nav } = createNewGame(terrain);
    state.resources = { food: 2000, timber: 2000, stone: 2000, iron: 0, gold: 2000 };
    const palace = state.buildings[0]!;
    expect(recruitUnit(state, nav, palace.id, 'villager').ok).toBe(true);
    expect(recruitUnit(state, nav, palace.id, 'commander').ok).toBe(true);
    expect(recruitUnit(state, nav, palace.id, 'cavalry')).toEqual({ ok: false, reason: 'not-barracks' });
    const cap = capitalCenter(terrain.size);
    let placed = false;
    for (let r = 8; r < 40 && !placed; r += 2) for (let a = 0; a < 16 && !placed; a++) {
      const wx = cap.x + Math.cos((a / 16) * 6.283) * r, wz = cap.z + Math.sin((a / 16) * 6.283) * r;
      if (validatePlacement(state, terrain, 'barracks', wx, wz).ok) placed = placeBuilding(state, terrain, nav, 'barracks', wx, wz).ok;
    }
    expect(placed).toBe(true);
    const b = state.buildings.find((x) => x.type === 'barracks')!;
    state.resources = { food: 2000, timber: 2000, stone: 2000, iron: 0, gold: 2000 };
    for (let i = 0; i < 400 && b.progress < 1; i++) stepSimulation(state, 0.05);
    expect(b.progress).toBe(1);
    const e = recruitUnit(state, nav, b.id, 'elephant');
    expect(e).toMatchObject({ ok: true });
    expect(recruitUnit(state, nav, b.id, 'cavalry').ok).toBe(true);
    expect(recruitUnit(state, nav, b.id, 'villager')).toEqual({ ok: false, reason: 'not-barracks' });
  });

  it('round-trips every kind through a save, and rejects an unknown kind', () => {
    const { state } = createNewGame(terrain);
    state.units.length = 0;
    UNIT_KINDS.forEach((kind, i) => state.units.push({ id: 100 + i, kind, x: 60 + i, z: 60, px: 60 + i, pz: 60, facing: 0, hp: UNIT_DEFS[kind].hp, path: [] }));
    state.nextId = 200;
    const back = parseSave(serializeState(state), terrain.size);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.state.units.map((u) => u.kind)).toEqual([...UNIT_KINDS]);
    const bad = JSON.parse(serializeState(state));
    bad.state.units[0].kind = 'dragon';
    expect(parseSave(JSON.stringify(bad), terrain.size).ok).toBe(false);
  });

  it('marches large mixed groups in a wider formation without overlapping', () => {
    const { state, nav } = createNewGame(terrain);
    const cap = capitalCenter(terrain.size);
    state.units[0]!.kind = 'elephant'; state.units[1]!.kind = 'elephant';
    const ids = state.units.map((u) => u.id);
    commandMove(state, nav, ids, { x: cap.x + 6, z: cap.z + 18 }, 'box');
    const ends = state.units.filter((u) => u.path.length).map((u) => u.path[u.path.length - 1]!);
    let minGap = Infinity;
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) minGap = Math.min(minGap, Math.hypot(ends[i]!.x - ends[j]!.x, ends[i]!.z - ends[j]!.z));
    expect(minGap).toBeGreaterThan(1.0);
  });
});

describe('procedural unit rigs', () => {
  for (const kind of UNIT_KINDS) {
    it(`${kind}: finite, joint ids 0-7, pivots finite, on the ground, sensible size`, () => {
      const g = buildUnitGeometry(kind);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const joint = g.getAttribute('aJoint') as THREE.BufferAttribute;
      const pivot = g.getAttribute('aPivot') as THREE.BufferAttribute;
      const col = g.getAttribute('color') as THREE.BufferAttribute;
      expect(joint.count).toBe(pos.count);
      expect(pivot.count).toBe(pos.count);
      expect(col.count).toBe(pos.count);
      const used = new Set<number>();
      for (let i = 0; i < pos.count; i++) {
        for (const a of [pos, pivot, col]) { expect(Number.isFinite(a.getX(i) + a.getY(i) + a.getZ(i))).toBe(true); }
        const j = joint.getX(i);
        expect(Number.isInteger(j)).toBe(true);
        expect(j).toBeGreaterThanOrEqual(0);
        expect(j).toBeLessThanOrEqual(7);
        used.add(j);
      }
      const bb = g.boundingBox!;
      expect(bb.min.y).toBeGreaterThan(-0.05);
      expect(bb.min.y).toBeLessThan(0.15);
      expect(bb.max.y).toBeGreaterThan(1.4);
      expect(bb.max.y).toBeLessThan(4.5);
      // every kind has a body plus animated limbs
      expect(used.has(0)).toBe(true);
      expect(used.has(2) && used.has(3) && used.has(4) && used.has(5)).toBe(true);
      expect(RIG_KIND[kind].stride.run).toBeGreaterThan(RIG_KIND[kind].stride.walk);
      // radius used for spacing roughly matches the model footprint
      const half = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2;
      expect(half).toBeLessThan(UNIT_DEFS[kind].radius * 4 + 1);
      g.dispose();
    });
  }
});
