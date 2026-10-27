import { describe, expect, it } from 'vitest';
import { generateTerrain } from '../src/world/terrain';
import { createNewGame, commandMove, stepSimulation } from '../src/systems/simulation';
import { parseSave, SaveStore, serializeState, type KeyValueStore } from '../src/systems/save';
import { AdaptiveResolution } from '../src/systems/adaptive';
import { boxSelect, mergeSelection, pickNearest } from '../src/systems/selection';
import { defaultSettings, loadSettings, saveSettings } from '../src/systems/settings';

class MemStore implements KeyValueStore {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

const terrain = generateTerrain(1337);

describe('save / load', () => {
  it('round-trips state, including paths and construction progress', () => {
    const { state, nav } = createNewGame(terrain);
    commandMove(state, nav, state.units.map((u) => u.id), { x: 60, z: 90 }, 'line');
    for (let i = 0; i < 30; i++) stepSimulation(state, 0.05);
    state.resources.gold = 123.5;
    const store = new SaveStore(new MemStore(), terrain.size);
    expect(store.save('manual', state).ok).toBe(true);
    expect(store.has('manual')).toBe(true);
    const loaded = store.load('manual');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.resources.gold).toBeCloseTo(123.5, 6);
    expect(loaded.state.units).toHaveLength(state.units.length);
    expect(loaded.state.units[0]!.x).toBeCloseTo(state.units[0]!.x, 6);
    expect(loaded.state.units[0]!.path.length).toBe(state.units[0]!.path.length);
    expect(loaded.state.units[0]!.px).toBe(loaded.state.units[0]!.x); // interpolation reset
    expect(loaded.state.nextId).toBeGreaterThan(Math.max(...loaded.state.units.map((u) => u.id)));
  });

  it('a loaded game continues identically to the original', () => {
    const { state, nav } = createNewGame(terrain);
    commandMove(state, nav, state.units.map((u) => u.id), { x: 70, z: 85 }, 'wedge');
    for (let i = 0; i < 40; i++) stepSimulation(state, 0.05);
    const loaded = parseSave(serializeState(state), terrain.size);
    if (!loaded.ok) throw new Error(loaded.error);
    for (let i = 0; i < 100; i++) { stepSimulation(state, 0.05); stepSimulation(loaded.state, 0.05); }
    state.units.forEach((u, i) => {
      expect(loaded.state.units[i]!.x).toBeCloseTo(u.x, 5);
      expect(loaded.state.units[i]!.z).toBeCloseTo(u.z, 5);
    });
  });

  it('reports missing, corrupt, wrong-version and tampered saves without throwing', () => {
    const s = new SaveStore(new MemStore(), terrain.size);
    expect(s.load('manual')).toEqual({ ok: false, error: 'No saved game found' });
    expect(parseSave('{not json', 128).ok).toBe(false);
    expect(parseSave(JSON.stringify({ v: 2 }), 128).ok).toBe(false);
    expect(parseSave('null', 128).ok).toBe(false);
    const { state } = createNewGame(terrain);
    const good = JSON.parse(serializeState(state));
    const bad = (mut: (d: any) => void) => { const d = structuredClone(good); mut(d); return parseSave(JSON.stringify(d), 128).ok; };
    expect(bad((d) => { d.state.resources.gold = 'lots'; })).toBe(false);
    expect(bad((d) => { d.state.units[0].kind = 'dragon'; })).toBe(false);
    expect(bad((d) => { d.state.buildings[0].type = '__proto__'; })).toBe(false);
    expect(bad((d) => { d.state.buildings[0].x0 = 500; })).toBe(false);
    expect(bad((d) => { d.state.units[1].id = d.state.units[0].id; })).toBe(false);
    expect(bad((d) => { d.state.units = new Array(5000).fill(d.state.units[0]); })).toBe(false);
    expect(parseSave('x'.repeat(2_100_000), 128).ok).toBe(false);
  });

  it('clamps out-of-range values instead of trusting them', () => {
    const { state } = createNewGame(terrain);
    const d = JSON.parse(serializeState(state));
    d.state.resources.gold = 9e9;
    d.state.resources.food = -50;
    d.state.units[0].x = 1e9;
    d.state.units[0].hp = 1e9;
    d.state.units[0].path = [{ x: 'a', z: 1 }, { x: 5, z: -1e6 }];
    const r = parseSave(JSON.stringify(d), 128);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.resources.gold).toBe(2000);
    expect(r.state.resources.food).toBe(0);
    expect(r.state.units[0]!.x).toBe(127);
    expect(r.state.units[0]!.hp).toBeLessThanOrEqual(100);
    expect(r.state.units[0]!.path).toEqual([{ x: 5, z: 0 }]);
  });

  it('handles unavailable or failing storage', () => {
    const { state } = createNewGame(terrain);
    expect(new SaveStore(null, 128).save('manual', state)).toEqual({ ok: false, error: 'Local storage is unavailable' });
    const full: KeyValueStore = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); }, removeItem: () => {} };
    expect(new SaveStore(full, 128).save('autosave', state).ok).toBe(false);
    const throwing: KeyValueStore = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => {}, removeItem: () => {} };
    expect(new SaveStore(throwing, 128).load('autosave').ok).toBe(false);
    expect(new SaveStore(throwing, 128).has('autosave')).toBe(false);
  });
});

describe('selection', () => {
  const items = [{ id: 1, sx: 10, sy: 10 }, { id: 2, sx: 50, sy: 50 }, { id: 3, sx: 90, sy: 20 }];
  it('box select works in any drag direction', () => {
    expect(boxSelect(items, 0, 0, 60, 60)).toEqual([1, 2]);
    expect(boxSelect(items, 60, 60, 0, 0)).toEqual([1, 2]);
    expect(boxSelect(items, 200, 200, 300, 300)).toEqual([]);
  });
  it('pickNearest respects the radius and picks the closest', () => {
    expect(pickNearest(items, 52, 52, 10)).toBe(2);
    expect(pickNearest(items, 70, 70, 10)).toBeNull();
    expect(pickNearest(items, 11, 11, 100)).toBe(1);
  });
  it('shift-click adds, toggles a single, and plain click replaces', () => {
    expect([...mergeSelection(new Set([1]), [2], false)]).toEqual([2]);
    expect([...mergeSelection(new Set([1]), [2], true)].sort()).toEqual([1, 2]);
    expect([...mergeSelection(new Set([1, 2]), [2], true)]).toEqual([1]);
    expect([...mergeSelection(new Set([1]), [2, 3], true)].sort()).toEqual([1, 2, 3]);
  });
});

describe('adaptive resolution & settings', () => {
  it('scales down on slow frames, recovers on fast ones, and stays within bounds', () => {
    const a = new AdaptiveResolution(0.5, 1, 16.7);
    for (let i = 0; i < 600; i++) a.update(40);
    expect(a.scale).toBe(0.5);
    for (let i = 0; i < 2000; i++) a.update(8);
    expect(a.scale).toBe(1);
    expect(a.update(NaN)).toBe(1);
    expect(a.update(-3)).toBe(1);
  });
  it('does not oscillate inside the dead band', () => {
    const a = new AdaptiveResolution(0.5, 1, 16.7);
    for (let i = 0; i < 600; i++) a.update(16.7);
    expect(a.scale).toBe(1);
  });
  it('persists settings and rejects invalid stored values', () => {
    const m = new MemStore();
    const d = defaultSettings();
    saveSettings(m, { ...d, quality: 'high', shadows: false });
    expect(loadSettings(m, d)).toMatchObject({ quality: 'high', shadows: false });
    m.setItem('palava.settings.v1', JSON.stringify({ quality: 'ultra', shadows: 'yes' }));
    expect(loadSettings(m, d)).toEqual(d);
    m.setItem('palava.settings.v1', '{bad');
    expect(loadSettings(m, d)).toEqual(d);
    expect(loadSettings(null, d)).toEqual(d);
  });
});
