import { describe, expect, it } from 'vitest';
import { pinchDelta, pinchOf } from '../src/systems/gesture';

describe('pinch gesture', () => {
  it('fingers moving apart zooms in, together zooms out, midpoint drives pan', () => {
    const a = pinchOf({ x: 100, y: 100 }, { x: 200, y: 100 });
    const out = pinchDelta(a, pinchOf({ x: 80, y: 100 }, { x: 220, y: 100 }));
    expect(out.zoom).toBeCloseTo(1.4, 5); expect(out.dx).toBe(0);
    const inn = pinchDelta(a, pinchOf({ x: 120, y: 100 }, { x: 180, y: 100 }));
    expect(inn.zoom).toBeCloseTo(0.6, 5);
    const pan = pinchDelta(a, pinchOf({ x: 130, y: 120 }, { x: 230, y: 120 }));
    expect(pan.zoom).toBeCloseTo(1, 5); expect(pan.dx).toBe(30); expect(pan.dy).toBe(20);
  });
  it('clamps glitches and never divides by zero', () => {
    const tiny = pinchOf({ x: 5, y: 5 }, { x: 5, y: 5 });
    expect(tiny.dist).toBe(1);
    const huge = pinchDelta(tiny, pinchOf({ x: 0, y: 0 }, { x: 900, y: 0 }));
    expect(huge.zoom).toBe(2);
    expect(pinchDelta({ dist: Infinity, cx: 0, cy: 0 }, { dist: Infinity, cx: 0, cy: 0 }).zoom).toBe(1);
  });
});
