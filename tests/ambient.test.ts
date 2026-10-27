import { describe, expect, it } from 'vitest';
import { ambientMix } from '../src/audio/ambient';
import { defaultSettings, loadSettings } from '../src/systems/settings';

describe('ambient mix', () => {
  it('has birds by day and crickets at night, never both', () => {
    const d = ambientMix(1, 0, 1), n = ambientMix(0, 0, 1);
    expect(d.birds).toBeGreaterThan(0.3); expect(d.crickets).toBe(0);
    expect(n.crickets).toBeGreaterThan(0.9); expect(n.birds).toBe(0);
  });
  it('rain silences birds and crickets and adds rain + wind', () => {
    const w = ambientMix(1, 1, 1), c = ambientMix(1, 0, 1);
    expect(w.birds).toBe(0); expect(w.rain).toBeGreaterThan(0.2); expect(w.wind).toBeGreaterThan(c.wind);
  });
  it('stays finite and in range for garbage input', () => {
    for (const v of [NaN, -3, Infinity, 99]) {
      const m = ambientMix(v, v, v);
      for (const x of Object.values(m)) { expect(Number.isFinite(x)).toBe(true); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
    }
  });
});

describe('sound setting', () => {
  it('defaults on and survives a bad stored value', () => {
    expect(defaultSettings().sound).toBe(true);
    const store = { getItem: () => JSON.stringify({ sound: 'loud' }), setItem: () => undefined, removeItem: () => undefined };
    expect(loadSettings(store as never, defaultSettings()).sound).toBe(true);
  });
});
