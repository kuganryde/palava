import { describe, expect, it } from 'vitest';
import { BUILDING_DEFS, SIM_STEP, UNIT_DEFS } from '../src/core/defs';
import { buildingHp, teamOf, type GameState } from '../src/core/state';
import { commandAttack } from '../src/systems/combat';
import { DIFFICULTY, ENEMY_UNIT_CAP, FIRST_WAVE_SECONDS, addEnemyBase, aiCost, waveComposition, waveInterval } from '../src/systems/enemyAi';
import { isBlocked } from '../src/systems/pathfinding';
import { parseSave, serializeState } from '../src/systems/save';
import { buildNav, createNewGame, makeUnit, placeBuilding, stepSimulation } from '../src/systems/simulation';
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
    const guards = state.units.filter((u) => teamOf(u) === 1 && u.kind !== 'villager');
    expect(guards.length).toBe(5);
    expect(state.units.filter((u) => teamOf(u) === 1 && u.kind === 'villager').length).toBe(4);
    expect(state.ai).toMatchObject({ wave: 0, nextWave: FIRST_WAVE_SECONDS, difficulty: 'normal', raid: [] });
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

  it('launch on schedule as attack-moving raiders, leaving home guards behind', () => {
    const { state, nav } = world();
    run(state, nav, FIRST_WAVE_SECONDS - 5);
    expect(state.ai!.wave).toBe(0);
    run(state, nav, 10);
    const raiders = state.units.filter((u) => teamOf(u) === 1 && u.amove);
    expect(raiders.length).toBeGreaterThanOrEqual(3);
    expect(raiders.length).toBeLessThanOrEqual(waveComposition(0).length + 2);
    expect(raiders.every((u) => u.goal)).toBe(true);
    expect(state.ai!.wave).toBe(1);
    expect(state.ai!.raid.length).toBe(raiders.length);
    const home = state.units.filter((u) => teamOf(u) === 1 && u.kind !== 'villager' && !u.amove);
    expect(home.length).toBeGreaterThanOrEqual(2);
  });

  it('never train soldiers past the enemy unit cap', () => {
    const { state, nav } = world();
    for (let i = 0; i < ENEMY_UNIT_CAP; i++) state.units.push(makeUnit(state, 'infantry', 20 + i * 0.1, 20, 1));
    state.ai!.bank = 1000;
    const soldiers = () => state.units.filter((u) => teamOf(u) === 1 && u.kind !== 'villager').length;
    const before = soldiers();
    run(state, nav, 30);
    expect(soldiers()).toBe(before);
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

describe('rival economy', () => {
  const soldiers = (st: GameState) => st.units.filter((u) => teamOf(u) === 1 && u.kind !== 'villager');
  const workers = (st: GameState) => st.units.filter((u) => teamOf(u) === 1 && u.kind === 'villager' && u.hp > 0);

  it('workers earn points and the rival buys more workers up to its goal', () => {
    const { state, nav } = world();
    const start = workers(state).length;
    run(state, nav, 60);
    expect(workers(state).length).toBeGreaterThan(start);
    expect(workers(state).length).toBeLessThanOrEqual(DIFFICULTY.normal.workers + 4);
  });

  it('killing its workers starves it: no income, no new soldiers', () => {
    const { state, nav } = world();
    state.units = state.units.filter((u) => !(teamOf(u) === 1 && u.kind === 'villager'));
    state.ai!.bank = 0;
    const before = soldiers(state).length;
    run(state, nav, 120);
    expect(state.ai!.bank).toBe(0);
    expect(soldiers(state).length).toBe(before);
    expect(workers(state).length).toBe(0);
  });

  it('difficulty changes pace and income but not unit stats', () => {
    expect(DIFFICULTY.hard.first).toBeLessThan(DIFFICULTY.normal.first);
    expect(DIFFICULTY.normal.first).toBeLessThan(DIFFICULTY.easy.first);
    expect(DIFFICULTY.hard.perWorker).toBeGreaterThan(DIFFICULTY.easy.perWorker);
    const easy = createNewGame(terrain), hard = createNewGame(terrain);
    addEnemyBase(easy.state, terrain, easy.nav, 'easy');
    addEnemyBase(hard.state, terrain, hard.nav, 'hard');
    expect(easy.state.ai!.nextWave).toBeGreaterThan(hard.state.ai!.nextWave);
    expect(easy.state.ai!.difficulty).toBe('easy');
  });

  it('prices units from the player costs', () => {
    expect(aiCost('villager')).toBe(Math.round(40 * 0.5));
    expect(aiCost('elephant')).toBeGreaterThan(aiCost('cavalry'));
  });

  it('raids go for the economy before the palace', () => {
    const { state, nav } = world();
    state.resources.timber = 1000;
    const c = capitalCenter(terrain.size);
    let farm;
    for (const dx of [14, -14, 18, -18]) {
      const r = placeBuilding(state, terrain, nav, 'farm', c.x + dx, c.z + 4);
      if (r.ok) { farm = r.building!; break; }
    }
    expect(farm).toBeDefined();
    run(state, nav, FIRST_WAVE_SECONDS + 4);
    const palace = state.buildings.find((b) => b.type === 'palace')!;
    const raiders = state.units.filter((u) => teamOf(u) === 1 && u.amove && u.goal);
    expect(raiders.length).toBeGreaterThan(0);
    const dFarm = Math.hypot(raiders[0]!.goal!.x - farm!.x0, raiders[0]!.goal!.z - farm!.z0);
    const dPal = Math.hypot(raiders[0]!.goal!.x - palace.x0, raiders[0]!.goal!.z - palace.z0);
    expect(dFarm).toBeLessThan(dPal);
  });

  it('a losing raid retreats to the stronghold and rejoins the garrison', () => {
    const { state, nav } = world();
    const f = fort(state);
    const raid = Array.from({ length: 3 }, (_, i) => makeUnit(state, 'infantry', f.x0 - 20 + i, f.z0 + 12, 1));
    state.units.push(...raid);
    for (const u of raid) u.amove = true;
    state.ai!.raid = raid.map((u) => u.id);
    state.ai!.raidSize = 10; // 3 of 10 left: below the retreat line
    state.ai!.check = 0;
    state.ai!.bank = 0;
    stepSimulation(state, SIM_STEP, nav);
    expect(state.ai!.raid).toEqual([]);
    expect(raid.every((u) => !u.amove)).toBe(true);
  });

  it('is deterministic', () => {
    const a = world(), b = world();
    run(a.state, a.nav, 250); run(b.state, b.nav, 250);
    expect(JSON.stringify(a.state.ai)).toBe(JSON.stringify(b.state.ai));
    expect(a.state.units.length).toBe(b.state.units.length);
  });
});

describe('unit counters', () => {
  const hit = (attacker: 'infantry' | 'cavalry' | 'archer' | 'elephant', defender: 'infantry' | 'cavalry' | 'archer' | 'elephant'): number => {
    const { state, nav } = world();
    state.units = [];
    const a = makeUnit(state, attacker, 60, 60, 0), d = makeUnit(state, defender, 60.8, 60, 1);
    d.hp = 1000;
    state.units.push(a, d);
    commandAttack(state, [a.id], d.id);
    stepSimulation(state, SIM_STEP, nav);
    return 1000 - d.hp;
  };
  it('follows the triangle', () => {
    expect(hit('infantry', 'cavalry')).toBeCloseTo(UNIT_DEFS.infantry.damage * 1.5, 5);
    expect(hit('cavalry', 'archer')).toBeCloseTo(UNIT_DEFS.cavalry.damage * 1.6, 5);
    expect(hit('archer', 'infantry')).toBeCloseTo(UNIT_DEFS.archer.damage * 1.25, 5);
    expect(hit('infantry', 'elephant')).toBeLessThan(UNIT_DEFS.infantry.damage);
  });
  it('elephants hit buildings twice as hard', () => {
    const { state, nav } = world();
    const f = fort(state);
    state.units = [];
    const e = makeUnit(state, 'elephant', f.x0 + 3, f.z0 + 7 + 2, 0);
    state.units.push(e);
    commandAttack(state, [e.id], f.id);
    run(state, nav, 1);
    expect(BUILDING_DEFS.stronghold.hp - buildingHp(f)).toBe(UNIT_DEFS.elephant.damage * 2);
  });
});

describe('save with rival economy', () => {
  it('round-trips bank, raid and difficulty, and neutralises tampering', () => {
    const { state, nav } = world();
    run(state, nav, FIRST_WAVE_SECONDS + 5);
    const r = parseSave(serializeState(state), terrain.size);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.ai).toMatchObject({ wave: state.ai!.wave, difficulty: 'normal', raidSize: state.ai!.raidSize });
    expect(r.state.ai!.raid).toEqual(state.ai!.raid);
    const raw = JSON.parse(serializeState(state));
    raw.state.ai.difficulty = '__proto__'; raw.state.ai.bank = 1e12; raw.state.ai.raid = [1.5, 'x', -2, 7];
    const bad = parseSave(JSON.stringify(raw), terrain.size);
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.state.ai!.difficulty).toBe('normal');
    expect(bad.state.ai!.bank).toBe(5000);
    expect(bad.state.ai!.raid).toEqual([7]);
  });
});
