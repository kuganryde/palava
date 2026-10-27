import { describe, expect, it } from 'vitest';
import { assignSlots, FORMATIONS, formationOffsets, formationSlots } from '../src/systems/formation';

describe('formations', () => {
  it('produces the requested count with unique, spaced slots for every kind', () => {
    for (const kind of FORMATIONS) {
      for (const n of [0, 1, 2, 7, 10, 33]) {
        const o = formationOffsets(kind, n, 2);
        expect(o).toHaveLength(n);
        for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) {
          expect(Math.hypot(o[i]!.x - o[j]!.x, o[i]!.z - o[j]!.z)).toBeGreaterThan(1.4);
        }
      }
    }
  });

  it('line is centred and symmetric; wedge leader is at the front', () => {
    const line = formationOffsets('line', 5, 2);
    expect(line.reduce((s, p) => s + p.x, 0)).toBeCloseTo(0, 6);
    const wedge = formationOffsets('wedge', 7, 2);
    expect(Math.min(...wedge.map((p) => p.z))).toBe(wedge[0]!.z);
  });

  it('rotates slots to face the direction of travel (leader nearest the destination side)', () => {
    const slots = formationSlots('column', 4, { x: 50, z: 10 }, { x: 10, z: 10 }, 2); // travelling +x
    expect(slots[0]!.x).toBeCloseTo(50, 5);
    expect(slots[3]!.x).toBeCloseTo(44, 5); // others trail behind (smaller x)
    expect(slots.every((s) => Math.abs(s.z - 10) < 1e-6)).toBe(true);
  });

  it('survives a zero-length move', () => {
    const slots = formationSlots('line', 3, { x: 5, z: 5 }, { x: 5, z: 5 });
    expect(slots.every((s) => Number.isFinite(s.x) && Number.isFinite(s.z))).toBe(true);
  });

  it('assignSlots is a bijection that never crosses lateral order', () => {
    const units = [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 2, z: 0 }];
    const slots = [{ x: 20, z: 0 }, { x: 20, z: 4 }, { x: 20, z: 8 }];
    const a = assignSlots(units, slots, { x: 1, z: 0 });
    expect(new Set(a).size).toBe(3);
    const lateral = (p: { x: number; z: number }) => -0 * p.x + 1 * p.z; // right vector for +x facing is (0,1)
    const order = units.map((_, i) => i).sort((p, q) => lateral(units[p]!) - lateral(units[q]!));
    const slotOrder = order.map((i) => lateral(slots[a[i]!]!));
    expect([...slotOrder].sort((x, y) => x - y)).toEqual(slotOrder);
  });
});
