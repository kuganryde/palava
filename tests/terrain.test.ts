import { describe, expect, it } from 'vitest';
import { capitalCenter, generateTerrain, heightAt, intersectRay, WATER_LEVEL } from '../src/world/terrain';
import { buildNavGrid, isBlocked } from '../src/systems/pathfinding';
import { placeVegetation } from '../src/world/vegetation';

describe('terrain', () => {
  const t = generateTerrain(1337);

  it('is deterministic for a seed and differs between seeds', () => {
    const a = generateTerrain(1337), b = generateTerrain(1337), c = generateTerrain(42);
    expect(Array.from(a.heights.slice(0, 500))).toEqual(Array.from(b.heights.slice(0, 500)));
    expect(Array.from(a.heights.slice(0, 500))).not.toEqual(Array.from(c.heights.slice(0, 500)));
  });

  it('rejects invalid sizes', () => {
    expect(() => generateTerrain(1, 8)).toThrow(RangeError);
    expect(() => generateTerrain(1, 33.5)).toThrow(RangeError);
  });

  it('has water, land, highlands and a flat capital plateau', () => {
    const cap = capitalCenter(t.size);
    let water = 0, land = 0;
    for (const h of t.heights) (h <= WATER_LEVEL ? water++ : land++);
    expect(water).toBeGreaterThan(t.heights.length * 0.1);
    expect(land).toBeGreaterThan(t.heights.length * 0.3);
    expect(t.maxHeight).toBeGreaterThan(7);
    let min = Infinity, max = -Infinity;
    for (let z = cap.z - 6; z <= cap.z + 6; z++) for (let x = cap.x - 6; x <= cap.x + 6; x++) {
      const h = heightAt(t, x, z); min = Math.min(min, h); max = Math.max(max, h);
    }
    expect(max - min).toBeLessThan(0.5);
    expect(min).toBeGreaterThan(WATER_LEVEL + 1);
  });

  it('bilinear heightAt clamps outside the map and matches grid points', () => {
    expect(heightAt(t, 10, 10)).toBeCloseTo(t.heights[10 * t.size + 10]!, 5);
    expect(heightAt(t, -50, -50)).toBeCloseTo(t.heights[0]!, 5);
  });

  it('ray picking hits the ground under a downward ray and misses upward rays', () => {
    const cap = capitalCenter(t.size);
    const hit = intersectRay(t, cap.x, 60, cap.z, 0, -1, 0);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBeCloseTo(heightAt(t, cap.x, cap.z), 1);
    expect(intersectRay(t, cap.x, 60, cap.z, 0, 1, 0)).toBeNull();
    expect(intersectRay(t, 0, 0, 0, 0, 0, 0)).toBeNull();
    expect(intersectRay(t, NaN, 5, 5, 0, -1, 0)).toBeNull();
  });

  it('ray picking works on an oblique isometric-style ray', () => {
    const cap = capitalCenter(t.size);
    const dir = { x: -0.5, y: -0.7, z: -0.5 };
    const hit = intersectRay(t, cap.x + 60, 70, cap.z + 60, dir.x, dir.y, dir.z);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBeLessThanOrEqual(heightAt(t, hit!.x, hit!.z) + 0.05);
  });
});

describe('nav grid & vegetation', () => {
  const t = generateTerrain(1337);
  const nav = buildNavGrid(t);

  it('blocks water, map borders; keeps capital walkable', () => {
    const cap = capitalCenter(t.size);
    expect(isBlocked(nav, cap.x, cap.z)).toBe(false);
    expect(isBlocked(nav, 0, 0)).toBe(true);
    expect(isBlocked(nav, -5, 4)).toBe(true);
    expect(isBlocked(nav, t.size - 1, 60)).toBe(true);
  });

  it('scatters trees on dry, non-capital ground deterministically', () => {
    const a = placeVegetation(t), b = placeVegetation(t);
    expect(a.trees.length).toBeGreaterThan(300);
    expect(a.trees.length).toBe(b.trees.length);
    expect(a.trees[0]).toEqual(b.trees[0]);
    const cap = capitalCenter(t.size);
    for (const p of a.trees) {
      expect(p.y).toBeGreaterThan(WATER_LEVEL);
      expect(Math.hypot(p.x - cap.x, p.z - cap.z)).toBeGreaterThan(16);
    }
  });
});
