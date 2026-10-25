import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  // scripts/videos generates renders (out/) and a scratch Rayfin app for checking lesson code (.cache/).
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'out-tsc/**', 'src-tauri/src/**', 'src-tauri/target/**', 'src-tauri/vendor/**', 'website/**', 'scripts/videos/out/**', 'scripts/videos/.cache/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node }
    }
  },
  // The YouTube tools also run code inside the browser's pages.
  {
    files: ['scripts/videos/tools/youtube/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    }
  }
)
