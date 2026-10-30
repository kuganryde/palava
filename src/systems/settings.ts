import type { Difficulty } from '../core/state';
import type { KeyValueStore } from './save';

export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  quality: Quality;
  shadows: boolean;
  adaptiveResolution: boolean;
  reducedMotion: boolean;
  /** Day/night cycle. Off = a fixed warm morning. */
  dayNight: boolean;
  /** Occasional light rain and haze. Off = always clear. */
  weather: boolean;
  /** Procedural ambient sound (starts only after a user gesture). */
  sound: boolean;
  /** Rival strength for new games (income, pace and head start; unit stats never change). */
  difficulty: Difficulty;
  /** Play the opening cinematic before new games. */
  intro: boolean;
  /** Guided objectives during the first minutes; switched off when finished or skipped. */
  tutorial: boolean;
}

export interface QualityPreset {
  maxPixelRatio: number;
  shadowMapSize: number; // 0 = disabled
  treeFraction: number; // share of scattered trees actually drawn
  rockFraction: number;
  bushFraction: number;
  reedFraction: number;
  grassFraction: number;
  antialias: boolean;
  /** Maximum counts for GPU-animated effects (the weather itself still affects light and fog on Low). */
  rainDrops: number;
  motes: number;
  birds: number;
}

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  low: { maxPixelRatio: 1, shadowMapSize: 0, treeFraction: 0.45, rockFraction: 0.5, bushFraction: 0.3, reedFraction: 0.4, grassFraction: 0.2, antialias: false, rainDrops: 0, motes: 0, birds: 3 },
  medium: { maxPixelRatio: 1.5, shadowMapSize: 1024, treeFraction: 0.75, rockFraction: 0.8, bushFraction: 0.65, reedFraction: 0.75, grassFraction: 0.55, antialias: true, rainDrops: 1200, motes: 140, birds: 7 },
  high: { maxPixelRatio: 2, shadowMapSize: 2048, treeFraction: 1, rockFraction: 1, bushFraction: 1, reedFraction: 1, grassFraction: 1, antialias: true, rainDrops: 2600, motes: 320, birds: 12 },
};

const SETTINGS_KEY = 'palava.settings.v1';

export function defaultSettings(prefersReducedMotion = false): Settings {
  return { quality: 'medium', shadows: true, adaptiveResolution: true, reducedMotion: prefersReducedMotion, dayNight: true, weather: true, sound: true, difficulty: 'normal', intro: true, tutorial: true };
}

export function loadSettings(store: KeyValueStore | null, fallback: Settings): Settings {
  if (!store) return fallback;
  try {
    const raw = store.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const d: unknown = JSON.parse(raw);
    if (typeof d !== 'object' || d === null) return fallback;
    const o = d as Record<string, unknown>;
    return {
      quality: o.quality === 'low' || o.quality === 'medium' || o.quality === 'high' ? o.quality : fallback.quality,
      shadows: typeof o.shadows === 'boolean' ? o.shadows : fallback.shadows,
      adaptiveResolution: typeof o.adaptiveResolution === 'boolean' ? o.adaptiveResolution : fallback.adaptiveResolution,
      reducedMotion: typeof o.reducedMotion === 'boolean' ? o.reducedMotion : fallback.reducedMotion,
      dayNight: typeof o.dayNight === 'boolean' ? o.dayNight : fallback.dayNight,
      weather: typeof o.weather === 'boolean' ? o.weather : fallback.weather,
      sound: typeof o.sound === 'boolean' ? o.sound : fallback.sound,
      intro: typeof o.intro === 'boolean' ? o.intro : fallback.intro,
      tutorial: typeof o.tutorial === 'boolean' ? o.tutorial : fallback.tutorial,
      difficulty: o.difficulty === 'easy' || o.difficulty === 'normal' || o.difficulty === 'hard' ? o.difficulty : fallback.difficulty,
    };
  } catch {
    return fallback;
  }
}

export function saveSettings(store: KeyValueStore | null, s: Settings): void {
  try { store?.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage blocked: settings just won't persist */ }
}
