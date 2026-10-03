// Public game files: fetched once, checked against the build's manifest, kept on the device.
//
// The manifest (src/assets/public-assets.index.json, built by scripts/build-asset-manifest.mjs) names
// every file this build may keep, with its sizes and the SHA-256 of its unpacked content. A file is
// handed to the game only when it matches, whether it came from the network or from the device, and
// it is written to the device only after that. Copies are stored under their content hash, so a new
// build reads the files it shares with the old one, downloads the ones that changed, and an old copy
// is removed once its replacement is in. Where the budget or the device is short of space, a copy this
// page has not read may be removed first to make room, but only when that frees enough for the new
// file. A path the manifest does not name is fetched and never kept. Nothing else is stored here: no
// photo, no service response, no request and no address.
//
// No DOM globals are read in this file: the browser's are passed in (src/assets/publicAssets.ts), so
// the same code runs under Node in scripts/verify-assets.ts.
import type { AssetErrorKind, AssetFailure, AssetJob, AssetProgress } from './assetProgress.ts'

export interface AssetEntry {
  /** Size of the file as shipped. */
  bytes: number
  /** Size of its content once any gzip wrapper is removed. */
  unpacked: number
  /** SHA-256 of that content, in hex. */
  sha256: string
  format: string
  /** What it is for; the loading view turns this into words. */
  group: string
}
export type AssetManifest = Readonly<Record<string, AssetEntry>>

/** The part of the browser's Cache this store uses. */
export interface AssetCache {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
  delete(key: string): Promise<boolean>
  keys(): Promise<readonly { url: string }[]>
}
export interface AssetCaches {
  open(name: string): Promise<AssetCache>
  delete(name: string): Promise<boolean>
}

export interface AssetStoreOptions {
  manifest: AssetManifest
  /** The address to fetch a path from. `entry` is null for a path the manifest does not name. */
  url: (path: string, entry: AssetEntry | null) => string
  progress: AssetProgress
  /** This App's own store. On an origin shared with other Apps nothing outside it is read or removed. */
  cacheName: string
  /** The most this App keeps on a device. */
  limitBytes: number
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** Null where the browser has no Cache storage: the game then downloads what it needs each visit. */
  caches: AssetCaches | null
  /** The browser's own estimate of space on the device, where it gives one. */
  estimate: (() => Promise<{ quota?: number; usage?: number }>) | null
  online: () => boolean
  /** A file that does not match stops a release. While developing it is reported and used as it is. */
  lenient: boolean
  /** How long a download may receive nothing before it counts as interrupted. Left out by the App, which uses 30 seconds; a check that cannot wait gives a short one. */
  idleMs?: number
}

export type AssetStoreReport =
  | { state: 'kept'; files: number; bytes: number; limit: number; free: number | null; declined: number }
  | { state: 'unavailable'; reason: 'unsupported' | 'blocked' }

export type AssetFileFailure = AssetFailure | { kind: 'storage'; message: string }

export interface AssetFileReport {
  path: string
  state: 'cached' | 'downloading' | 'missing' | 'failed'
  cachedBytes: number | null
  previousVersion: boolean
  failure: AssetFileFailure | null
}

export interface AssetStore {
  /** The unpacked content of a public file. The array owns its whole buffer; callers must not write to it. */
  /** Aborting a consumer only stops the shared request when no other caller still needs it. */
  load(path: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>
  report(): Promise<AssetStoreReport>
  /** Current manifest files, checked against this App's named cache on each read. */
  inventory(): Promise<readonly AssetFileReport[]>
  subscribe(listener: () => void): () => void
  /** Remove this App's kept files, and nothing else. True when there was a store to remove. */
  clear(): Promise<boolean>
  /** Resolves once every write that has been started is finished. */
  settled(): Promise<void>
}

export class AssetError extends Error {
  readonly kind: AssetErrorKind
  readonly path: string
  constructor(kind: AssetErrorKind, path: string) {
    super(MESSAGES[kind])
    this.name = 'AssetError'
    this.kind = kind
    this.path = path
  }
}

const MESSAGES: Record<AssetErrorKind, string> = {
  offline: 'You are offline, and this part of the game has not been downloaded yet. Reconnect and try again.',
  network: 'The download was interrupted. Check your connection and try again.',
  missing: 'A game file could not be loaded from the server. Reload the game; if it keeps happening, try again later.',
  changed: 'A game file does not match this version of the game, which usually means the game was updated. Reload to get the new version.',
  stopped: 'The download was stopped.',
}

/** Downloads and reads at once: enough for everything an arrival asks for, few enough that a phone is not unpacking a whole cast at the same moment. */
const CONCURRENT = 6
const RETRY_MS = 800
/** A download that receives nothing for this long is treated as interrupted: it is tried once more, and gives up its place if that fails too. */
const IDLE_MS = 30 * 1000
/** Space left alone on a device that is nearly full. */
const RESERVE = 8 * 1024 * 1024
const KEY = '/.neighbourhood-world-assets/'
const PATH = 'x-asset-path', BYTES = 'x-asset-bytes', STORED = 'x-asset-stored'

const gzipped = (bytes: Uint8Array): boolean => bytes[0] === 0x1f && bytes[1] === 0x8b

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Null where the page is not a secure context and cannot hash; such a page has no Cache storage either. */
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  return Array.from(new Uint8Array(await subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}

interface Kept { key: string; path: string; sha256: string; bytes: number; stored: number }
interface LoadingAsset { promise: Promise<Uint8Array<ArrayBuffer>>; controller: AbortController; consumers: number }

export function createAssetStore(options: AssetStoreOptions): AssetStore {
  const { manifest, progress } = options
  const inflight = new Map<string, LoadingAsset>()
  /** Hashes this page has read. They are not evicted from under it. */
  const used = new Set<string>()
  const failures = new Map<string, AssetFileFailure>()
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  let unavailable: 'unsupported' | 'blocked' = 'unsupported'
  /** Paths that finished downloading and could not be kept, so a retry of one file is not counted twice. */
  const declined = new Set<string>()
  /** Writes that are queued or running, by content hash: a file asked for again meanwhile waits for its copy instead of downloading again. */
  const saving = new Map<string, Promise<void>>()
  let writes: Promise<void> = Promise.resolve()
  let running = 0
  const waiting: (() => void)[] = []
  const idleMs = options.idleMs ?? IDLE_MS

  const keyOf = (entry: AssetEntry): string => `${KEY}${entry.format}/${entry.sha256}`

  function open(): Promise<AssetCache | null> {
    return (async () => {
      if (!options.caches) { unavailable = 'unsupported'; return null }
      // Private windows and locked-down browsers refuse here rather than being absent.
      try { return await options.caches.open(options.cacheName) } catch { unavailable = 'blocked'; return null }
    })()
  }

  /** A place among the CONCURRENT. A download that is stopped while it waits gives up its turn. */
  function acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (running < CONCURRENT) { running++; return Promise.resolve() }
    return new Promise((resolve, reject) => {
      const turn = (): void => { signal?.removeEventListener('abort', stopped); resolve() }
      function stopped(): void { waiting.splice(waiting.indexOf(turn), 1); reject(signal?.reason) }
      waiting.push(turn)
      signal?.addEventListener('abort', stopped, { once: true })
    })
  }
  /** A finished piece of work hands its place to the next in line. */
  function release(): void {
    const next = waiting.shift()
    if (next) next(); else running--
  }

  /** The content, when the stored bytes are exactly what the manifest says. Null otherwise. */
  async function checked(stored: Uint8Array<ArrayBuffer>, entry: AssetEntry): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const content = gzipped(stored) ? await gunzip(stored) : stored
      if (content.byteLength !== entry.unpacked) return null
      const hash = await sha256(content)
      return hash === null || hash === entry.sha256 ? content : null
    } catch { return null }
  }

  /** This build's copy of a file on the device, not yet read. Null when there is none. */
  async function copyOf(entry: AssetEntry): Promise<Response | null> {
    const cache = await open()
    if (!cache) return null
    try { return await cache.match(keyOf(entry)) ?? null } catch { return null }
  }

  async function readKept(entry: AssetEntry, copy: Response): Promise<Uint8Array<ArrayBuffer> | null> {
    let stored: Uint8Array<ArrayBuffer>
    try { stored = new Uint8Array(await copy.arrayBuffer()) } catch { return null }
    const content = await checked(stored, entry)
    if (content) { used.add(entry.sha256); return content }
    // A damaged copy is not a copy: drop it and fetch the file again.
    const cache = await open()
    await cache?.delete(keyOf(entry)).catch(() => false)
    return null
  }

  function asAssetError(error: unknown, path: string, signal: AbortSignal): AssetError {
    // A Stop is a Stop, whatever the download was in the middle of when it came.
    if (signal.aborted) return new AssetError('stopped', path)
    if (error instanceof AssetError) return error
    return new AssetError('network', path)
  }

  /**
   * The bytes as the host sent them. Stops reading as soon as there are more than the manifest allows,
   * and gives up on a host that has sent nothing for `idleMs`: that is an interruption, not a Stop.
   */
  async function receive(path: string, entry: AssetEntry, signal: AbortSignal, reload: boolean, job: AssetJob): Promise<Uint8Array<ArrayBuffer>> {
    if (!options.online()) throw new AssetError('offline', path)
    // This store is the copy that is kept, so the browser's own cache is not asked to keep a second one.
    const keeping = (await open()) !== null
    // The request can be ended without the download having been stopped, so the two are told apart.
    const request = new AbortController()
    let silent = false
    const stop = (): void => request.abort()
    const quiet = (): void => { silent = true; request.abort() }
    // Waiting ends here even where the request itself is slow to notice that it was ended.
    const ended = new Promise<never>((_, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }) })
    ended.catch(() => undefined)
    // The clock starts with the request, not while the file waits for a place, and starts again with whatever arrives.
    let timer = setTimeout(quiet, idleMs)
    const heard = (): void => { clearTimeout(timer); timer = setTimeout(quiet, idleMs) }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true })
    try {
      const response = await Promise.race([options.fetch(options.url(path, entry), { signal: request.signal, cache: reload ? 'reload' : keeping ? 'no-store' : 'default' }), ended])
      heard()
      reader = response.body?.getReader()
      if (!response.ok) throw new AssetError(response.status >= 500 || response.status === 429 || response.status === 408 ? 'network' : 'missing', path)
      if (!reader) throw new AssetError('network', path)
      // A host may send the .gz as it is, or the browser may already have inflated it. The first two
      // bytes say which, and the manifest has the size of both, so the total is known either way.
      let expected = entry.bytes
      let buffer = new Uint8Array(expected)
      let received = 0, sized = false
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), ended])
        if (done) break
        heard()
        if (!sized && received + value.byteLength >= 2) {
          sized = true
          const first = received > 0 ? buffer[0] : value[0], second = received > 1 ? buffer[1] : value[1 - received]
          if (!(first === 0x1f && second === 0x8b)) {
            expected = entry.unpacked
            const grown = new Uint8Array(expected)
            grown.set(buffer.subarray(0, Math.min(received, expected)))
            buffer = grown
          }
        }
        if (received + value.byteLength > expected) throw new AssetError('changed', path)
        buffer.set(value, received)
        received += value.byteLength
        job.progress(received, expected)
      }
      if (received !== expected) throw new AssetError('changed', path)
      return buffer
    } catch (error) {
      if (signal.aborted) throw new AssetError('stopped', path)
      throw silent ? new AssetError('network', path) : error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      // Whatever the host has not sent yet is not wanted: let go of the connection.
      void reader?.cancel().catch(() => undefined)
    }
  }

  /** A path the manifest does not name, or a mismatch while developing: fetched as it is, never kept. */
  async function unchecked(path: string, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    if (!options.online()) throw new AssetError('offline', path)
    const response = await options.fetch(options.url(path, null), { signal })
    if (!response.ok) throw new AssetError(response.status >= 500 || response.status === 429 || response.status === 408 ? 'network' : 'missing', path)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return gzipped(bytes) ? gunzip(bytes) : bytes
  }

  const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(done, ms)
    function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done)
  })

  /** Download, check, and keep. One more try after an interruption, and one that bypasses the browser's cache after a mismatch. */
  async function fetched(path: string, entry: AssetEntry, signal: AbortSignal, job: AssetJob): Promise<Uint8Array<ArrayBuffer>> {
    let reload = false
    for (let tries = 0; ; tries++) {
      try {
        const stored = await receive(path, entry, signal, reload, job)
        job.checking()
        const content = await checked(stored, entry)
        if (!content) throw new AssetError('changed', path)
        keep(path, entry, stored)
        return content
      } catch (error) {
        const failure = asAssetError(error, path, signal)
        if (tries > 0 || (failure.kind !== 'network' && failure.kind !== 'changed')) {
          if (failure.kind !== 'changed' || !options.lenient) throw failure
          console.warn(`[assets] ${path} does not match src/assets/public-assets.index.json. Run: node scripts/build-asset-manifest.mjs`)
          return unchecked(path, signal)
        }
        if (failure.kind === 'changed') reload = true
        else {
          await pause(RETRY_MS, signal)
          // A Stop during the pause ends the download here, not with one more request.
          if (signal.aborted) throw new AssetError('stopped', path)
        }
        job.progress(0, entry.bytes)
      }
    }
  }

  async function tracked(path: string, controller: AbortController, group: string, total: number | null, work: (signal: AbortSignal, job: AssetJob) => Promise<Uint8Array<ArrayBuffer>>): Promise<Uint8Array<ArrayBuffer>> {
    const job = progress.begin(group, total, () => controller.abort(), path)
    try {
      const content = await work(controller.signal, job)
      job.done()
      return content
    } catch (error) {
      const failure = asAssetError(error, path, controller.signal)
      job.failed({ kind: failure.kind, message: failure.message })
      throw failure
    }
  }

  async function declared(path: string, entry: AssetEntry, controller: AbortController): Promise<Uint8Array<ArrayBuffer>> {
    await saving.get(entry.sha256)
    const copy = await copyOf(entry)
    if (controller.signal.aborted) throw new AssetError('stopped', path)
    if (copy) {
      await acquire(controller.signal)
      try {
        // A file already on the device is read without a download and without anything on screen.
        const content = await readKept(entry, copy)
        if (content) return content
      } finally { release() }
    }
    // A download is reported from the moment it is asked for, not from the moment it gets a place:
    // its size is in the total while it waits, and Stop reaches it there.
    return tracked(path, controller, entry.group, entry.bytes, async (signal, job) => {
      await acquire(signal)
      try { return await fetched(path, entry, signal, job) } finally { release() }
    })
  }

  function consume(path: string, loading: LoadingAsset, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    loading.consumers++
    // World callers keep their interest until the shared load finishes.
    if (!signal) return loading.promise
    return new Promise((resolve, reject) => {
      let finished = false
      const finish = (): boolean => {
        if (finished) return false
        finished = true
        signal.removeEventListener('abort', stopped)
        loading.consumers--
        return true
      }
      function stopped(): void {
        if (!finish()) return
        if (loading.consumers === 0) loading.controller.abort()
        reject(new AssetError('stopped', path))
      }
      signal.addEventListener('abort', stopped, { once: true })
      if (signal.aborted) stopped()
      loading.promise.then(content => { if (finish()) resolve(content) }, error => { if (finish()) reject(error) })
    })
  }

  function load(path: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    if (signal?.aborted) return Promise.reject(new AssetError('stopped', path))
    const current = inflight.get(path)
    if (current) {
      // A new caller after the last consumer cancelled gets a fresh load once cleanup finishes.
      if (current.controller.signal.aborted) return current.promise.catch(() => undefined).then(() => load(path, signal))
      return consume(path, current, signal)
    }
    const entry = Object.hasOwn(manifest, path) ? manifest[path] : undefined
    const controller = new AbortController()
    failures.delete(path)
    const pending = (entry ? declared(path, entry, controller) : tracked(path, controller, 'other', null, jobSignal => unchecked(path, jobSignal)))
      .catch((error: unknown) => {
        const failure = asAssetError(error, path, controller.signal)
        failures.set(path, { kind: failure.kind, message: failure.message })
        throw failure
      })
      .finally(() => { inflight.delete(path); notify() })
    const loading: LoadingAsset = { promise: pending, controller, consumers: 0 }
    inflight.set(path, loading)
    const result = consume(path, loading, signal)
    notify()
    return result
  }

  // ── Keeping ──

  async function list(cache: AssetCache): Promise<Kept[]> {
    const kept: Kept[] = []
    for (const { url } of await cache.keys()) {
      const response = await cache.match(url)
      if (!response) continue
      void response.body?.cancel().catch(() => undefined)
      kept.push({
        key: url, sha256: url.slice(url.lastIndexOf('/') + 1), path: response.headers.get(PATH) ?? '',
        bytes: Number(response.headers.get(BYTES)) || 0, stored: Number(response.headers.get(STORED)) || 0,
      })
    }
    return kept
  }

  async function free(): Promise<number | null> {
    if (!options.estimate) return null
    try {
      const { quota, usage } = await options.estimate()
      return quota === undefined || usage === undefined ? null : Math.max(0, quota - usage)
    } catch { return null }
  }

  /** Stay inside this App's budget and off the last of the device's space. False when the file cannot be kept. */
  async function makeRoom(cache: AssetCache, kept: Kept[], size: number): Promise<boolean> {
    let over = kept.reduce((sum, item) => sum + item.bytes, 0) + size - options.limitBytes
    const space = await free()
    if (space !== null) over = Math.max(over, size + RESERVE - space)
    if (over <= 0) return true
    const current = new Set(Object.values(manifest).map(entry => entry.sha256))
    // First to go: copies this build does not use. Then the oldest. Never a file this page has read.
    const spare = kept.filter(item => !used.has(item.sha256)).sort((a, b) => Number(current.has(a.sha256)) - Number(current.has(b.sha256)) || a.stored - b.stored)
    // Nothing is removed unless that is enough: a file that cannot be kept must not cost the device a copy it has.
    if (spare.reduce((sum, item) => sum + item.bytes, 0) < over) return false
    for (const item of spare) {
      if (over <= 0) break
      if (await cache.delete(item.key)) over -= item.bytes
    }
    return over <= 0
  }

  async function write(path: string, entry: AssetEntry, stored: Uint8Array<ArrayBuffer>): Promise<void> {
    const cache = await open()
    if (!cache) { failures.set(path, { kind: 'storage', message: 'This browser could not save the pack. It can still be loaded when needed.' }); return }
    let kept: Kept[]
    try {
      kept = await list(cache)
      if (!(await makeRoom(cache, kept, stored.byteLength))) { declined.add(path); failures.set(path, { kind: 'storage', message: 'Not saved: the game cache or device is short of space. Free space, then retry.' }); return }
      await cache.put(keyOf(entry), new Response(stored, { headers: { 'content-type': 'application/octet-stream', [PATH]: path, [BYTES]: String(stored.byteLength), [STORED]: String(Date.now()) } }))
      used.add(entry.sha256)
      declined.delete(path)
      failures.delete(path)
    } catch {
      // Out of space, or the browser took the store away. The file is still used from memory this visit.
      declined.add(path)
      failures.set(path, { kind: 'storage', message: 'Not saved: browser storage was full or unavailable. Free space, then retry.' })
      return
    }
    // The replacement is in and checked: the copy it replaces can go. If that fails the file is still kept.
    for (const old of kept) if (old.path === path && old.sha256 !== entry.sha256) await cache.delete(old.key).catch(() => false)
  }

  /** Written after the game has its file, one at a time so the budget is counted once. */
  function keep(path: string, entry: AssetEntry, stored: Uint8Array<ArrayBuffer>): void {
    const saved = writes.then(() => write(path, entry, stored))
    writes = saved.finally(notify)
    saving.set(entry.sha256, saved)
    void saved.finally(() => { if (saving.get(entry.sha256) === saved) saving.delete(entry.sha256) })
  }

  async function report(): Promise<AssetStoreReport> {
    await writes
    const cache = await open()
    if (!cache) return { state: 'unavailable', reason: unavailable }
    const kept = await list(cache).catch((): Kept[] => [])
    return { state: 'kept', files: kept.length, bytes: kept.reduce((sum, item) => sum + item.bytes, 0), limit: options.limitBytes, free: await free(), declined: declined.size }
  }

  async function clear(): Promise<boolean> {
    await writes
    if (!options.caches) return false
    used.clear()
    declined.clear()
    failures.clear()
    try { return await options.caches.delete(options.cacheName) } catch { return false } finally { notify() }
  }

  async function inventory(): Promise<readonly AssetFileReport[]> {
    await writes
    const cache = await open()
    const kept = cache ? await list(cache).catch((): Kept[] => []) : []
    return Object.entries(manifest).map(([path, entry]) => {
      const current = kept.find(item => item.key.endsWith(keyOf(entry)))
      const failure = failures.get(path) ?? null
      return {
        path, state: current ? 'cached' : inflight.has(path) ? 'downloading' : failure ? 'failed' : 'missing',
        cachedBytes: current?.bytes ?? null,
        previousVersion: kept.some(item => item.path === path && item.sha256 !== entry.sha256), failure,
      }
    })
  }

  return {
    load, report, inventory, clear, settled: () => writes,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
