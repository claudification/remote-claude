import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'react-vendor'
          }
          if (
            id.includes('date-fns') ||
            id.includes('clsx') ||
            id.includes('tailwind-merge') ||
            id.includes('class-variance-authority')
          ) {
            return 'utils-vendor'
          }
        },
      },
    },
  },
  server: {
    port: parseInt(process.env.PORT || '3456', 10),
    proxy: {
      '/sessions': {
        target: 'http://localhost:9999',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:9999',
        changeOrigin: true,
      },
      '/file': {
        target: 'http://localhost:9999',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:9999',
        ws: true,
      },
    },
  },
})
