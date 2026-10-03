// Evidence probe for the store of downloaded game files (src/assets/assetStore.ts): what is fetched,
// what is kept, what is refused and what survives an update. It drives the real store against a
// host and a device store held in memory. Not a test suite: prints PASS lines, exits non-zero on
// the first failure. It proves the store's own rules; a real browser, network and device are not here.
//
//   node scripts/verify-assets.ts
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createAssetProgress } from '../src/assets/assetProgress.ts'
import type { AssetActivity, AssetProgress } from '../src/assets/assetProgress.ts'
import { AssetError, createAssetStore } from '../src/assets/assetStore.ts'
import type { AssetCache, AssetCaches, AssetEntry, AssetManifest, AssetStore } from '../src/assets/assetStore.ts'

const pass = (name: string): void => console.log(`PASS ${name}`)
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const NAME = 'neighbourhood-world:assets:v1'
const ORIGIN = 'https://game.test'
const CHUNK = 1000

// ── A pack, a host and a device ──

interface Pack { content: Uint8Array<ArrayBuffer>; file: Uint8Array<ArrayBuffer>; entry: AssetEntry }
/** Bytes that do not compress, so the size kept on the device is close to the size asked for. */
function pack(seed: number, size: number, group = 'street'): Pack {
  const content = new Uint8Array(size)
  let state = seed * 2654435761 >>> 0
  for (let i = 0; i < size; i++) { state = (state * 1664525 + 1013904223) >>> 0; content[i] = state >>> 24 }
  content.set([0x4e, 0x57, 0x50, 0x4b])
  const file = new Uint8Array(gzipSync(content))
  return { content, file, entry: { bytes: file.byteLength, unpacked: content.byteLength, sha256: createHash('sha256').update(content).digest('hex'), format: 'nwpk', group } }
}

class Device implements AssetCache {
  readonly items = new Map<string, { body: Uint8Array<ArrayBuffer>; headers: [string, string][] }>()
  full = false
  private at(key: string): string { return key.startsWith('http') ? key : `${ORIGIN}${key}` }
  async match(key: string): Promise<Response | undefined> {
    const item = this.items.get(this.at(key))
    return item ? new Response(item.body.slice(), { headers: item.headers }) : undefined
  }
  async put(key: string, response: Response): Promise<void> {
    if (this.full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    this.items.set(this.at(key), { body: new Uint8Array(await response.arrayBuffer()), headers: [...response.headers] })
  }
  async delete(key: string): Promise<boolean> { return this.items.delete(this.at(key)) }
  async keys(): Promise<{ url: string }[]> { return [...this.items.keys()].map(url => ({ url })) }
  get bytes(): number { let sum = 0; for (const item of this.items.values()) sum += item.body.byteLength; return sum }
  has(entry: AssetEntry): boolean { return [...this.items.keys()].some(url => url.endsWith(entry.sha256)) }
}

class Devices implements AssetCaches {
  readonly stores = new Map<string, Device>()
  blocked = false
  async open(name: string): Promise<Device> {
    if (this.blocked) throw new DOMException('The operation is insecure.', 'SecurityError')
    let store = this.stores.get(name)
    if (!store) { store = new Device(); this.stores.set(name, store) }
    return store
  }
  async delete(name: string): Promise<boolean> { return this.stores.delete(name) }
  get own(): Device { let store = this.stores.get(NAME); if (!store) { store = new Device(); this.stores.set(NAME, store) } return store }
}

class Host {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>()
  requests: { url: string; cache: RequestCache | undefined }[] = []
  down = false
  /** The next download breaks half-way. */
  dropNext = false
  /** Downloads send one piece and then wait for ever, as a stalled connection does. */
  stall = false
  sent = 0
  open = 0
  mostOpen = 0
  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    this.requests.push({ url, cache: init.cache })
    const signal = init.signal ?? null
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (this.down) throw new TypeError('fetch failed')
    const body = this.files.get(url.replace(/\?.*$/, ''))
    if (!body) return new Response('Not found', { status: 404 })
    const drop = this.dropNext
    this.dropNext = false
    let at = 0
    this.open++
    this.mostOpen = Math.max(this.mostOpen, this.open)
    const end = (): void => { this.open-- }
    return new Response(new ReadableStream<Uint8Array>({
      pull: async controller => {
        await wait(1)
        if (signal?.aborted) { end(); controller.error(new DOMException('Aborted', 'AbortError')); return }
        if (drop && at >= body.byteLength / 2) { end(); controller.error(new TypeError('network dropped')); return }
        if (this.stall && at > 0) {
          await new Promise<void>(resolve => { signal?.addEventListener('abort', () => resolve()) })
          end(); controller.error(new DOMException('Aborted', 'AbortError')); return
        }
        if (at >= body.byteLength) { end(); controller.close(); return }
        controller.enqueue(body.subarray(at, at + CHUNK))
        at += CHUNK
        this.sent += CHUNK
      },
      cancel: end,
    }))
  }
}

interface Setup { manifest: AssetManifest; host: Host; devices: Devices | null; online?: boolean; limit?: number; free?: number; lenient?: boolean }
function visit(setup: Setup): { store: AssetStore; progress: AssetProgress; seen: AssetActivity[] } {
  const progress = createAssetProgress()
  const seen: AssetActivity[] = []
  progress.subscribe(activity => { seen.push(activity) })
  const free = setup.free
  const store = createAssetStore({
    manifest: setup.manifest, progress, cacheName: NAME, limitBytes: setup.limit ?? 1e9, fetch: setup.host.fetch, caches: setup.devices,
    url: (path, entry) => `${path}${entry ? `?v=${entry.sha256.slice(0, 12)}` : ''}`,
    estimate: free === undefined ? null : async () => ({ quota: 1e9, usage: 1e9 - free }),
    online: () => setup.online ?? true, lenient: setup.lenient ?? false,
  })
  return { store, progress, seen }
}
const failsAs = (kind: AssetError['kind']) => (error: unknown): boolean => error instanceof AssetError && error.kind === kind

// ── First visit, return visit ──

const a = pack(1, 9000, 'character'), b = pack(2, 7000), c = pack(3, 8000)
const manifest: AssetManifest = { '/a.pack.gz': a.entry, '/b.pack.gz': b.entry, '/c.pack.gz': c.entry }
const serve = (host: Host, ...packs: [string, Pack][]): Host => { for (const [path, item] of packs) host.files.set(path, item.file); return host }
const all: [string, Pack][] = [['/a.pack.gz', a], ['/b.pack.gz', b], ['/c.pack.gz', c]]

{
  const host = serve(new Host(), ...all), devices = new Devices()
  const first = visit({ manifest, host, devices })
  assert.deepEqual(await first.store.load('/a.pack.gz'), a.content)
  await first.store.settled()
  assert.equal(host.requests.length, 1)
  assert.equal(host.requests[0]!.url, `/a.pack.gz?v=${a.entry.sha256.slice(0, 12)}`)
  assert.equal(host.requests[0]!.cache, 'no-store')
  assert.ok(first.seen.some(step => step.active === 1 && step.total === a.entry.bytes && step.groups[0] === 'character'), 'the total is the file size from the manifest')
  assert.ok(first.seen.some(step => step.checking), 'checking is reported apart from downloading')
  assert.equal(first.seen.at(-1)!.active, 0)
  assert.equal(devices.own.items.size, 1)
  pass('a first visit downloads the file once, reports its real size, and keeps it after it is checked')

  host.requests = []
  const again = visit({ manifest, host, devices })
  assert.deepEqual(await again.store.load('/a.pack.gz'), a.content)
  assert.equal(host.requests.length, 0)
  assert.equal(again.seen.length, 0, 'nothing is shown for a file that is already here')
  pass('a return visit reads the file from the device: no request, nothing on screen')

  const both = await Promise.all([again.store.load('/b.pack.gz'), again.store.load('/b.pack.gz')])
  assert.equal(host.requests.length, 1)
  assert.equal(both[0], both[1])
  pass('two callers asking for one file share one download')
}

{
  // A host that sets Content-Encoding hands the page the unpacked bytes.
  const host = new Host(), devices = new Devices()
  host.files.set('/a.pack.gz', a.content)
  const { store, seen } = visit({ manifest, host, devices })
  assert.deepEqual(await store.load('/a.pack.gz'), a.content)
  assert.ok(seen.some(step => step.total === a.entry.unpacked))
  await store.settled()
  assert.ok(devices.own.has(a.entry))
  pass('a host that has already unpacked the file is accepted, with the unpacked size as the total')
}

// ── Refusing what does not match ──

{
  const host = new Host(), devices = new Devices()
  host.files.set('/a.pack.gz', pack(99, 9000).file)
  const { store, progress } = visit({ manifest, host, devices })
  await assert.rejects(store.load('/a.pack.gz'), failsAs('changed'))
  await store.settled()
  assert.deepEqual(host.requests.map(request => request.cache), ['no-store', 'reload'])
  assert.equal(devices.own.items.size, 0)
  assert.equal(progress.activity().failure?.kind, 'changed')
  pass('a file that does not match the manifest is refused after one fresh fetch, and never kept')

  const big = new Host()
  big.files.set('/a.pack.gz', new Uint8Array(new Uint8Array(gzipSync(a.content)).byteLength + 400_000).fill(7))
  big.files.get('/a.pack.gz')!.set([0x1f, 0x8b])
  await assert.rejects(visit({ manifest, host: big, devices: new Devices() }).store.load('/a.pack.gz'), failsAs('changed'))
  // Two tries, each cut off just past the expected size (a stream may have a piece or two queued ahead).
  assert.ok(big.sent < 2 * (a.entry.bytes + 5 * CHUNK), `the host sent ${big.sent} bytes of a ${big.files.get('/a.pack.gz')!.byteLength}-byte response over two tries`)
  pass('a response larger than the manifest allows is cut off, not read into memory')

  const lenient = visit({ manifest, host, devices, lenient: true })
  const quiet = console.warn
  console.warn = () => undefined
  try { assert.equal((await lenient.store.load('/a.pack.gz')).byteLength, 9000) } finally { console.warn = quiet }
  await lenient.store.settled()
  assert.equal(devices.own.items.size, 0)
  pass('while developing, a rebuilt pack with a stale manifest is used as it is and still not kept')
}

// ── An update ──

{
  const a2 = pack(11, 9500, 'character')
  const next: AssetManifest = { ...manifest, '/a.pack.gz': a2.entry }
  const host = serve(new Host(), ...all), devices = new Devices()
  const old = visit({ manifest, host, devices })
  await old.store.load('/a.pack.gz'); await old.store.load('/b.pack.gz'); await old.store.settled()

  // The new build is out, but the connection is not: the old copy must still be there afterwards.
  host.files.set('/a.pack.gz', a2.file)
  host.requests = []; host.down = true
  const failed = visit({ manifest: next, host, devices })
  await assert.rejects(failed.store.load('/a.pack.gz'), failsAs('network'))
  await failed.store.settled()
  assert.equal(host.requests.length, 2, 'one more try after an interruption')
  assert.ok(devices.own.has(a.entry) && !devices.own.has(a2.entry))
  assert.deepEqual(await visit({ manifest, host, devices }).store.load('/a.pack.gz'), a.content)
  pass('an update that cannot be fetched leaves the working copy in place, and the old build still reads it')

  host.down = false; host.requests = []
  const updated = visit({ manifest: next, host, devices })
  assert.deepEqual(await updated.store.load('/b.pack.gz'), b.content)
  assert.equal(host.requests.length, 0)
  assert.ok(devices.own.has(a.entry), 'the old copy is not removed before its replacement is in')
  assert.deepEqual(await updated.store.load('/a.pack.gz'), a2.content)
  await updated.store.settled()
  assert.equal(host.requests.length, 1)
  assert.ok(devices.own.has(a2.entry) && !devices.own.has(a.entry) && devices.own.has(b.entry))
  pass('an update downloads only the changed file, then removes the copy it replaced; unchanged files are not fetched')

  // A page still running the old build asks for the old file after the update is live.
  host.requests = []
  await assert.rejects(visit({ manifest, host, devices }).store.load('/a.pack.gz'), failsAs('changed'))
  assert.ok(devices.own.has(a2.entry))
  pass('an old page is told the game was updated rather than given a file from another version')
}

// ── A device that will not keep things ──

{
  const host = serve(new Host(), ...all)
  const none = visit({ manifest, host, devices: null })
  assert.deepEqual(await none.store.load('/a.pack.gz'), a.content)
  assert.equal(host.requests[0]!.cache, 'default', 'the browser cache is left to do what it can')
  assert.deepEqual(await none.store.report(), { state: 'unavailable', reason: 'unsupported' })
  const refused = new Devices(); refused.blocked = true
  const blocked = visit({ manifest, host, devices: refused })
  assert.deepEqual(await blocked.store.load('/b.pack.gz'), b.content)
  assert.deepEqual(await blocked.store.report(), { state: 'unavailable', reason: 'blocked' })
  pass('with no storage, or storage refused, the game still gets its files and says nothing is kept')

  const devices = new Devices(); devices.own.full = true
  const full = visit({ manifest, host, devices })
  assert.deepEqual(await full.store.load('/a.pack.gz'), a.content)
  const report = await full.store.report()
  assert.ok(report.state === 'kept' && report.files === 0 && report.declined === 1)
  pass('a quota error while keeping a file does not fail the load')

  const tight = new Devices()
  const short = visit({ manifest, host, devices: tight, free: 4000 })
  assert.deepEqual(await short.store.load('/a.pack.gz'), a.content)
  const state = await short.store.report()
  assert.ok(state.state === 'kept' && state.files === 0 && state.declined === 1 && state.free === 4000)
  pass('a device that is nearly full is not filled: the file is used and not kept')

  const damaged = new Devices()
  const once = visit({ manifest, host, devices: damaged })
  await once.store.load('/a.pack.gz'); await once.store.settled()
  for (const item of damaged.own.items.values()) item.body = item.body.slice(0, item.body.byteLength - 100)
  host.requests = []
  const repair = visit({ manifest, host, devices: damaged })
  assert.deepEqual(await repair.store.load('/a.pack.gz'), a.content)
  await repair.store.settled()
  assert.equal(host.requests.length, 1)
  assert.equal(damaged.own.bytes, a.entry.bytes)
  pass('a damaged copy on the device is dropped and fetched again, never handed to the game')
}

// ── The budget ──

{
  const host = serve(new Host(), ...all), devices = new Devices()
  const limit = a.entry.bytes + b.entry.bytes + 100
  const first = visit({ manifest, host, devices, limit })
  await first.store.load('/a.pack.gz'); await first.store.settled(); await wait(3)
  await first.store.load('/b.pack.gz'); await first.store.settled(); await wait(3)
  await first.store.load('/c.pack.gz')
  const report = await first.store.report()
  assert.ok(report.state === 'kept' && report.files === 2 && report.declined === 1 && report.bytes <= limit)
  assert.ok(devices.own.has(a.entry) && devices.own.has(b.entry))
  pass('a file this page has read is not evicted to make room: the newcomer is used and not kept')

  const later = visit({ manifest, host, devices, limit })
  await later.store.load('/c.pack.gz')
  await later.store.settled()
  assert.ok(!devices.own.has(a.entry) && devices.own.has(b.entry) && devices.own.has(c.entry))
  assert.ok(devices.own.bytes <= limit)
  pass('on a later visit the oldest file makes room, and the store stays inside its budget')

  // A copy from a build that is no longer the current one goes before any current file, however new it is.
  const orphan = pack(50, 7000)
  await devices.own.put(`/.neighbourhood-world-assets/nwpk/${orphan.entry.sha256}`, new Response(orphan.file, { headers: { 'x-asset-path': '/gone.pack.gz', 'x-asset-bytes': String(orphan.file.byteLength), 'x-asset-stored': String(Date.now() + 60_000) } }))
  // Room for the three current files and no more: the leftover alone has to make way for the one that is missing.
  const roomy = visit({ manifest, host, devices, limit: a.entry.bytes + b.entry.bytes + c.entry.bytes + 100 })
  await roomy.store.load('/a.pack.gz')
  await roomy.store.settled()
  assert.ok(!devices.own.has(orphan.entry) && devices.own.has(a.entry) && devices.own.has(b.entry) && devices.own.has(c.entry))
  pass('copies no current file uses are the first to go')
}

// ── A bad connection ──

{
  const host = serve(new Host(), ...all), devices = new Devices()
  const kept = visit({ manifest, host, devices })
  await kept.store.load('/a.pack.gz'); await kept.store.settled()
  host.requests = []
  const offline = visit({ manifest, host, devices, online: false })
  assert.deepEqual(await offline.store.load('/a.pack.gz'), a.content)
  await assert.rejects(offline.store.load('/b.pack.gz'), failsAs('offline'))
  assert.equal(host.requests.length, 0)
  pass('offline, a kept file loads and a missing one fails at once with a reason, without a request')

  host.dropNext = true
  const flaky = visit({ manifest, host, devices })
  assert.deepEqual(await flaky.store.load('/b.pack.gz'), b.content)
  assert.equal(host.requests.length, 2)
  pass('a download that breaks half-way is tried once more and then succeeds')

  host.requests = []; host.stall = true
  const stalled = visit({ manifest, host, devices })
  const pending = stalled.store.load('/c.pack.gz')
  const settledAs = assert.rejects(pending, failsAs('stopped'))
  while (stalled.progress.activity().loaded === 0) await wait(2)
  stalled.progress.stopAll()
  await settledAs
  await stalled.store.settled()
  assert.equal(stalled.progress.activity().active, 0)
  assert.equal(stalled.progress.activity().failure?.kind, 'stopped')
  assert.ok(!devices.own.has(c.entry), 'half a file is not kept')
  host.stall = false
  assert.deepEqual(await stalled.store.load('/c.pack.gz'), c.content)
  pass('a stalled download can be stopped, keeps nothing, and loads when asked again')

  const empty = new Host()
  await assert.rejects(visit({ manifest, host: empty, devices: new Devices() }).store.load('/a.pack.gz'), failsAs('missing'))
  assert.equal(empty.requests.length, 1)
  pass('a file the host does not have fails as missing, without a second try')
}

// ── What never enters the store ──

{
  const host = serve(new Host(), ...all), devices = new Devices()
  const extra = pack(70, 5000)
  host.files.set('/extra.pack.gz', extra.file)
  const other = await devices.open('another-app')
  await other.put('/their-file', new Response('theirs'))
  const { store, seen } = visit({ manifest, host, devices })
  assert.deepEqual(await store.load('/extra.pack.gz'), extra.content)
  assert.equal(host.requests[0]!.url, '/extra.pack.gz')
  assert.ok(seen.some(step => step.active === 1 && step.total === null), 'a size that is not known is reported as not known')
  await store.load('/a.pack.gz'); await store.settled()
  assert.equal(devices.own.items.size, 1)
  for (const [url, item] of devices.own.items) {
    assert.match(url, /\/\.neighbourhood-world-assets\/nwpk\/[0-9a-f]{64}$/)
    assert.deepEqual(item.headers.map(([name]) => name).sort(), ['content-type', 'x-asset-bytes', 'x-asset-path', 'x-asset-stored'])
  }
  pass('a path the manifest does not name is fetched and never kept; a kept file carries no request, address or cookie')

  assert.equal(await store.clear(), true)
  assert.ok(!devices.stores.has(NAME) && devices.stores.get('another-app')?.items.size === 1)
  const after = await store.report()
  assert.ok(after.state === 'kept' && after.files === 0)
  host.requests = []
  assert.deepEqual(await store.load('/a.pack.gz'), a.content)
  assert.equal(host.requests.length, 1)
  pass('removing downloaded files removes this App\'s store only, and the files download again when needed')
}

{
  const many: [string, Pack][] = Array.from({ length: 14 }, (_, index) => [`/m${index}.pack.gz`, pack(200 + index, 6000)])
  const host = serve(new Host(), ...many)
  const { store, seen } = visit({ manifest: Object.fromEntries(many.map(([path, item]) => [path, item.entry])), host, devices: new Devices() })
  await Promise.all(many.map(([path]) => store.load(path)))
  assert.equal(host.requests.length, 14)
  assert.ok(host.mostOpen <= 6, `${host.mostOpen} downloads were open at once`)
  for (const step of seen) assert.ok(step.total === null || step.loaded <= step.total, 'never more received than the total says')
  pass('a crowd of characters downloads six at a time')
}

console.log('\nThe store of downloaded game files behaves as described. Not covered here: a real browser, a real network, real device storage.')
