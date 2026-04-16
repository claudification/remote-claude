import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Generate asset-manifest.json listing every file the dashboard needs.
// The SW uses this to precache on install and detect new builds.
function assetManifestPlugin(): Plugin {
  return {
    name: 'asset-manifest',
    writeBundle(options, bundle) {
      const outDir = options.dir || 'dist'
      const files: Array<{ url: string; size: number; hash: string }> = []
      const h = createHash('md5')

      for (const [name, chunk] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        const source = chunk.type === 'chunk' ? chunk.code : (chunk.source as string | Buffer)
        const size = typeof source === 'string' ? Buffer.byteLength(source) : (source?.length ?? 0)
        const fileHash = createHash('md5')
          .update(source ?? '')
          .digest('hex')
          .slice(0, 8)
        h.update(name)
        files.push({ url: `/${name}`, size, hash: fileHash })
      }

      // Also include static public files that Vite copies but aren't in the bundle
      const publicFiles = ['sw.js', 'icon-192.png', 'icon-512.png', 'favicon.ico']
      for (const f of publicFiles) {
        try {
          const content = require('node:fs').readFileSync(join(outDir, f))
          const fileHash = createHash('md5').update(content).digest('hex').slice(0, 8)
          files.push({ url: `/${f}`, size: content.length, hash: fileHash })
          h.update(f + fileHash)
        } catch {}
      }

      const buildHash = h.digest('hex').slice(0, 12)
      const manifest = { buildHash, buildTime: new Date().toISOString(), files }
      writeFileSync(join(outDir, 'asset-manifest.json'), JSON.stringify(manifest, null, 2))

      const totalKB = Math.round(files.reduce((s, f) => s + f.size, 0) / 1024)
      console.log(`[asset-manifest] ${buildHash} -- ${files.length} files, ${totalKB} KB`)

      // Stamp build hash into sw.js so the browser detects it as "changed"
      // and triggers reinstall + precache on each build
      const swPath = join(outDir, 'sw.js')
      try {
        const sw = readFileSync(swPath, 'utf8')
        writeFileSync(swPath, sw.replace('__BUILD_HASH__', buildHash))
        console.log(`[asset-manifest] stamped sw.js with build hash ${buildHash}`)
      } catch {}
    },
  }
}

export default defineConfig(({ mode }) => {
  // REACT_DEV=1 or --mode development: full React dev bundles with readable error messages
  const reactDev = mode === 'development'

  return {
    plugins: [react(), tailwindcss(), assetManifestPlugin()],
    resolve: {
      tsconfigPaths: true,
      conditions: reactDev ? ['development'] : [],
      alias: {
        // Enable React Profiler in production builds (for perf monitoring).
        // Skipped in dev mode -- profiling is a production variant, we want the full dev bundle.
        ...(reactDev ? {} : { 'react-dom/client': 'react-dom/profiling' }),
      },
    },
    // Force process.env.NODE_ENV replacement in debug builds so React's
    // index.js conditional require resolves to the development bundle.
    ...(reactDev ? { define: { 'process.env.NODE_ENV': '"development"' } } : {}),
    build: {
      outDir: 'dist',
      sourcemap: true,
      minify: reactDev ? false : undefined,
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
        '/auth': {
          target: 'http://localhost:9999',
          changeOrigin: true,
        },
        '/api': {
          target: 'http://localhost:9999',
          changeOrigin: true,
        },
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
  }
})
