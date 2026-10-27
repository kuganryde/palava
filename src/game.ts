import * as THREE from 'three';
import { BUILDABLE, BUILDING_DEFS, MAX_UNITS, SIM_STEP, TRAINABLE, UNIT_DEFS, type BuildingType, type UnitKind } from './core/defs';
import { canAfford, incomePerSecond, popCap, type GameState } from './core/state';
import { InputController } from './input';
import { BuildingsView } from './render/buildingsView';
import { loadUnitAsset, loadUnitManifest, UnitAssetLibrary } from './render/units/gltfUnits';
import { CameraRig } from './render/cameraRig';
import { Atmosphere } from './render/atmosphere';
import { createScene, type SceneContext } from './render/scene';
import { createTerrainMesh } from './render/terrainView';
import { UnitsView } from './render/unitsView';
import { VegetationView } from './render/vegetationView';
import { AdaptiveResolution } from './systems/adaptive';
import type { FormationKind } from './systems/formation';
import type { NavGrid } from './systems/pathfinding';
import { footprintOrigin, PLACEMENT_MESSAGES, validatePlacement } from './systems/placement';
import { safeLocalStorage, SaveStore, type LoadResult } from './systems/save';
import { boxSelect, mergeSelection, pickNearest, type ScreenItem } from './systems/selection';
import {
  defaultSettings, loadSettings, QUALITY_PRESETS, saveSettings, type Settings,
} from './systems/settings';
import { buildNav, commandMove, createNewGame, placeBuilding, recruitUnit, stepSimulation } from './systems/simulation';
import { AmbientAudio } from './audio/ambient';
import { HealthBars, type BarItem } from './ui/healthBars';
import { clockText } from './world/environment';
import { capitalCenter, generateTerrain, heightAt, intersectRay, type Terrain } from './world/terrain';
import { placeVegetation } from './world/vegetation';
import { Hud, type SelectionInfo } from './ui/hud';
import { Minimap } from './ui/minimap';

const WORLD_SEED = 1337;
const AUTOSAVE_SECONDS = 30;
const MAX_FRAME_ERRORS = 5;

const RECRUIT_ERRORS: Record<string, string> = {
  'no-building': 'Select a building that trains units first', 'not-barracks': 'This building cannot train that unit',
  'under-construction': 'Barracks is still under construction', 'unit-limit': 'Unit limit reached',
  population: 'Population is full — build more housing', unaffordable: 'Not enough resources', 'no-space': 'No room to spawn',
};

export class Game {
  private readonly terrain: Terrain;
  private nav!: NavGrid;
  private state!: GameState;
  private readonly ctx: SceneContext;
  private readonly rig: CameraRig;
  private readonly buildingsView: BuildingsView;
  /** Authored GLB characters, if any were loaded; empty means every unit uses its procedural placeholder. */
  private readonly unitAssets = new UnitAssetLibrary();
  private readonly unitsView: UnitsView;
  private readonly vegView: VegetationView;
  private readonly atmosphere: Atmosphere;
  private readonly clearedBuildings = new Set<number>();
  private readonly minimap: Minimap;
  private readonly hud: Hud;
  private readonly input: InputController;
  private readonly saves: SaveStore;
  private readonly store = safeLocalStorage();
  private readonly adaptive = new AdaptiveResolution(0.55, 1, 16.7);
  private settings: Settings;

  private selectedUnits = new Set<number>();
  private selectedBuilding: number | null = null;
  private placing: BuildingType | null = null;
  private formation: FormationKind = 'line';
  private paused = false;
  private speed: 1 | 2 = 1;
  private menuOpen = true;
  private inGame = false;
  private pointer = { x: 0, y: 0, inside: false };

  private acc = 0;
  private alpha = 1;
  private lastTs = 0;
  private hudTimer = 0;
  private statsTimer = 0;
  private autosaveTimer = 0;
  private frameEma = 16.7;
  private appliedRatio = 0;
  private errorCount = 0;
  private raf = 0;
  private showStats = false;
  private marker: THREE.Mesh;
  private markerLife = 0;
  private readonly clock = new THREE.Clock(false);
  private readonly audio = new AmbientAudio();
  private readonly bars: HealthBars;
  private readonly barItems: BarItem[] = [];
  private readonly barPos = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.settings = loadSettings(this.store, defaultSettings(reduced));
    this.terrain = generateTerrain(WORLD_SEED);
    this.saves = new SaveStore(this.store, this.terrain.size);

    this.ctx = createScene(canvas, this.terrain.size, this.settings); // throws a readable Error without WebGL
    const { scene } = this.ctx;
    scene.add(createTerrainMesh(this.terrain));
    this.atmosphere = new Atmosphere({ terrain: this.terrain, scene, renderer: this.ctx.renderer, sun: this.ctx.sun, moon: this.ctx.moon, hemi: this.ctx.hemi });
    this.vegView = new VegetationView(placeVegetation(this.terrain));
    this.buildingsView = new BuildingsView(this.terrain);
    this.unitsView = new UnitsView(this.terrain);
    scene.add(this.vegView.group, this.buildingsView.group, this.unitsView.group);
    this.unitsView.setAssets(this.unitAssets);
    this.loadModelsFromUrl();

    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.65, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false }),
    );
    this.marker.visible = false;
    this.marker.renderOrder = 8;
    scene.add(this.marker);

    this.rig = new CameraRig(window.innerWidth / window.innerHeight, this.terrain.size);
    this.hud = new Hud({
      onBuild: (t) => this.startPlacing(t),
      onFormation: (f) => { this.formation = f; this.refreshHud(true); },
      onRecruit: (k) => this.recruit(k),
      onPauseToggle: () => this.togglePause(),
      onSpeed: (s) => { this.speed = s; this.paused = false; this.syncPause(); },
      onMenu: () => this.openMenu(),
      onResume: () => this.closeMenu(),
      onContinue: () => this.continueGame(),
      onNewGame: () => this.newGame(),
      onSave: () => this.saveManual(),
      onLoad: () => this.loadManual(),
      onSettings: (s) => this.changeSettings(s),
      onSoundToggle: () => this.changeSettings({ sound: !this.settings.sound }),
    });
    this.minimap = new Minimap(document.getElementById('minimap') as HTMLCanvasElement, this.terrain, (x, z) => this.rig.setTarget(x, z, false));
    this.input = new InputController(canvas, this.rig, {
      onClick: (x, y, shift) => this.handleClick(x, y, shift),
      onBoxSelect: (a, b, c, d, shift) => this.handleBox(a, b, c, d, shift),
      onRightClick: (x, y) => this.handleRightClick(x, y),
      onHover: (x, y) => { this.pointer = { x, y, inside: true }; },
      onBuildHotkey: (i) => { const t = BUILDABLE[i]; if (t) this.startPlacing(t); },
      onPauseToggle: () => this.togglePause(),
      onEscape: () => this.handleEscape(),
      onHome: () => this.focusCapital(),
      onToggleSound: () => this.changeSettings({ sound: !this.settings.sound }),
      onToggleStats: () => { this.showStats = !this.showStats; this.hud.showStats(this.showStats); },
    });
    this.input.enabled = false;
    this.rig.ground = (x, z) => heightAt(this.terrain, x, z);
    this.bars = new HealthBars(document.getElementById('bars') as HTMLCanvasElement);
    // Browsers only allow audio after a user gesture: the first real interaction starts the soundscape.
    const unlock = (): void => { this.audio.start(); this.audio.setEnabled(this.settings.sound); };
    for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, unlock, { once: false, passive: true });

    // A world to look at behind the main menu.
    this.setWorld(createNewGame(this.terrain));
    this.hud.syncSettings(this.settings);
    this.hud.showStats(false);
    this.applySettings();
    this.resize();

    window.addEventListener('resize', this.resize);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.hud.toast('Graphics context lost — waiting for the browser to restore it…', 'error'); });
    canvas.addEventListener('webglcontextrestored', () => { this.applySettings(); this.hud.toast('Graphics restored', 'good'); });
    window.addEventListener('pagehide', () => this.autosave(true));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.autosave(true); });

    this.showMainMenu();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ───────────────────────────── lifecycle / menus ─────────────────────────────

  private setWorld(g: { state: GameState; nav: NavGrid }): void {
    this.state = g.state;
    this.nav = g.nav;
    this.selectedUnits.clear();
    this.selectedBuilding = null;
    this.cancelPlacing();
    this.vegView.restoreAll();
    this.clearedBuildings.clear();
    this.acc = 0;
    this.alpha = 1;
    this.focusCapital(true);
    this.rig.setZoom(1.35);
    for (const u of this.state.units) { u.px = u.x; u.pz = u.z; }
  }

  private showMainMenu(note = ''): void {
    this.menuOpen = true;
    this.input.enabled = false;
    this.hud.showHud(false);
    this.hud.showOverlay({ inGame: false, canContinue: this.saves.has('autosave') || this.saves.has('manual'), note });
  }

  private startPlaying(): void {
    this.inGame = true;
    this.menuOpen = false;
    this.paused = false;
    this.input.enabled = true;
    this.hud.hideOverlay();
    this.hud.showHud(true);
    this.syncPause();
    this.refreshHud(true);
    this.canvas.focus({ preventScroll: true });
  }

  private newGame(): void {
    this.setWorld(createNewGame(this.terrain));
    this.autosaveTimer = 0;
    this.startPlaying();
    this.hud.toast('A new kingdom begins. Build, recruit, and explore.', 'good');
  }

  private applyLoaded(r: LoadResult): void {
    if (!r.ok) { this.hud.setNote(r.error); this.hud.toast(r.error, 'error'); return; }
    if (r.state.seed !== this.terrain.seed) {
      const msg = 'This save belongs to a different world and cannot be loaded.';
      this.hud.setNote(msg); this.hud.toast(msg, 'error');
      return;
    }
    this.setWorld({ state: r.state, nav: buildNav(this.terrain, r.state) });
    this.autosaveTimer = 0;
    this.startPlaying();
    this.hud.toast('Game loaded', 'good');
  }

  private continueGame(): void {
    const a = this.saves.load('autosave');
    this.applyLoaded(a.ok ? a : this.saves.load('manual'));
  }

  private loadManual(): void { this.applyLoaded(this.saves.load('manual')); }

  private saveManual(): void {
    const r = this.saves.save('manual', this.state);
    const msg = r.ok ? 'Game saved' : r.error;
    this.hud.setNote(msg);
    this.hud.toast(msg, r.ok ? 'good' : 'error');
  }

  private autosave(silent: boolean): void {
    if (!this.inGame) return;
    const r = this.saves.save('autosave', this.state);
    if (!r.ok && !silent) this.hud.toast(`Autosave failed: ${r.error}`, 'error');
  }

  private openMenu(): void {
    if (!this.inGame) return;
    this.cancelPlacing();
    this.menuOpen = true;
    this.input.enabled = false;
    this.hud.showOverlay({ inGame: true, canContinue: false });
  }

  private closeMenu(): void {
    if (!this.inGame) return;
    this.menuOpen = false;
    this.input.enabled = true;
    this.hud.hideOverlay();
    this.canvas.focus({ preventScroll: true });
  }

  private handleEscape(): void {
    if (this.menuOpen) { if (this.inGame) this.closeMenu(); return; }
    if (this.placing) { this.cancelPlacing(); return; }
    this.openMenu();
  }

  private togglePause(): void {
    if (!this.inGame || this.menuOpen) return;
    this.paused = !this.paused;
    this.syncPause();
  }

  private syncPause(): void { this.hud.setPaused(this.paused, this.speed); }

  private changeSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.store, this.settings);
    this.applySettings();
  }

  private applySettings(): void {
    const preset = QUALITY_PRESETS[this.settings.quality];
    this.ctx.applySettings(this.settings);
    this.vegView.setQuality(preset, this.settings.shadows && preset.shadowMapSize > 0);
    this.atmosphere.setQuality(this.settings.quality);
    this.rig.smoothing = !this.settings.reducedMotion;
    this.audio.setEnabled(this.settings.sound);
    this.adaptive.reset(1);
    this.appliedRatio = 0; // force pixel-ratio re-application next frame
    this.hud.syncSettings(this.settings);
  }

  private resize = (): void => {
    const w = window.innerWidth, h = window.innerHeight;
    this.ctx.renderer.setSize(w, h, false);
    this.rig.resize(w, h);
    this.bars.resize(w, h, window.devicePixelRatio || 1);
  };

  private focusCapital(instant = false): void {
    const c = capitalCenter(this.terrain.size);
    this.rig.setTarget(c.x, c.z + 2, instant);
  }

  // ───────────────────────────── picking ─────────────────────────────

  private ndc(x: number, y: number): { x: number; y: number } {
    return { x: (x / this.canvas.clientWidth) * 2 - 1, y: -(y / this.canvas.clientHeight) * 2 + 1 };
  }

  private pickGround(x: number, y: number): { x: number; z: number } | null {
    const n = this.ndc(x, y);
    const ray = this.rig.rayFromNdc(n.x, n.y);
    const hit = intersectRay(this.terrain, ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, 600);
    return hit ? { x: hit.x, z: hit.z } : null;
  }

  private unitScreenItems(): ScreenItem[] {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const out: ScreenItem[] = [];
    for (const u of this.state.units) {
      this.unitsView.renderPosition(u, this.alpha, this.tmp).y += 0.6;
      this.tmp.project(this.rig.camera);
      if (this.tmp.z < -1 || this.tmp.z > 1) continue;
      out.push({ id: u.id, sx: (this.tmp.x * 0.5 + 0.5) * w, sy: (-this.tmp.y * 0.5 + 0.5) * h });
    }
    return out;
  }

  // ───────────────────────────── input intents ─────────────────────────────

  private handleClick(x: number, y: number, shift: boolean): void {
    if (this.menuOpen) return;
    if (this.placing) { this.tryPlace(x, y, shift); return; }
    const id = pickNearest(this.unitScreenItems(), x, y, 24);
    if (id !== null) {
      this.selectedUnits = mergeSelection(this.selectedUnits, [id], shift);
      this.selectedBuilding = null;
      this.refreshHud(true);
      return;
    }
    const n = this.ndc(x, y);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(n.x, n.y), this.rig.camera);
    const b = this.buildingsView.pick(rc);
    if (b !== null) {
      this.selectedBuilding = b;
      if (!shift) this.selectedUnits.clear();
    } else if (!shift) {
      this.selectedBuilding = null;
      this.selectedUnits.clear();
    }
    this.refreshHud(true);
  }

  private handleBox(x1: number, y1: number, x2: number, y2: number, shift: boolean): void {
    if (this.menuOpen || this.placing) return;
    const ids = boxSelect(this.unitScreenItems(), x1, y1, x2, y2);
    this.selectedUnits = mergeSelection(this.selectedUnits, ids, shift);
    if (ids.length > 0) this.selectedBuilding = null;
    this.refreshHud(true);
  }

  private handleRightClick(x: number, y: number): void {
    if (this.menuOpen) return;
    if (this.placing) { this.cancelPlacing(); return; }
    if (this.selectedUnits.size === 0) return;
    const g = this.pickGround(x, y);
    if (!g) return;
    const moved = commandMove(this.state, this.nav, this.selectedUnits, g, this.formation);
    if (moved === 0) { this.hud.toast('Units cannot reach that spot', 'error'); return; }
    this.marker.position.set(g.x, this.groundHeight(g.x, g.z) + 0.15, g.z);
    this.marker.visible = true;
    this.markerLife = 1;
  }

  private groundHeight(x: number, z: number): number {
    return heightAt(this.terrain, x, z);
  }

  private startPlacing(type: BuildingType): void {
    if (!this.inGame || this.menuOpen) return;
    if (this.placing === type) { this.cancelPlacing(); return; }
    if (!canAfford(this.state.resources, BUILDING_DEFS[type].cost)) {
      this.hud.toast(`Not enough resources for a ${BUILDING_DEFS[type].name}`, 'error');
      return;
    }
    this.placing = type;
    this.input.boxSelectEnabled = false;
    this.refreshHud(true);
  }

  private cancelPlacing(): void {
    this.placing = null;
    this.input.boxSelectEnabled = true;
    this.buildingsView.setGhost(null);
    this.refreshHud(true);
  }

  private tryPlace(x: number, y: number, keepPlacing: boolean): void {
    const type = this.placing;
    const g = this.pickGround(x, y);
    if (!type || !g) return;
    const r = placeBuilding(this.state, this.terrain, this.nav, type, g.x, g.z);
    if (!r.ok) { this.hud.toast(PLACEMENT_MESSAGES[r.reason], 'error'); return; }
    this.hud.toast(`${BUILDING_DEFS[type].name} construction started`, 'good');
    if (keepPlacing && canAfford(this.state.resources, BUILDING_DEFS[type].cost)) this.refreshHud(true);
    else this.cancelPlacing();
  }

  private recruit(kind: UnitKind): void {
    if (this.selectedBuilding === null) return;
    const r = recruitUnit(this.state, this.nav, this.selectedBuilding, kind);
    if (r.ok) this.hud.toast(`${UNIT_DEFS[kind].name} recruited`, 'good');
    else this.hud.toast(RECRUIT_ERRORS[r.reason] ?? 'Cannot recruit', 'error');
    this.refreshHud(true);
  }

  // ───────────────────────────── HUD sync ─────────────────────────────

  private selectionInfo(): SelectionInfo {
    if (this.selectedUnits.size > 0) {
      const counts: Partial<Record<UnitKind, number>> = {};
      let hp = 0, moving = 0, n = 0;
      for (const u of this.state.units) {
        if (!this.selectedUnits.has(u.id)) continue;
        counts[u.kind] = (counts[u.kind] ?? 0) + 1;
        hp += u.hp / UNIT_DEFS[u.kind].hp;
        if (u.path.length) moving++;
        n++;
      }
      if (n > 0) return { kind: 'units', counts, avgHpFraction: hp / n, moving, formation: this.formation };
    }
    const b = this.selectedBuilding === null ? undefined : this.state.buildings.find((x) => x.id === this.selectedBuilding);
    if (b) {
      const def = BUILDING_DEFS[b.type];
      const full = this.state.units.length >= Math.min(popCap(this.state), MAX_UNITS);
      return {
        kind: 'building', name: def.name, description: def.description, progress: Math.round(b.progress * 100) / 100,
        recruit: TRAINABLE[b.type] && b.progress >= 1
          ? TRAINABLE[b.type]!.map((k) => ({ kind: k, enabled: !full && canAfford(this.state.resources, UNIT_DEFS[k].cost) }))
          : null,
      };
    }
    return { kind: 'none' };
  }

  private refreshHud(force = false): void {
    if (!force && this.hudTimer < 0.1) return;
    this.hudTimer = 0;
    // Drop selections that no longer exist (e.g. after loading).
    if (this.selectedUnits.size) {
      const alive = new Set(this.state.units.map((u) => u.id));
      for (const id of this.selectedUnits) if (!alive.has(id)) this.selectedUnits.delete(id);
    }
    this.hud.setResources(this.state.resources, incomePerSecond(this.state), this.state.units.length, popCap(this.state), this.state.time);
    const tod = this.atmosphere.timeOfDay, day = this.atmosphere.sky.day;
    this.hud.setDayTime(clockText(tod), day > 0.7 ? 'day' : day > 0.25 ? 'dusk' : 'night');
    this.hud.setBuildState(this.state.resources, this.placing);
    this.hud.setSelection(this.selectionInfo(), this.formation);
    this.minimap.draw(this.state, this.selectedUnits, this.rig.groundCorners());
  }

  // ───────────────────────────── main loop ─────────────────────────────

  private frame = (ts: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    try {
      this.tick(ts);
      this.errorCount = 0;
    } catch (e) {
      console.error('Frame error:', e);
      if (++this.errorCount >= MAX_FRAME_ERRORS) {
        cancelAnimationFrame(this.raf);
        this.hud.fatal('Something went wrong and the game had to stop. Please reload the page — your last autosave is kept.');
      }
    }
  };

  private tick(ts: number): void {
    const frameMs = this.lastTs ? ts - this.lastTs : 16.7;
    this.lastTs = ts;
    const dt = Math.min(frameMs / 1000, 0.25);
    this.frameEma += (Math.min(frameMs, 250) - this.frameEma) * 0.1;

    // Fixed-timestep simulation with a spiral-of-death guard.
    if (this.inGame && !this.paused && !this.menuOpen) {
      this.acc += dt * this.speed;
      let steps = 0;
      while (this.acc >= SIM_STEP && steps < 6) { stepSimulation(this.state, SIM_STEP); this.acc -= SIM_STEP; steps++; }
      if (steps === 6) this.acc = 0;
      this.alpha = this.acc / SIM_STEP;
      this.autosaveTimer += dt;
      if (this.autosaveTimer >= AUTOSAVE_SECONDS) { this.autosaveTimer = 0; this.autosave(false); }
    }

    this.input.update(dt);
    this.rig.update(dt);
    this.updateMarker(dt);
    this.updatePlacementGhost();
    if (!this.clock.running) this.clock.start();
    const t = this.clock.getElapsedTime();

    this.atmosphere.update(this.state.time, t, this.rig.target, this.settings);
    this.vegView.update(this.rig.zoom, t, this.settings.reducedMotion);
    for (const b of this.state.buildings) {
      if (this.clearedBuildings.has(b.id)) continue;
      this.clearedBuildings.add(b.id);
      const def = BUILDING_DEFS[b.type];
      this.vegView.clearRect(b.x0, b.z0, def.w, def.d);
    }
    this.buildingsView.sync(this.state, this.selectedBuilding, t, this.settings.reducedMotion);
    this.unitsView.update(this.state, this.selectedUnits, this.alpha, t, this.settings.reducedMotion);

    this.hudTimer += dt;
    if (this.inGame) this.refreshHud();

    this.updateResolution(frameMs);
    this.ctx.renderer.render(this.ctx.scene, this.rig.camera);
    this.drawBars();
    this.audio.update(this.atmosphere.sky.day, this.atmosphere.weather.rain, this.rig.zoom);

    this.statsTimer += dt;
    if (this.showStats && this.statsTimer > 0.5) {
      this.statsTimer = 0;
      const info = this.ctx.renderer.info.render;
      this.hud.setStats(
        `${Math.round(1000 / this.frameEma)} fps · ${info.calls} draw calls · ${Math.round(info.triangles / 1000)}k tris · ` +
        `${this.state.units.length} units · ${this.vegView.drawnTrees} trees · ×${(this.appliedRatio).toFixed(2)} res`,
      );
    }
  }

  /** Health bars only for selected or wounded units, drawn after the 3D frame on a 2D overlay. */
  private drawBars(): void {
    const items = this.barItems;
    items.length = 0;
    if (this.inGame) {
      for (const u of this.state.units) {
        const def = UNIT_DEFS[u.kind];
        const sel = this.selectedUnits.has(u.id);
        if (!sel && u.hp >= def.hp) continue;
        this.unitsView.renderPosition(u, this.alpha, this.barPos);
        items.push({ x: this.barPos.x, y: this.barPos.y + def.radius * 3.2 + 1.2, z: this.barPos.z, frac: u.hp / def.hp, selected: sel, width: Math.max(0.8, def.radius * 1.6) });
      }
    }
    this.bars.draw(items, this.rig.camera, this.rig.zoom);
  }

  private updateMarker(dt: number): void {
    if (this.markerLife <= 0) { this.marker.visible = false; return; }
    this.markerLife = Math.max(0, this.markerLife - dt * 1.5);
    const k = this.settings.reducedMotion ? 1 : 1 + (1 - this.markerLife) * 1.4;
    this.marker.scale.set(k, 1, k);
    (this.marker.material as THREE.MeshBasicMaterial).opacity = this.markerLife;
  }

  private updatePlacementGhost(): void {
    if (!this.placing || this.menuOpen || !this.pointer.inside) { if (!this.placing) this.buildingsView.setGhost(null); return; }
    const g = this.pickGround(this.pointer.x, this.pointer.y);
    if (!g) { this.buildingsView.setGhost(null); return; }
    const def = BUILDING_DEFS[this.placing];
    const { x0, z0 } = footprintOrigin(def, g.x, g.z);
    const valid = validatePlacement(this.state, this.terrain, this.placing, g.x, g.z).ok;
    this.buildingsView.setGhost(this.placing, x0, z0, valid);
  }

  private updateResolution(frameMs: number): void {
    const preset = QUALITY_PRESETS[this.settings.quality];
    const scale = this.settings.adaptiveResolution && !this.menuOpen ? this.adaptive.update(frameMs) : this.adaptive.scale;
    const ratio = Math.max(0.5, Math.min(window.devicePixelRatio || 1, preset.maxPixelRatio) * scale);
    if (Math.abs(ratio - this.appliedRatio) > 0.04) {
      this.appliedRatio = ratio;
      this.ctx.setPixelRatio(ratio);
    }
  }

  /**
   * Opt-in authored models: `?models=<manifest url>` (same origin only) points at a JSON manifest of
   * `{ "units": { "infantry": "infantry.glb", ... } }`. Nothing is requested unless the parameter is present,
   * and any failure leaves the procedural placeholders in place with a console warning.
   */
  private loadModelsFromUrl(): void {
    const manifest = new URLSearchParams(location.search).get('models');
    if (!manifest) return;
    loadUnitManifest(manifest, this.unitAssets).then(
      (r) => {
        if (r.failed.length) console.warn('Some unit models failed to load; using placeholders for them:', r.failed);
        if (r.loaded.length) console.info(`Loaded authored unit models: ${r.loaded.join(', ')}`);
      },
      (e) => console.warn('Unit model manifest failed; using procedural placeholders.', e instanceof Error ? e.message : e),
    );
  }

  // Test / debug hooks (dev only; see main.ts).
  debug() {
    return {
      state: this.state, terrain: this.terrain, nav: this.nav, rig: this.rig, atmosphere: this.atmosphere,
      selectedUnits: this.selectedUnits, newGame: () => this.newGame(), unitScreenItems: () => this.unitScreenItems(),
      handleClick: (x: number, y: number, s = false) => this.handleClick(x, y, s),
      handleBox: (a: number, b: number, c: number, d: number, s = false) => this.handleBox(a, b, c, d, s),
      handleRightClick: (x: number, y: number) => this.handleRightClick(x, y),
      startPlacing: (t: BuildingType) => this.startPlacing(t), saveManual: () => this.saveManual(), loadManual: () => this.loadManual(),
      /** World (x, z) to CSS-pixel screen position on the canvas. */
      project: (x: number, z: number) => {
        const v = new THREE.Vector3(x, heightAt(this.terrain, x, z), z).project(this.rig.camera);
        return { x: (v.x * 0.5 + 0.5) * this.canvas.clientWidth, y: (-v.y * 0.5 + 0.5) * this.canvas.clientHeight };
      },
      validate: (t: BuildingType, x: number, z: number) => validatePlacement(this.state, this.terrain, t, x, z),
      placingType: () => this.placing,
      /** Force an animation clip on a unit (0 idle … 6 death); null releases it. */
      setClip: (id: number, clip: number | null) => this.unitsView.setClipOverride(id, clip),
      unitsView: this.unitsView,
      buildingsView: this.buildingsView,
      /** Load an authored skinned model for a unit kind (same-origin or blob URL). */
      loadUnitModel: async (kind: UnitKind, url: string) => { const a = await loadUnitAsset(kind, url); this.unitAssets.set(a); return { missing: a.missing }; },
    };
  }
}
