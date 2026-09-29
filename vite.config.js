import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  worker: { format: 'es' },
  resolve: {
    alias: {
      'proj4-fully-loaded': fileURLToPath(new URL('./src/vendor/proj4FullyLoaded.js', import.meta.url)),
    },
  },
});
