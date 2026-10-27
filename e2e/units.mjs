/**
 * End-to-end checks for the character and architecture upgrades (Stages 3-4):
 * new unit types and training, every animation clip, clip selection from game state, the authored
 * GLB pipeline (with a synthetic, in-memory skinned model; no asset files are assumed to exist),
 * and building construction stages. Run: node e2e/units.mjs
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
await ctx.addInitScript(() => localStorage.setItem('palava.settings.v1', JSON.stringify({ quality: 'low', shadows: false, adaptiveResolution: true, reducedMotion: false })));
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
// SwiftShader renders ~5 fps, so fixed sleeps are racy: poll from Node (same pattern as waitForTimeout) until the condition holds.
const until = async (expr, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await page.evaluate(`(() => { try { const g = window.__palava.debug(); return !!(${expr}); } catch { return false; } })()`);
    if (ok) return true;
    await page.waitForTimeout(250);
  }
  return false;
};
const dbg = (expr) => page.evaluate(`(() => { const g = window.__palava.debug(); return ${expr}; })()`);

await page.goto(URL_, { waitUntil: 'load' });
// Vite re-optimises dependencies the first time the test-only exporter is imported, which reloads the page once.
await page.evaluate(() => import('/tests/support/syntheticUnitGlb.ts')).catch(() => {});
await page.waitForTimeout(4000);
await page.goto(URL_, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__palava);
await page.click('#ov-new');
await page.waitForTimeout(1200);

// ── 1. Palace trains villagers and commanders
const pal = await dbg('(() => { const b = g.state.buildings[0]; return g.project(b.x0 + 3, b.z0 + 3); })()');
await page.mouse.click(pal.x, pal.y);
await page.waitForTimeout(300);
const panel = await page.locator('#selpanel').innerText();
check('palace selection offers Villager and Commander', panel.includes('Recruit Villager') && panel.includes('Recruit Commander') && !panel.includes('Recruit Archer'), panel.replace(/\n/g, ' | ').slice(0, 120));
const food0 = await dbg('g.state.resources.food'), n0 = await dbg('g.state.units.length');
await page.click('#selpanel button:has-text("Recruit Villager")');
await page.waitForTimeout(250);
check('recruiting a villager adds a unit and charges food', (await dbg('g.state.units.length')) === n0 + 1 && (await dbg('g.state.resources.food')) < food0);

// ── 2. every kind renders in every clip without errors
const setup = await dbg(`(() => {
  const cap = g.state.buildings[0]; const ox = cap.x0 + 3, oz = cap.z0 + 12;
  g.state.units.length = 0; const ids = {};
  ['infantry','archer','villager','commander','cavalry','elephant'].forEach((k, i) => {
    const x = ox + (i - 2.5) * 2.6, z = oz, id = g.state.nextId++;
    g.state.units.push({ id, kind: k, x, z, px: x, pz: z, facing: 0, hp: 100, path: [] }); ids[k] = id;
  });
  g.atmosphere.override = { tod: 0.45, rain: 0, mist: 0 };
  g.rig.setTarget(ox, oz, true); g.rig.setZoom(3.0, true);
  return ids; })()`);
await page.waitForTimeout(600);
const drawn = await dbg('Object.values(g.unitsView.counts).reduce((a, b) => a + b, 0)');
check('all six unit kinds are drawn', drawn === 6, `drawn=${drawn}`);
for (const [name, clip] of [['idle', 0], ['walk', 1], ['run', 2], ['attack', 3], ['gather', 4], ['build', 5], ['death', 6]]) {
  await page.evaluate(({ ids, clip }) => { const d = window.__palava.debug(); Object.values(ids).forEach((id) => d.setClip(id, clip)); }, { ids: setup, clip });
  await until(`Object.values(${JSON.stringify(setup)}).every((id) => g.unitsView.controller.get(id).clip === ${clip})`);
  const st = await dbg(`Object.values(${JSON.stringify(setup)}).map((id) => g.unitsView.controller.get(id).clip)`);
  check(`clip "${name}" plays on every kind`, st.every((c) => c === clip), st.join(','));
}
await page.screenshot({ path: `${OUT}/units-death.png` });
// Death is final in the controller, so respawn fresh units for the state-driven checks below.
const setup2 = await dbg(`(() => {
  const cap = g.state.buildings[0]; const ox = cap.x0 + 3, oz = cap.z0 + 12;
  g.state.units.length = 0; const ids = {};
  ['infantry','archer','villager','commander'].forEach((k, i) => {
    const x = ox + (i - 1.5) * 2.6, id = g.state.nextId++;
    g.state.units.push({ id, kind: k, x, z: oz, px: x, pz: oz, facing: 0, hp: 100, path: [] }); ids[k] = id;
  });
  return ids; })()`);

// ── 3. clips follow game state: idle, walk (short path), run (long path), build and gather (villager near buildings)
await page.evaluate(({ ids }) => {
  const d = window.__palava.debug(); const u = d.state.units.find((x) => x.id === ids.infantry);
  u.path = Array.from({ length: 4 }, (_, i) => ({ x: u.x, z: u.z + 1 + i }));
  const w = d.state.units.find((x) => x.id === ids.archer);
  w.path = Array.from({ length: 40 }, (_, i) => ({ x: w.x, z: w.z + 1 + i * 0.5 }));
}, { ids: setup2 });
await until(`g.unitsView.controller.get(${setup2.archer}).clip === 2 && g.unitsView.controller.get(${setup2.infantry}).clip === 1`);
const [idleC, walkC, runC] = await dbg(`[${setup2.commander}, ${setup2.infantry}, ${setup2.archer}].map((id) => g.unitsView.controller.get(id).clip)`);
check('standing unit idles, short path walks, long path runs', idleC === 0 && walkC === 1 && runC === 2, `${idleC}/${walkC}/${runC}`);
const work = await dbg(`(() => {
  const cap = g.state.buildings[0];
  const site = { id: g.state.nextId++, type: 'farm', x0: cap.x0 + 10, z0: cap.z0 + 2, progress: 0.4 }; g.state.buildings.push(site);
  const v = g.state.units.find((x) => x.id === ${setup2.villager});
  v.x = v.px = site.x0 - 1; v.z = v.pz = site.z0 + 1; v.path = [];
  return { siteId: site.id, vx: v.x, vz: v.z };
})()`);
await until(`g.unitsView.controller.get(${setup2.villager}).clip === 5`);
check('villager beside an unfinished building plays "build"', (await dbg(`g.unitsView.controller.get(${setup2.villager}).clip`)) === 5);
await dbg(`(() => { g.state.buildings.find((b) => b.id === ${work.siteId}).progress = 1; })()`);
await until(`g.unitsView.controller.get(${setup2.villager}).clip === 4`);
check('villager beside a finished farm plays "gather"', (await dbg(`g.unitsView.controller.get(${setup2.villager}).clip`)) === 4);

// ── 4. construction view: scaffold while building, shared materials and no scaffold when done
const stage = await dbg(`(() => {
  const e = g.buildingsView.models.get(${work.siteId});
  return { hasEntry: !!e, site: !!e.site, mats: e.materials.length };
})()`);
check('finished building has no scaffold and uses shared materials', stage.hasEntry && !stage.site && stage.mats === 0, JSON.stringify(stage));
await dbg(`(() => { g.state.buildings.find((b) => b.id === ${work.siteId}).progress = 0.5; })()`);
await until(`(() => { const e = g.buildingsView.models.get(${work.siteId}); return e && e.site && Math.abs(e.prog.value - 0.5) < 0.1; })()`);
const mid = await dbg(`(() => { const e = g.buildingsView.models.get(${work.siteId}); return { site: !!e.site, mats: e.materials.length, prog: e.prog.value }; })()`);
check('building at 50% shows scaffolding with construction materials', mid.site && mid.mats > 1 && Math.abs(mid.prog - 0.5) < 0.1, JSON.stringify(mid));

// ── 5. authored GLB pipeline with a synthetic skinned model, served from a same-origin URL
const gen = await page.evaluate(async () => {
  const { buildSyntheticGlb } = await import('/tests/support/syntheticUnitGlb.ts');
  const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  return { good: b64(await buildSyntheticGlb()), rigid: b64(await buildSyntheticGlb({ skinned: false })) };
});
await page.route('**/__test/good.glb', (r) => r.fulfill({ body: Buffer.from(gen.good, 'base64'), contentType: 'model/gltf-binary' }));
await page.route('**/__test/rigid.glb', (r) => r.fulfill({ body: Buffer.from(gen.rigid, 'base64'), contentType: 'model/gltf-binary' }));
const loaded = await page.evaluate(async () => {
  const d = window.__palava.debug(); const out = {};
  out.ok = await d.loadUnitModel('infantry', '/__test/good.glb');
  try { await d.loadUnitModel('archer', '/__test/rigid.glb'); out.rigid = 'accepted'; } catch (e) { out.rigid = e.message; }
  try { await d.loadUnitModel('archer', 'https://example.com/x.glb'); out.xo = 'accepted'; } catch (e) { out.xo = e.message; }
  try { await d.loadUnitModel('archer', '/__test/missing.glb'); out.missing = 'accepted'; } catch (e) { out.missing = 'rejected'; }
  return out;
});
check('synthetic skinned GLB loads and reports the clips it lacks', Array.isArray(loaded.ok.missing) && loaded.ok.missing.join() === 'gather,build', JSON.stringify(loaded.ok));
check('unskinned GLB is rejected with a clear message', /no skinned mesh/.test(loaded.rigid), loaded.rigid);
check('cross-origin model URL is refused', /another origin/.test(loaded.xo), loaded.xo);
check('missing model file is rejected, not silently ignored', loaded.missing === 'rejected');
await dbg(`(() => { g.state.units.length = 0; const cap = g.state.buildings[0]; const ox = cap.x0 + 3, oz = cap.z0 + 12;
  ['infantry','infantry','infantry','archer'].forEach((k, i) => { const x = ox + (i - 1.5) * 2.2, id = g.state.nextId++; g.state.units.push({ id, kind: k, x, z: oz, px: x, pz: oz, facing: 0, hp: 100, path: [] }); });
  g.rig.setTarget(ox, oz, true); })()`);
await page.waitForTimeout(1200);
const mix = await dbg('({ skinned: g.unitsView.skinnedCounts.infantry, inst: g.unitsView.counts.infantry, archers: g.unitsView.counts.archer })');
check('authored infantry are skinned; kinds without a model keep the placeholder', mix.skinned === 3 && mix.inst === 0 && mix.archers === 1, JSON.stringify(mix));
await dbg(`(() => { for (const u of g.state.units) if (u.kind === 'infantry') u.path = Array.from({ length: 5 }, (_, i) => ({ x: u.x, z: u.z + 1 + i })); })()`);
await page.waitForTimeout(900);
const anim = await dbg(`(() => { const p = g.unitsView.pools.get('infantry'); const u = [...p.used.values()][0]; return { cur: u.current, w: u.actions.walk.getEffectiveWeight() }; })()`);
check('skinned units cross-fade into the walk clip', anim.cur === 'walk' && anim.w > 0.9, JSON.stringify(anim));
await page.screenshot({ path: `${OUT}/units-glb.png` });
await dbg('(() => { g.state.units.length = 0; })()');
await page.waitForTimeout(600);
check('pool slots are released when units disappear', (await dbg(`g.unitsView.pools.get('infantry').size`)) === 0);

check('no console errors or page errors', logs.length === 0, logs.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close(); await server.close();
process.exit(failed ? 1 : 0);
