# PALAVA — Rise of an Ancient Kingdom (Phase 1 vertical slice)

Low-poly, Pallava-inspired 3D strategy game. Vite + TypeScript + Three.js.

## Run it

Requires Node 20+.

```bash
npm install
npm run dev          # http://localhost:5173
```

Other commands:

| Command | What it does |
|---|---|
| `npm test` | 44 unit tests for the game systems (Vitest, no browser needed) |
| `npm run typecheck` | Strict TypeScript check |
| `npm run build` / `npm run preview` | Production build / serve it |
| `npm run test:e2e` | Drives the real game in headless Chromium (86 checks across four scripts: base game, units/architecture, UI/camera/touch, combat). One-time setup: `npx playwright install chromium` |

## Controls

| Action | Input |
|---|---|
| Select | Click a unit, or drag a box (Shift = add/toggle) |
| Move | Right-click ground; formation chosen in the bottom panel (Line / Column / Wedge / Box) |
| Build | Hotkeys 1–5 or the Construct menu; green ghost = valid, red = invalid; Shift-click to keep placing; Esc / right-click cancels |
| Recruit | Select a finished Barracks → Recruit buttons |
| Camera | WASD / arrows pan · Q / E rotate 90° · wheel or +/− zoom · middle-drag pan · H home · minimap click/drag |
| Fight | Right-click an enemy to attack · F then click ground = attack-move · Alt+1–9 save a control group, Shift+1–9 recall (twice quickly = centre camera) |
| Game | P / Space pause · Esc menu · F3 performance stats · M mute / unmute ambient sound |
| Inspect | Zoom in past ~2.4× and the camera lowers its angle (to ~4.5×) for a close, side-on look at buildings and figures |

## What is implemented (Phase 1, plus a slice of Phase 2)

- Seeded procedural island terrain: highlands, river, coast, flat capital plateau (`src/world/terrain.ts`)
- Isometric orthographic camera, damped pan/zoom/rotate, golden-hour lighting, shadows, fog, sky, sea
- Palace, Temple, Barracks, Farm, Lumber Camp, Quarry as procedural models with placement validation
  (water, slope, overlap, spacing, edges, unit-in-way, cost, one-palace rule) and visible construction progress
- Passive resource income from completed buildings, storage cap, population cap from housing
- Infantry and archers: click/box selection, formations, A* pathfinding with smoothing, recruitment from a Barracks
- Fixed 20 Hz simulation with interpolated rendering (deterministic: same inputs → same result)
- HTML/CSS HUD: resource bar with per-minute rates, build menu with cost shortfalls, selection panel, minimap with camera view, pause/speed, toasts
- Save/restore to `localStorage` (autosave every 30 s and on tab hide, manual slot), with strict validation of save data
- Graphics: Low / Medium / High presets, shadow toggle, adaptive render resolution, reduce-motion, responsive layout
- Instancing: all trees in one draw call, rocks in one, each troop kind in one, selection rings in one
- Content-Security-Policy, no remote requests, no location or other permissions, no monetisation

## Combat, rival kingdom and hardening (Stages 6–9)

- **Combat:** units belong to a team, auto-acquire enemies within 9 cells when idle, chase, strike on a per-unit cooldown, and die (corpses linger 2.5 s, then are removed). Archers shoot from range and deal half damage to buildings. Pure, deterministic and unit-tested (`src/systems/combat.ts`).
- **Rival kingdom:** an enemy Stronghold is placed deterministically far from your capital with a small garrison. It launches raid waves (first at 3:30, then every 80 s shrinking to 45 s, growing in size; cavalry from wave 3, elephants from wave 6) that attack-move on your palace. The AI has no economy: it spends time, not resources (`src/systems/enemyAi.ts`).
- **Win/lose:** destroy the stronghold to win; lose if your palace falls. The simulation then freezes, a result screen appears, and the stale autosave is cleared.
- **Presentation:** attack clip is driven by combat state, arrows fly for ranged hits, units flash when hit, enemy units are tinted crimson, wounded units/buildings show health bars (colour-blind-safe ramp plus tick marks), raid countdown chip and warning toast.
- **Saves:** format v2 (team, target, cooldown, building hp, AI state, outcome). v1 saves load as all-player-units; saves without a rival get one added on load.
- **Touch:** two-finger pinch zooms and pans.
- **Accessibility:** `prefers-contrast` and `forced-colors` styles; every control still keyboard-operable.
- **Night shadows:** the sun's shadow map stops updating when the sun is below the horizon.
- **CI/CD:** `.github/workflows/ci.yml` (typecheck, unit tests, build, e2e in a real browser, `npm audit`, CycloneDX SBOM), `codeql.yml` (SAST), Dependabot, and `vercel.json` security headers. Not yet run on GitHub (no remote exists yet).

## Realism & visual-fidelity upgrade (Stages 1–5)

- **Environment:** biome-driven terrain shading, chunked instanced vegetation with wind, animated sea, sky dome, day/night cycle, light rain and haze, drifting motes and birds.
- **Architecture:** procedural Pallava-style temple/palace/barracks/farm/lumber/quarry with textured PBR materials, hi/lo LOD, scaffolded staged construction.
- **Characters:** six unit kinds (villager, commander, infantry, archer, cavalry, elephant) with GPU-skinned procedural rigs, 7 clips (idle/walk/run/attack/gather/build/death), cross-fading, formation spacing by body size.
- **Authored models (opt-in):** `?models=<manifest.json>` loads same-origin skinned `.glb` files per unit kind (see `src/render/units/gltfUnits.ts` for clip-name aliases). No model files ship with the game; without them the procedural rigs are used.
- **Camera/UI:** target rides the terrain height; inspection pitch when zoomed in; sandstone/bronze/deep-blue/muted-gold HUD; day-clock chip; health bars on selected or wounded units; procedural Web Audio ambience (wind, surf, birds, crickets, rain) that starts only after a click or key press and can be muted (button, M, or Settings).

## Known limits of this upgrade

- Frame rate was only measured on software rendering (about 5 fps, ~100 draw calls); no real-GPU or mobile testing has been done.
- Combat balance (damage, wave sizes, timings) is a first pass and has not been play-tested by a human. Villager build/gather clips are derived from proximity; there is no real worker economy yet.
- Destroying a building unblocks its footprint cells on the nav grid even if the terrain under them was already impassable (placement rules make this rare).
- Control groups are not saved.
- Audio output is synthesised and could not be heard or measured in the headless test; only error-free toggling is verified.
- Old saves store only the terrain seed, so they may not match the new terrain.

## Not implemented yet (so you know where the edges are)

Worker assignment, research tree, a real enemy economy, formations affecting combat, campaign map, diplomacy/trade,
quests/achievements, line of sight, difficulty levels, a tutorial.

## Replacing a placeholder with a Blender `.glb`

Every building is created through a registry (`src/render/buildingModels.ts`). Export from Blender with the origin at the
footprint centre on the ground, +Y up, and fit within the footprint in `src/core/defs.ts`, then:

```ts
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
const gltf = await new GLTFLoader().loadAsync('/models/temple.glb');
registerBuildingModel('temple', () => gltf.scene.clone());
```

The registry is tested only with procedural models; the loader snippet above is a documented pattern, not yet exercised.

## Layout

```
src/core/       defs (tuning data), state types, math, seeded RNG
src/world/      terrain heightfield, vegetation scatter (pure, no Three.js)
src/systems/    pathfinding, formations, placement, simulation, save, selection, adaptive resolution, settings (pure)
src/render/     scene/lighting, terrain mesh, buildings, units (instanced), vegetation (instanced), camera rig
src/ui/         HUD, minimap
src/game.ts     loop, picking, orchestration     src/input.ts   pointer + keyboard
tests/          unit tests                       e2e/run.mjs    browser test
```

Game logic never touches Three.js, so it is unit-testable and can later move to a worker or a server.

## Stage 10: worker economy, rival economy, counters

- **Workers.** Farms (3 slots), lumber camps (2), quarries (2) and temples (1) produce in proportion to villagers standing at them, plus a 25% idle trickle. Idle villagers pick the nearest free workplace by themselves; right-click a workplace with villagers selected to assign them. A manual move holds a villager until you give a work order. The game starts with 6 villagers.
- **Rival economy.** The enemy stronghold has its own workers that earn points; it buys workers, then the soldiers for its next wave, and launches its garrison on schedule (keeping two guards home). Raids sweep the nearest player building first (economy before palace) and retreat when fewer than 40% survive. Kill its workers and it stops growing.
- **Difficulty** (Settings, applies to new games): Easy / Normal / Hard change the rival's income, first-raid time, wave gap and head start. Unit stats are identical on every level.
- **Counters.** Sword warriors beat cavalry, cavalry ride down archers, archers shoot infantry and elephants; elephants deal double damage to buildings.
- **Authored buildings.** Put a GLB at `public/models/` and list it in `public/models/buildings.json` as `{ "buildings": { "temple": "temple.glb" } }`. It is scaled to the footprint and loaded automatically (same origin only, 120k-triangle limit); a missing or rejected file keeps the procedural model.

## Stage 11: intro clip and story

- **Intro (about 26 s).** A real-time cinematic rendered by the game itself: dawn over the capital, a push in to the palace, a pull back toward the rival's land, four subtitle lines and the title card. Skip with Esc, Space, Enter, a click or the Skip button. Turn it off in Settings ("Play the intro before new games"), or replay it from the menu ("Watch Intro"). With reduced motion the camera holds still and text appears at once. No video files; no extra network requests.
- **Story captions.** Short fictional captions appear once per game at milestones: first building, first harvest, first raid, the raid broken, the army marching out, the stronghold wounded, and the victory or fall epilogue. They count down in game time (pausing holds them), can be dismissed, and are announced politely to screen readers.
- **Chronicle.** The menu lists every chapter reached in the current game. Seen beats are saved with the game (ids are whitelisted on load).

## CrazyGames build (Stage 12)

```bash
npm run build:cg      # type-check, build with --mode crazygames, validate size limits, write palava-crazygames.zip
```

What the portal build changes (everything else is identical to the web build):

- Relative asset paths (`base: './'`), output in `dist-crazygames/`.
- The CrazyGames SDK v3 script is injected into `index.html`; the CSP allows only that script origin and `https:`/`wss:` connections for the SDK, and the referrer policy is relaxed to `strict-origin-when-cross-origin`.
- `src/platform/platform.ts` is the only code that touches `window.CrazyGames`. Every SDK call is wrapped, the SDK is used only on the portal (or its local preview), and a blocked or silent SDK falls back after 4 s so the game always starts.
- **Gameplay events:** `gameplayStart`/`gameplayStop` fire only on changes, and only while actually playing (not in menus, pause, intro, ad or end screen). `loadingStart`/`loadingStop` bracket boot. `happytime` fires on victory.
- **Ads:** a midgame ad is requested only at a natural break (starting a new game after a finished one), never mid-play. Audio and input are held during the ad, and the game resumes even if the ad fails.
- **Audio:** the portal mute setting overrides the in-game sound setting; a hidden tab is muted.
- **Saves and settings:** use the portal data module (cloud saves for signed-in players) and fall back to `localStorage` per call.
- **No** cryptocurrency, pay-to-win or external links; no location permission.

Play aids added for the portal audience: a six-step guided tutorial (skippable, off for loaded games), quick-select bar and hotkeys (`R` army, `I` idle villagers), touch tap-to-command (tap ground to move, tap a foe or a rival building to attack, tap a workplace to assign villagers), right-click attack on rival buildings, and a compact HUD for screens under 520 px tall.

### Checklist before submitting
- [ ] Upload `palava-crazygames.zip` to the CrazyGames Developer Portal and test in their preview tool (desktop and mobile frames).
- [ ] Record the preview video (15-20 s, 1080p landscape and portrait, no sound) on a machine with a real GPU.
- [ ] Prepare covers: 1920x1080, 800x1200 and 800x800 (title only, no borders).
- [ ] After the preview run, tighten the CSP `connect-src` to the hosts the SDK actually uses.
- [ ] Credit any third-party model (for example the temple GLB) with its licence before shipping it.
