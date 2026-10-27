export interface ScreenItem {
  id: number;
  sx: number; // screen-space position in CSS pixels
  sy: number;
}

/** Items whose screen position lies inside the (unordered) rectangle. */
export function boxSelect(items: readonly ScreenItem[], x1: number, y1: number, x2: number, y2: number): number[] {
  const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
  return items.filter((i) => i.sx >= minX && i.sx <= maxX && i.sy >= minY && i.sy <= maxY).map((i) => i.id);
}

/** Nearest item within `radius` pixels of (x, y), or null. */
export function pickNearest(items: readonly ScreenItem[], x: number, y: number, radius: number): number | null {
  let best: number | null = null;
  let bestD = radius;
  for (const i of items) {
    const d = Math.hypot(i.sx - x, i.sy - y);
    if (d <= bestD) { bestD = d; best = i.id; }
  }
  return best;
}

/** Combine a new selection with the existing one (shift = additive toggle). */
export function mergeSelection(current: ReadonlySet<number>, picked: readonly number[], additive: boolean): Set<number> {
  if (!additive) return new Set(picked);
  const out = new Set(current);
  for (const id of picked) {
    if (out.has(id) && picked.length === 1) out.delete(id); else out.add(id);
  }
  return out;
}
