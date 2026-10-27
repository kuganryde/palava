import {
  BUILDING_DEFS, RESOURCE_IDS, START_RESOURCES,
  type BuildingType, type ResourceId, type Resources, type UnitKind,
} from './defs';

export interface BuildingState {
  id: number;
  type: BuildingType;
  x0: number; // footprint origin cell
  z0: number;
  progress: number; // 0..1, complete at 1
}

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
}

export interface GameState {
  version: 1;
  seed: number;
  time: number; // simulated seconds
  resources: Resources;
  buildings: BuildingState[];
  units: UnitState[];
  nextId: number;
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

export function population(state: GameState): number {
  return state.units.length;
}

/** Capacity from completed buildings. */
export function popCap(state: GameState): number {
  let cap = 0;
  for (const b of state.buildings) if (b.progress >= 1) cap += BUILDING_DEFS[b.type].housing;
  return cap;
}

/** Per-second income from completed buildings (before storage caps). */
export function incomePerSecond(state: GameState): Resources {
  const out = emptyResources();
  for (const b of state.buildings) {
    if (b.progress < 1) continue;
    const p = BUILDING_DEFS[b.type].produces;
    for (const r of RESOURCE_IDS) out[r] += p[r] ?? 0;
  }
  return out;
}
