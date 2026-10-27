import { clamp, lerp, smoothstep } from '../core/math';
import { valueNoise } from '../core/noise';

/**
 * Pure atmosphere model: time of day, sun/moon, sky colours and weather as functions of SIMULATION
 * time. Driving it from sim time (not wall-clock) means pause freezes the sky, 2x speed doubles it,
 * and a loaded save resumes at the same hour. No Three.js here, so it is unit-testable.
 *
 * Colours are sRGB triples in 0..1 (the render layer converts them to linear working space).
 */
export const DAY_LENGTH_SECONDS = 720; // one full day = 12 simulated minutes at 1x
export const START_TIME_OF_DAY = 0.31; // warm early morning, like the original golden-hour look
const SUN_ARC_AZIMUTH = -2.55; // atan2(-40, -60): matches the original light direction at noon
const MAX_ELEVATION = 1.1; // radians (~63 degrees); keeps noon shadows short but not vanishing

export type RGB = [number, number, number];
export type Vec3 = [number, number, number];

export interface SkyState {
  /** 0..1 position in the day (0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset). */
  tod: number;
  /** sin of the sun's elevation: +1 noon, 0 at the horizon, -1 midnight. */
  sinEl: number;
  /** 0 (night) .. 1 (full day). */
  day: number;
  /** 0..1 bump around sunrise/sunset. */
  twilight: number;
  sunDir: Vec3; // unit vector from the ground towards the sun (never below ~7 degrees, so shadows stay finite)
  sunColor: RGB;
  sunIntensity: number;
  moonDir: Vec3;
  moonColor: RGB;
  moonIntensity: number;
  hemiSky: RGB;
  hemiGround: RGB;
  hemiIntensity: number;
  zenith: RGB;
  horizon: RGB;
  fogColor: RGB;
  fogNear: number;
  fogFar: number;
  exposure: number;
  /** 0..1, how visible the stars are. */
  stars: number;
  waterShallow: RGB;
  waterDeep: RGB;
}

export interface Weather {
  /** 0..1 rain intensity (0 = dry). */
  rain: number;
  /** 0..1 haze/mist amount. */
  mist: number;
}

const rgb = (hex: number): RGB => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

const mixInto = (out: RGB, a: RGB, b: RGB, t: number): RGB => {
  out[0] = lerp(a[0], b[0], t); out[1] = lerp(a[1], b[1], t); out[2] = lerp(a[2], b[2], t);
  return out;
};
const grade = (c: RGB, grey: number): void => {
  const l = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
  c[0] = lerp(c[0], l, grey); c[1] = lerp(c[1], l, grey); c[2] = lerp(c[2], l, grey);
};

const OVERCAST: RGB = [0.62, 0.66, 0.7];

const K = {
  nightZenith: rgb(0x0b1330), dayZenith: rgb(0x3a74bc), twilightZenith: rgb(0x4b4f94),
  nightHorizon: rgb(0x1f2c52), warmHorizon: rgb(0xf2c48a), paleHorizon: rgb(0xcfe0ea), twilightHorizon: rgb(0xf0905c),
  sunLow: rgb(0xff9a55), sunMid: rgb(0xffdca8), sunHigh: rgb(0xfff4e0), moon: rgb(0x9fb2e6),
  hemiSkyNight: rgb(0x5870b4), hemiSkyDay: rgb(0xbcd7f5), hemiSkyTwi: rgb(0xb4a3c0),
  hemiGroundNight: rgb(0x34344c), hemiGroundDay: rgb(0x8a6a3c),
  shallowDay: rgb(0x3fa3a0), shallowNight: rgb(0x1a3a5c), deepDay: rgb(0x14527e), deepNight: rgb(0x08162e),
};

export function createSkyState(): SkyState {
  const z = (): RGB => [0, 0, 0];
  return {
    tod: 0, sinEl: 0, day: 0, twilight: 0, sunDir: [0, 1, 0], sunColor: z(), sunIntensity: 0, moonDir: [0, 1, 0], moonColor: z(),
    moonIntensity: 0, hemiSky: z(), hemiGround: z(), hemiIntensity: 0, zenith: z(), horizon: z(), fogColor: z(), fogNear: 110,
    fogFar: 330, exposure: 1, stars: 0, waterShallow: z(), waterDeep: z(),
  };
}

/** Fraction of the day (0..1) at simulation time `t` seconds. Handles negative and huge inputs. */
export function timeOfDay(simSeconds: number, start = START_TIME_OF_DAY, dayLength = DAY_LENGTH_SECONDS): number {
  if (!Number.isFinite(simSeconds)) return start;
  const v = (start + simSeconds / dayLength) % 1;
  return v < 0 ? v + 1 : v;
}

/** "07:12"-style clock for the HUD, derived from the same fraction. */
export function clockText(tod: number): string {
  const mins = Math.floor(((tod % 1) + 1) % 1 * 24 * 60);
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function dirFrom(out: Vec3, azimuth: number, elevation: number): Vec3 {
  const ce = Math.cos(elevation);
  out[0] = Math.cos(azimuth) * ce; out[1] = Math.sin(elevation); out[2] = Math.sin(azimuth) * ce;
  return out;
}

/**
 * Fills `out` for time-of-day `tod` and `weather`. Allocation-free after createSkyState().
 * Everything is a smooth function of `sinEl`, so there are no keyframe seams or sudden pops.
 */
export function computeSky(out: SkyState, tod: number, weather: Weather): SkyState {
  const rain = clamp(weather.rain, 0, 1), mist = clamp(weather.mist, 0, 1);
  out.tod = tod;
  const sinEl = Math.sin((tod - 0.25) * Math.PI * 2);
  out.sinEl = sinEl;
  const day = smoothstep(-0.32, 0.3, sinEl);
  out.day = day;
  const tw = Math.exp(-(((sinEl + 0.02) / 0.24) ** 2));
  out.twilight = tw;
  const warm = 1 - smoothstep(0.22, 0.8, sinEl); // low sun = warm, high sun = neutral

  // Sun: the light direction keeps a minimum elevation so shadows never stretch to infinity at the horizon.
  const sunAz = SUN_ARC_AZIMUTH + (tod - 0.5) * 1.7;
  dirFrom(out.sunDir, sunAz, Math.max(0.12, sinEl * MAX_ELEVATION));
  const sunTone = smoothstep(0.0, 0.3, sinEl);
  mixInto(out.sunColor, K.sunLow, K.sunMid, sunTone);
  mixInto(out.sunColor, out.sunColor, K.sunHigh, smoothstep(0.45, 0.95, sinEl));
  out.sunIntensity = 3.0 * smoothstep(-0.02, 0.26, sinEl) * (1 - 0.62 * rain);

  // Moon: a dim, cool second light with no shadows; fades in as the sun sets.
  const night = 1 - day;
  dirFrom(out.moonDir, sunAz + Math.PI, Math.max(0.35, -sinEl * 0.95));
  out.moonColor[0] = K.moon[0]; out.moonColor[1] = K.moon[1]; out.moonColor[2] = K.moon[2];
  out.moonIntensity = 0.95 * night * (1 - 0.5 * rain);

  // Ambient sky/ground fill. Kept bright enough at night that the map stays readable.
  mixInto(out.hemiSky, K.hemiSkyNight, K.hemiSkyDay, day);
  mixInto(out.hemiSky, out.hemiSky, K.hemiSkyTwi, tw * 0.45);
  mixInto(out.hemiGround, K.hemiGroundNight, K.hemiGroundDay, day);
  out.hemiIntensity = lerp(1.0, 0.88, day) * (1 + 0.12 * rain);

  // Sky dome gradient.
  mixInto(out.zenith, K.nightZenith, K.dayZenith, day);
  mixInto(out.zenith, out.zenith, K.twilightZenith, tw * 0.55);
  mixInto(out.horizon, K.nightHorizon, K.paleHorizon, day);
  mixInto(out.horizon, out.horizon, K.warmHorizon, day * warm * 0.9);
  mixInto(out.horizon, out.horizon, K.twilightHorizon, tw * 0.8);

  // Water colours follow the light.
  mixInto(out.waterShallow, K.shallowNight, K.shallowDay, day);
  mixInto(out.waterDeep, K.deepNight, K.deepDay, day);

  // Weather: overcast greys the whole palette and pulls the haze in.
  const grey = rain * 0.45 + mist * 0.25;
  if (grey > 0) {
    grade(out.zenith, grey); grade(out.horizon, grey); grade(out.hemiSky, grey * 0.6);
    mixInto(out.horizon, out.horizon, OVERCAST, grey * 0.35);
  }
  out.fogColor[0] = out.horizon[0]; out.fogColor[1] = out.horizon[1]; out.fogColor[2] = out.horizon[2];
  out.fogNear = lerp(110, 40, mist * 0.8 + rain * 0.3);
  out.fogFar = lerp(330, 170, mist * 0.8 + rain * 0.35);
  out.exposure = lerp(1.18, 1.06, day);
  out.stars = clamp((night - 0.45) / 0.55, 0, 1) * (1 - Math.max(rain, mist * 0.8));
  return out;
}

/**
 * Deterministic, restrained weather from simulation time. Mostly clear: a slow noise field decides
 * when a light shower or morning haze passes. The first three minutes are always clear so a new
 * player's first impression (and every automated test) is dry.
 */
export function weatherAt(simSeconds: number, tod: number, seed = 1337, out: Weather = { rain: 0, mist: 0 }): Weather {
  const t = Number.isFinite(simSeconds) ? Math.max(0, simSeconds) : 0;
  const grace = smoothstep(150, 240, t);
  const front = valueNoise(t / 210, 3.7, seed + 977);
  out.rain = smoothstep(0.64, 0.8, front) * 0.85 * grace;
  // Dawn mist burns off after sunrise; fronts add a little haze before they bring rain.
  const dawn = Math.exp(-(((tod - 0.27) / 0.06) ** 2));
  out.mist = clamp(dawn * 0.5 * grace + smoothstep(0.5, 0.72, front) * 0.55 * grace, 0, 1);
  return out;
}
