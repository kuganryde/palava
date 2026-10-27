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
| `npm run test:e2e` | Drives the real game in headless Chromium (35 + 23 + 8 checks across three scripts). One-time setup: `npx playwright install chromium` |

## Controls

| Action | Input |
|---|---|
| Select | Click a unit, or drag a box (Shift = add/toggle) |
| Move | Right-click ground; formation chosen in the bottom panel (Line / Column / Wedge / Box) |
| Build | Hotkeys 1–5 or the Construct menu; green ghost = valid, red = invalid; Shift-click to keep placing; Esc / right-click cancels |
| Recruit | Select a finished Barracks → Recruit buttons |
| Camera | WASD / arrows pan · Q / E rotate 90° · wheel or +/− zoom · middle-drag pan · H home · minimap click/drag |
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

## Realism & visual-fidelity upgrade (Stages 1–5)

- **Environment:** biome-driven terrain shading, chunked instanced vegetation with wind, animated sea, sky dome, day/night cycle, light rain and haze, drifting motes and birds.
- **Architecture:** procedural Pallava-style temple/palace/barracks/farm/lumber/quarry with textured PBR materials, hi/lo LOD, scaffolded staged construction.
- **Characters:** six unit kinds (villager, commander, infantry, archer, cavalry, elephant) with GPU-skinned procedural rigs, 7 clips (idle/walk/run/attack/gather/build/death), cross-fading, formation spacing by body size.
- **Authored models (opt-in):** `?models=<manifest.json>` loads same-origin skinned `.glb` files per unit kind (see `src/render/units/gltfUnits.ts` for clip-name aliases). No model files ship with the game; without them the procedural rigs are used.
- **Camera/UI:** target rides the terrain height; inspection pitch when zoomed in; sandstone/bronze/deep-blue/muted-gold HUD; day-clock chip; health bars on selected or wounded units; procedural Web Audio ambience (wind, surf, birds, crickets, rain) that starts only after a click or key press and can be muted (button, M, or Settings).

## Known limits of this upgrade

- Frame rate was only measured on software rendering (about 5 fps, ~100 draw calls); no real-GPU or mobile testing has been done.
- Combat and enemy AI do not exist, so the attack and death clips have no in-game trigger yet (previewed via the debug hook). Villager build/gather clips are derived from proximity.
- Audio output is synthesised and could not be heard or measured in the headless test; only error-free toggling is verified.
- Old saves store only the terrain seed, so they may not match the new terrain.

## Not implemented yet (so you know where the edges are)

Workers and worker assignment, research tree, combat and health damage, enemy faction and AI, victory conditions,
campaign map, diplomacy/trade, quests/achievements, formations affecting combat, line of sight,
control groups, pinch/two-finger touch gestures.

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
