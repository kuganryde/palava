import * as THREE from 'three';
import { QUALITY_PRESETS, type Settings } from '../systems/settings';
import {
  computeSky, createSkyState, START_TIME_OF_DAY, timeOfDay, weatherAt, type RGB, type SkyState, type Weather,
} from '../world/environment';
import { heightAt, type Terrain } from '../world/terrain';
import { SkyDome } from './sky';
import { BirdFlock, MoteField, RainField } from './weatherFx';
import { WaterView } from './water';

export interface AtmosphereInit {
  terrain: Terrain;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  sun: THREE.DirectionalLight;
  moon: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
}

/** Test/debug override: pin the hour and/or weather regardless of simulation time. */
export interface AtmosphereOverride {
  tod?: number | null;
  rain?: number | null;
  mist?: number | null;
}

const LIGHT_DISTANCE = 120;
const MAX_RAIN = 2600, MAX_MOTES = 320, MAX_BIRDS = 12;

/**
 * Owns the sky dome, sea, light rig, fog and weather effects, and drives them all from the pure
 * environment model each frame. Every colour and vector is a preallocated scratch object, so a
 * frame allocates nothing.
 */
export class Atmosphere {
  readonly water: WaterView;
  readonly sky = createSkyState();
  readonly weather: Weather = { rain: 0, mist: 0 };
  override: AtmosphereOverride = {};

  private readonly dome: SkyDome;
  private readonly rain = new RainField(MAX_RAIN);
  private readonly motes = new MoteField(MAX_MOTES);
  private readonly birds: BirdFlock;
  private readonly fog: THREE.Fog;
  // Preallocated scratch objects: updating the atmosphere allocates nothing per frame.
  private readonly cZenith = new THREE.Color();
  private readonly cHorizon = new THREE.Color();
  private readonly cSun = new THREE.Color();
  private readonly cMoon = new THREE.Color();
  private readonly cHemiSky = new THREE.Color();
  private readonly cHemiGround = new THREE.Color();
  private readonly cShallow = new THREE.Color();
  private readonly cDeep = new THREE.Color();
  private readonly vSun = new THREE.Vector3();
  private readonly vMoon = new THREE.Vector3();
  private tod = START_TIME_OF_DAY;

  constructor(private readonly init: AtmosphereInit) {
    const { terrain, scene } = init;
    this.dome = new SkyDome(terrain.size);
    this.water = new WaterView(terrain);
    this.birds = new BirdFlock(MAX_BIRDS, terrain.size);
    this.fog = scene.fog as THREE.Fog;
    scene.add(this.dome.mesh, this.water.group, this.rain.object, this.motes.object, this.birds.object);
  }

  /** Quality preset: how many GPU-animated particles/birds are drawn. */
  setQuality(quality: Settings['quality']): void {
    const p = QUALITY_PRESETS[quality];
    this.rain.setCount(p.rainDrops);
    this.motes.setCount(p.motes);
    this.birds.setCount(p.birds);
  }

  get timeOfDay(): number { return this.tod; }

  private static set(c: THREE.Color, v: RGB): THREE.Color {
    return c.setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace); // model colours are sRGB; the working space is linear
  }

  /**
   * @param simSeconds simulation time (drives day/night and weather)
   * @param wallSeconds real elapsed time (drives waves, wind, particles so they keep moving while paused)
   * @param target world point the camera is looking at
   */
  update(simSeconds: number, wallSeconds: number, target: THREE.Vector3, settings: Settings): void {
    const tod = this.override.tod ?? (settings.dayNight ? timeOfDay(simSeconds) : START_TIME_OF_DAY);
    this.tod = tod;
    if (settings.weather) weatherAt(simSeconds, tod, this.init.terrain.seed, this.weather);
    else { this.weather.rain = 0; this.weather.mist = 0; }
    if (this.override.rain != null) this.weather.rain = this.override.rain;
    if (this.override.mist != null) this.weather.mist = this.override.mist;

    const s: SkyState = computeSky(this.sky, tod, this.weather);
    const { sun, moon, hemi, renderer } = this.init;

    // Lights follow the camera target so the shadow frustum always covers what is on screen.
    this.vSun.set(s.sunDir[0], s.sunDir[1], s.sunDir[2]);
    this.vMoon.set(s.moonDir[0], s.moonDir[1], s.moonDir[2]);
    sun.position.copy(target).addScaledVector(this.vSun, LIGHT_DISTANCE);
    sun.target.position.copy(target);
    sun.color.copy(Atmosphere.set(this.cSun, s.sunColor));
    sun.intensity = s.sunIntensity;
    moon.position.copy(target).addScaledVector(this.vMoon, LIGHT_DISTANCE);
    moon.target.position.copy(target);
    moon.color.copy(Atmosphere.set(this.cMoon, s.moonColor));
    moon.intensity = s.moonIntensity;
    hemi.color.copy(Atmosphere.set(this.cHemiSky, s.hemiSky));
    hemi.groundColor.copy(Atmosphere.set(this.cHemiGround, s.hemiGround));
    hemi.intensity = s.hemiIntensity;
    renderer.toneMappingExposure = s.exposure;

    Atmosphere.set(this.cHorizon, s.horizon);
    Atmosphere.set(this.cZenith, s.zenith);
    this.fog.color.copy(this.cHorizon);
    this.fog.near = s.fogNear;
    this.fog.far = s.fogFar;
    this.dome.update(this.cZenith, this.cHorizon, this.vSun, this.vMoon, this.cSun, s.sunIntensity > 0.05 ? 1 - this.weather.rain * 0.8 : 0, s.moonIntensity > 0.05 ? 1 - this.weather.rain : 0, s.stars);

    const t = settings.reducedMotion ? 0 : wallSeconds;
    this.water.update(
      t, Atmosphere.set(this.cShallow, s.waterShallow), Atmosphere.set(this.cDeep, s.waterDeep), this.cHorizon, this.vSun, this.cSun,
      Math.min(1, s.sunIntensity / 2.2) * (1 - this.weather.rain * 0.7), this.weather.rain, settings.reducedMotion ? 0.6 : 1,
    );
    if (!settings.reducedMotion) this.water.setLevel(-0.05 + Math.sin(wallSeconds * 0.8) * 0.03);

    // Particle volumes are centred on the camera target, resting on the ground height there.
    const ground = heightAt(this.init.terrain, target.x, target.z);
    this.rain.update(t, target.x, ground - 2, target.z, this.weather.rain);
    const night = 1 - s.day;
    this.motes.update(t, target.x, ground, target.z, night, 1 - this.weather.rain, !settings.reducedMotion);
    this.birds.update(wallSeconds, s.day > 0.6 && this.weather.rain < 0.35, settings.reducedMotion);
  }

  dispose(): void {
    const { scene } = this.init;
    scene.remove(this.dome.mesh, this.water.group, this.rain.object, this.motes.object, this.birds.object);
    this.dome.dispose();
    this.water.dispose();
    this.rain.dispose();
    this.motes.dispose();
    this.birds.dispose();
  }
}
