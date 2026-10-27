import './style.css';
import { Game } from './game';

function showFatal(message: string): void {
  const el = document.getElementById('fatal');
  if (el) { el.hidden = false; el.textContent = message; }
}

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) {
  showFatal('The game could not start: the page is missing its canvas.');
} else {
  try {
    const game = new Game(canvas);
    if (import.meta.env.DEV) (window as unknown as { __palava: Game }).__palava = game;
  } catch (e) {
    console.error(e);
    const webgl = e instanceof Error && /WebGL/.test(e.message);
    showFatal(webgl
      ? `${(e as Error).message} PALAVA needs a browser with WebGL enabled.`
      : 'The game could not start. Please reload the page or try another browser.');
  }
}

window.addEventListener('unhandledrejection', (e) => console.error('Unhandled rejection:', e.reason));
