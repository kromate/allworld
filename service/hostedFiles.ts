import type { IncomingMessage, ServerResponse } from 'node:http'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import type { HostedBinding } from './hostedIdentity.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.gz': 'application/gzip', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.bin': 'application/octet-stream', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.ktx2': 'image/ktx2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const inside = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith('../') && !isAbsolute(part))
}
function safeName(name: string): boolean {
  return Boolean(name) && !name.startsWith('/') && !/[\\\x00-\x1f\x7f%?#]/.test(name)
    && name.split('/').every(part => Boolean(part) && !part.startsWith('.') && !part.includes(':'))
}

/** Compose with the secure hosted listener. Does not listen, authenticate or set CORS. */
export async function createHostedFiles(builtRoot: string, binding?: Pick<HostedBinding, 'origin' | 'audience' | 'siteId' | 'packageId' | 'channel' | 'buildId' | 'guestAdmission'>): Promise<(request: IncomingMessage, response: ServerResponse) => Promise<boolean>> {
  if (!isAbsolute(builtRoot) || resolve(builtRoot) !== builtRoot) throw new Error('Supply an exact absolute built-root path.')
  const root = await realpath(builtRoot)
  const repo = await realpath(join(dirname(fileURLToPath(import.meta.url)), '..'))
  if (root !== builtRoot || inside(repo, root) || inside(root, repo) || !(await lstat(root)).isDirectory()) throw new Error('Static root must be a real build directory outside the repository.')
  async function confined(name: string): Promise<string> {
    if (!safeName(name)) throw new Error('Unsafe build filename.')
    let path = root
    for (const part of name.split('/')) {
      path = join(path, part)
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Static symlink refused.')
    }
    if (!inside(root, await realpath(path))) throw new Error('Static file outside root.')
    return path
  }
  const metadata: unknown = JSON.parse(await readFile(await confined('playtest-build.json'), 'utf8'))
  if (!record(metadata) || metadata.schema !== 1 || !record(metadata.files) || !Array.isArray(metadata.routes)
    || typeof metadata.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.artifactSha256)) throw new Error('Missing or invalid private playtest build metadata.')
  if (binding) {
    const config = metadata.config
    if (!record(config) || Object.entries(binding).some(([key, value]) => key !== 'guestAdmission' && config[key] !== value)
      || (config.guestAdmission ?? (config.channel === 'test' ? 'invite' : 'public')) !== (binding.guestAdmission ?? (binding.channel === 'test' ? 'invite' : 'public'))) throw new Error('Static build does not match the hosted world binding.')
  }
  const files = new Map<string, boolean>()
  for (const [name, entry] of Object.entries(metadata.files)) {
    if (!safeName(name) || !record(entry) || typeof entry.immutable !== 'boolean' || typeof entry.bytes !== 'number'
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid built-file inventory.')
    files.set(name, entry.immutable && /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[\w.]+$/.test(name))
  }
  if (!files.has('index.html') || !files.has('playtest-config.json')) throw new Error('Build lacks frontend entry/config.')
  files.set('playtest-build.json', false)
  const routes: RegExp[] = []
  for (const route of metadata.routes) {
    if (typeof route !== 'string' || !/^\/(?:[A-Za-z0-9_:-]+\/)*[A-Za-z0-9_:-]*$/.test(route)) throw new Error('Invalid SPA route metadata.')
    routes.push(new RegExp('^' + route.split('/').map(part => part.startsWith(':') ? '[A-Za-z0-9_-]+' : part).join('/') + (route === '/' ? '' : '/?') + '$'))
  }

  return async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false
    // Parse raw origin-form paths ourselves: URL() would silently normalize traversal.
    const raw = (request.url ?? '').split('?')[0] ?? ''
    if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x20\x7f]/.test(raw) || /%2f|%5c/i.test(raw)) return false
    let path: string
    try { path = decodeURIComponent(raw) } catch { return false }
    if (/[\\%\x00-\x20\x7f]/.test(path) || path.startsWith('//') || path.split('/').some(part => part.startsWith('.') || part.includes(':'))) return false
    if (/^\/(world|api)(\/|$)/.test(path)) return false
    const name = path.slice(1)
    let file: string
    if (files.has(name)) file = name
    else if (!extname(path) && routes.some(route => route.test(path))) file = 'index.html'
    else return false
    let handle: Awaited<ReturnType<typeof open>>
    try { handle = await open(await confined(file), constants.O_RDONLY | constants.O_NOFOLLOW) } catch { return false }
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) { await handle.close(); return false }
      response.statusCode = 200
      response.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
      response.setHeader('Content-Length', stat.size)
      response.setHeader('Cache-Control', file === 'index.html' || file === 'playtest-config.json' || file === 'playtest-build.json'
        ? 'no-store' : files.get(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.setHeader('X-Frame-Options', 'SAMEORIGIN')
      // .pack.gz is an application payload; the App unpacks it. Never add Content-Encoding.
      // No COEP/COOP/CSP or permission blanket: map/model fetches, Workers and voice need review.
      if (request.method === 'HEAD') { await handle.close(); response.end() }
      else await pipeline(handle.createReadStream({ autoClose: true }), response)
      return true
    } catch {
      await handle.close().catch(() => {})
      response.destroy()
      return true
    }
  }
}
