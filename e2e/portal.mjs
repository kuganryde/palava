/** Portal (CrazyGames SDK) integration with a fake SDK, plus tutorial, quick-select and touch commands. Run: node e2e/portal.mjs */
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root: ROOT, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const URL_ = server.resolvedUrls.local[0];
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 650 } });
// A fake SDK that records every call. Settings: tutorial stays ON here (default); sound ON so mute priority is visible.
await ctx.addInitScript(() => {
  localStorage.setItem('palava.settings.v1', JSON.stringify({ quality: 'low', shadows: false, adaptiveResolution: true, reducedMotion: false, sound: true, intro: false }));
  const log = []; const listeners = []; const store = new Map();
  // The portal store holds settings and saves when present, so seed it (not only localStorage).
  store.set('palava.settings.v1', localStorage.getItem('palava.settings.v1'));
  window.__cg = { log, store, settings: { muteAudio: false }, fireMute(v) { this.settings.muteAudio = v; listeners.forEach((l) => l({ muteAudio: v })); } };
  window.CrazyGames = { SDK: {
    environment: 'local', init: async () => { log.push('init'); },
    game: {
      get settings() { return window.__cg.settings; }, addSettingsChangeListener: (l) => listeners.push(l),
      gameplayStart: () => log.push('gameplayStart'), gameplayStop: () => log.push('gameplayStop'),
      loadingStart: () => log.push('loadingStart'), loadingStop: () => log.push('loadingStop'), happytime: () => log.push('happytime'),
    },
    ad: { requestAd: (type, cb) => { log.push('ad:' + type); cb.adStarted?.(); setTimeout(() => { cb.adFinished?.(); log.push('adFinished'); }, 400); } },
    data: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); log.push('data.set'); }, removeItem: (k) => store.delete(k) },
  } };
});
const page = await ctx.newPage();
const errs = []; 
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(e.message));
const dbg = (expr) => page.evaluate(`(() => { const g = window.__palava.debug(); return ${expr}; })()`);
const log = () => page.evaluate(() => [...window.__cg.log]);
const until = async (expr, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(`(() => { try { const g = window.__palava.debug(); return !!(${expr}); } catch { return false; } })()`)) return true;
    await page.waitForTimeout(250);
  }
  return false;
};

await page.goto(URL_, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__palava);
await page.waitForTimeout(800);
let l = await log();
check('SDK initialised and loading bracketed', l.includes('init') && l.indexOf('loadingStart') > -1 && l.indexOf('loadingStop') > l.indexOf('loadingStart'), l.join(','));
check('no gameplayStart while the main menu is open', !l.includes('gameplayStart'));

await page.click('#ov-new');
check('gameplayStart once play begins', await until(`true`) && (await page.waitForFunction(() => window.__cg.log.includes('gameplayStart'), null, { timeout: 8000 }).then(() => true, () => false)));
const lastIs = (name) => page.waitForFunction((n) => { const l = window.__cg.log; return l[l.length - 1] === n; }, name, { timeout: 8000 }).then(() => true, () => false);
await page.click('#btn-menu');
check('gameplayStop when the menu opens', await lastIs('gameplayStop'));
await page.keyboard.press('Escape');
check('gameplayStart again after resuming', await lastIs('gameplayStart'));
l = await log();
check('start/stop are edge-triggered (strictly alternating)', l.filter((x) => x.startsWith('gameplay')).every((x, i) => x === (i % 2 === 0 ? 'gameplayStart' : 'gameplayStop')), l.join(','));

// Mute priority: portal mute wins over the in-game sound setting
check('sound on by default in the test', await dbg(`g.soundOn()`) === true);
await page.evaluate(() => window.__cg.fireMute(true)); await page.waitForTimeout(200);
check('portal mute silences the game', await dbg(`g.soundOn()`) === false);
await page.evaluate(() => window.__cg.fireMute(false)); await page.waitForTimeout(200);
check('portal unmute restores sound', await dbg(`g.soundOn()`) === true);

// Tutorial
check('tutorial card is shown on a new game', await page.isVisible('#tutorial'));
check('tutorial starts at step 1', await dbg(`g.tutorialStep()`) === 0);
const pick = await dbg(`(() => { const u = g.state.units.find((u) => u.kind !== 'villager' && (u.team ?? 0) === 0); return u ? g.project(u.x, u.z) : null; })()`);
if (pick) await page.mouse.click(pick.x, pick.y + 650 * 0 + 0);
check('selecting a warrior advances the tutorial', await until(`g.tutorialStep() >= 1`, 6000));

// Quick select
await dbg(`g.quickSelect('clear')`);
await dbg(`g.quickSelect('army')`);
check('Army quick-select selects only warriors', await dbg(`g.selectedUnits.size > 0 && [...g.selectedUnits].every((id) => g.state.units.find((u) => u.id === id).kind !== 'villager')`));
await page.keyboard.press('i');
check('I selects idle villagers', await dbg(`g.selectedUnits.size > 0 && [...g.selectedUnits].every((id) => g.state.units.find((u) => u.id === id).kind === 'villager')`));
await page.click('#q-clear');
check('Clear button empties the selection', await dbg(`g.selectedUnits.size === 0`));

// Touch: with units selected, a tap on the ground moves them
await dbg(`g.quickSelect('army')`);
const before = await dbg(`(() => { const u = g.state.units.find((u) => g.selectedUnits.has(u.id)); return { id: u.id, x: u.x, z: u.z }; })()`);
const tapAt = await dbg(`(() => { const u = g.state.units.find((u) => g.selectedUnits.has(u.id)); return g.project(u.x + 6, u.z + 6); })()`);
await dbg(`g.handleClick(${tapAt.x}, ${tapAt.y}, false, true)`);
await page.waitForTimeout(1500);
const after = await dbg(`(() => { const u = g.state.units.find((u) => u.id === ${before.id}); return { x: u.x, z: u.z, moving: u.path.length > 0 }; })()`);
check('a touch tap on the ground issues a move order', Math.hypot(after.x - before.x, after.z - before.z) > 0.5 || after.moving);

// Ad flow: only after a finished game
const adsBefore = (await log()).filter((x) => x === 'ad:midgame').length;
await dbg(`g.newGame()`); await page.waitForTimeout(800);
check('no ad when starting a game mid-play (no outcome yet)', (await log()).filter((x) => x === 'ad:midgame').length === adsBefore);
await dbg(`(g.state.outcome = 'defeat', 0)`);
await page.waitForSelector('#overlay-outcome, #ov-outcome, [data-overlay="outcome"]', { timeout: 4000 }).catch(() => {});
await page.waitForTimeout(800);
await page.evaluate(() => { const b = document.getElementById('ov-again') || document.getElementById('ov-new') || [...document.querySelectorAll('button')].find((x) => /new game|again|play/i.test(x.textContent)); b?.click(); });
await page.waitForTimeout(250);
l = await log();
check('a midgame ad is requested after a finished game', l.filter((x) => x === 'ad:midgame').length === adsBefore + 1, l.slice(-5).join(','));
check('new game starts after the ad finishes', await page.waitForFunction(() => window.__cg.log.includes('adFinished'), null, { timeout: 5000 }).then(() => true, () => false));
await page.waitForTimeout(600);
check('ad block overlay is gone and game is playable', !(await page.isVisible('#adblock')) && !(await dbg(`g.adActive()`)));

// Cloud-save store is used when the portal provides one
await dbg(`g.saveManual()`); await page.waitForTimeout(300);
check('manual save goes to the portal store', (await log()).includes('data.set'));

check('no console or page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close(); await server.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
