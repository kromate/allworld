// Deliberate batches use the same store as world loading. No second cache or network client.
import type { AssetManifest, AssetStore } from './assetStore.ts'

export interface AssetDownloads {
  queued(): readonly string[]
  active(): readonly string[]
  stopped(): readonly string[]
  download(paths: readonly string[]): Promise<void>
  cancel(paths?: readonly string[]): void
  subscribe(listener: () => void): () => void
}

export function createAssetDownloads(store: AssetStore, manifest: AssetManifest): AssetDownloads {
  const queued = new Set<string>()
  const active = new Map<string, AbortController>()
  const stopped = new Set<string>()
  const listeners = new Set<() => void>()
  let running: Promise<void> | null = null
  const notify = (): void => { for (const listener of listeners) listener() }

  async function worker(): Promise<void> {
    for (;;) {
      const path = queued.values().next().value
      if (path === undefined) return
      queued.delete(path)
      const controller = new AbortController()
      active.set(path, controller)
      notify()
      try {
        await store.load(path, controller.signal)
        // A successful fetch is not a saved file until the real store has finished writing.
        await store.settled()
      } catch {
        // The store records the concrete failure per path. Other packs can still finish.
      } finally {
        // A retry may already hold this path under a new controller: only remove our own entry.
        if (active.get(path) === controller) active.delete(path)
        notify()
      }
    }
  }

  function start(): Promise<void> {
    if (running) return running
    running = Promise.all(Array.from({ length: 6 }, worker)).then(() => undefined).finally(() => {
      running = null
      notify()
      if (queued.size > 0) return start()
    })
    return running
  }

  return {
    queued: () => [...queued], active: () => [...active.keys()], stopped: () => [...stopped],
    download(paths) {
      for (const path of paths) {
        if (!Object.hasOwn(manifest, path) || (active.has(path) && !active.get(path)?.signal.aborted)) continue
        stopped.delete(path)
        queued.add(path)
      }
      notify()
      return start()
    },
    cancel(paths = [...queued, ...active.keys()]) {
      for (const path of paths) {
        if (queued.delete(path) || active.has(path)) stopped.add(path)
      }
      for (const path of paths) active.get(path)?.abort()
      notify()
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
