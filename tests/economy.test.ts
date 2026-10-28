import { describe, expect, it } from 'vitest';
import { BUILDING_DEFS, IDLE_TRICKLE, SIM_STEP } from '../src/core/defs';
import { incomePerSecond, workersOnSite, type GameState } from '../src/core/state';
import { commandWork, stepWorkers } from '../src/systems/economy';
import { parseSave, serializeState } from '../src/systems/save';
import { buildNav, commandMove, createNewGame, placeBuilding, stepSimulation } from '../src/systems/simulation';
import { capitalCenter, generateTerrain } from '../src/world/terrain';

const terrain = generateTerrain(1337);
type World = { state: GameState; nav: ReturnType<typeof buildNav> };
const run = (w: World, seconds: number): void => { for (let i = 0; i < seconds / SIM_STEP; i++) stepSimulation(w.state, SIM_STEP, w.nav); };
const villagers = (s: GameState) => s.units.filter((u) => u.kind === 'villager');

/** A game with one finished farm placed near the capital. */
function withFarm(): World & { farmId: number } {
  const w = createNewGame(terrain);
  w.state.resources.timber = 1000;
  const cap = capitalCenter(terrain.size);
  let farm: ReturnType<typeof placeBuilding>['building'];
  for (const dx of [14, -14, 18, -18]) {
    const r = placeBuilding(w.state, terrain, w.nav, 'farm', cap.x + dx, cap.z + 4);
    if (r.ok) { farm = r.building; break; }
  }
  expect(farm).toBeDefined();
  farm!.progress = 1;
  return { ...w, farmId: farm!.id };
}

describe('worker economy', () => {
  it('starts with villagers and no staffed workplaces', () => {
    const { state } = createNewGame(terrain);
    expect(villagers(state).length).toBe(6);
  });

  it('an unstaffed farm yields only the idle trickle', () => {
    const w = withFarm();
    for (const v of villagers(w.state)) v.hold = true; // keep them away
    const inc = incomePerSecond(w.state);
    expect(inc.food).toBeCloseTo(BUILDING_DEFS.farm.produces.food! * IDLE_TRICKLE, 5);
  });

  it('idle villagers find the farm on their own and staff it up to its slots', () => {
    const w = withFarm();
    run(w, 40);
    const farm = w.state.buildings.find((b) => b.id === w.farmId)!;
    expect(workersOnSite(w.state, farm)).toBe(BUILDING_DEFS.farm.slots);
    expect(incomePerSecond(w.state).food).toBeCloseTo(BUILDING_DEFS.farm.produces.food!, 5);
    // Extra villagers do not pile onto a full building.
    const assigned = villagers(w.state).filter((v) => v.work === w.farmId).length;
    expect(assigned).toBe(BUILDING_DEFS.farm.slots);
  });

  it('a manual move takes a villager off the job and it stays put (hold)', () => {
    const w = withFarm();
    run(w, 40);
    const v = villagers(w.state).find((u) => u.work === w.farmId)!;
    const cap = capitalCenter(terrain.size);
    commandMove(w.state, w.nav, [v.id], { x: cap.x, z: cap.z + 12 }, 'line');
    expect(v.work).toBeNull();
    expect(v.hold).toBe(true);
    run(w, 30);
    expect(v.work ?? null).toBeNull();
  });

  it('commandWork reassigns a held villager and rejects invalid targets', () => {
    const w = withFarm();
    const v = villagers(w.state)[0]!;
    v.hold = true;
    expect(commandWork(w.state, w.nav, [v.id], w.farmId)).toBe(1);
    expect(v.work).toBe(w.farmId);
    expect(v.hold).toBe(false);
    const palace = w.state.buildings.find((b) => b.type === 'palace')!;
    expect(commandWork(w.state, w.nav, [v.id], palace.id)).toBe(0); // palace has no slots
    expect(commandWork(w.state, w.nav, [v.id], 99999)).toBe(0);
    const soldier = w.state.units.find((u) => u.kind === 'infantry')!;
    expect(commandWork(w.state, w.nav, [soldier.id], w.farmId)).toBe(0); // only villagers work
  });

  it('workers are released when their building is destroyed', () => {
    const w = withFarm();
    run(w, 40);
    const farm = w.state.buildings.find((b) => b.id === w.farmId)!;
    farm.hp = 0;
    w.state.buildings = w.state.buildings.filter((b) => b.id !== w.farmId);
    stepWorkers(w.state, w.nav);
    expect(villagers(w.state).every((v) => v.work !== w.farmId)).toBe(true);
  });

  it('staffed farms grow food over time versus the trickle', () => {
    const staffed = withFarm();
    const empty = withFarm();
    for (const v of villagers(empty.state)) v.hold = true;
    staffed.state.resources.food = 0; empty.state.resources.food = 0;
    run(staffed, 60); run(empty, 60);
    expect(staffed.state.resources.food).toBeGreaterThan(empty.state.resources.food * 1.8);
  });

  it('work assignment survives a save round trip and tampered ids are neutralised', () => {
    const w = withFarm();
    run(w, 40);
    const back = parseSave(serializeState(w.state), terrain.size);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(villagers(back.state).filter((v) => v.work === w.farmId).length).toBe(BUILDING_DEFS.farm.slots);
    const raw = JSON.parse(serializeState(w.state));
    raw.state.units.find((u: { kind: string }) => u.kind === 'villager').work = -5;
    raw.state.units.find((u: { kind: string }) => u.kind === 'villager').hold = 'yes';
    const bad = parseSave(JSON.stringify(raw), terrain.size);
    expect(bad.ok).toBe(true);
    if (bad.ok) expect(villagers(bad.state).every((v) => v.work == null || v.work > 0)).toBe(true);
  });

  it('is deterministic', () => {
    const a = withFarm(), b = withFarm();
    run(a, 50); run(b, 50);
    expect(JSON.stringify(a.state.resources)).toBe(JSON.stringify(b.state.resources));
  });
});
