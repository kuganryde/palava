import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AD_FAILSAFE_MS, SDK_INIT_TIMEOUT_MS, createPlatform } from '../src/platform/platform';

type Calls = string[];
function fakeSdk(opts: { env?: string; mute?: boolean; initFails?: boolean; hang?: boolean; adMode?: 'finish' | 'error' | 'silent' | 'throw'; dataThrows?: boolean } = {}) {
  const calls: Calls = [];
  const listeners: Array<(s: { muteAudio?: boolean }) => void> = [];
  const data = new Map<string, string>();
  const settings = { muteAudio: opts.mute ?? false };
  const sdk = {
    environment: opts.env ?? 'crazygames',
    init: () => (opts.hang ? new Promise<void>(() => undefined) : opts.initFails ? Promise.reject(new Error('boom')) : Promise.resolve()),
    game: {
      settings,
      gameplayStart: () => calls.push('start'), gameplayStop: () => calls.push('stop'),
      loadingStart: () => calls.push('loadStart'), loadingStop: () => calls.push('loadStop'), happytime: () => calls.push('happy'),
      addSettingsChangeListener: (l: (s: { muteAudio?: boolean }) => void) => listeners.push(l),
    },
    ad: {
      requestAd: (_t: string, cb: { adStarted?: () => void; adFinished?: () => void; adError?: (e: unknown) => void }) => {
        calls.push('ad');
        if (opts.adMode === 'throw') throw new Error('sdk crashed');
        if (opts.adMode === 'silent') return;
        if (opts.adMode === 'error') { cb.adError?.({ code: 'unfilled' }); return; }
        cb.adStarted?.(); cb.adFinished?.();
      },
    },
    data: {
      getItem: (k: string) => { if (opts.dataThrows) throw new Error('dataModuleDisabled'); return data.get(k) ?? null; },
      setItem: (k: string, v: string) => { if (opts.dataThrows) throw new Error('dataModuleDisabled'); data.set(k, v); },
      removeItem: (k: string) => { data.delete(k); },
    },
  };
  return { sdk, calls, listeners, settings, data };
}
const make = (f: ReturnType<typeof fakeSdk>) => createPlatform({ CrazyGames: { SDK: f.sdk } });

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('platform without an SDK', () => {
  it('is inert and never throws', async () => {
    const p = createPlatform({});
    await p.init();
    expect(p.env).toBe('none');
    p.loadingStart(); p.loadingStop(); p.setPlaying(true); p.setPlaying(false); p.happytime();
    expect(p.muted).toBe(false);
    expect(p.store()).toBeNull();
    const done = vi.fn();
    p.requestMidgameAd({ started: vi.fn(), finished: done });
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('environment handling', () => {
  it('uses crazygames and local, but ignores a disabled environment', async () => {
    for (const [env, expected] of [['crazygames', 'crazygames'], ['local', 'local'], ['disabled', 'none']] as const) {
      const f = fakeSdk({ env });
      const p = make(f);
      await p.init();
      expect(p.env).toBe(expected);
      p.setPlaying(true);
      expect(f.calls.includes('start')).toBe(expected !== 'none');
    }
  });
  it('survives a failing init', async () => {
    const f = fakeSdk({ initFails: true });
    const p = make(f);
    await p.init();
    expect(p.env).toBe('none');
    p.setPlaying(true);
    expect(f.calls).toEqual([]);
  });
  it('gives up on an SDK that never answers', async () => {
    vi.useFakeTimers();
    const p = make(fakeSdk({ hang: true }));
    const init = p.init();
    await vi.advanceTimersByTimeAsync(SDK_INIT_TIMEOUT_MS + 10);
    await init;
    expect(p.env).toBe('none');
  });
});

describe('gameplay and loading events', () => {
  it('forward only changes, in order', async () => {
    const f = fakeSdk();
    const p = make(f);
    await p.init();
    p.loadingStart(); p.loadingStop();
    p.setPlaying(false);
    p.setPlaying(true); p.setPlaying(true); p.setPlaying(true);
    p.setPlaying(false); p.setPlaying(false);
    p.setPlaying(true);
    p.happytime();
    expect(f.calls).toEqual(['loadStart', 'loadStop', 'start', 'stop', 'start', 'happy']);
  });
  it('an SDK exception is swallowed', async () => {
    const f = fakeSdk();
    f.sdk.game.gameplayStart = () => { throw new Error('nope'); };
    const p = make(f);
    await p.init();
    expect(() => p.setPlaying(true)).not.toThrow();
  });
});

describe('mute', () => {
  it('reads the initial setting and follows changes', async () => {
    const f = fakeSdk({ mute: true });
    const p = make(f);
    const seen = vi.fn();
    p.onMuteChange(seen);
    await p.init();
    expect(p.muted).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    f.listeners[0]!({ muteAudio: false });
    expect(p.muted).toBe(false);
    f.listeners[0]!({ muteAudio: false }); // no change: no callback
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('storage', () => {
  it('uses the SDK data module and falls back when it is disabled', async () => {
    const f = fakeSdk();
    const p = make(f);
    await p.init();
    const s = p.store()!;
    s.setItem('a', '1');
    expect(s.getItem('a')).toBe('1');
    expect(f.data.get('a')).toBe('1');
    s.removeItem('a');
    expect(s.getItem('a')).toBeNull();
    const g = fakeSdk({ dataThrows: true });
    const q = make(g);
    await q.init();
    const ls = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => ls.set(k, v), removeItem: (k: string) => ls.delete(k) });
    const t = q.store()!;
    t.setItem('x', 'y');
    expect(t.getItem('x')).toBe('y');
    vi.unstubAllGlobals();
  });
});

describe('midgame ads', () => {
  it('start then finish, once each', async () => {
    const f = fakeSdk({ adMode: 'finish' });
    const p = make(f);
    await p.init();
    const started = vi.fn(), finished = vi.fn();
    p.requestMidgameAd({ started, finished });
    expect(started).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
  });
  it('an ad error resumes the game without a start', async () => {
    const f = fakeSdk({ adMode: 'error' });
    const p = make(f);
    await p.init();
    const started = vi.fn(), finished = vi.fn();
    p.requestMidgameAd({ started, finished });
    expect(started).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledTimes(1);
  });
  it('a throwing SDK still ends with finished', async () => {
    const f = fakeSdk({ adMode: 'throw' });
    const p = make(f);
    await p.init();
    const finished = vi.fn();
    p.requestMidgameAd({ started: vi.fn(), finished });
    expect(finished).toHaveBeenCalledTimes(1);
  });
  it('a silent SDK is released by the failsafe, once', async () => {
    vi.useFakeTimers();
    const f = fakeSdk({ adMode: 'silent' });
    const p = make(f);
    await p.init();
    const finished = vi.fn();
    p.requestMidgameAd({ started: vi.fn(), finished });
    expect(finished).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AD_FAILSAFE_MS + 10);
    expect(finished).toHaveBeenCalledTimes(1);
  });
});
