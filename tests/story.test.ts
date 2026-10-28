import { describe, expect, it } from 'vitest';
import { SIM_STEP } from '../src/core/defs';
import { workersOnSite, type GameState } from '../src/core/state';
import { parseSave, serializeState } from '../src/systems/save';
import { addEnemyBase } from '../src/systems/enemyAi';
import { createNewGame, makeUnit, placeBuilding, stepSimulation } from '../src/systems/simulation';
import { INTRO_LINES, INTRO_SECONDS, TITLE_FROM, introShot, lineAt, revealed } from '../src/story/intro';
import { BEATS, beatById, isBeatId, markSeen, newBeats } from '../src/story/story';
import { capitalCenter, generateTerrain } from '../src/world/terrain';

const terrain = generateTerrain(1337);
function world(): { state: GameState; nav: ReturnType<typeof createNewGame>['nav'] } {
  const w = createNewGame(terrain);
  addEnemyBase(w.state, terrain, w.nav);
  return w;
}
const ids = (s: GameState) => newBeats(s).map((b) => b.id);

describe('story beats', () => {
  it('have unique ids, titles and text, with no HTML', () => {
    expect(new Set(BEATS.map((b) => b.id)).size).toBe(BEATS.length);
    for (const b of BEATS) { expect(b.title.length).toBeGreaterThan(2); expect(b.text.length).toBeGreaterThan(20); expect(b.text + b.title).not.toMatch(/[<>]/); }
  });

  it('nothing fires at the start of a new game', () => {
    expect(ids(world().state)).toEqual([]);
  });

  it('founding fires when the first building is finished, once only', () => {
    const { state, nav } = world();
    state.resources.timber = 1000;
    const c = capitalCenter(terrain.size);
    let farm;
    for (const dx of [14, -14, 18, -18]) { const r = placeBuilding(state, terrain, nav, 'farm', c.x + dx, c.z + 4); if (r.ok) { farm = r.building!; break; } }
    expect(ids(state)).toEqual([]); // under construction
    farm!.progress = 1;
    expect(ids(state)).toContain('founding');
    markSeen(state, newBeats(state));
    expect(ids(state)).toEqual([]);
    markSeen(state, [beatById('founding')!]);
    expect(state.story!.filter((x) => x === 'founding').length).toBe(1); // idempotent
  });

  it('harvest, raid and standing follow the economy and the rival', () => {
    const { state, nav } = world();
    state.resources.timber = 2000;
    const c = capitalCenter(terrain.size);
    const spots = [14, -14, 18, -18];
    let farm;
    for (const dx of spots) { const r = placeBuilding(state, terrain, nav, 'farm', c.x + dx, c.z + 4); if (r.ok) { farm = r.building!; break; } }
    farm!.progress = 1;
    for (let i = 0; i < 40 / SIM_STEP; i++) stepSimulation(state, SIM_STEP, nav);
    expect(workersOnSite(state, farm!)).toBe(3);
    expect(ids(state)).toContain('harvest');
    expect(ids(state)).not.toContain('raid');
    state.time = state.ai!.nextWave; // launch the first raid
    for (let i = 0; i < 5 / SIM_STEP; i++) stepSimulation(state, SIM_STEP, nav);
    expect(ids(state)).toContain('raid');
    expect(ids(state)).not.toContain('standing'); // raiders still out
    state.ai!.raid = [];
    expect(ids(state)).toContain('standing');
  });

  it('march fires when soldiers are far from the palace; siege when the stronghold is hurt', () => {
    const { state } = world();
    const far = makeUnit(state, 'infantry', 5, 5, 0);
    state.units.push(far);
    expect(ids(state)).toContain('march');
    const fort = state.buildings.find((b) => b.type === 'stronghold')!;
    expect(ids(state)).not.toContain('siege');
    fort.hp = 100;
    expect(ids(state)).toContain('siege');
  });

  it('victory and fall fire from the outcome', () => {
    const { state } = world();
    state.outcome = 'victory';
    expect(ids(state)).toContain('victory');
    expect(ids(state)).not.toContain('fall');
    state.outcome = 'defeat';
    expect(ids(state)).toContain('fall');
  });

  it('are saved, and unknown or tampered ids are dropped on load', () => {
    const { state } = world();
    markSeen(state, [beatById('founding')!, beatById('raid')!]);
    const back = parseSave(serializeState(state), terrain.size);
    expect(back.ok && back.state.story).toEqual(['founding', 'raid']);
    const raw = JSON.parse(serializeState(state));
    raw.state.story = ['founding', '__proto__', 7, 'founding', '<img src=x>', 'siege'];
    const bad = parseSave(JSON.stringify(raw), terrain.size);
    expect(bad.ok && bad.state.story).toEqual(['founding', 'siege']);
    expect(isBeatId('raid')).toBe(true);
    expect(isBeatId('nope')).toBe(false);
  });
});

describe('intro timeline', () => {
  const cap = { x: 70, z: 80 }, fort = { x: 120, z: 30 };
  it('lines are ordered, non-overlapping and end before the title card', () => {
    for (let i = 0; i < INTRO_LINES.length; i++) {
      const l = INTRO_LINES[i]!;
      expect(l.to).toBeGreaterThan(l.from);
      if (i > 0) expect(l.from).toBeGreaterThanOrEqual(INTRO_LINES[i - 1]!.to);
    }
    expect(INTRO_LINES.at(-1)!.to).toBeLessThanOrEqual(TITLE_FROM);
    expect(TITLE_FROM).toBeLessThan(INTRO_SECONDS);
    expect(lineAt(0)).toBeNull();
    expect(lineAt(2)?.text).toBe(INTRO_LINES[0]!.text);
    expect(lineAt(INTRO_SECONDS)).toBeNull();
  });
  it('the camera moves continuously and ends looking toward the rival', () => {
    let prev = introShot(0, cap, fort, false);
    for (let t = 0.1; t <= INTRO_SECONDS; t += 0.1) {
      const s = introShot(t, cap, fort, false);
      expect(Math.hypot(s.x - prev.x, s.z - prev.z)).toBeLessThan(2);
      expect(Math.abs(s.zoom - prev.zoom)).toBeLessThan(0.3);
      prev = s;
    }
    const end = introShot(INTRO_SECONDS, cap, fort, false);
    expect(Math.hypot(end.x - fort.x, end.z - fort.z)).toBeLessThan(Math.hypot(cap.x - fort.x, cap.z - fort.z));
  });
  it('holds still with reduced motion and copes with no rival', () => {
    expect(introShot(3, cap, fort, true)).toEqual(introShot(20, cap, fort, true));
    expect(Number.isFinite(introShot(20, cap, null, false).x)).toBe(true);
  });
  it('typewriter reveals progressively or instantly', () => {
    expect(revealed('abcdef', 0, false)).toBe('');
    expect(revealed('abcdef', 0.1, false, 30)).toBe('abc');
    expect(revealed('abcdef', 99, false)).toBe('abcdef');
    expect(revealed('abcdef', 0, true)).toBe('abcdef');
  });
});
