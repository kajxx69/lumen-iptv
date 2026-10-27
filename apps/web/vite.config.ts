import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Backend Lumen en développement : l'API est relayée pour rester sur la même origine. */
const DEV_BACKEND = process.env['LUMEN_DEV_BACKEND'] ?? 'http://127.0.0.1:8090';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': DEV_BACKEND },
  },
  build: {
    outDir: 'dist',
    // Navigateurs de TV connectées et de box Android : pas plus récent qu'ES2020.
    target: 'es2020',
    sourcemap: true,
    // Pas de script en ligne : la CSP du backend l'interdit.
    modulePreload: { polyfill: false },
  },
});
