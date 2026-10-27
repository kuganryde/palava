import { describe, expect, it } from 'vitest';
import { SIM_STEP, UNIT_DEFS } from '../src/core/defs';
import { population, teamOf, type GameState } from '../src/core/state';
import { AGGRO_RADIUS, CORPSE_SECONDS, commandAttack, reach } from '../src/systems/combat';
import { generateTerrain } from '../src/world/terrain';
import { buildNav, createNewGame, commandMove, makeUnit, stepSimulation } from '../src/systems/simulation';
import { parseSave, serializeState } from '../src/systems/save';

const terrain = generateTerrain(1337);
function arena(): { state: GameState; nav: ReturnType<typeof buildNav> } {
  const { state } = createNewGame(terrain);
  state.units.length = 0; // empty field; each test places its own fighters
  return { state, nav: buildNav(terrain, state) };
}
const run = (s: GameState, nav: ReturnType<typeof buildNav>, seconds: number): void => {
  for (let i = 0; i < seconds / SIM_STEP; i++) stepSimulation(s, SIM_STEP, nav);
};

describe('combat', () => {
  it('idle enemies within aggro range fight; units out of range ignore each other', () => {
    const { state, nav } = arena();
    const a = makeUnit(state, 'infantry', 70, 85, 0), b = makeUnit(state, 'infantry', 70 + AGGRO_RADIUS - 2, 85, 1);
    const far = makeUnit(state, 'infantry', 70, 85 + AGGRO_RADIUS + 20, 1);
    state.units.push(a, b, far);
    run(state, nav, 1);
    expect(a.target).toBe(b.id);
    expect(far.target ?? null).toBe(null);
  });

  it('a melee unit closes distance, hits, and kills; the corpse is removed after the delay', () => {
    const { state, nav } = arena();
    const a = makeUnit(state, 'infantry', 70, 85, 0), b = makeUnit(state, 'villager', 74, 85, 1);
    state.units.push(a, b);
    commandAttack(state, [a.id], b.id);
    run(state, nav, 10);
    expect(b.hp).toBe(0);
    expect(state.events!.some((e) => e.killed && e.to === b.id)).toBe(true);
    expect(a.target ?? null).toBe(null);
    run(state, nav, CORPSE_SECONDS + 0.5);
    expect(state.units.some((u) => u.id === b.id)).toBe(false);
  });

  it('archers hit from range without closing in; events are marked ranged', () => {
    const { state, nav } = arena();
    const a = makeUnit(state, 'archer', 70, 85, 0), b = makeUnit(state, 'elephant', 76, 85, 1);
    state.units.push(a, b);
    commandAttack(state, [a.id], b.id);
    run(state, nav, 3);
    expect(b.hp).toBeLessThan(UNIT_DEFS.elephant.hp);
    expect(Math.hypot(a.x - 70, a.z - 85)).toBeLessThan(0.5);
    // the elephant fights back automatically (aggro); only the archer's own shots must be flagged ranged
    const shots = state.events!.filter((e) => e.from === a.id);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((e) => e.ranged)).toBe(true);
  });

  it('respects attack cooldown: damage per second never exceeds damage / interval', () => {
    const { state, nav } = arena();
    const a = makeUnit(state, 'infantry', 70, 85, 0), b = makeUnit(state, 'elephant', 71, 85, 1);
    b.hp = 400; state.units.push(a, b);
    commandAttack(state, [a.id], b.id);
    run(state, nav, 5);
    const hits = Math.ceil(5 / UNIT_DEFS.infantry.attackInterval);
    expect(400 - b.hp).toBeLessThanOrEqual(hits * UNIT_DEFS.infantry.damage);
    expect(400 - b.hp).toBeGreaterThan(0);
  });

  it('cannot attack allies, corpses or missing targets; a move order cancels an attack', () => {
    const { state, nav } = arena();
    const a = makeUnit(state, 'infantry', 70, 85, 0), ally = makeUnit(state, 'infantry', 102, 100, 0), foe = makeUnit(state, 'infantry', 106, 100, 1);
    state.units.push(a, ally, foe);
    expect(commandAttack(state, [a.id], ally.id)).toBe(0);
    expect(commandAttack(state, [a.id], 9999)).toBe(0);
    expect(commandAttack(state, [a.id], foe.id)).toBe(1);
    commandMove(state, nav, [a.id], { x: 62, z: 85 }, 'line');
    expect(a.target).toBe(null);
    foe.hp = 0;
    expect(commandAttack(state, [a.id], foe.id)).toBe(0);
  });

  it('enemies and corpses do not count toward the player population', () => {
    const { state } = arena();
    state.units.push(makeUnit(state, 'infantry', 10, 10, 0), makeUnit(state, 'infantry', 12, 10, 1));
    const dead = makeUnit(state, 'infantry', 14, 10, 0); dead.hp = 0; state.units.push(dead);
    expect(population(state)).toBe(1);
    expect(teamOf({})).toBe(0);
  });

  it('is deterministic: identical setups produce identical outcomes', () => {
    const play = (): string => {
      const { state, nav } = arena();
      for (let i = 0; i < 5; i++) { state.units.push(makeUnit(state, 'infantry', 66 + i, 85, 0), makeUnit(state, 'archer', 70 + i, 91, 1)); }
      run(state, nav, 20);
      return JSON.stringify(state.units.map((u) => [u.id, u.hp, Math.round(u.x * 100), Math.round(u.z * 100)]));
    };
    expect(play()).toBe(play());
  });

  it('reach grows with target size', () => {
    const { state } = arena();
    const a = makeUnit(state, 'infantry', 0, 0), small = makeUnit(state, 'villager', 0, 0), big = makeUnit(state, 'elephant', 0, 0);
    expect(reach(a, big)).toBeGreaterThan(reach(a, small));
  });
});

describe('save v2', () => {
  it('round-trips team, target and cooldown, drops corpses and events', () => {
    const { state } = arena();
    const a = makeUnit(state, 'infantry', 50, 50, 0), b = makeUnit(state, 'archer', 60, 50, 1), dead = makeUnit(state, 'archer', 70, 50, 1);
    a.target = b.id; a.cooldown = 0.4; dead.hp = 0; state.units.push(a, b, dead);
    state.events = [{ t: 1, from: a.id, to: b.id, ranged: false, killed: false }];
    const r = parseSave(serializeState(state), terrain.size);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.version).toBe(2);
    expect(r.state.units.map((u) => u.id)).toEqual([a.id, b.id]);
    expect(r.state.units[0]).toMatchObject({ team: 0, target: b.id, cooldown: 0.4 });
    expect(r.state.units[1]!.team).toBe(1);
    expect(r.state.events).toBeUndefined();
  });

  it('migrates a v1 save: units become player units with no target', () => {
    const { state } = createNewGame(terrain);
    const v1 = JSON.stringify({ v: 1, savedAt: 1, state: { ...state, version: 1, units: state.units.map((u) => ({ id: u.id, kind: u.kind, x: u.x, z: u.z, facing: 0, hp: u.hp, path: [] })) } });
    const r = parseSave(v1, terrain.size);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.state.version).toBe(2); expect(r.state.units.every((u) => u.team === 0 && u.target === null)).toBe(true); }
  });

  it('rejects tampered combat fields safely', () => {
    const { state } = createNewGame(terrain);
    const raw = JSON.parse(serializeState(state));
    raw.state.units[0].team = '__proto__'; raw.state.units[0].target = 'x'; raw.state.units[0].cooldown = 1e9;
    const r = parseSave(JSON.stringify(raw), terrain.size);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.units[0]).toMatchObject({ team: 0, target: null, cooldown: UNIT_DEFS[r.state.units[0]!.kind].attackInterval });
  });
});

import { CLIP, chooseClip } from '../src/render/units/animController';
import { commandAttackMove } from '../src/systems/simulation';

describe('attack-move and clips', () => {
  it('attack clip plays only while standing in range of a target; movement and death win', () => {
    const base = { hp: 50, moving: false, pathLength: 0, nearby: 'none' as const, canWork: false };
    expect(chooseClip({ ...base, attacking: true })).toBe(CLIP.attack);
    expect(chooseClip({ ...base, attacking: true, moving: true, pathLength: 3 })).toBe(CLIP.walk);
    expect(chooseClip({ ...base, attacking: true, hp: 0 })).toBe(CLIP.death);
    expect(chooseClip(base)).toBe(CLIP.idle);
  });

  it('attack-moving units fight what they meet and then continue to the destination', () => {
    const { state, nav } = arena();
    const a = makeUnit(state, 'infantry', 60, 85, 0), foe = makeUnit(state, 'villager', 66, 83, 1);
    foe.hp = 20; // villagers do not aggro, so it will not fight back; the point is that `a` stops for it
    state.units.push(a, foe);
    expect(commandAttackMove(state, nav, [a.id], { x: 78, z: 85 }, 'line')).toBe(1);
    expect(a.amove).toBe(true);
    expect(a.goal).toBeTruthy();
    run(state, nav, 4);
    expect(foe.hp).toBe(0); // engaged on the way
    run(state, nav, 15);
    expect(Math.hypot(a.x - 78, a.z - 85)).toBeLessThan(3); // resumed and arrived
  });

  it('a plain move order cancels attack-move; units on a plain move ignore enemies', () => {
    const { state, nav } = arena();
    const a = makeUnit(state, 'infantry', 60, 85, 0), foe = makeUnit(state, 'infantry', 64, 85, 1);
    state.units.push(a, foe);
    commandMove(state, nav, [a.id], { x: 55, z: 85 }, 'line');
    expect(a.amove).toBe(false);
    run(state, nav, 0.3);
    expect(a.target ?? null).toBe(null); // moving: no auto-acquire
  });
});
