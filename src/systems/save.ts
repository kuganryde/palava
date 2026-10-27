import {
  BUILDING_DEFS, MAX_BUILDINGS, MAX_UNITS, RESOURCE_CAP, RESOURCE_IDS, UNIT_DEFS,
  type BuildingType, type UnitKind,
} from '../core/defs';
import { clamp } from '../core/math';
import { emptyResources, type BuildingState, type GameState, type UnitState } from '../core/state';

/** Minimal Storage contract so tests can inject an in-memory implementation. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type SaveSlot = 'autosave' | 'manual';
export type LoadResult = { ok: true; state: GameState; savedAt: number } | { ok: false; error: string };
export type SaveResult = { ok: true; savedAt: number } | { ok: false; error: string };

const KEY_PREFIX = 'palava.save.v1.';
const MAX_SAVE_BYTES = 2_000_000; // refuse absurdly large payloads before parsing
const MAX_PATH_POINTS = 512;

export function serializeState(state: GameState, savedAt = Date.now()): string {
  const slim = {
    ...state,
    units: state.units.map((u) => ({ id: u.id, kind: u.kind, x: u.x, z: u.z, facing: u.facing, hp: u.hp, path: u.path })),
  };
  return JSON.stringify({ v: 1, savedAt, state: slim });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Parse and *validate* save data. Saves live in user-editable localStorage, so
 * nothing is trusted: unknown types, NaN, out-of-range values and oversized
 * arrays are rejected or clamped before they can reach the simulation.
 */
export function parseSave(raw: string, mapSize: number): LoadResult {
  if (raw.length > MAX_SAVE_BYTES) return { ok: false, error: 'Save data is too large' };
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { ok: false, error: 'Save data is corrupted' }; }
  if (!isObj(data) || data.v !== 1 || !isObj(data.state)) return { ok: false, error: 'Unsupported save version' };
  const s = data.state;
  const savedAt = num(data.savedAt) ?? 0;

  const seed = num(s.seed);
  const time = num(s.time);
  if (seed === null || time === null || time < 0) return { ok: false, error: 'Save data is invalid' };

  const resources = emptyResources();
  if (!isObj(s.resources)) return { ok: false, error: 'Save data is invalid' };
  for (const r of RESOURCE_IDS) {
    const v = num(s.resources[r]);
    if (v === null) return { ok: false, error: 'Save data is invalid' };
    resources[r] = clamp(v, 0, RESOURCE_CAP);
  }

  if (!Array.isArray(s.buildings) || s.buildings.length > MAX_BUILDINGS) return { ok: false, error: 'Save data is invalid' };
  const buildings: BuildingState[] = [];
  const ids = new Set<number>();
  for (const b of s.buildings) {
    if (!isObj(b)) return { ok: false, error: 'Save data is invalid' };
    const id = num(b.id), x0 = num(b.x0), z0 = num(b.z0), progress = num(b.progress);
    const type = b.type as BuildingType;
    if (id === null || x0 === null || z0 === null || progress === null || !Number.isInteger(id) || !Number.isInteger(x0) || !Number.isInteger(z0)) {
      return { ok: false, error: 'Save data is invalid' };
    }
    // hasOwn: a plain lookup would accept "__proto__" / "constructor" from tampered saves.
    const def = typeof type === 'string' && Object.hasOwn(BUILDING_DEFS, type) ? BUILDING_DEFS[type] : undefined;
    if (!def || ids.has(id)) return { ok: false, error: 'Save data is invalid' };
    if (x0 < 0 || z0 < 0 || x0 + def.w > mapSize || z0 + def.d > mapSize) return { ok: false, error: 'Save data is invalid' };
    ids.add(id);
    buildings.push({ id, type, x0, z0, progress: clamp(progress, 0, 1) });
  }

  if (!Array.isArray(s.units) || s.units.length > MAX_UNITS) return { ok: false, error: 'Save data is invalid' };
  const units: UnitState[] = [];
  for (const u of s.units) {
    if (!isObj(u)) return { ok: false, error: 'Save data is invalid' };
    const id = num(u.id), x = num(u.x), z = num(u.z), hp = num(u.hp), facing = num(u.facing) ?? 0;
    const kind = u.kind as UnitKind;
    const def = typeof kind === 'string' && Object.hasOwn(UNIT_DEFS, kind) ? UNIT_DEFS[kind] : undefined;
    if (id === null || x === null || z === null || hp === null || !Number.isInteger(id) || !def || ids.has(id)) {
      return { ok: false, error: 'Save data is invalid' };
    }
    ids.add(id);
    const path: { x: number; z: number }[] = [];
    if (Array.isArray(u.path)) {
      for (const p of u.path.slice(0, MAX_PATH_POINTS)) {
        if (isObj(p)) {
          const px = num(p.x), pz = num(p.z);
          if (px !== null && pz !== null) path.push({ x: clamp(px, 0, mapSize - 1), z: clamp(pz, 0, mapSize - 1) });
        }
      }
    }
    const cx = clamp(x, 0, mapSize - 1), cz = clamp(z, 0, mapSize - 1);
    units.push({ id, kind, x: cx, z: cz, px: cx, pz: cz, facing, hp: clamp(hp, 1, def.hp), path });
  }

  const maxId = Math.max(0, ...ids);
  const nextId = Math.max(num(s.nextId) ?? 0, maxId + 1);
  return { ok: true, savedAt, state: { version: 1, seed, time, resources, buildings, units, nextId } };
}

export class SaveStore {
  constructor(private readonly store: KeyValueStore | null, private readonly mapSize: number) {}

  save(slot: SaveSlot, state: GameState): SaveResult {
    if (!this.store) return { ok: false, error: 'Local storage is unavailable' };
    const savedAt = Date.now();
    try {
      this.store.setItem(KEY_PREFIX + slot, serializeState(state, savedAt));
      return { ok: true, savedAt };
    } catch {
      return { ok: false, error: 'Could not write save (storage full or blocked)' };
    }
  }

  load(slot: SaveSlot): LoadResult {
    if (!this.store) return { ok: false, error: 'Local storage is unavailable' };
    let raw: string | null;
    try { raw = this.store.getItem(KEY_PREFIX + slot); } catch { return { ok: false, error: 'Local storage is unavailable' }; }
    if (raw === null) return { ok: false, error: 'No saved game found' };
    return parseSave(raw, this.mapSize);
  }

  has(slot: SaveSlot): boolean {
    try { return this.store?.getItem(KEY_PREFIX + slot) != null; } catch { return false; }
  }

  clear(slot: SaveSlot): void {
    try { this.store?.removeItem(KEY_PREFIX + slot); } catch { /* ignore */ }
  }
}

/** localStorage can throw on access (privacy modes, sandboxed iframes), so probe it safely. */
export function safeLocalStorage(): KeyValueStore | null {
  try {
    const ls = globalThis.localStorage;
    const probe = '__palava_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}
