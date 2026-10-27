import * as THREE from 'three';

export interface BarItem { x: number; y: number; z: number; frac: number; selected: boolean; width: number }

/**
 * Health bars on a transparent 2D canvas over the WebGL view. One canvas draw per frame (no DOM
 * nodes per unit, no allocations beyond the shared Vector3), and only units that are selected or
 * wounded get a bar, so the map stays uncluttered. Colour is never the only signal: bars carry a
 * dark outline and the fill length itself.
 */
export class HealthBars {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly v = new THREE.Vector3();
  private w = 0; private h = 0; private dpr = 1;
  private drawn = false;

  constructor(private readonly canvas: HTMLCanvasElement) { this.ctx = canvas.getContext('2d'); }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.dpr = Math.min(2, dpr);
    this.w = cssW; this.h = cssH;
    this.canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * this.dpr));
    this.drawn = true; // force a clear on the next draw
  }

  draw(items: readonly BarItem[], camera: THREE.Camera, zoom: number): void {
    const c = this.ctx;
    if (!c) return;
    if (!items.length && !this.drawn) return;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    this.drawn = items.length > 0;
    const scale = Math.min(1.6, Math.max(0.8, Math.sqrt(zoom)));
    for (const it of items) {
      this.v.set(it.x, it.y, it.z).project(camera);
      if (this.v.z > 1 || Math.abs(this.v.x) > 1.05 || Math.abs(this.v.y) > 1.05) continue;
      const sx = (this.v.x * 0.5 + 0.5) * this.w, sy = (-this.v.y * 0.5 + 0.5) * this.h;
      const bw = it.width * scale * 22, bh = 5 * Math.min(1.3, scale);
      const x = Math.round(sx - bw / 2), y = Math.round(sy - bh);
      c.fillStyle = 'rgba(12,18,38,0.85)'; c.fillRect(x - 1, y - 1, bw + 2, bh + 2);
      const f = Math.max(0, Math.min(1, it.frac));
      c.fillStyle = f > 0.6 ? '#7fc46a' : f > 0.3 ? '#e0b040' : '#d6573f';
      c.fillRect(x, y, Math.round(bw * f), bh);
      if (it.selected) { c.strokeStyle = '#f2d98a'; c.lineWidth = 1; c.strokeRect(x - 1.5, y - 1.5, bw + 3, bh + 3); }
    }
  }
}
