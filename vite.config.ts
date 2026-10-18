import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The agent server writes its replay cache while a page is open; reloading would cut off a replay.
  server: { proxy: { '/api': 'http://localhost:8787' }, watch: { ignored: ['**/cache/**', '**/data/**'] } },
  test: {
    // Offline and repeatable: no model key, no replay cache, and a throwaway state file.
    env: { CRUSOE_API_KEY: '', LLM_CACHE: '0', LLM_CACHE_FILE: 'node_modules/.tmp/test/llm.json', TZ: 'UTC' },
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      // The logic the agents and views share; React components are left to the demo.
      include: ['src/shared/**', 'server/**'],
      reporter: ['text', 'json-summary', 'html'],
    },
  },
})
