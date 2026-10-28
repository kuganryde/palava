import { BUILDING_DEFS, MAX_UNITS, RESOURCE_IDS, UNIT_DEFS, type UnitKind } from '../core/defs';
import {
  buildingTeam, isAlive, teamOf, type AiState, type BuildingState, type Difficulty, type GameState, type UnitState,
} from '../core/state';
import { capitalCenter, type Terrain } from '../world/terrain';
import { findPath, nearestWalkable, setBlockedRect, type NavGrid } from './pathfinding';
import { validatePlacement, footprintCenter } from './placement';
import { makeUnit } from './unitFactory';

/** Seconds before the first raid on Normal; players get time to build an economy and an army. */
export const FIRST_WAVE_SECONDS = 210;
/** Never keep more than this many living enemy soldiers (performance and fairness cap). */
export const ENEMY_UNIT_CAP = 28;
const MIN_BASE_DISTANCE = 38; // keep the rival well away from the capital
const MAX_BASE_DISTANCE = 64;
/** Workers count when standing within this many cells of the stronghold. */
const WORKER_RADIUS = 14;
const MAX_ENEMY_WORKERS = 14;
/** Rival costs are a fraction of the player's, expressed as a single point currency. */
const COST_FACTOR = 0.5;
const BANK_CAP = 1500;
const BUY_INTERVAL = 3;
const CHECK_INTERVAL = 2;
const HOME_GUARDS = 2;
const MIN_RAID = 3;
const RETREAT_FRACTION = 0.4;

export interface DifficultyConfig {
  /** Seconds before the first raid. */
  first: number;
  /** Multiplier on the gap between raids. */
  interval: number;
  /** Bank points per worker per second. */
  perWorker: number;
  /** Workers before wave scaling (+1 per wave, up to +4). */
  workers: number;
  startBank: number;
}

/** Difficulty changes the rival's income, pace and head start: its units use the same stats on every setting. */
export const DIFFICULTY: Record<Difficulty, DifficultyConfig> = {
  easy: { first: 270, interval: 1.3, perWorker: 0.7, workers: 5, startBank: 0 },
  normal: { first: FIRST_WAVE_SECONDS, interval: 1, perWorker: 0.9, workers: 7, startBank: 60 },
  hard: { first: 170, interval: 0.8, perWorker: 1.1, workers: 9, startBank: 140 },
};

/** Raid composition for wave `w` (0-based): grows steadily, adds cavalry from wave 2 and elephants from wave 5. */
export function waveComposition(w: number): UnitKind[] {
  const out: UnitKind[] = [];
  const n = Math.min(3 + w * 2, 14);
  for (let i = 0; i < n; i++) out.push(i % 3 === 2 ? 'archer' : 'infantry');
  if (w >= 2) for (let i = 0; i < Math.min(1 + Math.floor((w - 2) / 2), 4); i++) out.push('cavalry');
  if (w >= 5) for (let i = 0; i < Math.min(1 + Math.floor((w - 5) / 3), 3); i++) out.push('elephant');
  return out;
}

/** Gap between waves shrinks from 80 s to a floor of 45 s (before the difficulty multiplier). */
export const waveInterval = (w: number): number => Math.max(45, 80 - w * 5);

/** What the rival pays, in bank points. */
export function aiCost(kind: UnitKind): number {
  const c = UNIT_DEFS[kind].cost;
  return Math.round(RESOURCE_IDS.reduce((n, r) => n + (c[r] ?? 0), 0) * COST_FACTOR);
}

/**
 * Pick the stronghold site: the farthest valid, connected spot within the allowed ring around the
 * capital. Deterministic for a given terrain, so every new game on a seed has the same rival.
 */
export function findEnemySite(state: GameState, terrain: Terrain, nav: NavGrid): { x: number; z: number } | null {
  const cap = capitalCenter(terrain.size);
  const probeFrom = nearestWalkable(nav, cap.x, cap.z + 10) ?? cap;
  let best: { x: number; z: number; d: number } | null = null;
  for (let z = 6; z < terrain.size - 6; z += 2) {
    for (let x = 6; x < terrain.size - 6; x += 2) {
      const d = Math.hypot(x - cap.x, z - cap.z);
      if (d < MIN_BASE_DISTANCE || d > MAX_BASE_DISTANCE || (best && d <= best.d)) continue;
      if (!validatePlacement(state, terrain, 'stronghold', x, z).ok) continue;
      const gate = nearestWalkable(nav, x, z + 6);
      if (!gate || !findPath(nav, probeFrom.x, probeFrom.z, gate.x, gate.z)) continue; // must be reachable by land
      best = { x, z, d };
    }
  }
  return best;
}

/** Spawn one rival unit just outside the stronghold gate, or return null when there is no room. */
function spawnAt(state: GameState, nav: NavGrid, fort: BuildingState, kind: UnitKind, slot: number): UnitState | null {
  const def = BUILDING_DEFS.stronghold;
  const worker = kind === 'villager';
  const row = worker ? 3.2 : 1.5; // workers stand further out so soldiers do not trample them
  const spot = nearestWalkable(nav, fort.x0 + (slot % 7) * 1.3 - 0.5, fort.z0 + def.d + row + Math.floor(slot / 7) * 1.3);
  if (!spot || state.units.length >= MAX_UNITS) return null;
  const u = makeUnit(state, kind, spot.x, spot.z, 1);
  state.units.push(u);
  return u;
}

/** Place the enemy stronghold, a small garrison and workforce, and arm the wave timer. Returns false if no site exists. */
export function addEnemyBase(state: GameState, terrain: Terrain, nav: NavGrid, difficulty: Difficulty = 'normal'): boolean {
  if (state.buildings.some((b) => b.type === 'stronghold')) return true;
  const site = findEnemySite(state, terrain, nav);
  if (!site) return false;
  const def = BUILDING_DEFS.stronghold;
  const v = validatePlacement(state, terrain, 'stronghold', site.x, site.z);
  const fort: BuildingState = { id: state.nextId++, type: 'stronghold', x0: v.x0, z0: v.z0, progress: 1 };
  state.buildings.push(fort);
  setBlockedRect(nav, v.x0, v.z0, def.w, def.d, true);
  const c = footprintCenter(def, v.x0, v.z0);
  const guards: UnitKind[] = ['infantry', 'infantry', 'infantry', 'archer', 'archer'];
  guards.forEach((kind, i) => {
    const spot = nearestWalkable(nav, c.x - 3 + i * 1.5, v.z0 + def.d + 1.5);
    if (spot) state.units.push(makeUnit(state, kind, spot.x, spot.z, 1));
  });
  const cfg = DIFFICULTY[difficulty];
  for (let i = 0; i < 4; i++) spawnAt(state, nav, fort, 'villager', i);
  state.ai = {
    wave: 0, nextWave: state.time + cfg.first, difficulty, bank: cfg.startBank,
    raid: [], raidSize: 0, nextBuy: state.time + BUY_INTERVAL, check: state.time + CHECK_INTERVAL,
  };
  return true;
}

/** Nearest player building to a unit, preferring anything over the palace so raids hit the economy first. */
function raidGoal(state: GameState, nav: NavGrid, u: UnitState): { x: number; z: number } | null {
  let best: BuildingState | undefined, bestD = Infinity;
  for (const b of state.buildings) {
    if (buildingTeam(b) !== 0) continue;
    const d = Math.hypot(u.x - (b.x0 + BUILDING_DEFS[b.type].w / 2), u.z - (b.z0 + BUILDING_DEFS[b.type].d / 2)) + (b.type === 'palace' ? 25 : 0);
    if (d < bestD) { bestD = d; best = b; }
  }
  if (!best) return null;
  const def = BUILDING_DEFS[best.type];
  return nearestWalkable(nav, best.x0 + def.w / 2, best.z0 + def.d + 2);
}

function sendTo(nav: NavGrid, u: UnitState, goal: { x: number; z: number }, attackMove: boolean): void {
  u.target = null;
  u.amove = attackMove;
  u.goal = attackMove ? { ...goal } : null;
  const path = findPath(nav, u.x, u.z, goal.x, goal.z);
  u.path = path ?? [];
}

/**
 * The rival's turn. It earns points from its workers, buys more workers and then the soldiers of its next wave,
 * launches the garrison on schedule, steers raids from building to building, and pulls back a losing raid.
 * Deterministic: no randomness, so a seed and a command history always replay the same.
 */
export function stepAi(state: GameState, nav: NavGrid | undefined, dt = 0.05): void {
  const ai = state.ai;
  if (!ai || state.outcome || !nav) return;
  const fort = state.buildings.find((b) => b.type === 'stronghold');
  if (!fort || !state.buildings.some((b) => b.type === 'palace')) return;
  const cfg = DIFFICULTY[ai.difficulty];
  const fc = footprintCenter(BUILDING_DEFS.stronghold, fort.x0, fort.z0);

  let workers = 0;
  const soldiers: UnitState[] = [];
  for (const u of state.units) {
    if (teamOf(u) !== 1 || !isAlive(u)) continue;
    if (u.kind === 'villager') { if (Math.hypot(u.x - fc.x, u.z - fc.z) <= WORKER_RADIUS) workers++; }
    else soldiers.push(u);
  }

  ai.bank = Math.min(BANK_CAP, ai.bank + workers * cfg.perWorker * dt);

  // Spend: workers first, then the soldiers the next wave calls for.
  if (state.time >= ai.nextBuy) {
    const workerGoal = Math.min(MAX_ENEMY_WORKERS, cfg.workers + Math.min(4, ai.wave));
    let buy: UnitKind | null = null;
    if (workers < workerGoal) buy = 'villager';
    else if (soldiers.length < ENEMY_UNIT_CAP) {
      const want = new Map<UnitKind, number>([['infantry', HOME_GUARDS]]);
      for (const k of waveComposition(ai.wave)) want.set(k, (want.get(k) ?? 0) + 1);
      const have = new Map<UnitKind, number>();
      for (const u of soldiers) if (!ai.raid.includes(u.id)) have.set(u.kind, (have.get(u.kind) ?? 0) + 1);
      for (const [k, n] of want) if ((have.get(k) ?? 0) < n) { buy = k; break; }
    }
    if (buy && ai.bank >= aiCost(buy) && spawnAt(state, nav, fort, buy, state.units.length)) {
      ai.bank -= aiCost(buy);
      ai.nextBuy = state.time + BUY_INTERVAL;
    } else ai.nextBuy = state.time + 1;
  }

  // Review the raid in the field: steer idle soldiers to the next target, or retreat a losing raid.
  if (state.time >= ai.check) {
    ai.check = state.time + CHECK_INTERVAL;
    const out = state.units.filter((u) => ai.raid.includes(u.id) && isAlive(u));
    ai.raid = out.map((u) => u.id);
    if (ai.raidSize >= 4 && out.length < ai.raidSize * RETREAT_FRACTION) {
      const home = nearestWalkable(nav, fc.x, fort.z0 + BUILDING_DEFS.stronghold.d + 2);
      if (home) for (const u of out) sendTo(nav, u, home, false);
      ai.raid = []; ai.raidSize = 0; // the survivors rejoin the garrison
    } else {
      for (const u of out) {
        if (u.path.length > 0 || u.target != null) continue;
        const goal = raidGoal(state, nav, u);
        if (goal) sendTo(nav, u, goal, true);
      }
    }
  }

  if (state.time < ai.nextWave) return;
  const garrison = soldiers.filter((u) => !ai.raid.includes(u.id)).sort((a, b) => a.id - b.id);
  const stay = garrison.length >= HOME_GUARDS + MIN_RAID ? HOME_GUARDS : 0;
  const launching = garrison.slice(stay);
  if (launching.length < MIN_RAID) { ai.nextWave = state.time + 10; return; } // too weak: gather more first
  for (const u of launching) {
    const goal = raidGoal(state, nav, u);
    if (goal) sendTo(nav, u, goal, true);
  }
  ai.raid = [...ai.raid, ...launching.map((u) => u.id)];
  ai.raidSize = ai.raid.length;
  ai.wave++;
  ai.nextWave = state.time + waveInterval(ai.wave) * cfg.interval;
}

export type { AiState };
