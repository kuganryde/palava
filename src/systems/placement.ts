import { BUILDING_DEFS, MAX_BUILDINGS, type BuildingDef, type BuildingType } from '../core/defs';
import { canAfford, type GameState } from '../core/state';
import { cellHeight, WATER_LEVEL, type Terrain } from '../world/terrain';

export type PlacementReason =
  | 'ok' | 'out-of-bounds' | 'water' | 'too-steep' | 'overlap' | 'unaffordable' | 'unique' | 'unit-in-way' | 'limit';

export interface PlacementResult {
  ok: boolean;
  reason: PlacementReason;
  x0: number;
  z0: number;
}

export const PLACEMENT_MESSAGES: Record<PlacementReason, string> = {
  ok: 'Ready to build',
  'out-of-bounds': 'Too close to the map edge',
  water: 'Cannot build on water or shoreline',
  'too-steep': 'Ground is too steep',
  overlap: 'Blocked by another building',
  unaffordable: 'Not enough resources',
  unique: 'Only one of these is allowed',
  'unit-in-way': 'Units are in the way',
  limit: 'Building limit reached',
};

const MAX_FOOTPRINT_SLOPE = 1.1; // max height range across the footprint
const MIN_SPACING = 1; // free cells kept between buildings so units can path between them
const EDGE_MARGIN = 3;

/** Snap a world position to the footprint origin cell so the cursor is at the footprint centre. */
export function footprintOrigin(def: BuildingDef, wx: number, wz: number): { x0: number; z0: number } {
  return { x0: Math.round(wx - (def.w - 1) / 2), z0: Math.round(wz - (def.d - 1) / 2) };
}

export function footprintCenter(def: BuildingDef, x0: number, z0: number): { x: number; z: number } {
  return { x: x0 + (def.w - 1) / 2, z: z0 + (def.d - 1) / 2 };
}

export function validatePlacement(
  state: GameState, terrain: Terrain, type: BuildingType, wx: number, wz: number,
): PlacementResult {
  const def = BUILDING_DEFS[type];
  const { x0, z0 } = footprintOrigin(def, wx, wz);
  const fail = (reason: PlacementReason): PlacementResult => ({ ok: false, reason, x0, z0 });

  if (!Number.isFinite(wx) || !Number.isFinite(wz)) return fail('out-of-bounds');
  if (x0 < EDGE_MARGIN || z0 < EDGE_MARGIN || x0 + def.w - 1 > terrain.size - 1 - EDGE_MARGIN || z0 + def.d - 1 > terrain.size - 1 - EDGE_MARGIN) {
    return fail('out-of-bounds');
  }
  if (state.buildings.length >= MAX_BUILDINGS) return fail('limit');
  if (def.unique && state.buildings.some((b) => b.type === type)) return fail('unique');

  let minH = Infinity, maxH = -Infinity;
  for (let z = z0; z < z0 + def.d; z++) {
    for (let x = x0; x < x0 + def.w; x++) {
      const h = cellHeight(terrain, x, z);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  if (minH <= WATER_LEVEL + 0.3) return fail('water');
  if (maxH - minH > MAX_FOOTPRINT_SLOPE) return fail('too-steep');

  for (const b of state.buildings) {
    const o = BUILDING_DEFS[b.type];
    const apartX = x0 > b.x0 + o.w - 1 + MIN_SPACING || b.x0 > x0 + def.w - 1 + MIN_SPACING;
    const apartZ = z0 > b.z0 + o.d - 1 + MIN_SPACING || b.z0 > z0 + def.d - 1 + MIN_SPACING;
    if (!(apartX || apartZ)) return fail('overlap');
  }
  for (const u of state.units) {
    if (u.x > x0 - 0.8 && u.x < x0 + def.w - 0.2 && u.z > z0 - 0.8 && u.z < z0 + def.d - 0.2) return fail('unit-in-way');
  }
  if (!canAfford(state.resources, def.cost)) return fail('unaffordable');
  return { ok: true, reason: 'ok', x0, z0 };
}
