// Asset packs: one gzip container per model family (see scripts/build-asset-packs.mjs).
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { loadAsset } from '../assets/publicAssets.ts'

export interface PackEntry { name: string; offset: number; length: number; meta?: Record<string, unknown> }
export interface Pack { entries: Map<string, PackEntry>; bytes: Uint8Array; base: number }

// Unpacked packs in memory. The device keeps the files themselves (src/assets/assetStore.ts), so a
// pack dropped from here is read back from the device, not downloaded again.
const CACHE_BYTES = 16 * 1024 * 1024
const cache = new Map<string, { pending: Promise<Pack>; bytes: number }>()
let cachedBytes = 0

export function packCacheStats(): { entries: number; bytes: number; limit: number } {
  return { entries: cache.size, bytes: cachedBytes, limit: CACHE_BYTES }
}

function trimCache(): void {
  for (const [url, entry] of cache) {
    if (cachedBytes <= CACHE_BYTES) break
    if (!entry.bytes) continue
    cache.delete(url); cachedBytes -= entry.bytes
  }
}

export function loadPack(url: string): Promise<Pack> {
  const existing = cache.get(url)
  if (existing) { cache.delete(url); cache.set(url, existing); return existing.pending }
  const pending = (async () => {
      // Downloaded once, checked against the build's manifest and already unpacked.
      const bytes = await loadAsset(url)
      if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'NWPK') throw new Error(`${url} is not an asset pack`)
      const indexLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true)
      const index = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + indexLength))) as { entries: PackEntry[] }
      return { entries: new Map(index.entries.map(entry => [entry.name, entry])), bytes, base: 8 + indexLength }
    })()
  const entry = { pending, bytes: 0 }
  cache.set(url, entry)
  void pending.then(pack => {
    entry.bytes = pack.bytes.byteLength
    cachedBytes += entry.bytes; trimCache()
  }, () => { if (cache.get(url) === entry) cache.delete(url) })
  return pending
}

const loader = new GLTFLoader()

export function parseModel(pack: Pack, name: string): Promise<GLTF> {
  const entry = pack.entries.get(name)
  if (!entry) return Promise.reject(new Error(`Model "${name}" is not in the pack`))
  const start = pack.base + entry.offset
  const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset + start, pack.bytes.byteOffset + start + entry.length) as ArrayBuffer
  return loader.parseAsync(buffer, '')
}

export const PACKS = { furniture: '/packs/furniture.pack.gz' } as const
