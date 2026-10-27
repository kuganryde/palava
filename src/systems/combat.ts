import { BUILDING_DEFS, UNIT_DEFS } from '../core/defs';
import {
  buildingHp, buildingTeam, isAlive, teamOf,
  type BuildingState, type CombatEvent, type GameState, type Team, type UnitState,
} from '../core/state';
import { findPath, setBlockedRect, type NavGrid } from './pathfinding';

/** Idle units notice enemies within this many cells. */
export const AGGRO_RADIUS = 9;
/** How long a corpse lingers (it plays the death clip) before it is removed. */
export const CORPSE_SECONDS = 2.5;
const REPATH_SECONDS = 0.6;
const SCAN_SECONDS = 0.5;
const MAX_EVENTS = 64;
/** Melee units strike buildings from this far outside the footprint edge. */
const BUILDING_REACH = 0.4;

/** Anything a unit can attack. Unit and building ids share one id space, so a bare number identifies either. */
export type Target =
  | { kind: 'unit'; unit: UnitState; id: number; team: Team }
  | { kind: 'building'; building: BuildingState; id: number; team: Team };

export function findTarget(state: GameState, id: number | null | undefined): Target | undefined {
  if (id == null) return undefined;
  const unit = state.units.find((u) => u.id === id);
  if (unit) return { kind: 'unit', unit, id, team: teamOf(unit) };
  const building = state.buildings.find((b) => b.id === id);
  if (building) return { kind: 'building', building, id, team: buildingTeam(building) };
  return undefined;
}

const targetAlive = (t: Target): boolean => (t.kind === 'unit' ? isAlive(t.unit) : buildingHp(t.building) > 0);

/** Distance from a unit to the nearest point of a building footprint (0 when inside). */
function rectDistance(u: UnitState, b: BuildingState): number {
  const def = BUILDING_DEFS[b.type];
  const cx = Math.min(Math.max(u.x, b.x0 - 0.5), b.x0 + def.w - 0.5);
  const cz = Math.min(Math.max(u.z, b.z0 - 0.5), b.z0 + def.d - 0.5);
  return Math.hypot(u.x - cx, u.z - cz);
}

function targetDistance(u: UnitState, t: Target): number {
  return t.kind === 'unit' ? Math.hypot(u.x - t.unit.x, u.z - t.unit.z) : rectDistance(u, t.building);
}

/** Distance at which `a` can hit the target: weapon range plus body radii, so elephants are reachable. */
export function reachTo(a: UnitState, t: Target): number {
  const base = UNIT_DEFS[a.kind].range + UNIT_DEFS[a.kind].radius;
  return t.kind === 'unit' ? base + UNIT_DEFS[t.unit.kind].radius : base + BUILDING_REACH;
}

/** Back-compat helper for unit-vs-unit reach (used by tests). */
export function reach(a: UnitState, b: UnitState): number {
  return reachTo(a, { kind: 'unit', unit: b, id: b.id, team: teamOf(b) });
}

/** Where to walk to attack: the target itself, or the footprint edge nearest the attacker for buildings. */
function approachPoint(u: UnitState, t: Target): { x: number; z: number } {
  if (t.kind === 'unit') return { x: t.unit.x, z: t.unit.z };
  const b = t.building, def = BUILDING_DEFS[b.type];
  const lo = { x: b.x0 - 1.2, z: b.z0 - 1.2 }, hi = { x: b.x0 + def.w + 0.2, z: b.z0 + def.d + 0.2 };
  const cx = (lo.x + hi.x) / 2, cz = (lo.z + hi.z) / 2;
  // Project the unit onto the ring just outside the footprint, preferring the side it is already on.
  const dx = u.x - cx, dz = u.z - cz;
  if (Math.abs(dx) / (hi.x - lo.x) > Math.abs(dz) / (hi.z - lo.z)) return { x: dx > 0 ? hi.x : lo.x, z: Math.min(Math.max(u.z, lo.z), hi.z) };
  return { x: Math.min(Math.max(u.x, lo.x), hi.x), z: dz > 0 ? hi.z : lo.z };
}

/** Order units to attack `targetId` (an enemy unit or building). Returns how many obeyed. */
export function commandAttack(state: GameState, unitIds: Iterable<number>, targetId: number): number {
  const target = findTarget(state, targetId);
  if (!target || !targetAlive(target)) return 0;
  const ids = new Set(unitIds);
  let n = 0;
  for (const u of state.units) {
    if (!ids.has(u.id) || !isAlive(u) || teamOf(u) === target.team) continue;
    u.target = targetId; u.path = []; u.repath = 0; u.amove = false; u.goal = null; n++;
  }
  return n;
}

/** Nearest living enemy within `radius`: units are preferred, then buildings. */
export function nearestEnemy(state: GameState, u: UnitState, radius: number): Target | undefined {
  let best: Target | undefined, bestD = radius;
  for (const o of state.units) {
    if (!isAlive(o) || teamOf(o) === teamOf(u)) continue;
    const d = Math.hypot(u.x - o.x, u.z - o.z);
    if (d < bestD) { bestD = d; best = { kind: 'unit', unit: o, id: o.id, team: teamOf(o) }; }
  }
  if (best) return best;
  for (const b of state.buildings) {
    if (buildingTeam(b) === teamOf(u)) continue;
    const d = rectDistance(u, b);
    if (d < bestD) { bestD = d; best = { kind: 'building', building: b, id: b.id, team: buildingTeam(b) }; }
  }
  return best;
}

function record(state: GameState, e: CombatEvent): void {
  const ev = (state.events ??= []);
  ev.push(e);
  if (ev.length > MAX_EVENTS) ev.splice(0, ev.length - MAX_EVENTS);
}

/** Remove destroyed buildings, unblock their cells and decide the game. */
function resolveBuildings(state: GameState, nav: NavGrid | undefined): void {
  if (state.buildings.every((b) => buildingHp(b) > 0)) return;
  for (const b of state.buildings) {
    if (buildingHp(b) > 0) continue;
    const def = BUILDING_DEFS[b.type];
    if (nav) setBlockedRect(nav, b.x0, b.z0, def.w, def.d, false);
  }
  state.buildings = state.buildings.filter((b) => buildingHp(b) > 0);
  if (!state.outcome) {
    if (!state.buildings.some((b) => b.type === 'palace')) state.outcome = 'defeat';
    else if (!state.buildings.some((b) => b.type === 'stronghold') && state.ai) state.outcome = 'victory';
  }
}

/**
 * One fixed step of combat: acquire targets, close distance, strike, die, and clear corpses.
 * Deterministic (no randomness): the same state always produces the same fight.
 */
export function stepCombat(state: GameState, nav: NavGrid | undefined, dt: number): void {
  let anyDead = false;
  for (const u of state.units) {
    if (!isAlive(u)) {
      if (u.diedAt === undefined) { u.diedAt = state.time; u.path = []; u.target = null; }
      anyDead = true;
      continue;
    }
    if (u.cooldown && u.cooldown > 0) u.cooldown = Math.max(0, u.cooldown - dt);
    if (u.repath && u.repath > 0) u.repath = Math.max(0, u.repath - dt);
    if (u.scan && u.scan > 0) u.scan = Math.max(0, u.scan - dt);

    let target = findTarget(state, u.target);
    if (target && (!targetAlive(target) || target.team === teamOf(u))) { u.target = null; target = undefined; }

    // Idle fighters (and attack-movers on the march) pick fights; ordinary movers and workers do not.
    if (!target && (u.path.length === 0 || u.amove) && u.kind !== 'villager' && !u.scan) {
      u.scan = SCAN_SECONDS;
      target = nearestEnemy(state, u, AGGRO_RADIUS);
      u.target = target ? target.id : null;
    }

    if (!target) {
      // Attack-movers resume their march once the fight is over.
      if (u.amove && u.goal && u.path.length === 0 && !u.repath) {
        u.repath = REPATH_SECONDS * 2;
        if (Math.hypot(u.goal.x - u.x, u.goal.z - u.z) > 3 && nav) {
          const path = findPath(nav, u.x, u.z, u.goal.x, u.goal.z);
          if (path) u.path = path;
        }
      }
      continue;
    }

    const def = UNIT_DEFS[u.kind];
    const d = targetDistance(u, target);
    if (d <= reachTo(u, target)) {
      u.path = [];
      const fx = target.kind === 'unit' ? target.unit.x : target.building.x0 + BUILDING_DEFS[target.building.type].w / 2 - 0.5;
      const fz = target.kind === 'unit' ? target.unit.z : target.building.z0 + BUILDING_DEFS[target.building.type].d / 2 - 0.5;
      u.facing = Math.atan2(fx - u.x, fz - u.z);
      if (!u.cooldown) {
        u.cooldown = def.attackInterval;
        let killed: boolean;
        if (target.kind === 'unit') {
          target.unit.hp = Math.max(0, target.unit.hp - def.damage);
          killed = target.unit.hp <= 0;
        } else {
          // Archers do little against stone: buildings take reduced damage from ranged units.
          const dmg = def.range > 3 ? def.damage * 0.5 : def.damage;
          target.building.hp = Math.max(0, buildingHp(target.building) - dmg);
          killed = target.building.hp <= 0;
        }
        record(state, { t: state.time, from: u.id, to: target.id, ranged: def.range > 3, killed });
        if (killed) u.target = null;
      }
    } else if (!u.repath && nav) {
      u.repath = REPATH_SECONDS;
      const a = approachPoint(u, target);
      const path = findPath(nav, u.x, u.z, a.x, a.z);
      if (path) u.path = path; else { u.target = null; u.path = []; } // unreachable: give up instead of freezing
    }
  }

  if (anyDead) {
    state.units = state.units.filter((u) => isAlive(u) || u.diedAt === undefined || state.time - u.diedAt < CORPSE_SECONDS);
  }
  resolveBuildings(state, nav);
}
