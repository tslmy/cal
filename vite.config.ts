import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The agent server writes its replay cache while a page is open; reloading would cut off a replay.
  server: { proxy: { '/api': 'http://localhost:8787' }, watch: { ignored: ['**/cache/**', '**/data/**'] } },
})
