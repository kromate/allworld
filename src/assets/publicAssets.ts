// This App's shipped game files, bound to the browser it is running in. Works on the page and in a worker.
import manifest from './public-assets.index.json'
import { assetProgress } from './assetProgress.ts'
import { createAssetStore } from './assetStore.ts'
import { createAssetDownloads } from './assetDownloads.ts'
import type { AssetManifest } from './assetStore.ts'

const assets: AssetManifest = manifest.assets
/** 48 MiB. scripts/build-asset-manifest.mjs fails its check before the live packs outgrow this. */
const LIMIT_BYTES = 48 * 1024 * 1024
let assetBase = import.meta.env.BASE_URL
/** The public entry supplies its verified same-origin native base before any pack is requested. */
export function configureAssetBase(basePath: string): void { assetBase = basePath }

const store = createAssetStore({
  manifest: assets,
  // Files under public/ keep their names between builds, so the address carries the content hash:
  // a changed file is a new address to every cache on the way, an unchanged one is the same address.
  url: (path, entry) => `${assetBase}${path.slice(1)}${entry ? `?v=${entry.sha256.slice(0, 12)}` : ''}`,
  progress: assetProgress,
  cacheName: 'neighbourhood-world:assets:v1',
  limitBytes: LIMIT_BYTES,
  fetch: (url, init) => fetch(url, init),
  caches: typeof caches === 'undefined' ? null : caches,
  estimate: typeof navigator !== 'undefined' && navigator.storage?.estimate ? () => navigator.storage.estimate() : null,
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  lenient: import.meta.env.DEV,
})

/** Names the set of files this build was made with. */
export const ASSET_REVISION: string = manifest.revision
export const ASSET_COUNT = Object.keys(assets).length
export const loadAsset = store.load
export const assetStoreReport = store.report
export const clearAssetStore = store.clear

export const ASSET_MANIFEST = assets
export const assetStoreInventory = store.inventory
export const subscribeAssetStore = store.subscribe
export const assetDownloads = createAssetDownloads(store, assets)
