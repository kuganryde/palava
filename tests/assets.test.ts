/// <reference types="node" />
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILDING_DEFS } from '../src/core/defs';
import { MAX_TRIANGLES } from '../src/render/buildingGltf';

/**
 * Asset gate: every model under public/models is checked without a GPU. A heavy, external or unlicensed
 * asset fails CI before it can reach the portal build.
 */
const MODELS = join(__dirname, '..', 'public', 'models');
const MAX_GLB_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_TRIANGLES = 30_000; // hero-landmark budget; crowd units must stay far below

interface Glb { json: { meshes?: Array<{ primitives: Array<{ indices?: number; mode?: number; attributes: { POSITION: number } }> }>; accessors: Array<{ count: number }>; buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> } }

function parseGlb(file: string): Glb {
  const buf = readFileSync(file);
  expect(buf.readUInt32LE(0)).toBe(0x46546c67); // "glTF"
  expect(buf.readUInt32LE(4)).toBe(2);
  expect(buf.readUInt32LE(8)).toBe(buf.length);
  const len = buf.readUInt32LE(12);
  expect(buf.readUInt32LE(16)).toBe(0x4e4f534a); // "JSON"
  return { json: JSON.parse(buf.subarray(20, 20 + len).toString('utf8')) };
}

function triangles(g: Glb): number {
  let n = 0;
  for (const m of g.json.meshes ?? []) for (const p of m.primitives) {
    if ((p.mode ?? 4) !== 4) continue;
    n += Math.floor((p.indices !== undefined ? g.json.accessors[p.indices]!.count : g.json.accessors[p.attributes.POSITION]!.count) / 3);
  }
  return n;
}

describe('building manifest and models', () => {
  const manifest = JSON.parse(readFileSync(join(MODELS, 'buildings.json'), 'utf8')) as { buildings: Record<string, string> };
  const credits = JSON.parse(readFileSync(join(__dirname, '..', 'ASSET_CREDITS.json'), 'utf8')) as { assets: Record<string, { licence?: string; source?: string }> };

  it('lists only known building types and same-folder files that exist', () => {
    for (const [type, file] of Object.entries(manifest.buildings)) {
      expect(Object.hasOwn(BUILDING_DEFS, type), type).toBe(true);
      expect(file, 'no path traversal or URLs').toMatch(/^[\w-]+\.glb$/);
      expect(existsSync(join(MODELS, file)), file).toBe(true);
    }
  });

  for (const [type, file] of Object.entries(manifest.buildings)) {
    describe(`${type} -> ${file}`, () => {
      const path = join(MODELS, file);
      it('is within the size and triangle budgets', () => {
        expect(statSync(path).size).toBeLessThanOrEqual(MAX_GLB_BYTES);
        const t = triangles(parseGlb(path));
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThanOrEqual(MAX_ASSET_TRIANGLES);
        expect(t).toBeLessThanOrEqual(MAX_TRIANGLES);
      });
      it('is self-contained (no external buffers or textures)', () => {
        const g = parseGlb(path);
        for (const b of g.json.buffers ?? []) expect(b.uri).toBeUndefined();
        for (const i of g.json.images ?? []) expect(i.uri === undefined || i.uri.startsWith('data:')).toBe(true);
      });
      it('has a source and licence recorded in ASSET_CREDITS.json', () => {
        const c = credits.assets[`models/${file}`];
        expect(c, 'missing credits entry').toBeDefined();
        expect(c!.licence).toBeTruthy();
        expect(c!.source).toBeTruthy();
      });
    });
  }
});
