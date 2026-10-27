/**
 * Animation state for units, kept free of any three.js types so it can be unit-tested in Node.
 *
 * Each unit has a current clip, the clip it is blending away from, a blend factor, a locomotion
 * phase (advanced by distance travelled so feet never slide) and the time since the clip began (used
 * by one-shot and loop clips such as attack, gather, build and death). The GPU animates the pose from
 * these few numbers; nothing here allocates per frame after a unit's first appearance.
 */

export const CLIPS = ['idle', 'walk', 'run', 'attack', 'gather', 'build', 'death'] as const;
export type ClipName = (typeof CLIPS)[number];
export const CLIP: Readonly<Record<ClipName, number>> = { idle: 0, walk: 1, run: 2, attack: 3, gather: 4, build: 5, death: 6 };

/** Seconds a clip takes to blend in. Short enough to feel responsive, long enough to hide pops. */
export const BLEND_SECONDS = 0.2;
/** A path with more waypoints than this is a long march: units break into a run. */
export const RUN_PATH_POINTS = 14;
/** Largest time step the controller will integrate (a stalled tab must not fling the blend). */
export const MAX_DT = 0.1;

export interface AnimInstance {
  clip: number;
  prev: number;
  blend: number; // 0 = still showing prev, 1 = fully on clip
  phase: number; // locomotion cycles, wraps to 0..1
  clipTime: number; // seconds since the current clip began
  seed: number; // 0..1, de-synchronises idle motion between units
  lastX: number;
  lastZ: number;
  /** Debug/test override: forces a clip regardless of what the sim says (-1 = none). */
  override: number;
}

export interface Stride { walk: number; run: number }

export interface ChooseContext {
  hp: number;
  moving: boolean;
  pathLength: number;
  /** Villager context: what the nearest relevant building is doing, if any. */
  nearby: 'none' | 'construction' | 'production';
  canWork: boolean;
  /** In weapon range of a target and swinging (no path left to walk). */
  attacking?: boolean;
}

/** Decide which clip a unit should be playing. Pure. */
export function chooseClip(c: ChooseContext): number {
  if (c.hp <= 0) return CLIP.death;
  if (c.attacking && !c.moving) return CLIP.attack;
  if (c.moving) return c.pathLength > RUN_PATH_POINTS ? CLIP.run : CLIP.walk;
  if (c.canWork) {
    if (c.nearby === 'construction') return CLIP.build;
    if (c.nearby === 'production') return CLIP.gather;
  }
  return CLIP.idle;
}

const easeBlend = (t: number): number => t * t * (3 - 2 * t);
export { easeBlend };

export class AnimController {
  private readonly states = new Map<number, AnimInstance>();

  get size(): number { return this.states.size; }

  get(id: number): AnimInstance | undefined { return this.states.get(id); }

  /**
   * Advance one unit by `dt` seconds. `x`,`z` are its rendered world position, used to move the
   * locomotion phase by distance. Returns the live (mutated) instance.
   */
  step(id: number, desired: number, x: number, z: number, dt: number, stride: Stride): AnimInstance {
    let s = this.states.get(id);
    if (!s) {
      s = { clip: desired, prev: desired, blend: 1, phase: hash01(id * 3 + 1), clipTime: 0, seed: hash01(id * 7 + 2), lastX: x, lastZ: z, override: -1 };
      this.states.set(id, s);
    }
    const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), MAX_DT) : 0;
    const target = s.override >= 0 ? s.override : desired;
    if (target !== s.clip) {
      // Death is final: nothing blends out of it unless a test override forces it.
      if (s.clip !== CLIP.death || s.override >= 0) {
        // Blend from whatever is dominant now, so a quick re-trigger does not snap through the old pose.
        s.prev = s.blend >= 0.5 ? s.clip : s.prev;
        s.clip = target;
        s.blend = 0;
        s.clipTime = 0;
      }
    }
    s.blend = Math.min(1, s.blend + d / BLEND_SECONDS);
    s.clipTime += d;
    const dist = Math.hypot(x - s.lastX, z - s.lastZ);
    s.lastX = x; s.lastZ = z;
    if (s.clip === CLIP.walk || s.clip === CLIP.run || s.prev === CLIP.walk || s.prev === CLIP.run) {
      const len = s.clip === CLIP.run ? stride.run : stride.walk;
      // Cap per-frame distance so a teleport (load, new game) does not spin the legs.
      s.phase = (s.phase + Math.min(dist, 2) / len) % 1;
    }
    return s;
  }

  /** Drop state for units that no longer exist. */
  prune(live: ReadonlySet<number>): void {
    for (const id of this.states.keys()) if (!live.has(id)) this.states.delete(id);
  }

  clear(): void { this.states.clear(); }
}

/** Cheap deterministic 0..1 hash (no allocation). */
export function hash01(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}
