import {
  BUILDING_DEFS, IDLE_TRICKLE, RESOURCE_IDS, START_RESOURCES, WORK_RADIUS,
  type BuildingType, type ResourceId, type Resources, type UnitKind,
} from './defs';

export interface BuildingState {
  id: number;
  type: BuildingType;
  x0: number; // footprint origin cell
  z0: number;
  progress: number; // 0..1, complete at 1
  /** Current hit points; missing means full health (def.hp). */
  hp?: number;
}

export type Team = 0 | 1; // 0 = player, 1 = enemy

/** One resolved attack, kept briefly so the renderer can show arrows, hits and deaths. Never saved. */
export interface CombatEvent { t: number; from: number; to: number; ranged: boolean; killed: boolean }

export interface UnitState {
  id: number;
  kind: UnitKind;
  x: number;
  z: number;
  px: number; // position at the start of the last sim step (render interpolation only)
  pz: number;
  facing: number; // radians about +Y
  hp: number;
  path: { x: number; z: number }[];
  /** Attack-move: keep acquiring enemies while travelling to `goal`. */
  amove?: boolean;
  goal?: { x: number; z: number } | null;
  /** Owner. Missing means the player (units created before combat existed). */
  team?: Team;
  /** Unit id being attacked, if any. */
  target?: number | null;
  /** Seconds until the next attack is allowed. */
  cooldown?: number;
  /** Seconds until the next re-path toward a moving target. */
  repath?: number;
  /** Seconds until the next scan for enemies while idle. */
  scan?: number;
  /** Sim time of death; the corpse is removed shortly after. */
  diedAt?: number;
  /** Villagers: id of the building they work at. */
  work?: number | null;
  /** Villagers: player-controlled; never auto-assigned until given a work order. */
  hold?: boolean;
}

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];

export interface AiState {
  /** Index of the next raid wave. */
  wave: number;
  /** Sim time at which it launches. */
  nextWave: number;
  difficulty: Difficulty;
  /** Spendable points earned by the rival's workers. */
  bank: number;
  /** Unit ids of the raid currently out in the field, and how many set out. */
  raid: number[];
  raidSize: number;
  /** Earliest sim time of the next purchase and of the next raid review. */
  nextBuy: number;
  check: number;
}

export type Outcome = 'victory' | 'defeat';

export interface GameState {
  version: 2;
  seed: number;
  time: number; // simulated seconds
  resources: Resources;
  buildings: BuildingState[];
  units: UnitState[];
  nextId: number;
  ai?: AiState;
  /** Set once the game is decided; the simulation then stops advancing. */
  outcome?: Outcome;
  /** Recent combat events (transient, not saved). */
  events?: CombatEvent[];
}

export function emptyResources(): Resources {
  return { food: 0, timber: 0, stone: 0, iron: 0, gold: 0 };
}

export function startingResources(): Resources {
  return { ...START_RESOURCES };
}

export function canAfford(res: Resources, cost: Partial<Resources>): boolean {
  return RESOURCE_IDS.every((r) => res[r] >= (cost[r] ?? 0));
}

export function spend(res: Resources, cost: Partial<Resources>): void {
  for (const r of RESOURCE_IDS) res[r] -= cost[r] ?? 0;
}

export function missingResources(res: Resources, cost: Partial<Resources>): ResourceId[] {
  return RESOURCE_IDS.filter((r) => res[r] < (cost[r] ?? 0));
}

export const buildingTeam = (b: BuildingState): Team => (b.type === 'stronghold' ? 1 : 0);
export const buildingHp = (b: BuildingState): number => b.hp ?? BUILDING_DEFS[b.type].hp;
export const teamOf = (u: { team?: Team }): Team => (u.team === 1 ? 1 : 0);
export const isAlive = (u: { hp: number }): boolean => u.hp > 0;

/** Living units of the player's team: corpses and enemies never count against the population cap. */
export function population(state: GameState): number {
  let n = 0;
  for (const u of state.units) if (teamOf(u) === 0 && isAlive(u)) n++;
  return n;
}

/** Capacity from completed buildings. */
export function popCap(state: GameState): number {
  let cap = 0;
  for (const b of state.buildings) if (b.progress >= 1) cap += BUILDING_DEFS[b.type].housing;
  return cap;
}

/** Distance from a point to the nearest point of a building footprint (0 when inside). */
export function distToFootprint(x: number, z: number, b: BuildingState): number {
  const def = BUILDING_DEFS[b.type];
  const cx = Math.min(Math.max(x, b.x0 - 0.5), b.x0 + def.w - 0.5);
  const cz = Math.min(Math.max(z, b.z0 - 0.5), b.z0 + def.d - 0.5);
  return Math.hypot(x - cx, z - cz);
}

/** Living player villagers assigned to `b` and standing at it. */
export function workersOnSite(state: GameState, b: BuildingState): number {
  let n = 0;
  for (const u of state.units) {
    if (u.work === b.id && u.kind === 'villager' && isAlive(u) && teamOf(u) === 0 && distToFootprint(u.x, u.z, b) <= WORK_RADIUS) n++;
  }
  return n;
}

/** Output multiplier for a finished building: full for worker-less buildings, else trickle plus staffing. */
export function productionFactor(state: GameState, b: BuildingState): number {
  const slots = BUILDING_DEFS[b.type].slots;
  if (slots <= 0) return 1;
  return IDLE_TRICKLE + (1 - IDLE_TRICKLE) * Math.min(1, workersOnSite(state, b) / slots);
}

/** Per-second income from completed buildings (before storage caps), scaled by staffing. */
export function incomePerSecond(state: GameState): Resources {
  const out = emptyResources();
  for (const b of state.buildings) {
    if (b.progress < 1 || buildingTeam(b) !== 0) continue;
    const p = BUILDING_DEFS[b.type].produces;
    const f = productionFactor(state, b);
    for (const r of RESOURCE_IDS) out[r] += (p[r] ?? 0) * f;
  }
  return out;
}
