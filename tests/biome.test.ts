import { describe, expect, it } from 'vitest';
import { Biome, biomeMapFor, computeBiomes } from '../src/world/biome';
import { capitalCenter, generateTerrain, WATER_LEVEL } from '../src/world/terrain';

describe('biome map', () => {
  const t = generateTerrain(1337);
  const bm = biomeMapFor(t);

  it('is deterministic and memoised per terrain', () => {
    expect(biomeMapFor(t)).toBe(bm);
    const again = computeBiomes(generateTerrain(1337));
    expect(Array.from(again.biome.slice(0, 2000))).toEqual(Array.from(bm.biome.slice(0, 2000)));
    expect(Array.from(again.moisture.slice(0, 500))).toEqual(Array.from(bm.moisture.slice(0, 500)));
  });

  it('keeps every field in range and sized to the grid', () => {
    expect(bm.biome.length).toBe(t.size * t.size);
    for (let i = 0; i < bm.biome.length; i++) {
      expect(bm.moisture[i]).toBeGreaterThanOrEqual(0);
      expect(bm.moisture[i]).toBeLessThanOrEqual(1);
      expect(bm.forest[i]).toBeGreaterThanOrEqual(0);
      expect(bm.forest[i]).toBeLessThanOrEqual(1);
      expect(bm.slope[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('classifies water exactly where the terrain is at or below the water level', () => {
    for (let i = 0; i < bm.biome.length; i++) {
      expect(bm.biome[i] === Biome.Water).toBe(t.heights[i]! <= WATER_LEVEL);
      if (t.heights[i]! <= WATER_LEVEL) expect(bm.waterDist[i]).toBe(0);
    }
  });

  it('measures distance to water: it grows inland and is 1 next to a shore cell', () => {
    // Find a land cell with a 4-neighbour that is water; its distance must be exactly 1.
    let checked = 0;
    for (let z = 1; z < t.size - 1 && checked < 20; z++) {
      for (let x = 1; x < t.size - 1 && checked < 20; x++) {
        const i = z * t.size + x;
        if (t.heights[i]! <= WATER_LEVEL) continue;
        const adj = [i - 1, i + 1, i - t.size, i + t.size].some((j) => t.heights[j]! <= WATER_LEVEL);
        if (adj) { expect(bm.waterDist[i]).toBeCloseTo(1, 5); checked++; }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('produces a varied island: several biomes present, and the capital is open ground', () => {
    const present = new Set<number>();
    for (const b of bm.biome) present.add(b);
    for (const b of [Biome.Water, Biome.Beach, Biome.Grassland, Biome.Forest, Biome.Rock, Biome.Highland]) {
      expect(present.has(b)).toBe(true);
    }
    const cap = capitalCenter(t.size);
    expect(bm.forest[cap.z * t.size + cap.x]).toBe(0);
    expect(bm.biome[cap.z * t.size + cap.x]).not.toBe(Biome.Forest);
  });

  it('is wetter near water than far from it, on average', () => {
    let near = 0, nearN = 0, far = 0, farN = 0;
    for (let i = 0; i < bm.biome.length; i++) {
      if (t.heights[i]! <= WATER_LEVEL) continue;
      if (bm.waterDist[i]! <= 3) { near += bm.moisture[i]!; nearN++; }
      else if (bm.waterDist[i]! >= 20) { far += bm.moisture[i]!; farN++; }
    }
    expect(nearN).toBeGreaterThan(50);
    expect(farN).toBeGreaterThan(50);
    expect(near / nearN).toBeGreaterThan(far / farN);
  });
});
