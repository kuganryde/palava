import { clamp } from '../core/math';

/** Target loudness (0..1) of each ambient layer. Pure, so the mix rules are unit-testable without Web Audio. */
export interface AmbientMix { wind: number; waves: number; birds: number; crickets: number; rain: number }

/**
 * @param day 0 (night) .. 1 (day)
 * @param rain 0..1 weather intensity
 * @param zoom camera zoom: closer in = quieter, wider soundscape (never fully silent)
 */
export function ambientMix(day: number, rain: number, zoom: number, out: AmbientMix = { wind: 0, waves: 0, birds: 0, crickets: 0, rain: 0 }): AmbientMix {
  const d = clamp(Number.isFinite(day) ? day : 0, 0, 1), r = clamp(Number.isFinite(rain) ? rain : 0, 0, 1);
  const near = clamp(((Number.isFinite(zoom) ? zoom : 1) - 1) / 3, 0, 1);
  out.wind = 0.1 + 0.18 * r + 0.05 * (1 - d);
  out.waves = 0.09 * (1 - 0.4 * r);
  out.birds = clamp((d - 0.55) / 0.45, 0, 1) * (1 - r * 1.4 > 0 ? 1 - r * 1.4 : 0) * (0.5 + 0.5 * near);
  out.crickets = clamp((0.45 - d) / 0.45, 0, 1) * (1 - r);
  out.rain = r * 0.35;
  return out;
}

/**
 * Procedural ambience (wind, surf, birdsong, crickets, rain) synthesised with Web Audio, so no audio
 * files are shipped or fetched. Security/UX: the AudioContext is only created inside a user gesture
 * (browser autoplay policy), it is closed on dispose, and muting suspends it so a hidden game costs nothing.
 */
export class AmbientAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private layers: Partial<Record<keyof AmbientMix, GainNode>> = {};
  private nextChirp = 0;
  private enabled = true;
  private readonly mix: AmbientMix = { wind: 0, waves: 0, birds: 0, crickets: 0, rain: 0 };

  get running(): boolean { return this.ctx !== null && this.ctx.state === 'running'; }
  get started(): boolean { return this.ctx !== null; }

  /** Must be called from a user-gesture handler. Safe to call repeatedly or when Web Audio is missing. */
  start(): void {
    if (this.ctx) { if (this.enabled) void this.ctx.resume().catch(() => undefined); return; }
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this.enabled ? 0.8 : 0;
      master.connect(ctx.destination);
      this.master = master;
      const noise = this.noiseBuffer(ctx);
      const layer = (name: keyof AmbientMix, nodes: AudioNode[]): GainNode => {
        const g = ctx.createGain(); g.gain.value = 0;
        nodes[nodes.length - 1]!.connect(g); g.connect(master);
        this.layers[name] = g;
        return g;
      };
      const src = (): AudioBufferSourceNode => { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.start(); return s; };
      // Wind: low band-passed noise, slowly swept by an LFO.
      const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 420; wf.Q.value = 0.7;
      src().connect(wf);
      const lfo = ctx.createOscillator(), lfoG = ctx.createGain(); lfo.frequency.value = 0.11; lfoG.gain.value = 220; lfo.connect(lfoG); lfoG.connect(wf.frequency); lfo.start();
      layer('wind', [wf]);
      // Surf: low-passed noise with a ~9 s swell.
      const sf = ctx.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 520;
      const sg = ctx.createGain(); sg.gain.value = 0.6;
      src().connect(sf); sf.connect(sg);
      const swell = ctx.createOscillator(), swellG = ctx.createGain(); swell.frequency.value = 0.11; swellG.gain.value = 0.4; swell.connect(swellG); swellG.connect(sg.gain); swell.start();
      layer('waves', [sf, sg]);
      // Rain: high-passed hiss.
      const rf = ctx.createBiquadFilter(); rf.type = 'highpass'; rf.frequency.value = 2400;
      src().connect(rf);
      layer('rain', [rf]);
      // Crickets: a 4.3 kHz tone chopped by a ~14 Hz square LFO.
      const cr = ctx.createOscillator(); cr.frequency.value = 4300;
      const cg = ctx.createGain(); cg.gain.value = 0.5;
      const cl = ctx.createOscillator(); cl.type = 'square'; cl.frequency.value = 14;
      const clg = ctx.createGain(); clg.gain.value = 0.5; cl.connect(clg); clg.connect(cg.gain);
      cr.connect(cg); cr.start(); cl.start();
      layer('crickets', [cg]);
      // Birds are scheduled chirps (see update); they need only a bus.
      const bus = ctx.createGain(); layer('birds', [bus]); this.birdBus = bus;
      if (!this.enabled) void ctx.suspend().catch(() => undefined);
    } catch {
      this.ctx = null; // audio is optional: a failure must never break the game
    }
  }

  private birdBus: GainNode | null = null;

  /** One buffer of brown-ish noise reused by every noise layer (a single 2 s allocation). */
  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0, seed = 1234567;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0; // deterministic LCG: no Math.random in audio generation
      const w = seed / 4294967296 * 2 - 1;
      last = (last + 0.04 * w) / 1.04;
      d[i] = last * 6;
    }
    return buf;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.1);
    if (on) void this.ctx.resume().catch(() => undefined);
    else void this.ctx.suspend().catch(() => undefined);
  }

  update(day: number, rain: number, zoom: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || ctx.state !== 'running') return;
    const m = ambientMix(day, rain, zoom, this.mix);
    for (const k of ['wind', 'waves', 'crickets', 'rain'] as const) this.layers[k]?.gain.setTargetAtTime(m[k], ctx.currentTime, 0.8);
    this.birdBus?.gain.setTargetAtTime(m.birds, ctx.currentTime, 0.8);
    if (m.birds > 0.05 && ctx.currentTime >= this.nextChirp && this.birdBus) {
      const t = ctx.currentTime;
      this.nextChirp = t + 1.6 + ((t * 7.31) % 1) * 3.5; // irregular gaps without Math.random
      const base = 2400 + ((t * 13.7) % 1) * 1800, notes = 2 + Math.floor(((t * 3.3) % 1) * 3);
      for (let i = 0; i < notes; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        const s = t + i * 0.11;
        o.frequency.setValueAtTime(base, s); o.frequency.exponentialRampToValueAtTime(base * 1.35, s + 0.07);
        g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.18, s + 0.015); g.gain.exponentialRampToValueAtTime(0.001, s + 0.09);
        o.connect(g); g.connect(this.birdBus); o.start(s); o.stop(s + 0.1);
      }
    }
  }

  dispose(): void {
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null; this.master = null; this.birdBus = null; this.layers = {};
  }
}
