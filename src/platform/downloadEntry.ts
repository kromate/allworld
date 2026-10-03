export interface DownloadEntry { basePath: string; playHref: string }

function segments(path: string): string[] | null {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\u0000-\u0020\u007f]/.test(path)) return null
  const parts = path.slice(1).split('/')
  if (parts.at(-1) === '') parts.pop()
  const decoded: string[] = []
  for (const part of parts) {
    let value: string
    try { value = decodeURIComponent(part) } catch { return null }
    if (!value || value === '.' || value === '..' || value.trim() !== value || /[/\\?#%\u0000-\u001f\u007f]/.test(value)) return null
    decoded.push(value)
  }
  return decoded
}

/** Same-origin intrinsic entry URL carries the native handoff base used to rewrite /assets/. */
export function resolveDownloadEntry(href: string, moduleHref: string, compiledBase: string): DownloadEntry | null {
  if ([href, moduleHref, compiledBase].some(value => value !== value.trim() || value.includes('\\'))) return null
  const rawPath = (value: string): string | null => /^https?:\/\/[^/?#]+(\/[^?#]*)?(?:[?#]|$)/.exec(value)?.[1] ?? null
  const requestPath = rawPath(href), modulePath = rawPath(moduleHref)
  if (requestPath === null || modulePath === null) return null
  const requested = segments(requestPath), loaded = segments(modulePath), configured = segments(compiledBase)
  if (!requested || !loaded || !configured || compiledBase.includes('?') || compiledBase.includes('#')) return null
  let page: URL, script: URL
  try { page = new URL(href); script = new URL(moduleHref) } catch { return null }
  if (page.origin !== script.origin || page.username || page.password || script.username || script.password) return null
  const file = loaded.at(-1)
  if (!file) return null
  let base: string[]
  if (loaded.at(-2) === 'assets' && /^[A-Za-z0-9._-]+\.(?:m?js)$/.test(file)) base = loaded.slice(0, -2)
  else if (file === 'main.ts') base = loaded.slice(0, -1)
  else return null
  if (configured.length > 0 && (configured.length !== base.length || configured.some((part, index) => part !== base[index]))) return null
  if (file === 'main.ts' && configured.length !== base.length) return null
  if (requested.length !== base.length + 1 || base.some((part, index) => part !== requested[index]) || requested.at(-1) !== 'downloads') return null
  const basePath = base.length ? `/${base.map(encodeURIComponent).join('/')}/` : '/'
  return { basePath, playHref: new URL(basePath, page.origin).href }
}
