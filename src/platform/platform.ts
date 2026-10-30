import type { KeyValueStore } from '../systems/save';

/**
 * Portal integration (CrazyGames SDK v3). Everything the game needs from a portal goes through this one
 * facade, so the rest of the code never touches `window.CrazyGames` directly.
 *
 * Robustness rules (a portal SDK must never be able to break the game):
 *  - Without the SDK (own site, adblock, offline) every method is a harmless no-op.
 *  - The SDK is only used when its environment is `crazygames` or `local`; `disabled` throws on use.
 *  - Every SDK call is wrapped: an exception is logged and swallowed.
 *  - Gameplay start/stop are edge-triggered, so callers can just report their current state each frame.
 *  - An ad request always ends in exactly one `finished` callback, even if the SDK never answers.
 */

export type PlatformEnv = 'none' | 'local' | 'crazygames';

export interface AdCallbacks {
  /** The ad is actually playing: mute and pause now. */
  started(): void;
  /** The ad ended, failed or was never available: resume. Called exactly once. */
  finished(): void;
}

export interface Platform {
  readonly env: PlatformEnv;
  /** Resolves when the SDK is ready or has been given up on. Never rejects. */
  init(): Promise<void>;
  loadingStart(): void;
  loadingStop(): void;
  /** Report whether the player is actively playing; only changes are forwarded to the portal. */
  setPlaying(playing: boolean): void;
  /** A major achievement (the portal celebrates). Use sparingly. */
  happytime(): void;
  /** True while the portal asks for all game audio to be off. Takes priority over in-game settings. */
  readonly muted: boolean;
  onMuteChange(listener: () => void): void;
  /** Portal-backed storage (cloud saves for signed-in players) or null to use localStorage. */
  store(): KeyValueStore | null;
  /** Show a midgame ad at a natural break. Ends with `finished` whatever happens. */
  requestMidgameAd(cb: AdCallbacks): void;
}

/** The slice of the SDK this game uses (typed loosely: it comes from a remote script). */
interface SdkLike {
  init(): Promise<void>;
  environment?: string;
  game?: {
    gameplayStart?(): void; gameplayStop?(): void; loadingStart?(): void; loadingStop?(): void; happytime?(): void;
    settings?: { muteAudio?: boolean };
    addSettingsChangeListener?(l: (s: { muteAudio?: boolean }) => void): void;
  };
  ad?: { requestAd?(type: 'midgame' | 'rewarded', cb: { adStarted?: () => void; adFinished?: () => void; adError?: (e: unknown) => void }): void };
  data?: KeyValueStore;
}

/** Give up on a silent SDK so a blocked or slow script can never hold the game on the loading screen. */
export const SDK_INIT_TIMEOUT_MS = 4000;
/** If an ad never reports back, hand control to the player again after this long. */
export const AD_FAILSAFE_MS = 90_000;

export function createPlatform(win: { CrazyGames?: { SDK?: unknown } } = globalThis as never): Platform {
  const sdk = win.CrazyGames?.SDK as SdkLike | undefined;
  let env: PlatformEnv = 'none';
  let playing = false;
  let muted = false;
  const muteListeners: Array<() => void> = [];

  const safe = <T>(label: string, fn: () => T): T | undefined => {
    try { return fn(); } catch (e) { console.warn(`CrazyGames SDK: ${label} failed`, e); return undefined; }
  };
  const active = (): SdkLike | null => (env === 'none' || !sdk ? null : sdk);

  const readMute = (s: { muteAudio?: boolean } | undefined): void => {
    const next = s?.muteAudio === true;
    if (next === muted) return;
    muted = next;
    for (const l of muteListeners) safe('mute listener', l);
  };

  return {
    get env() { return env; },
    get muted() { return muted; },

    async init(): Promise<void> {
      if (!sdk || typeof sdk.init !== 'function') return;
      const ready = await Promise.race([
        sdk.init().then(() => true, (e: unknown) => { console.warn('CrazyGames SDK init failed', e); return false; }),
        new Promise<boolean>((r) => setTimeout(() => r(false), SDK_INIT_TIMEOUT_MS)),
      ]);
      if (!ready) return;
      const e = sdk.environment;
      if (e !== 'crazygames' && e !== 'local') return; // 'disabled' (any other site): calls would throw
      env = e;
      readMute(sdk.game?.settings);
      safe('settings listener', () => sdk.game?.addSettingsChangeListener?.((s) => readMute(s)));
    },

    loadingStart() { safe('loadingStart', () => active()?.game?.loadingStart?.()); },
    loadingStop() { safe('loadingStop', () => active()?.game?.loadingStop?.()); },

    setPlaying(next: boolean): void {
      if (next === playing) return;
      playing = next;
      safe(next ? 'gameplayStart' : 'gameplayStop', () => (next ? active()?.game?.gameplayStart?.() : active()?.game?.gameplayStop?.()));
    },

    happytime() { safe('happytime', () => active()?.game?.happytime?.()); },

    onMuteChange(listener: () => void): void { muteListeners.push(listener); },

    store(): KeyValueStore | null {
      const data = active()?.data;
      if (!data) return null;
      // The data module throws when it is switched off for the game (or storage is unavailable):
      // fall back to localStorage per call so saving keeps working either way.
      const ls = (): Storage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
      return {
        getItem: (k) => { try { return data.getItem(k); } catch { return ls()?.getItem(k) ?? null; } },
        setItem: (k, v) => { try { data.setItem(k, v); } catch { ls()?.setItem(k, v); } },
        removeItem: (k) => { try { data.removeItem(k); } catch { ls()?.removeItem(k); } },
      };
    },

    requestMidgameAd(cb: AdCallbacks): void {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => { if (done) return; done = true; if (timer) clearTimeout(timer); safe('ad finished callback', cb.finished); };
      const s = active();
      const request = s?.ad?.requestAd;
      if (!s || !request) { finish(); return; }
      timer = setTimeout(finish, AD_FAILSAFE_MS);
      const ok = safe('requestAd', () => {
        request.call(s.ad, 'midgame', {
          adStarted: () => { if (!done) safe('ad started callback', cb.started); },
          adFinished: finish,
          adError: finish, // unfilled, blocked, cooldown or disabled: the game just carries on
        });
        return true;
      });
      if (!ok) finish();
    },
  };
}

/** A platform that does nothing; used by tests and as the safe default. */
export const nullPlatform: Platform = createPlatform({});
