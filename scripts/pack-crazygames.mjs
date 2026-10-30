/**
 * Validate and zip the CrazyGames build against the portal's technical limits.
 * Run after `vite build --mode crazygames` (npm run build:cg does both).
 * Limits (docs.crazygames.com/requirements/technical): total 250 MB, 1500 files, initial download 50 MB
 * (20 MB to qualify for the mobile homepage), relative paths only, no external game files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const dir = resolve('dist-crazygames');
const zip = resolve('palava-crazygames.zip');
if (!existsSync(join(dir, 'index.html'))) { console.error('dist-crazygames/index.html is missing: run the crazygames build first.'); process.exit(1); }

const files = [];
(function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } })(dir);

let total = 0;
for (const f of files) total += statSync(f).size;
// "Initial download" ~ everything the first screen needs; gzip is what players actually download.
let gz = 0;
for (const f of files) gz += gzipSync(readFileSync(f)).length;

const problems = [];
const MB = 1024 * 1024;
if (total > 250 * MB) problems.push(`total size ${(total / MB).toFixed(1)} MB exceeds 250 MB`);
if (files.length > 1500) problems.push(`${files.length} files exceeds 1500`);
if (total > 50 * MB) problems.push(`initial download ${(total / MB).toFixed(1)} MB exceeds 50 MB`);

const html = readFileSync(join(dir, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const u = m[1];
  if (u.startsWith('https://sdk.crazygames.com/')) continue;
  if (/^(https?:)?\/\//.test(u)) problems.push(`external resource in index.html: ${u}`);
  else if (u.startsWith('/')) problems.push(`absolute path in index.html: ${u}`);
}
if (!html.includes('crazygames-sdk-v3.js')) problems.push('SDK script tag is missing from index.html');

if (problems.length) { console.error('CrazyGames build check FAILED:\n - ' + problems.join('\n - ')); process.exit(1); }

if (existsSync(zip)) rmSync(zip);
// index.html must sit at the root of the zip.
execFileSync('zip', ['-qr', zip, '.'], { cwd: dir });
console.log(`OK  ${files.length} files, ${(total / MB).toFixed(2)} MB raw, ~${(gz / MB).toFixed(2)} MB gzipped (limit 50 MB; 20 MB for the mobile homepage)`);
console.log(`Zip: ${relative(process.cwd(), zip)} (${(statSync(zip).size / MB).toFixed(2)} MB)`);
