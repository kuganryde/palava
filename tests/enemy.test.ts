import { describe, expect, it } from 'vitest';
import { BUILDING_DEFS, SIM_STEP, UNIT_DEFS } from '../src/core/defs';
import { buildingHp, teamOf, type GameState } from '../src/core/state';
import { commandAttack } from '../src/systems/combat';
import { ENEMY_UNIT_CAP, FIRST_WAVE_SECONDS, addEnemyBase, waveComposition, waveInterval } from '../src/systems/enemyAi';
import { isBlocked } from '../src/systems/pathfinding';
import { parseSave, serializeState } from '../src/systems/save';
import { buildNav, createNewGame, makeUnit, stepSimulation } from '../src/systems/simulation';
import { capitalCenter, generateTerrain } from '../src/world/terrain';

const terrain = generateTerrain(1337);
function world(): { state: GameState; nav: ReturnType<typeof buildNav> } {
  const { state, nav } = createNewGame(terrain);
  expect(addEnemyBase(state, terrain, nav)).toBe(true);
  return { state, nav };
}
const run = (s: GameState, nav: ReturnType<typeof buildNav>, seconds: number): void => {
  for (let i = 0; i < seconds / SIM_STEP; i++) stepSimulation(s, SIM_STEP, nav);
};
const fort = (s: GameState) => s.buildings.find((b) => b.type === 'stronghold')!;

describe('enemy base', () => {
  it('is placed far from the capital, blocks the nav grid, and has a garrison', () => {
    const { state, nav } = world();
    const f = fort(state), cap = capitalCenter(terrain.size);
    expect(Math.hypot(f.x0 - cap.x, f.z0 - cap.z)).toBeGreaterThan(30);
    expect(isBlocked(nav, f.x0 + 1, f.z0 + 1)).toBe(true);
    const guards = state.units.filter((u) => teamOf(u) === 1);
    expect(guards.length).toBe(5);
    expect(state.ai).toEqual({ wave: 0, nextWave: FIRST_WAVE_SECONDS });
  });

  it('is deterministic and idempotent', () => {
    const a = world(), b = world();
    expect(fort(a.state).x0).toBe(fort(b.state).x0);
    expect(fort(a.state).z0).toBe(fort(b.state).z0);
    const n = a.state.buildings.length;
    addEnemyBase(a.state, terrain, a.nav);
    expect(a.state.buildings.length).toBe(n);
  });
});

describe('waves', () => {
  it('grow, stay within caps and speed up to a floor', () => {
    expect(waveComposition(0).length).toBe(3);
    expect(waveComposition(0)).not.toContain('cavalry');
    expect(waveComposition(2)).toContain('cavalry');
    expect(waveComposition(5)).toContain('elephant');
    for (let w = 0; w < 40; w++) expect(waveComposition(w).length).toBeLessThanOrEqual(14 + 4 + 3);
    expect(waveInterval(0)).toBe(80);
    expect(waveInterval(100)).toBe(45);
  });

  it('launch on schedule as attack-moving raiders aimed at the palace', () => {
    const { state, nav } = world();
    run(state, nav, FIRST_WAVE_SECONDS - 5);
    const before = state.units.filter((u) => teamOf(u) === 1).length;
    expect(before).toBe(5);
    run(state, nav, 10);
    const raiders = state.units.filter((u) => teamOf(u) === 1 && u.amove);
    expect(raiders.length).toBe(waveComposition(0).length);
    expect(raiders.every((u) => u.goal && u.path.length > 0)).toBe(true);
    expect(state.ai!.wave).toBe(1);
  });

  it('never exceed the enemy unit cap', () => {
    const { state, nav } = world();
    for (let i = 0; i < 40; i++) state.units.push(makeUnit(state, 'infantry', 20 + i * 0.1, 20, 1));
    state.time = state.ai!.nextWave;
    stepSimulation(state, SIM_STEP, nav);
    expect(state.units.filter((u) => teamOf(u) === 1).length).toBeLessThanOrEqual(45);
    expect(state.ai!.wave).toBe(0); // postponed, not consumed
    void ENEMY_UNIT_CAP;
  });
});

describe('siege and outcome', () => {
  it('units walk to a building, damage it, destroy it, and unblock its cells', () => {
    const { state, nav } = world();
    const f = fort(state);
    state.units = state.units.filter((u) => teamOf(u) === 0);
    const c = capitalCenter(terrain.size);
    const army = Array.from({ length: 8 }, (_, i) => makeUnit(state, 'infantry', f.x0 + 3 + i * 0.4, f.z0 + 10, 0));
    void c;
    state.units.push(...army);
    expect(commandAttack(state, army.map((u) => u.id), f.id)).toBe(8);
    run(state, nav, 20);
    expect(buildingHp(f)).toBeLessThan(BUILDING_DEFS.stronghold.hp);
    run(state, nav, 120);
    expect(state.buildings.some((b) => b.type === 'stronghold')).toBe(false);
    expect(state.outcome).toBe('victory');
    expect(isBlocked(nav, f.x0 + 1, f.z0 + 1)).toBe(false);
  });

  it('archers deal half damage to buildings', () => {
    const { state, nav } = world();
    const f = fort(state);
    state.units = [];
    const a = makeUnit(state, 'archer', f.x0 + 3, f.z0 + 7 + 2, 0);
    state.units.push(a);
    commandAttack(state, [a.id], f.id);
    run(state, nav, 1);
    expect(BUILDING_DEFS.stronghold.hp - buildingHp(f)).toBe(UNIT_DEFS.archer.damage * 0.5);
  });

  it('losing the palace is defeat and freezes the simulation', () => {
    const { state, nav } = world();
    const palace = state.buildings.find((b) => b.type === 'palace')!;
    palace.hp = 1;
    const raider = makeUnit(state, 'cavalry', palace.x0 + 2, palace.z0 + BUILDING_DEFS.palace.d + 1, 1);
    state.units.push(raider);
    commandAttack(state, [raider.id], palace.id);
    run(state, nav, 5);
    expect(state.outcome).toBe('defeat');
    const t = state.time;
    run(state, nav, 5);
    expect(state.time).toBe(t);
  });
});

describe('save with enemy state', () => {
  it('round-trips ai, outcome, building hp and raider orders', () => {
    const { state, nav } = world();
    run(state, nav, FIRST_WAVE_SECONDS + 5);
    fort(state).hp = 500;
    state.outcome = undefined;
    const r = parseSave(serializeState(state), terrain.size);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.ai).toEqual(state.ai);
    expect(buildingHp(r.state.buildings.find((b) => b.type === 'stronghold')!)).toBe(500);
    expect(r.state.units.filter((u) => u.amove).length).toBeGreaterThan(0);
  });

  it('clamps tampered hp and ignores a bad outcome', () => {
    const { state } = world();
    const raw = JSON.parse(serializeState(state));
    raw.state.buildings[0].hp = 1e12; raw.state.outcome = 'maybe'; raw.state.ai = { wave: -5, nextWave: 'x' };
    const r = parseSave(JSON.stringify(raw), terrain.size);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(buildingHp(r.state.buildings[0]!)).toBe(BUILDING_DEFS[r.state.buildings[0]!.type].hp);
      expect(r.state.outcome).toBeUndefined();
      expect(r.state.ai).toBeUndefined();
    }
  });
});
