import { readonly, ref } from 'vue'
import { hostedWorldConfig } from '../platform/runtime.ts'
import { worldUrl } from '../platform/worldEndpoint.ts'
import { isLiveCountsSnapshot } from '../shared/liveCounts.ts'
import type { LiveCountsSnapshot, PageView } from '../shared/liveCounts.ts'

type CountsStatus = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; snapshot: LiveCountsSnapshot }
const status = ref<CountsStatus>({ kind: 'loading' })
export const liveCounts = readonly(status)
let users = 0, timer: ReturnType<typeof setTimeout> | null = null
let controller: AbortController | null = null
let pageView: PageView | null = null, recorded = false, viewExpired = false

/** One random event per document lifetime. Mounts and socket reconnects reuse it. */
export function retainLiveCounts(): () => void {
  users++
  if (users === 1) {
    controller = new AbortController()
    const signal = controller.signal
    const poll = async (): Promise<void> => {
      const config = hostedWorldConfig()
      if (!config) { status.value = { kind: 'unavailable' }; timer = setTimeout(() => { void poll() }, 15_000); return }
      try {
        const view = pageView ??= { eventId: crypto.randomUUID(), startedAt: Date.now() }
        const send = (): Promise<Response> => {
          const record = !recorded && !viewExpired
          return fetch(worldUrl(config, `/world/counts/${record ? 'view' : 'snapshot'}`), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(record ? view : {}), credentials: 'omit',
            signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
          })
        }
        let response = await send()
        // A view the service refuses as too old is never counted. Read the totals now rather than show nothing for a whole interval.
        if (response.status === 410 && !recorded) { viewExpired = true; response = await send() }
        if (!response.ok) throw new Error('Counts unavailable.')
        const raw: unknown = await response.json()
        let snapshot: unknown = raw
        if (!recorded && !viewExpired) {
          if (!raw || typeof raw !== 'object' || !('recorded' in raw) || raw.recorded !== true || !('snapshot' in raw)) throw new Error('The view was not recorded.')
          snapshot = raw.snapshot
        }
        if (!isLiveCountsSnapshot(snapshot)) throw new Error('Invalid count snapshot.')
        if (!signal.aborted) { if (!viewExpired) recorded = true; status.value = { kind: 'ready', snapshot } }
      } catch { if (!signal.aborted) status.value = { kind: 'unavailable' } }
      finally { if (!signal.aborted) timer = setTimeout(() => { void poll() }, 15_000) }
    }
    void poll()
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--users !== 0) return
    controller?.abort(); controller = null
    if (timer) clearTimeout(timer)
    timer = null
  }
}
