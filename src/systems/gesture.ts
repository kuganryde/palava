/** Pure two-finger gesture maths (kept free of the DOM so it is unit-tested in Node). */
export interface Pt { x: number; y: number }
export interface Pinch { dist: number; cx: number; cy: number }

export function pinchOf(a: Pt, b: Pt): Pinch {
  return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}

/**
 * Movement between two frames of a pinch: `zoom` is the multiplicative zoom change (fingers apart = >1),
 * clamped so a glitchy touch sample cannot fling the camera; `dx`/`dy` is how far the midpoint moved in pixels.
 */
export function pinchDelta(prev: Pinch, cur: Pinch): { zoom: number; dx: number; dy: number } {
  const raw = cur.dist / prev.dist;
  const zoom = Number.isFinite(raw) ? Math.min(2, Math.max(0.5, raw)) : 1;
  return { zoom, dx: cur.cx - prev.cx, dy: cur.cy - prev.cy };
}
