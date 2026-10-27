import { BUILDING_DEFS, MAX_UNITS, type UnitKind } from '../core/defs';
import { teamOf, isAlive, type GameState } from '../core/state';
import { capitalCenter, type Terrain } from '../world/terrain';
import { findPath, nearestWalkable, setBlockedRect, type NavGrid } from './pathfinding';
import { validatePlacement, footprintCenter } from './placement';
import { makeUnit } from './unitFactory';

/** Seconds before the first raid; players get time to build an economy and an army. */
export const FIRST_WAVE_SECONDS = 210;
/** Never keep more than this many living enemy units (performance and fairness cap). */
export const ENEMY_UNIT_CAP = 28;
const MIN_BASE_DISTANCE = 38; // keep the rival well away from the capital
const MAX_BASE_DISTANCE = 64;

/** Raid composition for wave `w` (0-based): grows steadily, adds cavalry from wave 2 and elephants from wave 5. */
export function waveComposition(w: number): UnitKind[] {
  const out: UnitKind[] = [];
  const n = Math.min(3 + w * 2, 14);
  for (let i = 0; i < n; i++) out.push(i % 3 === 2 ? 'archer' : 'infantry');
  if (w >= 2) for (let i = 0; i < Math.min(1 + Math.floor((w - 2) / 2), 4); i++) out.push('cavalry');
  if (w >= 5) for (let i = 0; i < Math.min(1 + Math.floor((w - 5) / 3), 3); i++) out.push('elephant');
  return out;
}

/** Gap between waves shrinks from 80 s to a floor of 45 s. */
export const waveInterval = (w: number): number => Math.max(45, 80 - w * 5);

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

/** Place the enemy stronghold, a small garrison, and arm the wave timer. Returns false if no site exists. */
export function addEnemyBase(state: GameState, terrain: Terrain, nav: NavGrid): boolean {
  if (state.buildings.some((b) => b.type === 'stronghold')) return true;
  const site = findEnemySite(state, terrain, nav);
  if (!site) return false;
  const def = BUILDING_DEFS.stronghold;
  const v = validatePlacement(state, terrain, 'stronghold', site.x, site.z);
  state.buildings.push({ id: state.nextId++, type: 'stronghold', x0: v.x0, z0: v.z0, progress: 1 });
  setBlockedRect(nav, v.x0, v.z0, def.w, def.d, true);
  const c = footprintCenter(def, v.x0, v.z0);
  const guards: UnitKind[] = ['infantry', 'infantry', 'infantry', 'archer', 'archer'];
  guards.forEach((kind, i) => {
    const spot = nearestWalkable(nav, c.x - 3 + i * 1.5, v.z0 + def.d + 1.5);
    if (spot) state.units.push(makeUnit(state, kind, spot.x, spot.z, 1));
  });
  state.ai = { wave: 0, nextWave: state.time + FIRST_WAVE_SECONDS };
  return true;
}

/** Launch waves on schedule. The AI has no economy: it spends time, not resources, so it is simple and predictable. */
export function stepAi(state: GameState, nav: NavGrid | undefined): void {
  const ai = state.ai;
  if (!ai || state.outcome || state.time < ai.nextWave || !nav) return;
  const fort = state.buildings.find((b) => b.type === 'stronghold');
  const palace = state.buildings.find((b) => b.type === 'palace');
  if (!fort || !palace) return;
  const living = state.units.filter((u) => teamOf(u) === 1 && isAlive(u)).length;
  if (living >= ENEMY_UNIT_CAP || state.units.length >= MAX_UNITS) { ai.nextWave = state.time + 10; return; }

  const def = BUILDING_DEFS.stronghold;
  const pdef = BUILDING_DEFS.palace;
  const goal = footprintCenter(pdef, palace.x0, palace.z0);
  const kinds = waveComposition(ai.wave).slice(0, ENEMY_UNIT_CAP - living);
  kinds.forEach((kind, i) => {
    if (state.units.length >= MAX_UNITS) return;
    const spot = nearestWalkable(nav, fort.x0 + (i % 6) * 1.4, fort.z0 + def.d + 1.5 + Math.floor(i / 6) * 1.4);
    if (!spot) return;
    const u = makeUnit(state, kind, spot.x, spot.z, 1);
    u.amove = true; u.goal = { x: goal.x, z: goal.z + pdef.d / 2 + 2 };
    const path = findPath(nav, u.x, u.z, u.goal.x, u.goal.z);
    if (path) u.path = path;
    state.units.push(u);
  });
  ai.wave++;
  ai.nextWave = state.time + waveInterval(ai.wave);
}
