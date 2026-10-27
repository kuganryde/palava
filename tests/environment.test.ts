import { describe, expect, it } from 'vitest';
import {
  clockText, computeSky, createSkyState, DAY_LENGTH_SECONDS, START_TIME_OF_DAY, timeOfDay, weatherAt,
  type RGB, type SkyState,
} from '../src/world/environment';

const clear = { rain: 0, mist: 0 };
const sky = (tod: number, w = clear): SkyState => computeSky(createSkyState(), tod, w);
const lum = (c: RGB): number => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
const dist = (a: RGB, b: RGB): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('time of day', () => {
  it('starts in the early morning and wraps once per day', () => {
    expect(timeOfDay(0)).toBeCloseTo(START_TIME_OF_DAY, 6);
    expect(timeOfDay(DAY_LENGTH_SECONDS)).toBeCloseTo(START_TIME_OF_DAY, 6);
    expect(timeOfDay(DAY_LENGTH_SECONDS * 7.25)).toBeCloseTo((START_TIME_OF_DAY + 0.25) % 1, 6);
  });

  it('is safe for negative, NaN and enormous inputs', () => {
    for (const v of [-1, -1e9, 1e12, Infinity, NaN]) {
      const t = timeOfDay(v);
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(1);
    }
  });

  it('formats a 24h clock', () => {
    expect(clockText(0)).toBe('00:00');
    expect(clockText(0.5)).toBe('12:00');
    expect(clockText(0.25)).toBe('06:00');
    expect(clockText(0.999)).toMatch(/^23:5\d$/);
  });
});

describe('sky model', () => {
  it('has a high sun and bright light at noon, and no sunlight at midnight', () => {
    const noon = sky(0.5), midnight = sky(0);
    expect(noon.sinEl).toBeCloseTo(1, 5);
    expect(noon.sunDir[1]).toBeGreaterThan(0.85);
    expect(noon.sunIntensity).toBeGreaterThan(2.5);
    expect(noon.moonIntensity).toBe(0);
    expect(midnight.sunIntensity).toBe(0);
    expect(midnight.moonIntensity).toBeGreaterThan(0.4);
    expect(midnight.stars).toBeGreaterThan(0.9);
    expect(noon.stars).toBe(0);
  });

  it('keeps the world readable at night (restrained, not black)', () => {
    const n = sky(0);
    const ambient = n.hemiIntensity * lum(n.hemiSky);
    expect(n.hemiIntensity).toBeGreaterThan(0.8);
    expect(ambient).toBeGreaterThan(0.3);
    expect(sky(0.5).hemiIntensity * lum(sky(0.5).hemiSky)).toBeGreaterThan(ambient);
  });

  it('never lets the light direction go below the horizon (finite shadows) and returns unit vectors', () => {
    for (let i = 0; i < 200; i++) {
      const s = sky(i / 200);
      for (const d of [s.sunDir, s.moonDir]) {
        expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 5);
        expect(d[1]).toBeGreaterThanOrEqual(0.11);
      }
    }
  });

  it('warms the horizon and sun near sunrise/sunset and cools them at noon', () => {
    const dawn = sky(0.27), noon = sky(0.5);
    expect(dawn.sunColor[0] - dawn.sunColor[2]).toBeGreaterThan(noon.sunColor[0] - noon.sunColor[2]);
    expect(dawn.horizon[0] - dawn.horizon[2]).toBeGreaterThan(noon.horizon[0] - noon.horizon[2]);
    expect(dawn.twilight).toBeGreaterThan(0.5);
    expect(noon.twilight).toBeLessThan(0.05);
  });

  it('changes smoothly: no frame-to-frame jumps across the whole day', () => {
    const N = 2000;
    let prev = sky(0);
    for (let i = 1; i <= N; i++) {
      const s = sky(i / N);
      expect(Math.abs(s.sunIntensity - prev.sunIntensity)).toBeLessThan(0.08);
      expect(Math.abs(s.hemiIntensity - prev.hemiIntensity)).toBeLessThan(0.01);
      expect(dist(s.zenith, prev.zenith)).toBeLessThan(0.02);
      expect(dist(s.horizon, prev.horizon)).toBeLessThan(0.02);
      expect(dist(s.sunDir as RGB, prev.sunDir as RGB)).toBeLessThan(0.01);
      prev = s;
    }
    // and it wraps: 1.0 equals 0.0
    expect(dist(sky(1).horizon, sky(0).horizon)).toBeLessThan(1e-6);
  });

  it('keeps every colour channel in 0..1 for all hours and weather', () => {
    for (let i = 0; i < 100; i++) {
      for (const w of [clear, { rain: 1, mist: 1 }, { rain: 0.5, mist: 0.2 }]) {
        const s = sky(i / 100, w);
        for (const c of [s.sunColor, s.moonColor, s.hemiSky, s.hemiGround, s.zenith, s.horizon, s.fogColor, s.waterShallow, s.waterDeep]) {
          for (const v of c) { expect(v).toBeGreaterThanOrEqual(-1e-6); expect(v).toBeLessThanOrEqual(1 + 1e-6); }
        }
        expect(s.fogNear).toBeLessThan(s.fogFar);
        expect(s.exposure).toBeGreaterThan(0.8);
        expect(s.exposure).toBeLessThan(1.3);
      }
    }
  });

  it('rain dims the sun, greys the sky and pulls the fog in', () => {
    const dry = sky(0.5), wet = sky(0.5, { rain: 1, mist: 0.6 });
    expect(wet.sunIntensity).toBeLessThan(dry.sunIntensity * 0.5);
    expect(wet.fogFar).toBeLessThan(dry.fogFar);
    const sat = (c: RGB): number => Math.max(...c) - Math.min(...c);
    expect(sat(wet.zenith)).toBeLessThan(sat(dry.zenith));
  });
});

describe('weather', () => {
  it('is deterministic and clear for the first two and a half minutes', () => {
    expect(weatherAt(5000, 0.4)).toEqual(weatherAt(5000, 0.4));
    for (let t = 0; t <= 150; t += 5) {
      const w = weatherAt(t, timeOfDay(t));
      expect(w.rain).toBe(0);
      expect(w.mist).toBe(0);
    }
  });

  it('stays in range, is mostly dry (restrained) but does rain sometimes', () => {
    let rainy = 0, samples = 0, max = 0;
    for (let t = 0; t < 36000; t += 10) {
      const w = weatherAt(t, timeOfDay(t));
      expect(w.rain).toBeGreaterThanOrEqual(0);
      expect(w.rain).toBeLessThanOrEqual(1);
      expect(w.mist).toBeGreaterThanOrEqual(0);
      expect(w.mist).toBeLessThanOrEqual(1);
      if (w.rain > 0.05) rainy++;
      max = Math.max(max, w.rain);
      samples++;
    }
    expect(rainy / samples).toBeGreaterThan(0.02);
    expect(rainy / samples).toBeLessThan(0.3);
    expect(max).toBeGreaterThan(0.4);
  });

  it('survives garbage time values', () => {
    for (const v of [NaN, -5, Infinity]) {
      const w = weatherAt(v, 0.3);
      expect(Number.isFinite(w.rain)).toBe(true);
      expect(Number.isFinite(w.mist)).toBe(true);
    }
  });
});
