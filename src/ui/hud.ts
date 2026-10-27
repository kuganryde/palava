import {
  BUILDABLE, BUILDING_DEFS, RESOURCE_IDS, UNIT_DEFS,
  type BuildingType, type ResourceId, type Resources, type UnitKind,
} from '../core/defs';
import { canAfford, missingResources } from '../core/state';
import { FORMATIONS, type FormationKind } from '../systems/formation';
import type { Quality, Settings } from '../systems/settings';

const RES_COLORS: Record<ResourceId, string> = { food: '#9acd32', timber: '#a0703c', stone: '#b8b2a0', iron: '#7f8fa6', gold: '#e0b040' };
const RES_LABEL: Record<ResourceId, string> = { food: 'Food', timber: 'Timber', stone: 'Stone', iron: 'Iron', gold: 'Gold' };

export interface HudHandlers {
  onBuild(type: BuildingType): void;
  onFormation(kind: FormationKind): void;
  onRecruit(kind: UnitKind): void;
  onPauseToggle(): void;
  onSpeed(speed: 1 | 2): void;
  onMenu(): void;
  onResume(): void;
  onContinue(): void;
  onNewGame(): void;
  onSave(): void;
  onLoad(): void;
  onSettings(s: Partial<Settings>): void;
  onSoundToggle(): void;
}

export type SelectionInfo =
  | { kind: 'none' }
  | { kind: 'units'; counts: Partial<Record<UnitKind, number>>; avgHpFraction: number; moving: number; formation: FormationKind }
  | { kind: 'building'; hpFraction: number; name: string; progress: number; description: string; recruit: { kind: UnitKind; enabled: boolean }[] | null };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // textContent only: never inject HTML
  return e;
}
function $<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing #${id} in index.html`);
  return e as T;
}
function costText(cost: Partial<Resources>): string {
  const parts = RESOURCE_IDS.filter((r) => (cost[r] ?? 0) > 0).map((r) => `${cost[r]} ${RES_LABEL[r]}`);
  return parts.length ? parts.join(' · ') : 'Free';
}

export class Hud {
  private readonly resourceEls = new Map<ResourceId, { li: HTMLElement; val: HTMLElement; rate: HTMLElement }>();
  private readonly buildButtons = new Map<BuildingType, { btn: HTMLButtonElement; cost: HTMLElement }>();
  private readonly selPanel = $('selpanel');
  private readonly cache = new Map<string, string>();
  private toastTimers = new Set<number>();

  constructor(private readonly h: HudHandlers) {
    this.buildResourceBar();
    this.buildBuildMenu();
    $('btn-pause').addEventListener('click', h.onPauseToggle);
    $('btn-1x').addEventListener('click', () => h.onSpeed(1));
    $('btn-2x').addEventListener('click', () => h.onSpeed(2));
    $('btn-menu').addEventListener('click', h.onMenu);
    $('btn-sound').addEventListener('click', h.onSoundToggle);
    $<HTMLInputElement>('set-sound').addEventListener('change', (e) => h.onSettings({ sound: (e.target as HTMLInputElement).checked }));
    $('ov-resume').addEventListener('click', h.onResume);
    $('ov-continue').addEventListener('click', h.onContinue);
    $('ov-new').addEventListener('click', h.onNewGame);
    $('ov-save').addEventListener('click', h.onSave);
    $('ov-load').addEventListener('click', h.onLoad);
    $('ov-settings').addEventListener('click', () => this.pane('settings'));
    $('ov-help').addEventListener('click', () => this.pane('help'));
    $('set-back').addEventListener('click', () => this.pane('main'));
    $('help-back').addEventListener('click', () => this.pane('main'));
    $<HTMLSelectElement>('set-quality').addEventListener('change', (e) => h.onSettings({ quality: (e.target as HTMLSelectElement).value as Quality }));
    $<HTMLInputElement>('set-shadows').addEventListener('change', (e) => h.onSettings({ shadows: (e.target as HTMLInputElement).checked }));
    $<HTMLInputElement>('set-adaptive').addEventListener('change', (e) => h.onSettings({ adaptiveResolution: (e.target as HTMLInputElement).checked }));
    $<HTMLInputElement>('set-motion').addEventListener('change', (e) => h.onSettings({ reducedMotion: (e.target as HTMLInputElement).checked }));
    $<HTMLInputElement>('set-daynight').addEventListener('change', (e) => h.onSettings({ dayNight: (e.target as HTMLInputElement).checked }));
    $<HTMLInputElement>('set-weather').addEventListener('change', (e) => h.onSettings({ weather: (e.target as HTMLInputElement).checked }));
  }

  private buildResourceBar(): void {
    const ul = $('resources');
    for (const r of RESOURCE_IDS) {
      const li = el('li');
      const dot = el('span', 'dot'); dot.style.background = RES_COLORS[r];
      const name = el('span', undefined, RES_LABEL[r]);
      const val = el('b', undefined, '0');
      const rate = el('span', 'rate');
      li.append(dot, name, val, rate);
      ul.append(li);
      this.resourceEls.set(r, { li, val, rate });
    }
  }

  private buildBuildMenu(): void {
    const nav = $('buildmenu');
    nav.append(el('h2', undefined, 'Construct'));
    BUILDABLE.forEach((type, i) => {
      const def = BUILDING_DEFS[type];
      const btn = el('button');
      btn.type = 'button';
      btn.title = def.description;
      btn.append(el('span', 'name', def.name), el('span', 'key', String(i + 1)));
      const cost = el('span', 'cost', costText(def.cost));
      btn.append(cost);
      btn.setAttribute('aria-label', `Build ${def.name}. Cost: ${costText(def.cost)}. Hotkey ${i + 1}.`);
      btn.addEventListener('click', () => this.h.onBuild(type));
      nav.append(btn);
      this.buildButtons.set(type, { btn, cost });
    });
  }

  private set(key: string, value: string, apply: () => void): void {
    if (this.cache.get(key) !== value) { this.cache.set(key, value); apply(); }
  }

  setResources(res: Resources, perSecond: Resources, pop: number, popCap: number, timeSeconds: number): void {
    for (const r of RESOURCE_IDS) {
      const e = this.resourceEls.get(r)!;
      this.set(`res.${r}`, `${Math.floor(res[r])}|${Math.round(perSecond[r] * 60)}`, () => {
        e.val.textContent = String(Math.floor(res[r]));
        const perMin = Math.round(perSecond[r] * 60);
        e.rate.textContent = perMin > 0 ? `+${perMin}/min` : '';
        e.li.setAttribute('aria-label', `${RES_LABEL[r]} ${Math.floor(res[r])}${perMin > 0 ? `, plus ${perMin} per minute` : ''}`);
      });
    }
    this.set('pop', `${pop}/${popCap}`, () => {
      const p = $('pop'); p.textContent = `Pop ${pop}/${popCap}`;
      p.style.borderColor = pop >= popCap ? '#e5484d' : '';
    });
    const m = Math.floor(timeSeconds / 60), s = Math.floor(timeSeconds % 60);
    this.set('clock', `${m}:${s}`, () => { $('clock').textContent = `${m}:${String(s).padStart(2, '0')}`; });
  }

  setBuildState(res: Resources, active: BuildingType | null): void {
    for (const [type, { btn, cost }] of this.buildButtons) {
      const def = BUILDING_DEFS[type];
      const ok = canAfford(res, def.cost);
      const missing = missingResources(res, def.cost).join(',');
      this.set(`bm.${type}`, `${ok}|${active === type}|${missing}`, () => {
        btn.setAttribute('aria-disabled', String(!ok));
        btn.classList.toggle('active', active === type);
        btn.setAttribute('aria-pressed', String(active === type));
        cost.replaceChildren();
        const parts = RESOURCE_IDS.filter((r) => (def.cost[r] ?? 0) > 0);
        parts.forEach((r, i) => {
          const s = el('span', res[r] < (def.cost[r] ?? 0) ? 'short' : undefined, `${def.cost[r]} ${RES_LABEL[r]}`);
          cost.append(s);
          if (i < parts.length - 1) cost.append(document.createTextNode(' · '));
        });
        if (!parts.length) cost.textContent = 'Free';
      });
    }
  }

  setSelection(info: SelectionInfo, formation: FormationKind): void {
    const key = JSON.stringify(info) + formation;
    if (this.cache.get('sel') === key) return;
    this.cache.set('sel', key);
    const p = this.selPanel;
    p.replaceChildren();
    p.classList.toggle('empty', info.kind === 'none');
    if (info.kind === 'none') {
      p.append(el('h2', undefined, 'Nothing selected'), el('span', 'muted', 'Click or drag to select units. Click the Palace or a Barracks to train units.'));
      return;
    }
    if (info.kind === 'units') {
      const total = Object.values(info.counts).reduce((a, b) => a + (b ?? 0), 0);
      p.append(el('h2', undefined, `${total} unit${total === 1 ? '' : 's'} selected`));
      const detail = (Object.keys(info.counts) as UnitKind[])
        .filter((k) => (info.counts[k] ?? 0) > 0).map((k) => `${info.counts[k]} × ${UNIT_DEFS[k].name}`).join(', ');
      p.append(el('span', undefined, detail));
      const hp = el('div', 'row');
      const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = `${Math.round(info.avgHpFraction * 100)}%`; bar.append(fill);
      hp.append(el('span', 'muted', 'Health'), bar, el('span', 'muted', info.moving > 0 ? `${info.moving} moving` : 'idle'));
      p.append(hp);
      const row = el('div', 'row');
      row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Formation');
      row.append(el('span', 'muted', 'Formation:'));
      for (const f of FORMATIONS) {
        const b = el('button', f === formation ? 'active' : undefined, f[0]!.toUpperCase() + f.slice(1));
        b.type = 'button'; b.setAttribute('aria-pressed', String(f === formation));
        b.addEventListener('click', () => this.h.onFormation(f));
        row.append(b);
      }
      p.append(row, el('span', 'muted', 'Right-click the ground to move.'));
      return;
    }
    p.append(el('h2', undefined, info.name), el('span', 'muted', info.description));
    if (info.hpFraction < 1) {
      const hrow = el('div', 'row');
      const hbar = el('div', 'bar'); const hfill = el('i'); hfill.style.width = `${Math.round(info.hpFraction * 100)}%`; hbar.append(hfill);
      hrow.append(el('span', 'muted', 'Structure'), hbar, el('span', 'muted', `${Math.round(info.hpFraction * 100)}%`));
      p.append(hrow);
    }
    if (info.progress < 1) {
      const row = el('div', 'row');
      const bar = el('div', 'bar build'); const fill = el('i'); fill.style.width = `${Math.round(info.progress * 100)}%`; bar.append(fill);
      row.append(el('span', 'muted', 'Under construction'), bar, el('span', 'muted', `${Math.round(info.progress * 100)}%`));
      p.append(row);
    } else if (info.recruit) {
      const row = el('div', 'row');
      for (const r of info.recruit) {
        const def = UNIT_DEFS[r.kind];
        const b = el('button', undefined, `Recruit ${def.name} (${costText(def.cost)})`);
        b.type = 'button'; b.setAttribute('aria-disabled', String(!r.enabled));
        b.addEventListener('click', () => this.h.onRecruit(r.kind));
        row.append(b);
      }
      p.append(row);
    }
  }

  toast(message: string, kind: 'info' | 'good' | 'error' = 'info'): void {
    const root = $('toasts');
    while (root.children.length >= 3) root.firstElementChild?.remove();
    const t = el('div', `toast ${kind === 'info' ? '' : kind}`.trim(), message);
    root.append(t);
    const id = window.setTimeout(() => { t.remove(); this.toastTimers.delete(id); }, kind === 'error' ? 4500 : 3000);
    this.toastTimers.add(id);
  }

  /** Countdown to the next enemy raid; null hides the chip. */
  setRaid(text: string | null, imminent: boolean): void {
    this.set('raid', `${text}|${imminent}`, () => {
      const e = $('raid');
      e.hidden = text === null;
      if (text !== null) { e.textContent = text; e.classList.toggle('warn', imminent); e.setAttribute('aria-label', `${text} until the next enemy raid`); }
    });
  }

  /** Time-of-day chip, e.g. 06:30 with a sun/moon glyph drawn in CSS from the data-phase attribute. */
  setDayTime(text: string, phase: 'day' | 'dusk' | 'night'): void {
    this.set('daytime', text + phase, () => { const e = $('daytime'); e.textContent = text; e.dataset.phase = phase; e.setAttribute('aria-label', `Time of day ${text}`); });
  }

  setStats(text: string): void { this.set('stats', text, () => { $('stats').textContent = text; }); }
  setPaused(paused: boolean, speed: 1 | 2): void {
    $('pausebanner').hidden = !paused;
    $('btn-pause').classList.toggle('active', paused);
    $('btn-pause').setAttribute('aria-pressed', String(paused));
    $('btn-1x').classList.toggle('active', !paused && speed === 1);
    $('btn-2x').classList.toggle('active', !paused && speed === 2);
  }
  showStats(visible: boolean): void { $('stats').hidden = !visible; }
  showHud(visible: boolean): void { $('hud').hidden = !visible; }

  private pane(which: 'main' | 'settings' | 'help'): void {
    $('ov-main').hidden = which !== 'main';
    $('ov-settings-pane').hidden = which !== 'settings';
    $('ov-help-pane').hidden = which !== 'help';
    const first = which === 'main'
      ? document.querySelector<HTMLElement>('#ov-main button:not([hidden])')
      : which === 'settings' ? $('set-quality') : $('help-back');
    first?.focus();
  }

  showOverlay(opts: { inGame: boolean; canContinue: boolean; note?: string; title?: string; sub?: string }): void {
    $('overlay').hidden = false;
    $('ov-resume').hidden = !opts.inGame;
    $('ov-save').hidden = !opts.inGame;
    $('ov-continue').hidden = opts.inGame || !opts.canContinue;
    $('ov-title').textContent = opts.title ?? 'PALAVA';
    $('ov-sub').textContent = opts.sub ?? 'Rise of an Ancient Kingdom';
    $('ov-note').textContent = opts.note ?? '';
    this.pane('main');
  }
  setNote(text: string): void { $('ov-note').textContent = text; }
  hideOverlay(): void {
    $('overlay').hidden = true;
    $('ov-title').textContent = 'PALAVA'; // clear any VICTORY/DEFEAT headline
    $('ov-sub').textContent = 'Rise of an Ancient Kingdom';
  }
  get overlayOpen(): boolean { return !$('overlay').hidden; }

  syncSettings(s: Settings): void {
    $<HTMLSelectElement>('set-quality').value = s.quality;
    $<HTMLInputElement>('set-shadows').checked = s.shadows;
    $<HTMLInputElement>('set-adaptive').checked = s.adaptiveResolution;
    $<HTMLInputElement>('set-motion').checked = s.reducedMotion;
    $<HTMLInputElement>('set-daynight').checked = s.dayNight;
    $<HTMLInputElement>('set-weather').checked = s.weather;
    $<HTMLInputElement>('set-sound').checked = s.sound;
    const bs = $('btn-sound'); bs.classList.toggle('muted', !s.sound); bs.setAttribute('aria-pressed', String(!s.sound));
    bs.setAttribute('aria-label', s.sound ? 'Mute sound (M)' : 'Unmute sound (M)');
  }

  fatal(message: string): void {
    const f = $('fatal');
    f.hidden = false;
    f.textContent = message;
  }
}
