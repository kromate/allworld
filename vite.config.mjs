import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { join } from 'node:path'
import { createReadStream, readFileSync, readdirSync } from 'node:fs'
import { invalidateTypeCache } from 'vue/compiler-sfc'
import { previewBuildInfo } from './scripts/preview/build-info.mjs'

// .pack.gz files are application payloads. Sirv otherwise marks their gzip wrapper as HTTP
// Content-Encoding, which Fetch removes before the vehicle provenance check can hash the file.
export function publicPackPayloads() {
  return {
    name: 'public-pack-payloads',
    apply: 'serve',
    configureServer(server) {
      const manifest = JSON.parse(readFileSync(join(server.config.root, 'src/assets/public-assets.index.json'), 'utf8'))
      const packs = new Set(Object.keys(manifest.assets).filter(path => path.endsWith('.pack.gz')))
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
        if (!packs.has(pathname) || !['GET', 'HEAD'].includes(request.method ?? 'GET')) return next()
        response.setHeader('Content-Type', 'application/gzip')
        response.setHeader('Cache-Control', 'no-cache')
        if (request.method === 'HEAD') { response.end(); return }
        const stream = createReadStream(join(server.config.publicDir, pathname.slice(1)))
        stream.on('error', error => response.destroy(error))
        stream.pipe(response)
      })
    },
  }
}

// Local only: mounts the world service on the dev server. The standalone hosted build uses
// its configured world endpoint and never loads this development plugin.
//
// One state file has one owner. The shared dev server (port 5187) owns
// `.goalmatic/local/world-state.json`. Anything else — a playtest, a browser check, a load run —
// starts its own copy with its own state and cache:
//   NW_STATE="$STATE_PATH" NW_CACHE_DIR="$CACHE_PATH" npx vite --port 5250 --strictPort
// Vite restarts its server whenever a service file changes, and several restarts can overlap.
// The world must not be tied to any one of those servers: an earlier version left the previous
// world running after each restart, and the stale copies kept writing their old state over the
// newer file (playtest R1-00, lost progress). So there is exactly one world per process, kept
// here across restarts. A restart stops the old one (which saves), then starts the new one from
// what was saved. Every Vite server forwards to whichever world is current.
const slot = (globalThis.__neighbourhoodWorld ??= { queue: Promise.resolve(), current: null, upgrade: null, servers: new WeakSet(), exitHook: false })

function localWorldService() {
  return {
    name: 'local-world-service',
    apply: 'serve',
    async configureServer(server) {
      const statePath = process.env.NW_STATE || join(server.config.root, '.goalmatic', 'local', 'world-state.json')
      slot.queue = slot.queue.then(async () => {
        const { createWorldServer } = await import('./service/server.ts')
        const previous = slot.current
        slot.current = null; slot.upgrade = null
        previous?.stop()
        const next = createWorldServer({ statePath })
        // The world sees this server through a stand-in, so its socket handler can be handed to
        // whichever Vite server is listening rather than being bound to one that may go away.
        const http = server.httpServer
        next.attach({
          get listening() { return http?.listening ?? false },
          address: () => http?.address() ?? null,
          once: (event, listener) => { http?.once(event, listener) },
          on: (event, listener) => { if (event === 'upgrade') slot.upgrade = listener; else http?.on(event, listener) },
        })
        slot.current = next
      }).catch(error => { console.error('[world] the local world service could not start:', error) })
      await slot.queue
      server.middlewares.use((request, response, next) => { if (!slot.current || !slot.current.handle(request, response)) next() })
      if (server.httpServer && !slot.servers.has(server.httpServer)) {
        slot.servers.add(server.httpServer)
        server.httpServer.on('upgrade', (request, socket, head) => slot.upgrade?.(request, socket, head))
      }
      if (!slot.exitHook) { slot.exitHook = true; process.once('exit', () => { try { slot.current?.stop() } catch { /* nothing left to save to */ } }) }
    },
  }
}

// Players choose when to take a new preview build. Build polling replaces automatic HMR reloads.

// Service dependencies restart Vite before Vue's hot-update hook sees their changed types.
// Clear those cached declarations so fresh component code receives its new runtime props.
function freshComponentTypes() {
  return {
    name: 'fresh-component-types',
    apply: 'serve',
    configureServer(server) {
      const source = join(server.config.root, 'src')
      for (const file of readdirSync(source, { recursive: true })) {
        if (/\.tsx?$/.test(file)) invalidateTypeCache(join(source, file))
      }
    },
  }
}

export default defineConfig({
  plugins: [publicPackPayloads(), previewBuildInfo(), freshComponentTypes(), vue(), localWorldService()],
  ...(process.env.NW_CACHE_DIR ? { cacheDir: process.env.NW_CACHE_DIR } : {}),
  server: { host: '127.0.0.1', hmr: false, watch: { ignored: ['**/.goalmatic/local/**'] } },
  build: { chunkSizeWarningLimit: 900 },
})
