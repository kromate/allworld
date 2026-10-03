import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

export function previewBuildInfo({ sourceFiles = [], buildIdentity = null } = {}) {
  let root = ''
  function info() {
    const files = ['App.vue', 'main.ts', 'index.html', 'vite.config.mjs', 'package.json', 'package-lock.json', 'scripts/preview/build-info.mjs', ...sourceFiles]
    for (const dir of ['src', 'service']) for (const file of readdirSync(join(root, dir), { recursive: true })) {
      if (/\.(ts|vue|css|json|js)$/.test(file)) files.push(`${dir}/${file}`)
    }
    const hash = createHash('sha256')
    for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0')
    if (buildIdentity !== null) hash.update('buildIdentity').update('\0').update(JSON.stringify(buildIdentity)).update('\0')
    const assets = JSON.parse(readFileSync(join(root, 'src/assets/public-assets.index.json'), 'utf8'))
    return { id: hash.digest('hex').slice(0, 12), assets: assets.revision }
  }
  return {
    name: 'preview-build-info',
    enforce: 'pre',
    configResolved(config) { root = config.root },
    transform(code, id) {
      if (id.split('?')[0] !== join(root, 'src/platform/buildInfo.ts')) return
      return code.replace('null /* preview build metadata */', JSON.stringify(info()))
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/app-build.json') return next()
        response.setHeader('Content-Type', 'application/json')
        response.setHeader('Cache-Control', 'no-store')
        response.end(JSON.stringify(info()))
      })
      const invalidate = file => {
        const path = relative(root, file)
        if (!/^(src\/|service\/|App\.vue$|main\.ts$|index\.html$)/.test(path)) return
        for (const environment of Object.values(server.environments)) {
          const module = environment.moduleGraph.getModuleById(join(root, 'src/platform/buildInfo.ts'))
          if (module) environment.moduleGraph.invalidateModule(module)
        }
      }
      server.watcher.on('change', invalidate).on('add', invalidate).on('unlink', invalidate)
      server.httpServer?.once('close', () => { server.watcher.off('change', invalidate).off('add', invalidate).off('unlink', invalidate) })
    },
    transformIndexHtml: { order: 'post', handler(html) { return html.replace(/<script type="module" src="[^"\n]*\/@vite\/client"><\/script>\s*/g, '') } },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'app-build.json', source: JSON.stringify(info()) }) },
  }
}
