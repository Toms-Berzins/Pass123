import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: 'esnext',
    sourcemap: true,
  },
  server: {
    // CRXJS HMR needs a stable port for the extension to connect to.
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
})
