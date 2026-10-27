/** Stage 5 checks: terrain-aware camera, inspection pitch, day clock, health bars, sound toggle. Run: node e2e/ui.mjs */
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
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 650 } });
await ctx.addInitScript(() => localStorage.setItem('palava.settings.v1', JSON.stringify({ quality: 'low', shadows: false, adaptiveResolution: true, reducedMotion: false })));
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(e.message));
const dbg = (expr) => page.evaluate(`(() => { const g = window.__palava.debug(); return ${expr}; })()`);
await page.goto(URL_, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__palava);
await page.click('#ov-new');
await page.waitForTimeout(1500);

// Day clock chip
const clock = await page.textContent('#daytime');
check('day clock chip shows HH:MM', /^\d\d:\d\d$/.test(clock ?? ''), clock);

// Terrain-aware camera: target.y tracks ground height, not a constant
const ys = await dbg(`(() => { const out = []; for (const [x,z] of [[20,20],[100,40],[60,110]]) { g.rig.setTarget(x,z,true); } return 0; })()`);
const samples = [];
for (const [x, z] of [[24, 24], [110, 50], [64, 120], [200, 200]]) {
  await dbg(`g.rig.setTarget(${x}, ${z}, true)`);
  await page.waitForTimeout(1500);
  samples.push(await dbg(`({ y: g.rig.target.y, h: Math.max(0, g.rig.ground(g.rig.target.x, g.rig.target.z)) })`));
}
check('camera target follows ground height', samples.every((s) => Math.abs(s.y - s.h) < 0.35) && new Set(samples.map((s) => s.y.toFixed(1))).size > 1, JSON.stringify(samples.map((s) => [+s.y.toFixed(2), +s.h.toFixed(2)])));

// Inspection view: deep zoom lowers pitch
await dbg('g.rig.setZoom(1.35)'); await page.waitForTimeout(200);
const far = await dbg('g.rig.camera.position.y - g.rig.target.y');
await dbg('g.rig.setZoom(5)'); await page.waitForTimeout(200);
const near = await dbg('g.rig.camera.position.y - g.rig.target.y');
check('inspection zoom lowers the camera angle', near < far - 10, `${far.toFixed(1)} -> ${near.toFixed(1)}`);
await dbg('g.rig.setZoom(1.35)');

// Health bars: wounded unit gets a bar (pixels drawn on #bars)
await dbg(`(() => { const u = g.state.units[0]; u.hp = u.hp * 0.4; g.selectedUnits.add(u.id); const c = g.project(u.x, u.z); return c; })()`);
await dbg(`g.rig.setTarget(g.state.units[0].x, g.state.units[0].z, true)`);
await page.waitForTimeout(1500);
const painted = await page.evaluate(() => { const c = document.getElementById('bars'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
check('wounded/selected unit draws a health bar', painted > 20, `${painted} px`);
await page.screenshot({ path: `${OUT}/stage5-ui.png` });

// Sound toggle (M key and button), persisted
await page.click('#btn-sound');
check('sound button mutes (aria-pressed)', (await page.getAttribute('#btn-sound', 'aria-pressed')) === 'true');
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('palava.settings.v1')).sound);
check('mute persists to settings', stored === false);
await page.focus('#game'); await page.keyboard.press('KeyM');
check('M key unmutes', (await page.getAttribute('#btn-sound', 'aria-pressed')) === 'false');
const ctxState = await page.evaluate(() => window.__palava.debug && 'ok');
check('no console errors after sound toggling (audible output not verifiable headless)', !!ctxState && logs.length === 0, logs.join(' | '));

await page.evaluate(() => window.__palava.debug().rig.setZoom(5));
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/stage5-inspect.png` });

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close(); await server.close();
process.exit(results.every(Boolean) ? 0 : 1);
