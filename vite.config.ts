import { defineConfig, type Plugin } from 'vite';

const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';

/**
 * CrazyGames build (`vite build --mode crazygames`): adds the portal SDK and loosens the Content Security
 * Policy just enough for it. The regular build ships no remote origins at all.
 *  - scripts: this origin plus the SDK host only (the XSS-relevant directive stays tight);
 *  - connect: https/wss, because the SDK talks to several portal endpoints that are not published as a list.
 *    The game holds no secrets and makes no requests of its own, so this is low risk; tighten it if the
 *    portal's preview tool shows the exact hosts.
 */
function crazyGamesHtml(): Plugin {
  return {
    name: 'palava-crazygames-html',
    apply: 'build',
    transformIndexHtml(html) {
      let out = html.replace("script-src 'self';", `script-src 'self' ${SDK_URL.replace(/\/[^/]*$/, '')};`);
      out = out.replace("connect-src 'self' blob: ws://localhost:* ws://127.0.0.1:*;", "connect-src 'self' blob: https: wss:;");
      out = out.replace("img-src 'self' data: blob:;", "img-src 'self' data: blob: https:;");
      // The portal's endpoints may check the referrer, so send the origin (the regular build sends none).
      out = out.replace('content="no-referrer"', 'content="strict-origin-when-cross-origin"');
      // First thing in <head>: the SDK must exist before the game's module script runs.
      return { html: out, tags: [{ tag: 'script', attrs: { src: SDK_URL }, injectTo: 'head-prepend' as const }] };
    },
  };
}

export default defineConfig(({ mode }) => {
  const cg = mode === 'crazygames';
  return {
    // Relative paths only: the portal serves the game from a path it chooses, and absolute paths fail to load.
    base: cg ? './' : '/',
    build: {
      target: 'es2022', chunkSizeWarningLimit: 900,
      outDir: cg ? 'dist-crazygames' : 'dist',
    },
    plugins: cg ? [crazyGamesHtml()] : [],
    test: { environment: 'node', include: ['tests/**/*.test.ts'] },
  };
});
