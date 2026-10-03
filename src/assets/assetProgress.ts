// What is being downloaded right now, for the loading view. No framework and no DOM: the store
// reports here from the page and from workers, and a view subscribes.
//
// Sizes are counted per burst: from the first download that starts while nothing is running to the
// moment nothing is running again. A file that has finished still counts toward the burst, so the
// bar does not jump back each time one file ends and the next is half-way.

export type AssetErrorKind = 'offline' | 'network' | 'missing' | 'changed' | 'stopped'
export interface AssetFailure { kind: AssetErrorKind; message: string }

export interface AssetActivity {
  /** Downloads under way, counting those waiting their turn. A view shows nothing when this is 0. */
  active: number
  /** Bytes received in this burst. */
  loaded: number
  /** Bytes this burst will receive, or null when a size is not known. */
  total: number | null
  /** What the files are for (manifest groups), in the order they were asked for. */
  groups: readonly string[]
  /** Every byte has arrived; the files are being checked and unpacked. */
  checking: boolean
  /** The last download that did not finish, until another burst starts. */
  failure: AssetFailure | null
}

/** One download, as the store reports it. Exactly one of done or failed ends it. */
export interface AssetJob {
  progress(loaded: number, total: number | null): void
  checking(): void
  done(): void
  failed(failure: AssetFailure): void
}

export interface AssetProgress {
  /** `key` names what is downloaded (its path). A new download under the key of the last failure clears that failure: it is being retried. */
  begin(group: string, total: number | null, stop: () => void, key?: string): AssetJob
  activity(): AssetActivity
  /** Calls back on every change, at most a few times a second while bytes arrive. Returns the way to stop. */
  subscribe(listener: (activity: AssetActivity) => void): () => void
  /** Stop every download under way. Each ends as failed with kind 'stopped'. */
  stopAll(): void
}

interface Running { group: string; loaded: number; total: number | null; checking: boolean; stop: () => void }

const NOTIFY_MS = 120

export function createAssetProgress(): AssetProgress {
  const running = new Set<Running>()
  const listeners = new Set<(activity: AssetActivity) => void>()
  let settled = 0
  let groups: string[] = []
  let failure: AssetFailure | null = null
  let failedKey: string | undefined
  let timer: ReturnType<typeof setTimeout> | null = null

  function activity(): AssetActivity {
    let loaded = settled, total: number | null = settled, checking = running.size > 0
    for (const job of running) {
      loaded += job.loaded
      total = total === null || job.total === null ? null : total + job.total
      if (!job.checking) checking = false
    }
    return { active: running.size, loaded, total, groups, checking, failure }
  }

  function notify(): void {
    if (timer !== null) { clearTimeout(timer); timer = null }
    const now = activity()
    for (const listener of listeners) listener(now)
  }
  /** Bytes arrive many times a second; the view does not need each one. */
  function notifySoon(): void {
    if (timer === null && listeners.size > 0) timer = setTimeout(() => { timer = null; notify() }, NOTIFY_MS)
  }

  return {
    begin(group, total, stop, key) {
      if (running.size === 0) { settled = 0; groups = []; failure = null }
      else if (failure && key !== undefined && key === failedKey) failure = null
      if (!groups.includes(group)) groups = [...groups, group]
      const job: Running = { group, loaded: 0, total, checking: false, stop }
      running.add(job)
      notify()
      return {
        // Bytes reported after a check mean the file is being fetched again: it is a download once more.
        progress(loaded, size) { job.loaded = loaded; job.total = size; job.checking = false; notifySoon() },
        checking() { job.checking = true; notify() },
        done() {
          if (!running.delete(job)) return
          settled += job.total ?? job.loaded
          notify()
        },
        failed(reason) {
          if (!running.delete(job)) return
          failure = reason
          failedKey = key
          notify()
        },
      }
    },
    activity,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== null) { clearTimeout(timer); timer = null }
      }
    },
    stopAll() { for (const job of [...running]) job.stop() },
  }
}

/** The page's own tracker. A worker that imports this gets a separate one that nothing shows. */
export const assetProgress = createAssetProgress()
