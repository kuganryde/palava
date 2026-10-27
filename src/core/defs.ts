/** Static game data. Tuning lives here so systems stay free of magic numbers. */

export const RESOURCE_IDS = ['food', 'timber', 'stone', 'iron', 'gold'] as const;
export type ResourceId = (typeof RESOURCE_IDS)[number];
export type Resources = Record<ResourceId, number>;

export const RESOURCE_CAP = 2000;
export const MAX_UNITS = 200; // hard entity limit (also sizes the instanced meshes)
export const MAX_BUILDINGS = 120;
export const SIM_STEP = 0.05; // fixed 20 Hz simulation timestep (seconds)

export type BuildingType = 'palace' | 'temple' | 'barracks' | 'farm' | 'lumber' | 'quarry' | 'stronghold';

export interface BuildingDef {
  type: BuildingType;
  name: string;
  description: string;
  w: number; // footprint in grid cells (x)
  d: number; // footprint in grid cells (z)
  cost: Partial<Resources>;
  buildTime: number; // seconds
  produces: Partial<Resources>; // per second once complete
  housing: number; // population capacity contributed once complete
  /** Hit points; a building at 0 is destroyed. */
  hp: number;
  unique?: boolean;
}

export const BUILDING_DEFS: Record<BuildingType, BuildingDef> = {
  palace: {
    type: 'palace', name: 'Palace', description: 'Seat of the Pallava ruler. Collects royal tribute.',
    w: 6, d: 6, cost: {}, buildTime: 1, produces: { gold: 0.6 }, housing: 20, hp: 1500, unique: true,
  },
  temple: {
    type: 'temple', name: 'Temple', description: 'Stone vimana. Offerings yield gold.',
    w: 5, d: 5, cost: { stone: 120, gold: 80 }, buildTime: 25, produces: { gold: 0.4 }, housing: 4, hp: 500,
  },
  barracks: {
    type: 'barracks', name: 'Barracks', description: 'Recruit infantry and archers.',
    w: 4, d: 3, cost: { timber: 100, stone: 40 }, buildTime: 18, produces: {}, housing: 6, hp: 450,
  },
  farm: {
    type: 'farm', name: 'Farm', description: 'Paddy fields producing food.',
    w: 4, d: 4, cost: { timber: 60 }, buildTime: 10, produces: { food: 1.2 }, housing: 2, hp: 250,
  },
  lumber: {
    type: 'lumber', name: 'Lumber Camp', description: 'Fells timber.',
    w: 3, d: 3, cost: { timber: 30, gold: 10 }, buildTime: 8, produces: { timber: 1.0 }, housing: 0, hp: 200,
  },
  quarry: {
    type: 'quarry', name: 'Quarry', description: 'Cuts sandstone and granite.',
    w: 3, d: 3, cost: { timber: 50 }, buildTime: 12, produces: { stone: 0.8 }, housing: 0, hp: 250,
  },
  stronghold: {
    type: 'stronghold', name: 'Enemy Stronghold', description: 'The rival kingdom\'s fortress. Destroy it to win.',
    w: 7, d: 7, cost: {}, buildTime: 1, produces: {}, housing: 0, hp: 1400, unique: true,
  },
};

/** Order shown in the build menu; index+1 is the hotkey. */
export const BUILDABLE: readonly BuildingType[] = ['temple', 'barracks', 'farm', 'lumber', 'quarry'];

export type UnitKind = 'infantry' | 'archer' | 'villager' | 'commander' | 'cavalry' | 'elephant';
export const UNIT_KINDS: readonly UnitKind[] = ['infantry', 'archer', 'villager', 'commander', 'cavalry', 'elephant'];

export interface UnitDef {
  kind: UnitKind;
  name: string;
  cost: Partial<Resources>;
  speed: number; // cells per second
  hp: number;
  range: number; // reserved for Phase 3 combat
  damage: number; // reserved for Phase 3 combat
  /** Body radius in cells: sets formation spacing so large animals are not packed like infantry. */
  radius: number;
  /** Seconds between attacks. */
  attackInterval: number;
  /** The building type that trains this unit. */
  trainedAt: BuildingType;
}

export const UNIT_DEFS: Record<UnitKind, UnitDef> = {
  infantry: { kind: 'infantry', name: 'Sword Warrior', cost: { food: 50, gold: 20 }, speed: 3.2, hp: 100, range: 1.5, damage: 12, radius: 0.35, attackInterval: 1.0, trainedAt: 'barracks' },
  archer: { kind: 'archer', name: 'Archer', cost: { food: 40, timber: 30 }, speed: 3.4, hp: 70, range: 9, damage: 8, radius: 0.35, attackInterval: 1.4, trainedAt: 'barracks' },
  villager: { kind: 'villager', name: 'Villager', cost: { food: 40 }, speed: 2.8, hp: 40, range: 1, damage: 2, radius: 0.3, attackInterval: 1.2, trainedAt: 'palace' },
  commander: { kind: 'commander', name: 'Commander', cost: { food: 80, gold: 60 }, speed: 3.4, hp: 160, range: 1.6, damage: 16, radius: 0.4, attackInterval: 0.9, trainedAt: 'palace' },
  cavalry: { kind: 'cavalry', name: 'Cavalry', cost: { food: 80, timber: 50, gold: 30 }, speed: 5.2, hp: 140, range: 1.8, damage: 14, radius: 0.7, attackInterval: 0.9, trainedAt: 'barracks' },
  elephant: { kind: 'elephant', name: 'War Elephant', cost: { food: 150, timber: 60, gold: 120 }, speed: 2.6, hp: 400, range: 1.8, damage: 30, radius: 1.2, attackInterval: 1.6, trainedAt: 'barracks' },
};

/** Units each building can train, in menu order. */
export const TRAINABLE: Partial<Record<BuildingType, readonly UnitKind[]>> = {
  barracks: ['infantry', 'archer', 'cavalry', 'elephant'],
  palace: ['villager', 'commander'],
};

/** Spacing for a group: at least the default, wider when large units are present. */
export function formationSpacing(kinds: Iterable<UnitKind>): number {
  let r = 0;
  for (const k of kinds) r = Math.max(r, UNIT_DEFS[k].radius);
  return Math.max(1.6, r * 2.3);
}

export const START_RESOURCES: Resources = { food: 300, timber: 300, stone: 150, iron: 0, gold: 200 };
