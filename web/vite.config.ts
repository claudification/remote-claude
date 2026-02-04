import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
	plugins: [react(), tailwindcss(), tsconfigPaths()],
	build: {
		outDir: 'dist',
		sourcemap: true,
		rollupOptions: {
			output: {
				manualChunks: {
					'react-vendor': ['react', 'react-dom'],
					'utils-vendor': ['date-fns', 'clsx', 'tailwind-merge', 'class-variance-authority'],
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
			'/ws': {
				target: 'ws://localhost:9999',
				ws: true,
			},
		},
	},
})
