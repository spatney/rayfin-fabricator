import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite config for the React renderer, built/served for the Tauri shell.
// The renderer source lives under src/renderer (entry: src/renderer/index.html →
// /src/main.tsx). Output goes to dist/, which Tauri consumes as `frontendDist`.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  // Tauri serves assets from a custom protocol; relative asset URLs keep them
  // resolvable both in `tauri dev` and in the packaged app.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  // Prevent Vite from obscuring Rust compiler errors during `tauri dev`.
  clearScreen: false,
  // Expose TAURI_* env vars to the client so build-time platform info is available.
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  server: {
    // Fabricator's own renderer dev server uses 1420 (Tauri's default) so that
    // port 5173 stays free for a project's live local-preview Vite server — Rayfin
    // apps pin their auth redirect URI / CORS to localhost:5173. Keep in sync with
    // `src-tauri/tauri.conf.json` (`build.devUrl`).
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      // Don't watch the Rust crate from the Vite dev server.
      ignored: ['**/src-tauri/**']
    }
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: false
  }
})
