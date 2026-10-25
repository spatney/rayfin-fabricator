import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Renderer unit/integration tests (jsdom). Kept separate from vite.config.mts
// (whose `root` is src/renderer, tuned for the app build) so test discovery and
// aliases are unambiguous. Run with `npm test`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(import.meta.dirname, 'src/renderer/src'),
      '@shared': resolve(import.meta.dirname, 'src/shared')
    }
  },
  test: {
    environment: 'jsdom',
    include: ['src/renderer/**/*.test.{ts,tsx}'],
    globals: false,
    restoreMocks: true,
    css: false
  }
})
