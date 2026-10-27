import { clamp } from '../core/math';

/**
 * Adaptive render resolution. Feed it frame times; it returns a pixel-ratio
 * scale. Steps down quickly when frames are slow and recovers slowly, with a
 * dead band between thresholds so it does not oscillate.
 */
export class AdaptiveResolution {
  private ema: number;
  private frames = 0;
  scale: number;

  constructor(
    private readonly minScale = 0.5,
    private readonly maxScale = 1,
    private readonly targetMs = 16.7,
    private readonly step = 0.1,
    private readonly interval = 30,
  ) {
    this.scale = maxScale;
    this.ema = targetMs;
  }

  /** Returns the current scale after observing a frame (milliseconds). */
  update(frameMs: number): number {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return this.scale;
    this.ema += (Math.min(frameMs, 200) - this.ema) * 0.1;
    if (++this.frames >= this.interval) {
      this.frames = 0;
      if (this.ema > this.targetMs * 1.25) this.scale = clamp(this.scale - this.step, this.minScale, this.maxScale);
      else if (this.ema < this.targetMs * 0.8) this.scale = clamp(this.scale + this.step / 2, this.minScale, this.maxScale);
    }
    return this.scale;
  }

  reset(maxScale = this.maxScale): void {
    this.scale = maxScale;
    this.ema = this.targetMs;
    this.frames = 0;
  }
}
