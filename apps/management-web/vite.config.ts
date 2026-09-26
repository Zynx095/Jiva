import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  envDir: path.resolve(import.meta.dirname, '../../'),
  resolve: {
    // @jiva/ui is consumed as source; force a single React instance for the whole bundle.
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    // maplibre-gl v6 loads its worker from a sibling .mjs file; pre-bundling breaks that path.
    exclude: ['maplibre-gl'],
  },
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
})
