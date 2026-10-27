import { BUILDING_DEFS } from '../core/defs';
import { buildingTeam, teamOf, type GameState } from '../core/state';
import { terrainColor } from '../render/terrainView';
import type { Terrain } from '../world/terrain';

const SIZE = 192;

/** North-up 2D minimap: terrain is pre-rendered once; dynamic markers are redrawn at ~10 Hz. */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private dragging = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly terrain: Terrain,
    private readonly onNavigate: (x: number, z: number) => void,
  ) {
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    this.base = this.renderBase();

    const nav = (e: PointerEvent): void => {
      const r = canvas.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width, nz = (e.clientY - r.top) / r.height;
      this.onNavigate(Math.min(1, Math.max(0, nx)) * (terrain.size - 1), Math.min(1, Math.max(0, nz)) * (terrain.size - 1));
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      nav(e);
      e.preventDefault();
      e.stopPropagation();
    });
    canvas.addEventListener('pointermove', (e) => { if (this.dragging) nav(e); });
    const end = (e: PointerEvent): void => {
      this.dragging = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private renderBase(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = SIZE; c.height = SIZE;
    const g = c.getContext('2d')!;
    const img = g.createImageData(SIZE, SIZE);
    const n = this.terrain.size;
    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        const x = Math.min(n - 1, Math.round((px / (SIZE - 1)) * (n - 1)));
        const z = Math.min(n - 1, Math.round((py / (SIZE - 1)) * (n - 1)));
        const h = this.terrain.heights[z * n + x]!;
        const o = (py * SIZE + px) * 4;
        if (h <= 0) {
          const depth = Math.min(1, -h / 6);
          img.data[o] = 30 - depth * 12; img.data[o + 1] = 110 - depth * 40; img.data[o + 2] = 160 - depth * 40;
        } else {
          const col = terrainColor(this.terrain, x, z);
          img.data[o] = Math.min(255, col.r * 255 * 1.1); img.data[o + 1] = Math.min(255, col.g * 255 * 1.1); img.data[o + 2] = Math.min(255, col.b * 255 * 1.1);
        }
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  draw(state: GameState, selected: ReadonlySet<number>, viewQuad: { x: number; z: number }[]): void {
    const g = this.ctx;
    const k = (SIZE - 1) / (this.terrain.size - 1);
    g.drawImage(this.base, 0, 0);

    for (const b of state.buildings) {
      const def = BUILDING_DEFS[b.type];
      const foe = buildingTeam(b) === 1;
      g.fillStyle = foe ? '#d9503f' : b.progress >= 1 ? '#e0b040' : 'rgba(224,176,64,0.5)';
      g.fillRect(b.x0 * k - 1, b.z0 * k - 1, def.w * k + 2, def.d * k + 2);
      g.strokeStyle = '#1b2a52';
      g.lineWidth = 1;
      g.strokeRect(b.x0 * k - 1, b.z0 * k - 1, def.w * k + 2, def.d * k + 2);
    }
    for (const u of state.units) {
      if (u.hp <= 0) continue;
      g.fillStyle = teamOf(u) === 1 ? '#ff5a48' : selected.has(u.id) ? '#ffffff' : '#4f7dff';
      g.fillRect(u.x * k - 1.5, u.z * k - 1.5, 3, 3);
    }
    if (viewQuad.length >= 3) {
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.lineWidth = 1.5;
      g.beginPath();
      viewQuad.forEach((p, i) => { const x = p.x * k, z = p.z * k; if (i === 0) g.moveTo(x, z); else g.lineTo(x, z); });
      g.closePath();
      g.stroke();
    }
  }
}
