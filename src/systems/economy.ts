import { BUILDING_DEFS, WORK_RADIUS } from '../core/defs';
import { distToFootprint, isAlive, teamOf, type BuildingState, type GameState, type UnitState } from '../core/state';
import { findPath, nearestWalkable, type NavGrid } from './pathfinding';

/** Seconds between a villager's look for work. */
const ASSIGN_SECONDS = 1;

const isWorkplace = (b: BuildingState): boolean => b.progress >= 1 && BUILDING_DEFS[b.type].slots > 0 && b.type !== 'stronghold';

/** Where a worker stands: just in front (south) of the building, spread by id so they do not stack. */
function workSpot(nav: NavGrid, b: BuildingState, id: number): { x: number; z: number } | null {
  const def = BUILDING_DEFS[b.type];
  const x = b.x0 + def.w / 2 - 0.5 + ((id % 5) - 2) * 0.6;
  return nearestWalkable(nav, x, b.z0 + def.d + 0.6);
}

function sendToWork(nav: NavGrid, u: UnitState, b: BuildingState): void {
  u.work = b.id;
  const spot = workSpot(nav, b, u.id);
  if (!spot) { u.path = []; return; }
  if (distToFootprint(u.x, u.z, b) <= WORK_RADIUS * 0.6) { u.path = []; return; }
  const path = findPath(nav, u.x, u.z, spot.x, spot.z);
  u.path = path ?? [];
}

/**
 * Player order: villagers go and work at `buildingId`. Returns how many villagers obeyed
 * (non-villagers and non-workplaces are ignored). Over-assigning is allowed but adds nothing.
 */
export function commandWork(state: GameState, nav: NavGrid, unitIds: Iterable<number>, buildingId: number): number {
  const b = state.buildings.find((x) => x.id === buildingId);
  if (!b || !isWorkplace(b) || b.type === 'palace') return 0;
  const ids = new Set(unitIds);
  let n = 0;
  for (const u of state.units) {
    if (!ids.has(u.id) || u.kind !== 'villager' || !isAlive(u) || teamOf(u) !== 0) continue;
    u.hold = false; u.target = null; u.amove = false; u.goal = null;
    sendToWork(nav, u, b);
    n++;
  }
  return n;
}

/** Idle, uncommanded villagers find the nearest workplace with a free slot; stray workers walk back. */
export function stepWorkers(state: GameState, nav: NavGrid | undefined): void {
  if (!nav) return;
  let assigned: Map<number, number> | null = null;
  for (const u of state.units) {
    if (u.kind !== 'villager' || teamOf(u) !== 0 || !isAlive(u) || u.hold) continue;
    if (u.scan && u.scan > 0) continue;
    const current = u.work != null ? state.buildings.find((b) => b.id === u.work && isWorkplace(b)) : undefined;
    if (u.work != null && !current) u.work = null; // building was destroyed
    if (current) {
      // Keep at the post: drifted workers (after a fight or a blocked path) return.
      u.scan = ASSIGN_SECONDS;
      if (u.path.length === 0 && distToFootprint(u.x, u.z, current) > WORK_RADIUS) sendToWork(nav, u, current);
      continue;
    }
    if (u.path.length > 0 || u.target != null) continue; // busy
    u.scan = ASSIGN_SECONDS;
    if (!assigned) {
      assigned = new Map();
      for (const o of state.units) if (o.work != null && o.kind === 'villager' && isAlive(o)) assigned.set(o.work, (assigned.get(o.work) ?? 0) + 1);
    }
    let best: BuildingState | undefined, bestD = Infinity;
    for (const b of state.buildings) {
      if (!isWorkplace(b) || b.type === 'palace') continue;
      if ((assigned.get(b.id) ?? 0) >= BUILDING_DEFS[b.type].slots) continue;
      const d = distToFootprint(u.x, u.z, b);
      if (d < bestD || (d === bestD && best && b.id < best.id)) { bestD = d; best = b; }
    }
    if (best) {
      assigned.set(best.id, (assigned.get(best.id) ?? 0) + 1);
      sendToWork(nav, u, best);
    }
  }
}
