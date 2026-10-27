import { describe, expect, it } from 'vitest';
import { BUILDING_DEFS, MAX_UNITS, SIM_STEP, UNIT_DEFS } from '../src/core/defs';
import { incomePerSecond, popCap } from '../src/core/state';
import { capitalCenter, generateTerrain } from '../src/world/terrain';
import { isBlocked } from '../src/systems/pathfinding';
import { validatePlacement, footprintOrigin } from '../src/systems/placement';
import { commandMove, createNewGame, placeBuilding, recruitUnit, stepSimulation } from '../src/systems/simulation';

const terrain = generateTerrain(1337);
const fresh = () => createNewGame(terrain);

/** Find a placeable spot for a type near the capital by scanning outward. */
function findSpot(type: Parameters<typeof placeBuilding>[3], state: ReturnType<typeof fresh>['state']) {
  const cap = capitalCenter(terrain.size);
  for (let r = 6; r < 40; r += 2) {
    for (let a = 0; a < 16; a++) {
      const wx = cap.x + Math.cos((a / 16) * Math.PI * 2) * r, wz = cap.z + Math.sin((a / 16) * Math.PI * 2) * r;
      if (validatePlacement(state, terrain, type, wx, wz).ok) return { wx, wz };
    }
  }
  throw new Error('no spot found');
}

describe('new game', () => {
  it('has a pre-built palace, 10 walkable units and starting resources', () => {
    const { state, nav } = fresh();
    expect(state.buildings).toHaveLength(1);
    expect(state.buildings[0]!.type).toBe('palace');
    expect(state.buildings[0]!.progress).toBe(1);
    expect(state.units).toHaveLength(10);
    for (const u of state.units) expect(isBlocked(nav, u.x, u.z)).toBe(false);
    expect(state.resources.gold).toBeGreaterThan(0);
    expect(new Set([...state.units.map((u) => u.id), ...state.buildings.map((b) => b.id)]).size).toBe(11);
  });
});

describe('placement', () => {
  it('rejects water, edges, overlap, second palace and unaffordable builds', () => {
    const { state } = fresh();
    expect(validatePlacement(state, terrain, 'farm', 1, 1).reason).toBe('out-of-bounds');
    expect(validatePlacement(state, terrain, 'farm', 123, 64).reason).toMatch(/water|out-of-bounds|too-steep/);
    const cap = capitalCenter(terrain.size);
    expect(validatePlacement(state, terrain, 'farm', cap.x, cap.z).reason).toBe('overlap');
    expect(validatePlacement(state, terrain, 'palace', cap.x + 14, cap.z).reason).toMatch(/unique/);
    const spot = findSpot('temple', state);
    state.resources.stone = 0;
    expect(validatePlacement(state, terrain, 'temple', spot.wx, spot.wz).reason).toBe('unaffordable');
    expect(validatePlacement(state, terrain, 'farm', NaN, 5).ok).toBe(false);
  });

  it('keeps one free cell between buildings', () => {
    const { state, nav } = fresh();
    const spot = findSpot('farm', state);
    const placed = placeBuilding(state, terrain, nav, 'farm', spot.wx, spot.wz);
    expect(placed.ok).toBe(true);
    const def = BUILDING_DEFS.farm;
    // Directly adjacent (no gap) must fail.
    const adj = validatePlacement(state, terrain, 'farm', spot.wx + def.w, spot.wz);
    expect(adj.reason === 'overlap' || adj.reason === 'water' || adj.reason === 'too-steep').toBe(true);
  });

  it('charges cost, blocks the footprint on the nav grid, and snaps to the footprint origin', () => {
    const { state, nav } = fresh();
    const spot = findSpot('farm', state);
    const before = state.resources.timber;
    const r = placeBuilding(state, terrain, nav, 'farm', spot.wx, spot.wz);
    expect(r.ok).toBe(true);
    expect(state.resources.timber).toBe(before - (BUILDING_DEFS.farm.cost.timber ?? 0));
    const { x0, z0 } = footprintOrigin(BUILDING_DEFS.farm, spot.wx, spot.wz);
    expect(r.building!.x0).toBe(x0);
    expect(isBlocked(nav, x0, z0)).toBe(true);
    expect(state.buildings.at(-1)!.progress).toBe(0);
  });

  it('refuses placement on top of a unit', () => {
    const { state } = fresh();
    const u = state.units[0]!;
    expect(validatePlacement(state, terrain, 'lumber', u.x, u.z).ok).toBe(false);
  });
});

describe('construction and economy', () => {
  it('constructs over buildTime then produces resources', () => {
    const { state, nav } = fresh();
    const spot = findSpot('farm', state);
    const r = placeBuilding(state, terrain, nav, 'farm', spot.wx, spot.wz);
    const b = r.building!;
    const steps = Math.ceil(BUILDING_DEFS.farm.buildTime / SIM_STEP);
    for (let i = 0; i < steps / 2; i++) stepSimulation(state, SIM_STEP);
    expect(b.progress).toBeGreaterThan(0.4);
    expect(b.progress).toBeLessThan(0.6);
    const foodMid = state.resources.food;
    for (let i = 0; i < steps; i++) stepSimulation(state, SIM_STEP);
    expect(b.progress).toBe(1);
    expect(state.resources.food).toBeGreaterThan(foodMid); // palace gold + farm food
    const before = state.resources.food;
    for (let i = 0; i < 20; i++) stepSimulation(state, SIM_STEP); // 1 second
    expect(state.resources.food - before).toBeCloseTo(BUILDING_DEFS.farm.produces.food!, 1);
  });

  it('income and population cap only count completed buildings', () => {
    const { state, nav } = fresh();
    const base = popCap(state);
    const spot = findSpot('farm', state);
    placeBuilding(state, terrain, nav, 'farm', spot.wx, spot.wz);
    expect(popCap(state)).toBe(base);
    expect(incomePerSecond(state).food).toBe(0);
  });

  it('caps stored resources', () => {
    const { state } = fresh();
    state.resources.gold = 1999.99;
    for (let i = 0; i < 400; i++) stepSimulation(state, SIM_STEP);
    expect(state.resources.gold).toBeLessThanOrEqual(2000);
  });
});

describe('recruitment', () => {
  function withBarracks() {
    const g = fresh();
    g.state.resources = { food: 1000, timber: 1000, stone: 1000, iron: 0, gold: 1000 };
    const spot = findSpot('barracks', g.state);
    const b = placeBuilding(g.state, terrain, g.nav, 'barracks', spot.wx, spot.wz).building!;
    return { ...g, b };
  }

  it('refuses while under construction, then recruits and charges', () => {
    const { state, nav, b } = withBarracks();
    expect(recruitUnit(state, nav, b.id, 'archer')).toEqual({ ok: false, reason: 'under-construction' });
    b.progress = 1;
    const timber = state.resources.timber, n = state.units.length;
    const r = recruitUnit(state, nav, b.id, 'archer');
    expect(r.ok).toBe(true);
    expect(state.units).toHaveLength(n + 1);
    expect(state.resources.timber).toBe(timber - (UNIT_DEFS.archer.cost.timber ?? 0));
  });

  it('enforces population cap, cost and building type', () => {
    const { state, nav, b } = withBarracks();
    b.progress = 1;
    state.resources.food = 0;
    expect(recruitUnit(state, nav, b.id, 'infantry')).toEqual({ ok: false, reason: 'unaffordable' });
    state.resources.food = 1000;
    while (state.units.length < popCap(state)) { const r = recruitUnit(state, nav, b.id, 'archer'); if (!r.ok) break; state.resources.food = 1000; state.resources.timber = 1000; }
    expect(recruitUnit(state, nav, b.id, 'archer')).toEqual({ ok: false, reason: 'population' });
    expect(recruitUnit(state, nav, state.buildings[0]!.id, 'archer')).toEqual({ ok: false, reason: 'not-barracks' });
    expect(recruitUnit(state, nav, 99999, 'archer')).toEqual({ ok: false, reason: 'no-building' });
    expect(state.units.length).toBeLessThanOrEqual(MAX_UNITS);
  });
});

describe('movement commands', () => {
  it('moves selected units to formation slots at their speed and leaves others alone', () => {
    const { state, nav } = fresh();
    const cap = capitalCenter(terrain.size);
    const ids = state.units.slice(0, 5).map((u) => u.id);
    const other = state.units[9]!;
    const otherPos = { x: other.x, z: other.z };
    const target = { x: cap.x - 14, z: cap.z + 12 };
    expect(commandMove(state, nav, ids, target, 'wedge')).toBe(5);
    expect(other.path).toHaveLength(0);
    const start = state.units[0]!;
    const sx = start.x, sz = start.z;
    stepSimulation(state, SIM_STEP);
    expect(Math.hypot(start.x - sx, start.z - sz)).toBeCloseTo(UNIT_DEFS[start.kind].speed * SIM_STEP, 3);
    for (let i = 0; i < 20 * 30; i++) stepSimulation(state, SIM_STEP);
    for (const id of ids) {
      const u = state.units.find((q) => q.id === id)!;
      expect(u.path).toHaveLength(0);
      expect(isBlocked(nav, u.x, u.z)).toBe(false);
      expect(Math.hypot(u.x - target.x, u.z - target.z)).toBeLessThan(8);
    }
    expect(other.x).toBe(otherPos.x);
    expect(other.z).toBe(otherPos.z);
  });

  it('is deterministic: identical commands give identical results', () => {
    const run = () => {
      const { state, nav } = fresh();
      const cap = capitalCenter(terrain.size);
      commandMove(state, nav, state.units.map((u) => u.id), { x: cap.x + 15, z: cap.z + 10 }, 'box');
      for (let i = 0; i < 200; i++) stepSimulation(state, SIM_STEP);
      return state.units.map((u) => [u.x.toFixed(4), u.z.toFixed(4)]);
    };
    expect(run()).toEqual(run());
  });

  it('ignores unknown ids and unreachable targets without throwing', () => {
    const { state, nav } = fresh();
    expect(commandMove(state, nav, [424242], { x: 50, z: 50 }, 'line')).toBe(0);
    expect(() => commandMove(state, nav, state.units.map((u) => u.id), { x: -999, z: 9999 }, 'line')).not.toThrow();
  });
});
