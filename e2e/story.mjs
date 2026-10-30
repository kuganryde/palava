/** Stage 11 checks: intro cinematic, story captions, chronicle. Run: node e2e/story.mjs */
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
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 650 } });
await ctx.addInitScript(() => localStorage.setItem('palava.settings.v1', JSON.stringify({ quality: 'low', shadows: false, adaptiveResolution: true, reducedMotion: false, sound: false, tutorial: false })));
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(e.message));
const dbg = (expr) => page.evaluate(`(() => { const g = window.__palava.debug(); return ${expr}; })()`);
const until = async (expr, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(`(() => { try { const g = window.__palava.debug(); return !!(${expr}); } catch { return false; } })()`)) return true;
    await page.waitForTimeout(250);
  }
  return false;
};
const fresh = async () => { await page.evaluate(() => window.__palava.debug().newGame()); await page.waitForTimeout(800); };

await page.goto(URL_, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__palava);
await page.click('#ov-new');
await page.waitForTimeout(1200);


// 1. The intro plays on a new game
await page.goto(URL_, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__palava);
await page.click('#ov-new');
await page.waitForTimeout(500);
check('intro overlay is shown', await page.locator('#intro').isVisible());
check('intro is active and the HUD is hidden', await dbg('g.introActive()') === true && await page.locator('#hud').isHidden());
check('simulation does not run during the intro', await dbg('g.state.time') === 0);
const cam1 = await dbg('({ z: g.rig.zoom, x: g.rig.target.x })');
check('a subtitle line is typed', await until(`document.getElementById('intro-typed').textContent.length > 5`, 20000), (await page.locator('#intro-typed').textContent()) ?? '');
check('the subtitle is exposed to screen readers in full', ((await page.locator('#intro-sr').textContent()) ?? '').length > 20);
const cam2 = await dbg('({ z: g.rig.zoom, x: g.rig.target.x })');
check('the camera moves during the intro', Math.abs(cam2.z - cam1.z) > 0.01 || Math.abs(cam2.x - cam1.x) > 0.01, JSON.stringify([cam1, cam2]));
await page.screenshot({ path: `${OUT}/stage11-intro.png` });

// 2. Escape skips it and hands over a normal game
await page.keyboard.press('Escape');
check('Escape skips the intro', await until(`!g.introActive()`, 5000));
check('intro overlay hidden and HUD visible', await page.locator('#intro').isHidden() && await page.locator('#hud').isVisible());
check('menu is not left open after the intro', await dbg('g.state.time') >= 0 && await page.locator('#overlay').isHidden());
const zoomAfter = await dbg('g.rig.zoom');
check('the camera is handed back near the starting view', Math.abs(zoomAfter - 1.35) < 0.05, String(zoomAfter));

// 3. A story caption appears when a milestone is reached
await dbg(`(() => { const cap = g.state.buildings[0]; g.state.buildings.push({ id: g.state.nextId++, type: 'quarry', x0: cap.x0 + 14, z0: cap.z0 + 4, progress: 1 }); })()`);
check('"The First Stone" caption appears', await until(`!document.getElementById('story').hidden && /First Stone/.test(document.getElementById('story-title').textContent)`, 20000));
check('caption is announced politely', await page.getAttribute('#story', 'aria-live') === 'polite');
check('beat is recorded for saving', await dbg(`(g.state.story ?? []).includes('founding')`));
await page.click('#story-close');
check('the caption can be dismissed', await page.locator('#story').isHidden());

// 4. Chronicle lists it
await page.keyboard.press('Escape');
await page.click('#ov-chronicle');
const items = await page.locator('#chronicle-list li').allTextContents();
check('chronicle lists the chapter', items.length === 1 && /First Stone/.test(items[0]), items.join(' | '));
await page.click('#chronicle-back');

// 5. Beats survive a save and are not repeated
await page.click('#ov-save');
await page.click('#ov-resume');
await dbg('g.loadManual()');
await page.waitForTimeout(800);
check('loaded game keeps its story record', await dbg(`(g.state.story ?? []).includes('founding')`));
await page.waitForTimeout(1500);
check('a seen caption does not fire again', await page.locator('#story').isHidden());

// 6. Watch Intro from the menu, skip with a click, return to the menu
await page.keyboard.press('Escape');
await page.click('#ov-intro');
check('Watch Intro starts the clip', await until(`g.introActive()`, 3000));
await page.locator('#intro').click({ position: { x: 300, y: 300 } });
check('a click skips it and returns to the menu', await until(`!g.introActive()`, 3000) && await page.locator('#overlay').isVisible());

// 7. The setting turns it off for new games
await page.click('#ov-settings');
await page.uncheck('#set-intro');
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('palava.settings.v1') ?? '{}').intro);
check('intro setting persists', stored === false, String(stored));
await page.click('#set-back');
await page.click('#ov-new');
await page.waitForTimeout(600);
check('new game starts straight away with the intro off', await dbg('g.introActive()') === false && await page.locator('#hud').isVisible());

const bad = logs.filter((l) => !/WebGL|GPU stall|swiftshader/i.test(l));
check('no console errors', bad.length === 0, bad.slice(0, 2).join(' | '));
await browser.close();
await server.close();
const pass = results.filter(Boolean).length;
console.log(`${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
