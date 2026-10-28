/**
 * End-to-end test: drives the real game in headless Chromium (software WebGL).
 * Run with:  npm run test:e2e      (needs `npx playwright install chromium` once)
 * Screenshots land in e2e/artifacts/.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = fileURLToPath(new URL('./artifacts', import.meta.url));
mkdirSync(OUT, { recursive: true });
const server = await createServer({ root: ROOT, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const URL_ = server.resolvedUrls.local[0];
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
await ctx.addInitScript(() => { if (!localStorage.getItem('palava.settings.v1')) localStorage.setItem('palava.settings.v1', JSON.stringify({ quality: 'low', shadows: false, adaptiveResolution: true, reducedMotion: false, intro: false })); });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const d = (fn, arg) => page.evaluate(`(${fn.toString()})(${JSON.stringify(arg ?? null)})`);
const simWait = async (sec) => { const t = await page.evaluate(() => window.__palava.debug().state.time); await page.waitForFunction((x) => window.__palava.debug().state.time >= x, t + sec, { timeout: 90000, polling: 100 }); };
const dbg = (expr) => page.evaluate(`(() => { const g = window.__palava.debug(); return ${expr}; })()`);

await page.goto(URL_, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__palava);
await page.click('#ov-new');
await page.waitForTimeout(1200);

// ── 1. click-select a single unit
const items = await dbg('g.unitScreenItems()');
const first = items[0];
await page.mouse.click(first.sx, first.sy);
await page.waitForTimeout(250);
let sel = await dbg('g.selectedUnits.size');
check('click selects one unit', sel === 1, `selected=${sel}`);
check('selection panel shows count', (await page.locator('#selpanel').innerText()).toLowerCase().includes('1 unit selected'));

// ── 2. box select all
await page.mouse.click(40, 700); // click empty-ish area to clear (HUD free zone, bottom-left)
await page.waitForTimeout(150);
const xs = items.map((i) => i.sx), ys = items.map((i) => i.sy);
await page.mouse.move(Math.min(...xs) - 30, Math.min(...ys) - 40);
await page.mouse.down();
await page.mouse.move(Math.max(...xs) + 30, Math.max(...ys) + 30, { steps: 8 });
await page.screenshot({ path: `${OUT}/03-boxselect.png` });
await page.mouse.up();
await page.waitForTimeout(250);
sel = await dbg('g.selectedUnits.size');
check('drag box selects all 16 units (10 soldiers + 6 villagers)', sel === 16, `selected=${sel}`);
check('selection box element hidden after release', await page.locator('#selbox').isHidden());

// ── 3. move command
const before = await dbg('g.state.units.filter(u => (u.team ?? 0) === 0).map(u => [u.x, u.z])');
const cap = await dbg('({x: Math.round(g.terrain.size*0.55), z: Math.round(g.terrain.size*0.58)})');
const tgt = await dbg(`g.project(${cap.x - 10}, ${cap.z + 8})`);
await page.click('#selpanel button:has-text("Wedge")');
await page.mouse.click(tgt.x, tgt.y, { button: 'right' });
await page.waitForTimeout(300);
const pathing = await dbg('g.state.units.filter(u => (u.team ?? 0) === 0 && u.path.length > 0).length');
check('right-click gives paths to all selected units', pathing === 16, `${pathing} with paths`);
await simWait(6);
const after = await dbg('g.state.units.filter(u => (u.team ?? 0) === 0).map(u => [u.x, u.z])');
const moved = after.filter((p, i) => Math.hypot(p[0] - before[i][0], p[1] - before[i][1]) > 3).length;
check('units physically moved and arrived', moved >= 14, `${moved}/16 moved >3 cells`);
const blockedNow = await dbg('g.state.units.filter(u => (u.team ?? 0) === 0 && g.nav.blocked[Math.round(u.z)*g.nav.size+Math.round(u.x)]).length');
check('no unit ended in a blocked cell', blockedNow === 0);
await page.screenshot({ path: `${OUT}/04-moved-wedge.png` });

// ── 4. building placement via hotkey + ghost + click
const pre = await dbg('({ t: g.state.resources.timber, b: g.state.buildings.length })');
await page.keyboard.press('Digit3'); // farm
await page.waitForTimeout(150);
check('hotkey 3 enters placement mode', (await dbg('g.placingType()')) === 'farm');
// find a valid spot
const spot = await dbg(`(() => { for (let r = 9; r < 30; r += 1.5) for (let a = 0; a < 24; a++) { const x = ${cap.x} + Math.cos(a/24*6.283)*r, z = ${cap.z} + Math.sin(a/24*6.283)*r; if (g.validate('farm', x, z).ok) return {x, z}; } return null; })()`);
check('found a valid farm spot near the capital', !!spot);
const sp = await dbg(`g.project(${spot.x}, ${spot.z})`);
await page.mouse.move(sp.x, sp.y);
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/05-ghost-valid.png` });
// invalid spot: on top of the palace
const pal = await dbg(`g.project(${cap.x}, ${cap.z})`);
await page.mouse.click(pal.x, pal.y);
await page.waitForTimeout(250);
const stillBuildings = await dbg('g.state.buildings.length');
check('clicking an invalid spot is rejected with a message', stillBuildings === pre.b && (await page.locator('.toast.error').count()) > 0, `buildings=${stillBuildings}`);
await page.mouse.click(sp.x, sp.y);
await page.waitForTimeout(250);
const post = await dbg('({ t: g.state.resources.timber, b: g.state.buildings.length, p: g.state.buildings.at(-1).progress })');
check('valid click places the farm and charges timber', post.b === pre.b + 1 && post.t === pre.t - 60, JSON.stringify(post));
check('placement mode exits after placing', (await dbg('g.placingType()')) === null);

// ── 5. construction progresses then produces
await page.click('#btn-2x');
await simWait(11);
const farm = await dbg('({ p: g.state.buildings.at(-1).progress, food: g.state.resources.food })');
check('farm completes construction', farm.p === 1, JSON.stringify(farm));
check('farm production raises food above starting 300', farm.food > 300, `food=${farm.food.toFixed(1)}`);
await page.click('#btn-1x');

// ── 6. barracks → select → recruit
await page.evaluate(() => { const g = window.__palava.debug(); g.state.resources.timber = 900; g.state.resources.stone = 500; g.state.resources.food = 900; g.state.resources.gold = 500; });
await page.keyboard.press('Digit2');
const bspot = await dbg(`(() => { for (let r = 9; r < 34; r += 1.5) for (let a = 0; a < 24; a++) { const x = ${cap.x} + Math.cos(a/24*6.283+0.3)*r, z = ${cap.z} + Math.sin(a/24*6.283+0.3)*r; if (g.validate('barracks', x, z).ok) return {x, z}; } return null; })()`);
const bp = await dbg(`g.project(${bspot.x}, ${bspot.z})`);
await page.mouse.move(bp.x, bp.y);
await page.mouse.click(bp.x, bp.y);
await page.waitForTimeout(200);
await page.evaluate(() => { const g = window.__palava.debug(); g.state.buildings.at(-1).progress = 1; g.state.buildings.find(b => b.type === 'farm').progress = 1; });
await page.waitForTimeout(400);
const bb = await dbg(`g.project(${bspot.x}, ${bspot.z})`);
await page.mouse.click(bb.x, bb.y - 20);
await page.waitForTimeout(350);
const panel = await page.locator('#selpanel').innerText();
check('clicking the barracks selects it (Recruit buttons shown)', panel.toLowerCase().includes('barracks') && panel.includes('Recruit'), panel.split('\n')[0]);
const units0 = await dbg('g.state.units.length');
await page.click('#selpanel button:has-text("Recruit Archer")');
await page.waitForTimeout(250);
const units1 = await dbg('g.state.units.length');
check('recruit adds a unit', units1 === units0 + 1, `${units0} -> ${units1}`);
await page.screenshot({ path: `${OUT}/06-barracks.png` });

// ── 7. pause / menu
await simWait(0.5);
const t0 = await dbg('g.state.time');
await page.keyboard.press('KeyP');
await page.waitForTimeout(2500);
const t1 = await dbg('g.state.time');
await page.waitForTimeout(2500);
const t2 = await dbg('g.state.time');
check('P pauses the simulation', t2 === t1 && t1 >= t0, `${t0.toFixed(2)} → ${t1.toFixed(2)} → ${t2.toFixed(2)}`);
check('pause banner visible', await page.locator('#pausebanner').isVisible());
await page.keyboard.press('KeyP');
await simWait(0.5);
check('P again resumes', (await dbg('g.state.time')) > t2);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Esc opens the menu', await page.locator('#overlay').isVisible());
const tm = await dbg('g.state.time');
await page.waitForTimeout(500);
check('simulation halted while menu is open', (await dbg('g.state.time')) === tm);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Esc closes the menu again', await page.locator('#overlay').isHidden());

// ── 8. camera controls
const camBefore = await dbg('({ x: g.rig.target.x, z: g.rig.target.z, yaw: g.rig.yaw })');
await page.keyboard.down('KeyD'); await page.waitForTimeout(500); await page.keyboard.up('KeyD');
await page.keyboard.press('KeyE');
await page.mouse.move(640, 400); await page.mouse.wheel(0, -300);
await page.waitForTimeout(800);
const camAfter = await dbg('({ x: g.rig.target.x, z: g.rig.target.z, yaw: g.rig.yaw, zoom: g.rig.zoom })');
check('WASD pans the camera', Math.hypot(camAfter.x - camBefore.x, camAfter.z - camBefore.z) > 3);
check('E rotates the camera by ~90°', Math.abs(camAfter.yaw - camBefore.yaw) > 1.2, `Δyaw=${(camAfter.yaw - camBefore.yaw).toFixed(2)}`);
check('wheel zooms in', camAfter.zoom > 1.1, `zoom=${camAfter.zoom.toFixed(2)}`);
await page.keyboard.press('KeyH');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/07-rotated-zoomed.png` });

// ── 9. minimap navigation
const mm = await page.locator('#minimap').boundingBox();
await page.mouse.click(mm.x + mm.width * 0.2, mm.y + mm.height * 0.2);
await page.waitForTimeout(900);
const camMm = await dbg('({ x: g.rig.target.x, z: g.rig.target.z })');
check('minimap click moves camera to that map position', Math.abs(camMm.x - 0.2 * 127) < 6 && Math.abs(camMm.z - 0.2 * 127) < 6, JSON.stringify(camMm));

// ── 10. save → reload → load
await dbg('g.saveManual()');
const saved = await dbg('({ units: g.state.units.length, b: g.state.buildings.length, t: g.state.time })');
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!window.__palava);
check('Continue button appears after a save exists', await page.locator('#ov-continue').isVisible());
await page.click('#ov-load');
await page.waitForTimeout(800);
const loaded = await dbg('({ units: g.state.units.length, b: g.state.buildings.length, t: g.state.time })');
check('load restores units, buildings and time', loaded.units === saved.units && loaded.b === saved.b && Math.abs(loaded.t - saved.t) < 1.5, `${JSON.stringify(saved)} vs ${JSON.stringify(loaded)}`);
check('HUD shown after load', await page.locator('#hud').isVisible() && await page.locator('#overlay').isHidden());

// ── 11. corrupted save is handled
await page.evaluate(() => localStorage.setItem('palava.save.v1.manual', '{"v":1,"state":{"seed":"x"}}'));
await page.keyboard.press('Escape');
await page.click('#ov-load');
await page.waitForTimeout(300);
check('tampered save shows an error instead of crashing', (await page.locator('#ov-note').innerText()).length > 0 && (await page.locator('#hud').isVisible()));
await page.evaluate(() => localStorage.setItem('palava.save.v1.manual', '{bad json'));
await page.click('#ov-load');
await page.waitForTimeout(300);
check('garbage save shows an error', (await page.locator('#ov-note').innerText()).includes('corrupted'));
await page.keyboard.press('Escape');

// ── 12. settings
await page.keyboard.press('F3');
await page.keyboard.press('Escape');
await page.click('#ov-settings');
await page.selectOption('#set-quality', 'low');
await page.click('#set-back');
await page.keyboard.press('Escape');
await page.waitForTimeout(1200);
const statsLow = await page.locator('#stats').innerText();
console.log('stats (low):', statsLow);
check('quality switch to Low applies without errors', statsLow.includes('fps'));
await page.keyboard.press('Escape'); await page.click('#ov-settings');
await page.selectOption('#set-quality', 'high'); await page.click('#set-back'); await page.keyboard.press('Escape');
await page.waitForTimeout(1200);
console.log('stats (high):', await page.locator('#stats').innerText());

// ── 13. responsive
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/08-mobile.png` });
await page.evaluate(() => { const g = window.__palava.debug(); g.state.units.forEach((u) => g.selectedUnits.add(u.id)); });
await page.waitForTimeout(1500);
const rect = async (sel) => page.locator(sel).boundingBox();
const bm = await rect('#buildmenu'), selRect = await rect('#selpanel'), mmr = await rect('.minimap-wrap');
const overlaps = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
check('mobile: selection panel does not cover the build menu or minimap', !overlaps(bm, selRect) && !overlaps(mmr, selRect), JSON.stringify({ bm, selRect, mmr }));
await page.screenshot({ path: `${OUT}/09-mobile-selected.png` });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
check('no horizontal overflow at 390px wide', !overflow);

check('no console errors or page errors', logs.length === 0, logs.join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
await server.close();
process.exit(failed.length ? 1 : 0);
