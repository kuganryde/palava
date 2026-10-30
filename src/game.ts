import * as THREE from 'three';
import { BUILDABLE, BUILDING_DEFS, MAX_UNITS, SIM_STEP, TRAINABLE, UNIT_DEFS, type BuildingType, type UnitKind } from './core/defs';
import { buildingHp, buildingTeam, canAfford, incomePerSecond, isAlive, popCap, population, teamOf, workersOnSite, type GameState, type Team } from './core/state';
import { commandAttack } from './systems/combat';
import { loadBuildingManifest } from './render/buildingGltf';
import { nullPlatform, type Platform } from './platform/platform';
import { INTRO_SECONDS, TITLE_FROM, introShot, lineAt, revealed } from './story/intro';
import { beatById, markSeen, newBeats } from './story/story';
import { STEPS, advance, isComplete } from './story/tutorial';
import { commandWork } from './systems/economy';
import { addEnemyBase } from './systems/enemyAi';
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
import { footprintCenter, footprintOrigin, PLACEMENT_MESSAGES, validatePlacement } from './systems/placement';
import { safeLocalStorage, SaveStore, type KeyValueStore, type LoadResult } from './systems/save';
import { boxSelect, mergeSelection, pickNearest, type ScreenItem } from './systems/selection';
import {
  defaultSettings, loadSettings, QUALITY_PRESETS, saveSettings, type Settings,
} from './systems/settings';
import { buildNav, commandAttackMove, commandMove, createNewGame, placeBuilding, recruitUnit, stepSimulation } from './systems/simulation';
import { CombatFx } from './render/combatFx';
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
  private readonly store: KeyValueStore | null;
  private tutIndex = 0;
  private tutMoved = false;
  private tutRecruited = false;
  private adActive = false;
  private adPlaying = false;
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
  private outcomeShown = false;
  private introActive = false;
  private introT = 0;
  private introDone: (() => void) | null = null;
  private introCamera: { x: number; z: number; zoom: number; yaw: number } | null = null;
  private readonly fx: CombatFx;
  private attackMoveArmed = false;
  private readonly groups = new Map<number, number[]>();
  private lastRecall = { index: -1, at: 0 };
  private lastWave = 0;
  private readonly bars: HealthBars;
  private readonly barItems: BarItem[] = [];
  private readonly barPos = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly platform: Platform = nullPlatform) {
    // Portal storage (cloud saves for signed-in players) when available, otherwise localStorage.
    this.store = platform.store() ?? safeLocalStorage();
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
    this.fx = new CombatFx(this.terrain);
    this.unitsView.flashes = this.fx.flashes;
    scene.add(this.fx.group);
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
      onNewGame: () => this.requestNewGame(),
      onSave: () => this.saveManual(),
      onLoad: () => this.loadManual(),
      onSettings: (s) => this.changeSettings(s),
      onSoundToggle: () => this.changeSettings({ sound: !this.settings.sound }),
      onQuick: (k) => this.quickSelect(k),
      onTutorialSkip: () => this.skipTutorial(),
      onWatchIntro: () => this.watchIntro(),
      onIntroSkip: () => this.endIntro(),
    });
    this.minimap = new Minimap(document.getElementById('minimap') as HTMLCanvasElement, this.terrain, (x, z) => this.rig.setTarget(x, z, false));
    this.input = new InputController(canvas, this.rig, {
      onClick: (x, y, shift, touch) => this.handleClick(x, y, shift, touch),
      onQuick: (k) => this.quickSelect(k),
      onBoxSelect: (a, b, c, d, shift) => this.handleBox(a, b, c, d, shift),
      onRightClick: (x, y) => this.handleRightClick(x, y),
      onHover: (x, y) => { this.pointer = { x, y, inside: true }; },
      onBuildHotkey: (i) => { const t = BUILDABLE[i]; if (t) this.startPlacing(t); },
      onPauseToggle: () => this.togglePause(),
      onEscape: () => this.handleEscape(),
      onHome: () => this.focusCapital(),
      onAttackMove: () => this.armAttackMove(),
      onGroup: (i, a) => this.controlGroup(i, a),
      onToggleSound: () => this.changeSettings({ sound: !this.settings.sound }),
      onToggleStats: () => { this.showStats = !this.showStats; this.hud.showStats(this.showStats); },
    });
    this.input.enabled = false;
    this.rig.ground = (x, z) => heightAt(this.terrain, x, z);
    this.bars = new HealthBars(document.getElementById('bars') as HTMLCanvasElement);
    // Browsers only allow audio after a user gesture: the first real interaction starts the soundscape.
    const unlock = (): void => { this.audio.start(); this.audio.setEnabled(this.soundOn()); };
    // touchend/click as well: iOS needs a gesture to resume audio after an interruption, and a visibility change alone is not enough.
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'click'] as const) window.addEventListener(ev, unlock, { once: false, passive: true });

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
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.autosave(true);
      this.audio.setEnabled(this.soundOn() && !document.hidden); // a hidden tab is silent
    });
    this.platform.onMuteChange(() => this.audio.setEnabled(this.soundOn())); // the portal's mute wins over our toggle

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
    this.outcomeShown = false;
    this.hud.clearStory();
    this.syncChronicle();
    this.attackMoveArmed = false;
    this.canvas.style.cursor = '';
    this.groups.clear();
    this.lastWave = g.state.ai?.wave ?? 0;
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
    const g = createNewGame(this.terrain);
    addEnemyBase(g.state, this.terrain, g.nav, this.settings.difficulty); // rival stronghold + garrison; raids start after a grace period
    this.setWorld(g);
    this.autosaveTimer = 0;
    this.tutIndex = 0; this.tutMoved = false; this.tutRecruited = false;
    const begin = (): void => {
      this.startPlaying();
      this.hud.toast('A new kingdom begins. Build, recruit, and explore.', 'good');
    };
    if (this.settings.intro) this.playIntro(begin); else begin();
  }

  // ───────────────────────────── intro cinematic ─────────────────────────────

  /** Play the opening clip over the live world, then call `done`. Esc, Space, Enter or a click skips it. */
  private playIntro(done: () => void): void {
    this.introActive = true;
    this.introT = 0;
    this.introDone = done;
    this.introCamera = { x: this.rig.target.x, z: this.rig.target.z, zoom: this.rig.zoom, yaw: this.rig.yaw };
    this.menuOpen = true;
    this.input.enabled = false;
    this.hud.hideOverlay();
    this.hud.showHud(false);
    this.atmosphere.override = { tod: 0.27, rain: 0, mist: 0.12 }; // dawn light, clear air
    this.hud.showIntro(true);
  }

  private endIntro(): void {
    if (!this.introActive) return;
    this.introActive = false;
    this.hud.showIntro(false);
    this.atmosphere.override = {};
    const c = this.introCamera;
    if (c) { this.rig.setYaw(c.yaw); this.rig.setTarget(c.x, c.z, true); this.rig.setZoom(c.zoom, true); }
    this.introCamera = null;
    const done = this.introDone;
    this.introDone = null;
    done?.();
  }

  private watchIntro(): void {
    this.playIntro(() => { if (this.inGame) this.openMenu(); else this.showMainMenu(); });
  }

  private updateIntro(dt: number): void {
    this.introT += dt;
    const fort = this.state.buildings.find((b) => b.type === 'stronghold');
    const palace = this.state.buildings.find((b) => b.type === 'palace');
    const centre = (b: { x0: number; z0: number; type: BuildingType }): { x: number; z: number } => ({ x: b.x0 + BUILDING_DEFS[b.type].w / 2, z: b.z0 + BUILDING_DEFS[b.type].d / 2 });
    const cap = palace ? centre(palace) : { x: this.terrain.size / 2, z: this.terrain.size / 2 };
    const reduced = this.settings.reducedMotion;
    const shot = introShot(this.introT, cap, fort ? centre(fort) : null, reduced);
    this.rig.setYaw(shot.yaw);
    this.rig.setZoom(shot.zoom, true);
    this.rig.setTarget(shot.x, shot.z, true);
    const line = lineAt(this.introT);
    if (line) this.hud.setIntroLine(line.text, revealed(line.text, this.introT - line.from, reduced));
    else this.hud.setIntroLine('', '');
    this.hud.showIntroTitle(this.introT >= TITLE_FROM);
    if (this.introT >= INTRO_SECONDS) this.endIntro();
  }

  // ───────────────────────────── tutorial ─────────────────────────────

  /** Drive the guided objectives: show the current step, advance when it is done, finish cleanly. */
  private updateTutorial(): void {
    if (!this.settings.tutorial || !this.inGame || this.state.outcome) { this.hud.setTutorial(null); return; }
    if (this.tutIndex >= STEPS.length) { this.hud.setTutorial(null); return; }
    let farms = 0, staffed = 0, barracks = 0;
    for (const b of this.state.buildings) {
      if (buildingTeam(b) !== 0) continue;
      if (b.type === 'farm') farms++;
      if (b.type === 'barracks' && b.progress >= 1) barracks++;
      const slots = BUILDING_DEFS[b.type].slots;
      if (slots > 0 && b.progress >= 1) staffed += Math.min(slots, workersOnSite(this.state, b));
    }
    let selectedFighters = 0;
    for (const u of this.state.units) if (this.selectedUnits.has(u.id) && u.kind !== 'villager' && isAlive(u)) selectedFighters++;
    const next = advance(this.tutIndex, { selectedFighters, moved: this.tutMoved, farms, staffed, barracks, recruited: this.tutRecruited });
    if (next !== this.tutIndex) {
      this.tutIndex = next;
      if (isComplete(next)) {
        this.hud.setTutorial(null);
        this.hud.toast('Well done! Hold out against the raids, then break the rival stronghold.', 'good');
        this.changeSettings({ tutorial: false });
        return;
      }
    }
    const step = STEPS[this.tutIndex]!;
    this.hud.setTutorial({ index: this.tutIndex, total: STEPS.length, title: step.title, hint: step.hint(this.touchLikely) });
  }

  private skipTutorial(): void {
    this.tutIndex = STEPS.length;
    this.hud.setTutorial(null);
    this.changeSettings({ tutorial: false });
  }

  /** True on devices whose primary input is touch (decides which hints to show). */
  private get touchLikely(): boolean { return window.matchMedia?.('(pointer: coarse)').matches ?? false; }

  // ───────────────────────────── story ─────────────────────────────

  private syncChronicle(): void {
    this.hud.setChronicle((this.state.story ?? []).flatMap((id) => { const b = beatById(id); return b ? [{ title: b.title, text: b.text }] : []; }));
  }

  /** Show captions for milestones reached since the last check. Outcome epilogues appear on the end screen instead. */
  private checkStory(): void {
    const fresh = newBeats(this.state);
    if (fresh.length === 0) return;
    markSeen(this.state, fresh);
    for (const b of fresh) if (b.id !== 'victory' && b.id !== 'fall') this.hud.showStory(b.title, b.text);
    this.syncChronicle();
  }

  private applyLoaded(r: LoadResult): void {
    if (!r.ok) { this.hud.setNote(r.error); this.hud.toast(r.error, 'error'); return; }
    if (r.state.seed !== this.terrain.seed) {
      const msg = 'This save belongs to a different world and cannot be loaded.';
      this.hud.setNote(msg); this.hud.toast(msg, 'error');
      return;
    }
    const g = { state: r.state, nav: buildNav(this.terrain, r.state) };
    // Saves from before the story existed: mark already-true milestones as seen so they do not all fire at once.
    if (r.state.story === undefined) markSeen(r.state, newBeats(r.state));
    this.tutIndex = STEPS.length; // a loaded game is past the tutorial
    // Saves from before the rival existed get one now (unless the game was already decided).
    const rivalAdded = !g.state.outcome && !g.state.buildings.some((b) => b.type === 'stronghold') && addEnemyBase(g.state, this.terrain, g.nav, this.settings.difficulty);
    this.setWorld(g);
    this.autosaveTimer = 0;
    this.startPlaying();
    this.hud.toast(rivalAdded ? 'Game loaded — a rival stronghold has appeared' : 'Game loaded', 'good');
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
    if (!this.inGame || this.state.outcome) return; // a finished game is never autosaved
    const r = this.saves.save('autosave', this.state);
    if (!r.ok && !silent) this.hud.toast(`Autosave failed: ${r.error}`, 'error');
  }

  /** The game is decided: stop, clear the stale autosave, and show a result screen. */
  private showOutcome(outcome: 'victory' | 'defeat'): void {
    this.outcomeShown = true;
    this.saves.clear('autosave');
    this.menuOpen = true;
    this.input.enabled = false;
    this.cancelPlacing();
    this.hud.showHud(true);
    const won = outcome === 'victory';
    if (won) this.platform.happytime();
    this.hud.showOverlay({
      inGame: false, canContinue: false, title: won ? 'VICTORY' : 'DEFEAT',
      sub: `${won ? 'The rival stronghold has fallen. The kingdom is yours.' : 'Your palace has been destroyed.'} ${beatById(won ? 'victory' : 'fall')?.text ?? ''}`.trim(),
      note: 'Start a new game or load a saved one.',
    });
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
    if (this.introActive) { this.endIntro(); return; }
    if (this.menuOpen) { if (this.inGame && !this.state.outcome) this.closeMenu(); return; }
    if (this.placing) { this.cancelPlacing(); return; }
    if (this.attackMoveArmed) { this.disarmAttackMove(); return; }
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

  /** In-game sound setting, overridden by the portal's mute request and silenced while an ad plays. */
  private soundOn(): boolean { return this.settings.sound && !this.platform.muted && !this.adPlaying; }

  /**
   * New game. After a finished game this is a natural break, so a midgame ad may run first (the portal
   * decides whether one is shown and how often). Input stays blocked until the ad ends or fails.
   */
  private requestNewGame(): void {
    if (!this.outcomeShown || this.adActive) { if (!this.adActive) this.newGame(); return; }
    this.adActive = true;
    this.input.enabled = false;
    this.hud.showAdBlock(true);
    this.platform.requestMidgameAd({
      started: () => { this.adPlaying = true; this.audio.setEnabled(this.soundOn()); },
      finished: () => {
        this.adActive = false; this.adPlaying = false;
        this.audio.setEnabled(this.soundOn());
        this.hud.showAdBlock(false);
        this.newGame();
      },
    });
  }

  private applySettings(): void {
    const preset = QUALITY_PRESETS[this.settings.quality];
    this.ctx.applySettings(this.settings);
    this.vegView.setQuality(preset, this.settings.shadows && preset.shadowMapSize > 0);
    this.atmosphere.setQuality(this.settings.quality);
    this.rig.smoothing = !this.settings.reducedMotion;
    this.audio.setEnabled(this.soundOn());
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

  /** Screen positions of living units of one team (the player's by default). */
  private unitScreenItems(team: Team = 0): ScreenItem[] {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const out: ScreenItem[] = [];
    for (const u of this.state.units) {
      if (!isAlive(u) || teamOf(u) !== team) continue;
      this.unitsView.renderPosition(u, this.alpha, this.tmp).y += 0.6;
      this.tmp.project(this.rig.camera);
      if (this.tmp.z < -1 || this.tmp.z > 1) continue;
      out.push({ id: u.id, sx: (this.tmp.x * 0.5 + 0.5) * w, sy: (-this.tmp.y * 0.5 + 0.5) * h });
    }
    return out;
  }

  // ───────────────────────────── input intents ─────────────────────────────

  /** The building under a screen point, if any. */
  private pickBuildingAt(x: number, y: number): number | null {
    const n = this.ndc(x, y);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(n.x, n.y), this.rig.camera);
    return this.buildingsView.pick(rc);
  }

  private handleClick(x: number, y: number, shift: boolean, touch = false): void {
    if (this.menuOpen) return;
    if (this.placing) { this.tryPlace(x, y, shift); return; }
    if (this.attackMoveArmed) { this.doAttackMove(x, y); return; }
    const id = pickNearest(this.unitScreenItems(), x, y, 24);
    if (id !== null) {
      this.selectedUnits = mergeSelection(this.selectedUnits, [id], shift);
      this.selectedBuilding = null;
      this.refreshHud(true);
      return;
    }
    const b = this.pickBuildingAt(x, y);
    // Touch has no right button: with units selected, a tap on the ground, a foe or a workplace is the
    // command (move, attack, work). Tapping one of your own other buildings still selects it, and the
    // Clear button drops the selection.
    if (touch && this.selectedUnits.size > 0) {
      const wb = b === null ? undefined : this.state.buildings.find((x2) => x2.id === b);
      const ownOther = !!wb && buildingTeam(wb) === 0 && !(BUILDING_DEFS[wb.type].slots > 0);
      if (!ownOther) { this.handleRightClick(x, y); return; }
    }
    if (b !== null) {
      this.selectedBuilding = b;
      if (!shift) this.selectedUnits.clear();
    } else if (!shift) {
      this.selectedBuilding = null;
      this.selectedUnits.clear();
    }
    this.refreshHud(true);
  }

  /** Quick selection: all warriors, idle villagers, attack-move, or clear. Works with keys, buttons and touch. */
  private quickSelect(kind: 'army' | 'idle' | 'attack' | 'clear'): void {
    if (!this.inGame || this.menuOpen || this.placing) return;
    if (kind === 'attack') { this.armAttackMove(); return; }
    if (kind === 'clear') { this.disarmAttackMove(); this.selectedUnits.clear(); this.selectedBuilding = null; this.refreshHud(true); return; }
    const mine = this.state.units.filter((u) => isAlive(u) && teamOf(u) === 0);
    const picked = kind === 'army'
      ? mine.filter((u) => u.kind !== 'villager')
      : mine.filter((u) => u.kind === 'villager' && u.work == null && u.path.length === 0);
    if (picked.length === 0) { this.hud.toast(kind === 'army' ? 'No warriors to select' : 'No idle villagers', 'info'); return; }
    this.selectedUnits = new Set(picked.map((u) => u.id));
    this.selectedBuilding = null;
    if (kind === 'idle') this.rig.setTarget(picked[0]!.x, picked[0]!.z, false); // show where they are
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
    if (this.attackMoveArmed) { this.disarmAttackMove(); return; }
    if (this.selectedUnits.size === 0) return;
    // Right-clicking an enemy unit orders an attack instead of a move.
    const foe = pickNearest(this.unitScreenItems(1), x, y, 26);
    if (foe !== null) {
      if (commandAttack(this.state, this.selectedUnits, foe) === 0) this.hud.toast('Your units cannot attack that', 'error');
      else this.tutMoved = true;
      return;
    }
    // Right-clicking an enemy building attacks it; a farm, camp or quarry sends selected villagers to work there.
    const bid = this.pickBuildingAt(x, y);
    if (bid !== null) {
      const wb = this.state.buildings.find((b) => b.id === bid);
      if (wb && buildingTeam(wb) === 1) {
        if (commandAttack(this.state, this.selectedUnits, bid) === 0) this.hud.toast('Your units cannot attack that', 'error');
        else this.tutMoved = true;
        return;
      }
      if (wb && BUILDING_DEFS[wb.type].slots > 0 && wb.type !== 'stronghold') {
        if (wb.progress < 1) { this.hud.toast('Wait for it to be finished', 'info'); return; }
        const sent = commandWork(this.state, this.nav, this.selectedUnits, bid);
        if (sent === 0) this.hud.toast('Select villagers to put them to work', 'error');
        else this.hud.toast(`${sent} villager${sent === 1 ? '' : 's'} assigned to the ${BUILDING_DEFS[wb.type].name}`, 'good');
        return;
      }
    }
    const g = this.pickGround(x, y);
    if (!g) return;
    const moved = commandMove(this.state, this.nav, this.selectedUnits, g, this.formation);
    if (moved === 0) { this.hud.toast('Units cannot reach that spot', 'error'); return; }
    this.tutMoved = true;
    this.marker.position.set(g.x, this.groundHeight(g.x, g.z) + 0.15, g.z);
    this.marker.visible = true;
    this.markerLife = 1;
  }

  private armAttackMove(): void {
    if (!this.inGame || this.menuOpen || this.placing) return;
    if (this.selectedUnits.size === 0) { this.hud.toast('Select units first, then press F to attack-move', 'info'); return; }
    this.attackMoveArmed = true;
    this.canvas.style.cursor = 'crosshair';
    this.hud.toast('Attack-move: click a destination (Esc cancels)', 'info');
  }

  private disarmAttackMove(): void {
    this.attackMoveArmed = false;
    this.canvas.style.cursor = '';
  }

  private doAttackMove(x: number, y: number): void {
    this.disarmAttackMove();
    const g = this.pickGround(x, y);
    if (!g) return;
    if (commandAttackMove(this.state, this.nav, this.selectedUnits, g, this.formation) === 0) { this.hud.toast('Units cannot reach that spot', 'error'); return; }
    this.tutMoved = true;
    this.marker.position.set(g.x, this.groundHeight(g.x, g.z) + 0.15, g.z);
    this.marker.visible = true;
    this.markerLife = 1;
  }

  /** Alt+digit stores the current selection; Shift+digit recalls it (twice quickly also centres the camera). */
  private controlGroup(index: number, action: 'set' | 'recall'): void {
    if (!this.inGame || this.menuOpen) return;
    if (action === 'set') {
      if (this.selectedUnits.size === 0) return;
      this.groups.set(index, [...this.selectedUnits]);
      this.hud.toast(`Group ${index + 1} set (${this.selectedUnits.size} units)`, 'good');
      return;
    }
    const alive = new Set(this.state.units.filter((u) => isAlive(u) && teamOf(u) === 0).map((u) => u.id));
    const ids = (this.groups.get(index) ?? []).filter((id) => alive.has(id));
    if (ids.length === 0) { this.hud.toast(`Group ${index + 1} is empty`, 'error'); return; }
    this.selectedUnits = new Set(ids);
    this.selectedBuilding = null;
    const now = performance.now();
    if (this.lastRecall.index === index && now - this.lastRecall.at < 450) {
      const us = this.state.units.filter((u) => ids.includes(u.id));
      this.rig.setTarget(us.reduce((a, u) => a + u.x, 0) / us.length, us.reduce((a, u) => a + u.z, 0) / us.length, false);
    }
    this.lastRecall = { index, at: now };
    this.refreshHud(true);
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
    if (r.ok) { this.tutRecruited = true; this.hud.toast(`${UNIT_DEFS[kind].name} recruited`, 'good'); }
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
      const full = population(this.state) >= Math.min(popCap(this.state), MAX_UNITS);
      return {
        kind: 'building', hpFraction: buildingHp(b) / def.hp, name: def.name, description: def.description, progress: Math.round(b.progress * 100) / 100,
        workers: def.slots > 0 && b.progress >= 1 ? { on: workersOnSite(this.state, b), slots: def.slots } : null,
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
      const alive = new Set(this.state.units.filter((u) => isAlive(u) && teamOf(u) === 0).map((u) => u.id));
      for (const id of this.selectedUnits) if (!alive.has(id)) this.selectedUnits.delete(id);
    }
    this.hud.setResources(this.state.resources, incomePerSecond(this.state), population(this.state), popCap(this.state), this.state.time);
    let on = 0, slots = 0, idle = 0;
    for (const b of this.state.buildings) {
      const sl = BUILDING_DEFS[b.type].slots;
      if (sl > 0 && b.progress >= 1 && b.type !== 'stronghold') { slots += sl; on += Math.min(sl, workersOnSite(this.state, b)); }
    }
    for (const u of this.state.units) if (u.kind === 'villager' && isAlive(u) && teamOf(u) === 0 && u.work == null) idle++;
    this.hud.setWorkers(on, slots, idle);
    const ai = this.state.ai;
    if (ai && !this.state.outcome && this.state.buildings.some((b) => b.type === 'stronghold')) {
      const left = Math.max(0, Math.ceil(ai.nextWave - this.state.time));
      this.hud.setRaid(`Raid ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, left <= 20);
      if (ai.wave > this.lastWave) { this.lastWave = ai.wave; this.hud.toast(`Enemy raid ${ai.wave} is marching on your palace!`, 'error'); }
    } else this.hud.setRaid(null, false);
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
      while (this.acc >= SIM_STEP && steps < 6) { stepSimulation(this.state, SIM_STEP, this.nav); this.acc -= SIM_STEP; steps++; }
      if (steps === 6) this.acc = 0;
      this.checkStory();
      this.hud.tickStory(dt);
      this.updateTutorial();
      if (this.state.outcome && !this.outcomeShown) this.showOutcome(this.state.outcome);
      this.alpha = this.acc / SIM_STEP;
      this.autosaveTimer += dt;
      if (this.autosaveTimer >= AUTOSAVE_SECONDS) { this.autosaveTimer = 0; this.autosave(false); }
    }

    // Tell the portal whether the player is actually playing (menus, pauses, intro, ads and the end screen are not).
    this.platform.setPlaying(this.inGame && !this.menuOpen && !this.paused && !this.state.outcome && !this.introActive && !this.adActive);
    if (this.introActive) this.updateIntro(dt);
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
    this.fx.update(this.state, Math.min(dt, 0.1), this.settings.reducedMotion);
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
    if (this.inGame) {
      for (const b of this.state.buildings) {
        const def = BUILDING_DEFS[b.type], hp = buildingHp(b);
        if (hp >= def.hp || b.progress < 1) continue; // only damaged, finished buildings
        const c = footprintCenter(def, b.x0, b.z0);
        items.push({ x: c.x, y: this.groundHeight(c.x, c.z) + 3.4, z: c.z, frac: hp / def.hp, selected: this.selectedBuilding === b.id, width: def.w * 0.7 });
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
    // Building models: the explicit manifest if given, otherwise our own optional /models/buildings.json.
    // A missing default file is normal (nothing is shipped unless someone adds it), so it stays silent.
    const explicit = manifest !== null;
    loadBuildingManifest(manifest ?? 'models/buildings.json').then(
      (r) => {
        if (r.failed.length) console.warn('Some building models failed to load; using procedural models for them:', r.failed);
        if (r.loaded.length) { console.info(`Loaded authored building models: ${r.loaded.join(', ')}`); this.buildingsView.refreshModels(); }
      },
      (e) => { if (explicit) console.warn('Building manifest failed; using procedural models.', e instanceof Error ? e.message : e); },
    );
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
      selectedUnits: this.selectedUnits, newGame: () => this.newGame(),
      introActive: () => this.introActive, introTime: () => this.introT, skipIntro: () => this.endIntro(), unitScreenItems: () => this.unitScreenItems(),
      handleClick: (x: number, y: number, s = false, touch = false) => this.handleClick(x, y, s, touch),
      quickSelect: (k: 'army' | 'idle' | 'attack' | 'clear') => this.quickSelect(k),
      soundOn: () => this.soundOn(), tutorialStep: () => this.tutIndex, adActive: () => this.adActive,
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
