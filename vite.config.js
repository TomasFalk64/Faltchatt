import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/Faltchatt/',
  worker: { format: 'es' },
  resolve: {
    alias: {
      'proj4-fully-loaded': fileURLToPath(new URL('./src/vendor/proj4FullyLoaded.js', import.meta.url)),
    },
  },
});
