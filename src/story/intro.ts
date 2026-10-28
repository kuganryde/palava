/**
 * The opening clip: a short real-time cinematic rendered by the game itself (no video file). This module
 * holds the pure timeline (camera shots and subtitle lines) so it can be tested without a GPU.
 */
export const INTRO_SECONDS = 26;

export interface IntroLine { from: number; to: number; text: string }

export const INTRO_LINES: readonly IntroLine[] = [
  { from: 1.0, to: 6.5, text: 'In an age of kings, a kingdom rose where the river meets the sea.' },
  { from: 7.0, to: 12.5, text: 'Its builders cut temples from living rock, and its harvests fed the shore.' },
  { from: 13.0, to: 18.5, text: 'Now the crown passes to you: a palace, a few loyal swords, and land worth keeping.' },
  { from: 19.0, to: 23.0, text: 'But beyond the hills, a rival banner has been raised.' },
];
/** The title card appears for the last seconds. */
export const TITLE_FROM = 23.2;

export interface Shot { x: number; z: number; zoom: number; yaw: number }
export type Pt = { x: number; z: number };

const smooth = (t: number): number => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const START_YAW = Math.PI / 4;

/**
 * Camera for time `t`: a wide establishing orbit over the capital, a push in to the palace, then a pull back
 * and pan toward the rival's land. With reduced motion the camera holds the wide shot.
 */
export function introShot(t: number, capital: Pt, fort: Pt | null, reducedMotion: boolean): Shot {
  const rival = fort ?? { x: capital.x + 30, z: capital.z - 30 };
  if (reducedMotion) return { x: capital.x, z: capital.z + 2, zoom: 1.3, yaw: START_YAW };
  if (t < 9) {
    const k = smooth(t / 9);
    return { x: capital.x, z: capital.z + 2, zoom: mix(0.95, 1.5, k), yaw: mix(START_YAW - 0.5, START_YAW + 0.35, k) };
  }
  if (t < 17) {
    const k = smooth((t - 9) / 8);
    return { x: capital.x, z: capital.z + 3, zoom: mix(1.5, 3.1, k), yaw: mix(START_YAW + 0.35, START_YAW + 0.1, k) };
  }
  const k = smooth((t - 17) / (INTRO_SECONDS - 17));
  return {
    x: mix(capital.x, rival.x, k * 0.75), z: mix(capital.z + 3, rival.z, k * 0.75),
    zoom: mix(3.1, 1.1, k), yaw: mix(START_YAW + 0.1, START_YAW - 0.25, k),
  };
}

/** The subtitle active at time `t`, or null between lines. */
export function lineAt(t: number): IntroLine | null {
  return INTRO_LINES.find((l) => t >= l.from && t < l.to) ?? null;
}

/** Typewriter: how much of `text` is visible `elapsed` seconds after the line began (instant when asked). */
export function revealed(text: string, elapsed: number, instant: boolean, charsPerSecond = 32): string {
  if (instant) return text;
  return text.slice(0, Math.max(0, Math.min(text.length, Math.floor(elapsed * charsPerSecond))));
}
