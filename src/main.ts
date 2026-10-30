import './style.css';
import { Game } from './game';
import { createPlatform } from './platform/platform';

function showFatal(message: string): void {
  const el = document.getElementById('fatal');
  if (el) { el.hidden = false; el.textContent = message; }
}

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) {
  showFatal('The game could not start: the page is missing its canvas.');
} else {
  void boot(canvas);
}

async function boot(canvas: HTMLCanvasElement): Promise<void> {
  // Portal SDK (CrazyGames build only): a no-op everywhere else, and never able to block the game.
  const platform = createPlatform();
  await platform.init();
  platform.loadingStart();
  try {
    const game = new Game(canvas, platform);
    if (import.meta.env.DEV) (window as unknown as { __palava: Game }).__palava = game;
    // Two frames: the first has been drawn and the menu is interactive.
    requestAnimationFrame(() => requestAnimationFrame(() => platform.loadingStop()));
  } catch (e) {
    console.error(e);
    platform.loadingStop();
    const webgl = e instanceof Error && /WebGL/.test(e.message);
    showFatal(webgl
      ? `${(e as Error).message} PALAVA needs a browser with WebGL enabled.`
      : 'The game could not start. Please reload the page or try another browser.');
  }
}

window.addEventListener('unhandledrejection', (e) => console.error('Unhandled rejection:', e.reason));
