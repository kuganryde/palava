import {
  BUILDING_DEFS, MAX_BUILDINGS, MAX_UNITS, RESOURCE_CAP, RESOURCE_IDS, UNIT_DEFS,
  type BuildingType, type UnitKind,
} from '../core/defs';
import { clamp } from '../core/math';
import { DIFFICULTIES, emptyResources, teamOf, type BuildingState, type Difficulty, type GameState, type UnitState } from '../core/state';

/** Minimal Storage contract so tests can inject an in-memory implementation. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type SaveSlot = 'autosave' | 'manual';
export type LoadResult = { ok: true; state: GameState; savedAt: number } | { ok: false; error: string };
export type SaveResult = { ok: true; savedAt: number } | { ok: false; error: string };

const KEY_PREFIX = 'palava.save.v1.'; // slot keys keep the v1 prefix so older saves are still found and migrated
const MAX_SAVE_BYTES = 2_000_000; // refuse absurdly large payloads before parsing
const MAX_PATH_POINTS = 512;

export function serializeState(state: GameState, savedAt = Date.now()): string {
  const { events: _events, ...rest } = state; // combat events are transient
  const slim = {
    ...rest,
    buildings: state.buildings.map((b) => ({ id: b.id, type: b.type, x0: b.x0, z0: b.z0, progress: b.progress, hp: b.hp })),
    // Corpses are not worth saving; targets/cooldowns are so a fight resumes where it stopped.
    units: state.units.filter((u) => u.hp > 0).map((u) => ({
      id: u.id, kind: u.kind, x: u.x, z: u.z, facing: u.facing, hp: u.hp, path: u.path,
      team: teamOf(u), target: u.target ?? null, cooldown: u.cooldown ?? 0, amove: u.amove === true, goal: u.goal ?? null, work: u.work ?? null, hold: u.hold === true,
    })),
  };
  return JSON.stringify({ v: 2, savedAt, state: slim });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function parsePoint(v: unknown, mapSize: number): { x: number; z: number } | null {
  if (!isObj(v)) return null;
  const x = num(v.x), z = num(v.z);
  return x === null || z === null ? null : { x: clamp(x, 0, mapSize - 1), z: clamp(z, 0, mapSize - 1) };
}
const workId = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
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
  // v1 saves (before combat) load fine: every unit becomes a player unit with no target.
  if (!isObj(data) || (data.v !== 1 && data.v !== 2) || !isObj(data.state)) return { ok: false, error: 'Unsupported save version' };
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
    const hpRaw = num(b.hp);
    buildings.push({ id, type, x0, z0, progress: clamp(progress, 0, 1), ...(hpRaw !== null ? { hp: clamp(hpRaw, 1, def.hp) } : {}) });
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
    const team = u.team === 1 ? 1 : 0;
    const target = num(u.target);
    units.push({
      id, kind, x: cx, z: cz, px: cx, pz: cz, facing, hp: clamp(hp, 1, def.hp), path, team,
      target: target !== null && Number.isInteger(target) ? target : null,
      cooldown: clamp(num(u.cooldown) ?? 0, 0, def.attackInterval), repath: 0, scan: 0,
      amove: u.amove === true, goal: parsePoint(u.goal, mapSize),
      ...(kind === 'villager' ? { work: workId(u.work), hold: u.hold === true } : {}),
    });
  }

  let ai: GameState['ai'];
  if (isObj(s.ai)) {
    const wave = num(s.ai.wave), nextWave = num(s.ai.nextWave);
    if (wave !== null && nextWave !== null) {
      const diff = typeof s.ai.difficulty === 'string' && (DIFFICULTIES as readonly string[]).includes(s.ai.difficulty) ? (s.ai.difficulty as Difficulty) : 'normal';
      // Raid ids must be integers; the list is bounded so a tampered save cannot bloat it.
      const raid = Array.isArray(s.ai.raid) ? s.ai.raid.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0).slice(0, 64) : [];
      ai = {
        wave: clamp(Math.floor(wave), 0, 1000), nextWave: Math.max(0, nextWave), difficulty: diff,
        bank: clamp(num(s.ai.bank) ?? 0, 0, 5000), raid, raidSize: clamp(Math.floor(num(s.ai.raidSize) ?? raid.length), 0, 64),
        nextBuy: Math.max(0, num(s.ai.nextBuy) ?? 0), check: Math.max(0, num(s.ai.check) ?? 0),
      };
    }
  }
  const outcome = s.outcome === 'victory' || s.outcome === 'defeat' ? s.outcome : undefined;
  const maxId = Math.max(0, ...ids);
  const nextId = Math.max(num(s.nextId) ?? 0, maxId + 1);
  return { ok: true, savedAt, state: { version: 2, seed, time, resources, buildings, units, nextId, ...(ai ? { ai } : {}), ...(outcome ? { outcome } : {}) } };
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
