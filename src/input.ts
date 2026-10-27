import type { CameraRig } from './render/cameraRig';
import { pinchDelta, pinchOf, type Pinch } from './systems/gesture';

export interface InputHandlers {
  /** Plain left click (no drag). Coordinates are CSS pixels relative to the canvas. */
  onClick(x: number, y: number, shift: boolean): void;
  onBoxSelect(x1: number, y1: number, x2: number, y2: number, shift: boolean): void;
  onRightClick(x: number, y: number): void;
  onHover(x: number, y: number): void;
  onBuildHotkey(index: number): void;
  onPauseToggle(): void;
  onEscape(): void;
  onHome(): void;
  onToggleStats(): void;
  onToggleSound(): void;
  /** F: arm attack-move (the next ground click). */
  onAttackMove(): void;
  /** Alt+digit assigns a control group, Shift+digit recalls it. */
  onGroup(index: number, action: 'set' | 'recall'): void;
}

const DRAG_THRESHOLD = 6; // px before a press becomes a box selection

/** Pointer + keyboard handling. Owns camera control; everything else is forwarded as intent. */
export class InputController {
  private readonly keys = new Set<string>();
  private downAt: { x: number; y: number; shift: boolean } | null = null;
  private dragging = false;
  private panning: { x: number; y: number } | null = null;
  /** Active touch points by pointer id; two fingers = pinch-zoom + pan. */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinch: Pinch | null = null;
  private readonly box = document.getElementById('selbox') as HTMLElement;
  enabled = true;
  boxSelectEnabled = true;
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly canvas: HTMLCanvasElement, private readonly rig: CameraRig, private readonly h: InputHandlers) {
    const on = (t: HTMLElement | Window, type: string, fn: (e: any) => void, opts?: AddEventListenerOptions): void => {
      t.addEventListener(type, fn, opts);
      this.disposers.push(() => t.removeEventListener(type, fn, opts));
    };

    on(canvas, 'pointerdown', (e: PointerEvent) => this.pointerDown(e));
    on(canvas, 'pointermove', (e: PointerEvent) => this.pointerMove(e));
    on(canvas, 'pointerup', (e: PointerEvent) => this.pointerUp(e));
    on(canvas, 'pointercancel', (e: PointerEvent) => { this.touches.delete(e.pointerId); if (this.touches.size < 2) this.pinch = null; this.cancelDrag(); });
    on(canvas, 'contextmenu', (e: Event) => e.preventDefault());
    on(canvas, 'wheel', (e: WheelEvent) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.rig.zoomBy(Math.exp(-Math.sign(e.deltaY) * 0.12 * Math.min(3, Math.abs(e.deltaY) / 100 + 0.5)));
    }, { passive: false });
    on(window, 'keydown', (e: KeyboardEvent) => this.keyDown(e));
    on(window, 'keyup', (e: KeyboardEvent) => { this.keys.delete(e.code); });
    on(window, 'blur', () => { this.keys.clear(); this.cancelDrag(); });
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.enabled) return;
    this.canvas.focus({ preventScroll: true });
    const p = this.local(e);
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, p);
      this.canvas.setPointerCapture(e.pointerId);
      if (this.touches.size >= 2) {
        // A second finger turns the gesture into camera control: abandon any selection drag in progress.
        this.cancelDrag();
        const [a, b] = [...this.touches.values()];
        this.pinch = pinchOf(a!, b!);
        return;
      }
    }
    if (e.button === 0) {
      this.downAt = { ...p, shift: e.shiftKey };
      this.dragging = false;
      this.canvas.setPointerCapture(e.pointerId);
    } else if (e.button === 1) {
      this.panning = p;
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else if (e.button === 2) {
      this.h.onRightClick(p.x, p.y);
    }
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.enabled) return;
    const p = this.local(e);
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, p);
      if (this.pinch && this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()];
        const cur = pinchOf(a!, b!);
        const d = pinchDelta(this.pinch, cur);
        const perPixel = 46 / (this.canvas.clientHeight * this.rig.zoom);
        this.rig.zoomBy(d.zoom);
        this.rig.pan(-d.dx * perPixel, d.dy * perPixel);
        this.pinch = cur;
        return;
      }
    }
    if (this.panning) {
      const perPixel = 46 / (this.canvas.clientHeight * this.rig.zoom);
      this.rig.pan(-(p.x - this.panning.x) * perPixel, (p.y - this.panning.y) * perPixel);
      this.panning = p;
      return;
    }
    if (this.downAt) {
      if (!this.dragging && this.boxSelectEnabled && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) > DRAG_THRESHOLD) this.dragging = true;
      if (this.dragging) this.drawBox(this.downAt.x, this.downAt.y, p.x, p.y);
    }
    this.h.onHover(p.x, p.y);
  }

  private pointerUp(e: PointerEvent): void {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.pinch) { if (this.touches.size < 2) this.pinch = null; return; } // lifting a finger after a pinch must not click
    }
    if (e.button === 1) { this.panning = null; return; }
    if (e.button !== 0 || !this.downAt) return;
    const p = this.local(e);
    const start = this.downAt;
    const wasDrag = this.dragging;
    this.cancelDrag();
    if (!this.enabled) return;
    if (wasDrag) this.h.onBoxSelect(start.x, start.y, p.x, p.y, start.shift || e.shiftKey);
    else this.h.onClick(p.x, p.y, start.shift || e.shiftKey);
  }

  private cancelDrag(): void {
    this.downAt = null;
    this.dragging = false;
    this.panning = null;
    this.box.hidden = true;
  }

  private drawBox(x1: number, y1: number, x2: number, y2: number): void {
    const r = this.canvas.getBoundingClientRect();
    Object.assign(this.box.style, {
      left: `${r.left + Math.min(x1, x2)}px`, top: `${r.top + Math.min(y1, y2)}px`,
      width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px`,
    });
    this.box.hidden = false;
  }

  private keyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    const inField = !!t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (inField && e.code !== 'Escape') return;
    const dg = /^Digit([1-9])$/.exec(e.code);
    if (dg && this.enabled && !e.ctrlKey && !e.metaKey && (e.altKey || e.shiftKey)) {
      e.preventDefault();
      if (!e.repeat) this.h.onGroup(Number(dg[1]) - 1, e.altKey ? 'set' : 'recall');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Escape') { e.preventDefault(); this.h.onEscape(); return; }
    if (!this.enabled) return;
    const onButton = !!t && t.tagName === 'BUTTON';
    if (e.code === 'KeyP' || (e.code === 'Space' && !onButton)) { e.preventDefault(); if (!e.repeat) this.h.onPauseToggle(); return; }
    if (e.code === 'KeyQ') { if (!e.repeat) this.rig.rotateStep(1); return; }
    if (e.code === 'KeyE') { if (!e.repeat) this.rig.rotateStep(-1); return; }
    if (e.code === 'Equal' || e.code === 'NumpadAdd') { this.rig.zoomBy(1.15); return; }
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') { this.rig.zoomBy(1 / 1.15); return; }
    if (e.code === 'KeyH') { if (!e.repeat) this.h.onHome(); return; }
    if (e.code === 'KeyF') { if (!e.repeat) this.h.onAttackMove(); return; }
    if (e.code === 'KeyM') { if (!e.repeat) this.h.onToggleSound(); return; }
    if (e.code === 'F3') { e.preventDefault(); if (!e.repeat) this.h.onToggleStats(); return; }
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && !e.repeat) { this.h.onBuildHotkey(Number(digit[1]) - 1); return; }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
      this.keys.add(e.code);
    }
  }

  /** Apply held-key panning; call once per frame with real elapsed seconds. */
  update(dt: number): void {
    if (!this.enabled || this.keys.size === 0) return;
    const k = this.keys;
    const right = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    if (!right && !forward) return;
    const speed = (36 / this.rig.zoom) * dt;
    const len = Math.hypot(right, forward);
    this.rig.pan((right / len) * speed, (forward / len) * speed);
  }

  dispose(): void { this.disposers.forEach((d) => d()); this.disposers.length = 0; }
}
