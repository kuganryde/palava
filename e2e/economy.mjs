/** Stage 10 checks: worker economy, rival economy, difficulty setting. Run: node e2e/economy.mjs */
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
await ctx.addInitScript(() => localStorage.setItem('palava.settings.v1', JSON.stringify({ quality: 'low', shadows: false, adaptiveResolution: true, reducedMotion: false, sound: false, intro: false, tutorial: false })));
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


// 1. Workforce chip and starting villagers
check('starts with six villagers', await dbg(`g.state.units.filter((u) => u.kind === 'villager' && (u.team ?? 0) === 0).length`) === 6);
check('rival starts with four workers', await dbg(`g.state.units.filter((u) => u.kind === 'villager' && u.team === 1).length`) === 4);
const chip0 = await page.locator('#workers').textContent();
check('workers chip is shown', /Workers 0\/0/.test(chip0 ?? ''), chip0 ?? '');

// 2. A finished farm gets staffed by idle villagers on its own; the chip reflects it
const placed = { ok: true };
const farmId = await dbg(`(() => {
  const cap = g.state.buildings[0];
  const id = g.state.nextId++;
  g.state.buildings.push({ id, type: 'farm', x0: cap.x0 + 14, z0: cap.z0 + 4, progress: 1 });
  const d = 4; for (let z = 0; z < d; z++) for (let x = 0; x < d; x++) g.nav.blocked[(cap.z0 + 4 + z) * g.nav.size + cap.x0 + 14 + x] = 1;
  return id;
})()`);
check('a farm was added', typeof farmId === 'number', JSON.stringify(placed));
check('villagers staff the farm by themselves', await until(`g.state.units.filter((u) => u.work === ${farmId}).length === 3`, 40000));
check('workers chip counts staffed slots', await until(`/Workers 3\\/3/.test(document.getElementById('workers').textContent)`, 20000), await page.locator('#workers').textContent() ?? '');
check('the other villagers show as idle in the chip', /idle/.test((await page.locator('#workers').textContent()) ?? ''));

// 3. Difficulty setting
await page.evaluate(() => document.getElementById('btn-menu')?.click());
await page.click('#ov-settings');
await page.selectOption('#set-difficulty', 'hard');
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('palava.settings.v1') ?? '{}').difficulty);
check('difficulty setting persists', stored === 'hard', String(stored));
await page.click('#set-back');
await page.click('#ov-new');
await page.waitForTimeout(1200);
check('new game uses the chosen difficulty', await dbg(`g.state.ai.difficulty`) === 'hard');
check('hard rival launches earlier than normal', await dbg(`g.state.ai.nextWave`) < 210);

const bad = logs.filter((l) => !/WebGL|GPU stall|swiftshader/i.test(l));
check('no console errors', bad.length === 0, bad.slice(0, 2).join(' | '));
await browser.close();
await server.close();
const pass = results.filter(Boolean).length;
console.log(`${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
