/** Stage 6-7 checks: enemy base, raids, attack orders, destruction, victory/defeat screens. Run: node e2e/combat.mjs */
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

// 1. Rival base
const base = await dbg(`({ fort: g.state.buildings.find((b) => b.type === 'stronghold') || null, foes: g.state.units.filter((u) => u.team === 1 && u.kind !== 'villager').length, workers: g.state.units.filter((u) => u.team === 1 && u.kind === 'villager').length, ai: g.state.ai })`);
check('enemy stronghold and garrison exist after a new game', !!base.fort && base.foes === 5 && base.workers === 4 && !!base.ai, JSON.stringify({ x0: base.fort?.x0, z0: base.fort?.z0, foes: base.foes }));
await dbg(`g.rig.setTarget(${base.fort.x0 + 3}, ${base.fort.z0 + 6}, true)`);
await dbg('g.rig.setZoom(1.6, true)');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/stage7-enemy-base.png` });
const drawn = await dbg('g.buildingsView.models.size');
check('stronghold is rendered as a building model', drawn >= 2, `models=${drawn}`);

// 2. Raid wave launches on schedule
await dbg('(() => { g.state.time = g.state.ai.nextWave - 0.2; })()');
check('a raid wave spawns at its scheduled time', await until(`g.state.ai.wave === 1 && g.state.units.filter((u) => u.team === 1 && u.amove).length >= 3`));

// 3. Right-click an enemy orders an attack (selected player unit)
await fresh();
const setup = await dbg(`(() => {
  const cap = g.state.buildings[0]; const x = cap.x0 + 2, z = cap.z0 + 12;
  g.state.units.length = 0; g.state.ai.bank = 0; // no workers and no points: the rival cannot field new units mid-test
  const a = { id: g.state.nextId++, kind: 'infantry', x, z, px: x, pz: z, facing: 0, hp: 100, path: [], team: 0, target: null, cooldown: 0 };
  const e = { id: g.state.nextId++, kind: 'infantry', x: x + 14, z, px: x + 14, pz: z, facing: 0, hp: 100, path: [], team: 1, target: null, cooldown: 0 };
  g.state.units.push(a, e); g.selectedUnits.clear(); g.selectedUnits.add(a.id);
  g.rig.setTarget(x + 7, z, true); g.rig.setZoom(2, true);
  return { a: a.id, e: e.id, ex: e.x, ez: e.z };
})()`);
await page.waitForTimeout(1200);
const pt = await dbg(`g.project(${setup.ex}, ${setup.ez})`);
await dbg(`g.handleRightClick(${pt.x}, ${pt.y - 8})`);
const tgt = await dbg(`g.state.units.find((u) => u.id === ${setup.a}).target`);
check('right-click on an enemy issues an attack order', tgt === setup.e, `target=${tgt}`);
check('the fight resolves (one side dies, corpse is cleaned up)', await until(`g.state.units.filter((u) => u.hp > 0).length === 1 || g.state.units.length === 1`, 40000));
await page.screenshot({ path: `${OUT}/stage7-fight.png` });

// 4. Victory
await fresh();
await dbg(`(() => {
  const f = g.state.buildings.find((b) => b.type === 'stronghold'); f.hp = 1;
  g.state.units = g.state.units.filter((u) => u.team === 0);
  const a = g.state.units[0]; a.x = a.px = f.x0 + 3; a.z = a.pz = f.z0 + 9; a.target = f.id;
  g.state.units.length = 1; return true; })()`);
check('destroying the stronghold shows VICTORY', await until(`document.getElementById('ov-title').textContent === 'VICTORY' && !document.getElementById('overlay').hidden`, 30000));
const stuck = await dbg(`({ out: g.state.outcome, t: g.state.time })`);
await page.waitForTimeout(1500);
const after = await dbg('g.state.time');
check('the simulation freezes after the game is decided', stuck.out === 'victory' && after === stuck.t);
check('a finished game is not left as the autosave', await page.evaluate(() => localStorage.getItem('palava.save.v1.autosave') === null));
await page.screenshot({ path: `${OUT}/stage7-victory.png` });

// 5. Defeat
await fresh();
await dbg(`(() => {
  const p = g.state.buildings.find((b) => b.type === 'palace'); p.hp = 1;
  const e = { id: g.state.nextId++, kind: 'cavalry', x: p.x0 + 2, z: p.z0 + 8, px: p.x0 + 2, pz: p.z0 + 8, facing: 0, hp: 140, path: [], team: 1, target: p.id, cooldown: 0 };
  g.state.units.push(e); return true; })()`);
check('losing the palace shows DEFEAT', await until(`document.getElementById('ov-title').textContent === 'DEFEAT'`, 30000));

// 6. New game after an outcome works and resets the title
await page.click('#ov-new');
await page.waitForTimeout(1200);
check('a new game starts cleanly after a result screen', await dbg(`g.state.outcome === undefined && g.state.units.length >= 15`) && (await page.textContent('#ov-title')) === 'PALAVA');

// 7. Presentation and controls (Stage 8)
await fresh();
check('raid countdown chip is shown', (await page.isVisible('#raid')) && /^Raid \d+:\d\d$/.test((await page.textContent('#raid')) ?? ''), await page.textContent('#raid'));
const fightIds = await dbg(`(() => {
  const cap = g.state.buildings[0]; const x = cap.x0 + 2, z = cap.z0 + 12;
  g.state.units.length = 0;
  const mk = (kind, team, dx) => { const id = g.state.nextId++; g.state.units.push({ id, kind, x: x + dx, z, px: x + dx, pz: z, facing: 0, hp: 400, path: [], team, target: null, cooldown: 0 }); return id; };
  const a = mk('infantry', 0, 0), e = mk('elephant', 1, 1.2), ar = mk('archer', 0, -3);
  g.state.units.find((u) => u.id === e).hp = 400; g.state.units.find((u) => u.id === a).hp = 100;
  g.rig.setTarget(x, z, true); g.rig.setZoom(3, true);
  return { a, e, ar };
})()`);
check('fighters in range play the attack clip', await until(`g.unitsView.controller.get(${fightIds.a}) && g.unitsView.controller.get(${fightIds.a}).clip === 3`, 20000));
check('arrows are spawned for ranged hits', await until(`g.state.events && g.state.events.some((e) => e.ranged)`, 20000));
await page.screenshot({ path: `${OUT}/stage8-fight.png` });

// attack-move via the F key, then a ground click
await fresh();
await dbg(`(() => { const u = g.state.units.find((x) => x.team === 0); g.selectedUnits.clear(); g.selectedUnits.add(u.id); g.rig.setZoom(1.5, true); })()`);
await page.focus('#game'); await page.keyboard.press('KeyF');
check('F arms attack-move (crosshair cursor)', (await page.evaluate(() => document.getElementById('game').style.cursor)) === 'crosshair');
const dest = await dbg(`(() => { const u = g.state.units.find((x) => x.team === 0); return g.project(u.x + 4, u.z + 4); })()`);
await dbg(`g.handleClick(${dest.x}, ${dest.y}, false)`);
const am = await dbg(`(() => { const u = g.state.units.find((x) => g.selectedUnits.has(x.id)); return { amove: u.amove, path: u.path.length }; })()`);
check('the next click issues an attack-move order', am.amove === true && am.path > 0, JSON.stringify(am));

// control groups: Alt+1 assigns, Shift+1 recalls
await dbg(`(() => { g.selectedUnits.clear(); g.state.units.filter((u) => u.team === 0).slice(0, 3).forEach((u) => g.selectedUnits.add(u.id)); })()`);
await page.keyboard.press('Alt+Digit1');
await dbg('g.selectedUnits.clear()');
await page.keyboard.press('Shift+Digit1');
check('Alt+1 saves and Shift+1 recalls a control group', (await dbg('g.selectedUnits.size')) === 3);

// damaged building shows a bar
await dbg(`(() => { const p = g.state.buildings.find((b) => b.type === 'palace'); p.hp = p.hp ?? 1500; p.hp = 600; g.rig.setTarget(p.x0 + 3, p.z0 + 3, true); g.rig.setZoom(1.3, true); })()`);
await page.waitForTimeout(2000);
const painted = await page.evaluate(() => { const c = document.getElementById('bars'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
check('a damaged building draws a health bar', painted > 40, `${painted} px`);

check('no console errors', logs.length === 0, logs.slice(0, 3).join(' | '));
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close(); await server.close();
process.exit(results.every(Boolean) ? 0 : 1);
