import {
  BUILDING_DEFS, formationSpacing, MAX_UNITS, RESOURCE_CAP, RESOURCE_IDS, UNIT_DEFS,
  type BuildingType, type UnitKind,
} from '../core/defs';
import {
  buildingTeam, canAfford, popCap, population, productionFactor, spend, startingResources, teamOf,
  type BuildingState, type GameState, type UnitState,
} from '../core/state';
import { capitalCenter, type Terrain } from '../world/terrain';
import { assignSlots, formationSlots, type FormationKind } from './formation';
import {
  buildNavGrid, findPath, nearestWalkable, setBlockedRect, type NavGrid, type Point,
} from './pathfinding';
import { makeUnit } from './unitFactory';
export { makeUnit };
import { stepCombat } from './combat';
import { stepAi } from './enemyAi';
import { stepWorkers } from './economy';
import { footprintCenter, validatePlacement, type PlacementResult } from './placement';

/** Nav grid = terrain walkability + building footprints. Rebuilt after loading a save. */
export function buildNav(terrain: Terrain, state: GameState): NavGrid {
  const nav = buildNavGrid(terrain);
  for (const b of state.buildings) {
    const def = BUILDING_DEFS[b.type];
    setBlockedRect(nav, b.x0, b.z0, def.w, def.d, true);
  }
  return nav;
}


const START_VILLAGERS = 6;

export function createNewGame(terrain: Terrain): { state: GameState; nav: NavGrid } {
  const state: GameState = {
    version: 2, seed: terrain.seed, time: 0, resources: startingResources(),
    buildings: [], units: [], nextId: 1,
  };
  const nav = buildNavGrid(terrain);
  const cap = capitalCenter(terrain.size);
  // The palace is free and pre-built: place it directly.
  const palace = BUILDING_DEFS.palace;
  const x0 = cap.x - Math.floor(palace.w / 2), z0 = cap.z - Math.floor(palace.d / 2);
  state.buildings.push({ id: state.nextId++, type: 'palace', x0, z0, progress: 1 });
  setBlockedRect(nav, x0, z0, palace.w, palace.d, true);

  const kinds: UnitKind[] = ['infantry', 'infantry', 'infantry', 'infantry', 'infantry', 'infantry', 'archer', 'archer', 'archer', 'archer'];
  const slots = formationSlots('box', kinds.length, { x: cap.x, z: z0 + palace.d + 3 }, { x: cap.x, z: cap.z }, 1.7);
  kinds.forEach((kind, i) => {
    const spot = nearestWalkable(nav, slots[i]!.x, slots[i]!.z) ?? { x: cap.x, z: cap.z + 10 };
    state.units.push(makeUnit(state, kind, spot.x, spot.z));
  });
  // A small starting workforce: villagers find work on their own once buildings are finished.
  for (let i = 0; i < START_VILLAGERS; i++) {
    const spot = nearestWalkable(nav, cap.x - 3 + i * 1.2, z0 - 2.5) ?? { x: cap.x, z: cap.z - 10 };
    state.units.push(makeUnit(state, 'villager', spot.x, spot.z));
  }
  return { state, nav };
}

export type PlaceOutcome = PlacementResult & { building?: BuildingState };

/** Validate, charge and place a building (it then constructs over time). */
export function placeBuilding(
  state: GameState, terrain: Terrain, nav: NavGrid, type: BuildingType, wx: number, wz: number,
): PlaceOutcome {
  const result = validatePlacement(state, terrain, type, wx, wz);
  if (!result.ok) return result;
  const def = BUILDING_DEFS[type];
  spend(state.resources, def.cost);
  const building: BuildingState = { id: state.nextId++, type, x0: result.x0, z0: result.z0, progress: 0 };
  state.buildings.push(building);
  setBlockedRect(nav, building.x0, building.z0, def.w, def.d, true);
  return { ...result, building };
}

export type RecruitOutcome =
  | { ok: true; unit: UnitState }
  | { ok: false; reason: 'no-building' | 'not-barracks' | 'under-construction' | 'unit-limit' | 'population' | 'unaffordable' | 'no-space' };

export function recruitUnit(state: GameState, nav: NavGrid, buildingId: number, kind: UnitKind): RecruitOutcome {
  const b = state.buildings.find((x) => x.id === buildingId);
  if (!b) return { ok: false, reason: 'no-building' };
  if (b.type !== UNIT_DEFS[kind].trainedAt) return { ok: false, reason: 'not-barracks' }; // wrong building for this unit
  if (b.progress < 1) return { ok: false, reason: 'under-construction' };
  if (state.units.length >= MAX_UNITS) return { ok: false, reason: 'unit-limit' };
  if (population(state) >= popCap(state)) return { ok: false, reason: 'population' };
  const cost = UNIT_DEFS[kind].cost;
  if (!canAfford(state.resources, cost)) return { ok: false, reason: 'unaffordable' };
  const def = BUILDING_DEFS[b.type];
  const c = footprintCenter(def, b.x0, b.z0);
  // Spawn in front (south) of the building, jittered by id so recruits do not stack exactly.
  const jitter = ((state.nextId % 5) - 2) * 0.7;
  const spot = nearestWalkable(nav, c.x + jitter, b.z0 + def.d + 1.5);
  if (!spot) return { ok: false, reason: 'no-space' };
  spend(state.resources, cost);
  const unit = makeUnit(state, kind, spot.x, spot.z);
  state.units.push(unit);
  return { ok: true, unit };
}

/** Order units to move to `target` in the given formation. Returns the number of units that received a path. */
export function commandMove(
  state: GameState, nav: NavGrid, unitIds: Iterable<number>, target: Point, formation: FormationKind,
): number {
  const ids = new Set(unitIds);
  const units = state.units.filter((u) => ids.has(u.id) && u.hp > 0 && teamOf(u) === 0);
  if (units.length === 0) return 0;
  const centroid = {
    x: units.reduce((s, u) => s + u.x, 0) / units.length,
    z: units.reduce((s, u) => s + u.z, 0) / units.length,
  };
  const slots = formationSlots(formation, units.length, target, centroid, formationSpacing(units.map((u) => u.kind)));
  const facing = { x: target.x - centroid.x, z: target.z - centroid.z };
  const assignment = assignSlots(units, slots, facing);
  let moved = 0;
  units.forEach((u, i) => {
    const slot = slots[assignment[i]!]!;
    const path = findPath(nav, u.x, u.z, slot.x, slot.z);
    u.target = null; // a move order cancels any attack order
    u.amove = false; u.goal = null;
    if (u.kind === 'villager') { u.work = null; u.hold = true; } // manual control until given a work order
    if (path) { u.path = path; moved++; } else { u.path = []; }
  });
  return moved;
}

/** Like a move, but units fight anything they meet on the way and then carry on to the destination. */
export function commandAttackMove(
  state: GameState, nav: NavGrid, unitIds: Iterable<number>, target: Point, formation: FormationKind,
): number {
  const ids = new Set(unitIds);
  const moved = commandMove(state, nav, ids, target, formation);
  for (const u of state.units) {
    if (!ids.has(u.id) || u.hp <= 0 || teamOf(u) !== 0 || u.path.length === 0) continue;
    u.amove = true;
    u.goal = { ...u.path[u.path.length - 1]! };
  }
  return moved;
}

export function stopUnits(state: GameState, unitIds: Iterable<number>): void {
  const ids = new Set(unitIds);
  for (const u of state.units) if (ids.has(u.id)) { u.path = []; u.target = null; u.amove = false; u.goal = null; if (u.kind === 'villager') { u.work = null; u.hold = true; } }
}

/** Advance the deterministic simulation by a fixed `dt`. */
/** `nav` enables pursuit pathing in combat; without it units still fight whatever is in reach. */
export function stepSimulation(state: GameState, dt: number, nav?: NavGrid): void {
  if (state.outcome) return; // the game is decided: nothing advances
  state.time += dt;
  stepAi(state, nav, dt);

  for (const b of state.buildings) {
    if (b.progress < 1) b.progress = Math.min(1, b.progress + dt / BUILDING_DEFS[b.type].buildTime);
  }

  stepWorkers(state, nav);
  for (const b of state.buildings) {
    if (b.progress < 1 || buildingTeam(b) !== 0) continue;
    const p = BUILDING_DEFS[b.type].produces;
    const f = productionFactor(state, b); // villagers on site decide the rate
    for (const r of RESOURCE_IDS) {
      const rate = p[r];
      if (rate) state.resources[r] = Math.min(RESOURCE_CAP, state.resources[r] + rate * f * dt);
    }
  }

  stepCombat(state, nav, dt);

  for (const u of state.units) {
    if (u.hp <= 0) { u.px = u.x; u.pz = u.z; continue; }
    u.px = u.x;
    u.pz = u.z;
    let remaining = UNIT_DEFS[u.kind].speed * dt;
    while (remaining > 1e-9 && u.path.length > 0) {
      const wp = u.path[0]!;
      const dx = wp.x - u.x, dz = wp.z - u.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-6) u.facing = Math.atan2(dx, dz);
      if (d <= remaining) {
        u.x = wp.x; u.z = wp.z;
        remaining -= d;
        u.path.shift();
      } else {
        u.x += (dx / d) * remaining;
        u.z += (dz / d) * remaining;
        remaining = 0;
      }
    }
  }
}
