import type { IdentityCalibration, FittedSurfaceIdentity } from '../../world/avatarIdentity.ts'

export interface IdentityFitRequest {
  /** Existing `FaceScan.mesh`, encoded as 468 Int16 xyz triples. */
  front: string
  /** Optional meshes from a guided turn in the same capture session. */
  left?: string
  right?: string
  calibration: IdentityCalibration
  signal?: AbortSignal
}

export type IdentityFitOutcome =
  | { kind: 'fitted'; result: FittedSurfaceIdentity }
  | { kind: 'baseline'; reason: string }

type WorkerReply =
  | { kind: 'fitted'; result: FittedSurfaceIdentity }
  | { kind: 'error'; message: string }

/** Downloads the GNM pack only when called from the creator. Termination cancels fetch and CPU fitting. */
export function fitSurfaceIdentity(request: IdentityFitRequest): Promise<FittedSurfaceIdentity> {
  if (request.signal?.aborted) return Promise.reject(new DOMException('Identity fit cancelled', 'AbortError'))
  const worker = new Worker(new URL('./identityWorker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (value: FittedSurfaceIdentity | Error): void => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      request.signal?.removeEventListener('abort', cancel)
      worker.terminate()
      if (value instanceof Error) reject(value)
      else resolve(value)
    }
    const cancel = (): void => finish(new DOMException('Identity fit cancelled', 'AbortError'))
    request.signal?.addEventListener('abort', cancel, { once: true })
    worker.onerror = () => finish(new Error('Identity fitting is unavailable. The original face fit can still be used.'))
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (event.data.kind === 'error') finish(new Error(event.data.message))
      else if (event.data.kind === 'fitted') finish(event.data.result)
    }
    timeout = setTimeout(() => finish(new Error('Head fitting took too long. Your current character is still available.')), 30_000)
    worker.postMessage({
      front: request.front, left: request.left, right: request.right,
      calibration: request.calibration,
    })
    if (request.signal?.aborted) cancel()
  })
}

/** Explicit fallback for the creator preview; cancellation remains a cancellation. */
export async function fitSurfaceIdentityWithFallback(request: IdentityFitRequest): Promise<IdentityFitOutcome> {
  try { return { kind: 'fitted', result: await fitSurfaceIdentity(request) } }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return { kind: 'baseline', reason: error instanceof Error ? error.message : 'Identity fitting failed.' }
  }
}
