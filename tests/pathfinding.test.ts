import { describe, expect, it } from 'vitest';
import { findPath, isBlocked, lineOfSight, nearestWalkable, setBlockedRect, type NavGrid } from '../src/systems/pathfinding';

function openGrid(size = 40): NavGrid {
  const blocked = new Uint8Array(size * size);
  for (let i = 0; i < size; i++) {
    blocked[i] = 1; blocked[(size - 1) * size + i] = 1; blocked[i * size] = 1; blocked[i * size + size - 1] = 1;
  }
  return { size, blocked };
}

const pathLength = (sx: number, sz: number, p: { x: number; z: number }[]): number => {
  let len = 0, x = sx, z = sz;
  for (const q of p) { len += Math.hypot(q.x - x, q.z - z); x = q.x; z = q.z; }
  return len;
};

describe('pathfinding', () => {
  it('goes straight across open ground', () => {
    const nav = openGrid();
    const p = findPath(nav, 5, 5, 30, 5)!;
    expect(p).not.toBeNull();
    expect(p[p.length - 1]).toEqual({ x: 30, z: 5 });
    expect(pathLength(5, 5, p)).toBeCloseTo(25, 3);
  });

  it('routes around a wall and every segment has line of sight', () => {
    const nav = openGrid();
    setBlockedRect(nav, 15, 3, 2, 30, true); // wall with gaps only at the ends
    const p = findPath(nav, 5, 20, 30, 20)!;
    expect(p).not.toBeNull();
    let x = 5, z = 20;
    for (const q of p) { expect(lineOfSight(nav, x, z, q.x, q.z)).toBe(true); x = q.x; z = q.z; }
    expect(pathLength(5, 20, p)).toBeGreaterThan(25);
  });

  it('returns null when the goal region is enclosed', () => {
    const nav = openGrid();
    setBlockedRect(nav, 20, 20, 5, 1, true); setBlockedRect(nav, 20, 24, 5, 1, true);
    setBlockedRect(nav, 20, 20, 1, 5, true); setBlockedRect(nav, 24, 20, 1, 5, true);
    expect(findPath(nav, 5, 5, 22, 22)).toBeNull();
  });

  it('relocates a blocked goal to the nearest walkable cell', () => {
    const nav = openGrid();
    setBlockedRect(nav, 18, 18, 4, 4, true);
    const p = findPath(nav, 5, 5, 20, 20)!;
    const end = p[p.length - 1]!;
    expect(isBlocked(nav, end.x, end.z)).toBe(false);
    expect(Math.hypot(end.x - 20, end.z - 20)).toBeLessThan(4);
  });

  it('does not cut corners between two diagonal blocked cells', () => {
    const nav = openGrid();
    setBlockedRect(nav, 10, 11, 1, 1, true);
    setBlockedRect(nav, 11, 10, 1, 1, true);
    const p = findPath(nav, 10, 10, 11, 11)!;
    expect(p).not.toBeNull();
    let x = 10, z = 10;
    for (const q of p) { expect(lineOfSight(nav, x, z, q.x, q.z)).toBe(true); x = q.x; z = q.z; }
  });

  it('handles start == goal and out-of-map goals safely', () => {
    const nav = openGrid();
    expect(findPath(nav, 5, 5, 5, 5)).toEqual([{ x: 5, z: 5 }]);
    const p = findPath(nav, 5, 5, 500, 500);
    expect(p === null || !isBlocked(nav, p[p.length - 1]!.x, p[p.length - 1]!.z)).toBe(true);
  });

  it('nearestWalkable finds a ring neighbour or null when none within range', () => {
    const nav = openGrid();
    expect(nearestWalkable(nav, 0, 0)).not.toBeNull();
    const full: NavGrid = { size: 10, blocked: new Uint8Array(100).fill(1) };
    expect(nearestWalkable(full, 5, 5, 4)).toBeNull();
  });
});
