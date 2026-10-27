import type { Point } from './pathfinding';

export type FormationKind = 'line' | 'column' | 'wedge' | 'box';
export const FORMATIONS: readonly FormationKind[] = ['line', 'column', 'wedge', 'box'];

/**
 * Local slot offsets: x = lateral (right is +), z = distance BEHIND the leader
 * (so smaller z is closer to the front). Deterministic and independent of facing.
 */
export function formationOffsets(kind: FormationKind, count: number, spacing = 1.6): Point[] {
  const out: Point[] = [];
  const n = Math.max(0, Math.floor(count));
  switch (kind) {
    case 'line':
      for (let i = 0; i < n; i++) out.push({ x: (i - (n - 1) / 2) * spacing, z: 0 });
      break;
    case 'column':
      for (let i = 0; i < n; i++) out.push({ x: 0, z: i * spacing });
      break;
    case 'wedge':
      for (let i = 0; i < n; i++) {
        if (i === 0) { out.push({ x: 0, z: 0 }); continue; }
        const row = Math.ceil(i / 2);
        out.push({ x: (i % 2 === 1 ? -1 : 1) * row * spacing * 0.85, z: row * spacing });
      }
      break;
    case 'box': {
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      for (let i = 0; i < n; i++) {
        const c = i % cols, r = Math.floor(i / cols);
        out.push({ x: (c - (cols - 1) / 2) * spacing, z: r * spacing });
      }
      break;
    }
  }
  return out;
}

/** World-space slots for `count` units moving from `from` to `target`, facing the travel direction. */
export function formationSlots(kind: FormationKind, count: number, target: Point, from: Point, spacing = 1.6): Point[] {
  let fx = target.x - from.x, fz = target.z - from.z;
  const len = Math.hypot(fx, fz);
  if (len < 1e-6) { fx = 0; fz = -1; } else { fx /= len; fz /= len; }
  const rx = -fz, rz = fx; // right-hand vector on the XZ plane
  return formationOffsets(kind, count, spacing).map((o) => ({
    x: target.x + rx * o.x - fx * o.z,
    z: target.z + rz * o.x - fz * o.z,
  }));
}

/**
 * Assign units to slots without crossing paths: sort both by lateral position
 * relative to the facing direction, then pair them in order. Returns slot index per unit.
 */
export function assignSlots(units: Point[], slots: Point[], facing: Point): number[] {
  const len = Math.hypot(facing.x, facing.z) || 1;
  const rx = -facing.z / len, rz = facing.x / len;
  const lateral = (p: Point): number => p.x * rx + p.z * rz;
  const uOrder = units.map((_, i) => i).sort((a, b) => lateral(units[a]!) - lateral(units[b]!));
  const sOrder = slots.map((_, i) => i).sort((a, b) => lateral(slots[a]!) - lateral(slots[b]!));
  const result = new Array<number>(units.length).fill(0);
  uOrder.forEach((u, k) => { result[u] = sOrder[k] ?? 0; });
  return result;
}
