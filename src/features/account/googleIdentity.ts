import type { GoogleCredentialCollector, GoogleCredentialRequest, GooglePreparedAttempt } from '../../platform/account.ts'

interface GoogleId {
  initialize(input: { client_id: string; nonce: string; auto_select: false; button_auto_select: false; callback(reply: unknown): void }): void
  renderButton(host: HTMLElement, input: { type: 'standard'; theme: 'outline'; size: 'large'; text: 'continue_with'; width: string; logo_alignment: 'left'; click_listener(): void }): void
  cancel(): void
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
function isGoogleId(value: unknown): value is GoogleId {
  return object(value) && typeof value.initialize === 'function' && typeof value.renderButton === 'function' && typeof value.cancel === 'function'
}
function identityApi(): GoogleId | null {
  const google: unknown = Reflect.get(window, 'google')
  const id = object(google) && object(google.accounts) ? google.accounts.id : null
  return isGoogleId(id) ? id : null
}

/** Load only after the account form mounts and transfer capture has already run. No sign-in starts. */
export async function loadGoogleIdentity(signal: AbortSignal): Promise<GoogleId> {
  signal.throwIfAborted()
  const available = identityApi()
  if (available) return available
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true
    let complete = false
    const timeout = setTimeout(() => finish(new Error('Google sign-in could not load. Use your password or try again.')), 8000)
    function finish(error?: Error) {
      if (complete) return
      complete = true; clearTimeout(timeout)
      signal.removeEventListener('abort', cancelled); script.onload = null; script.onerror = null; script.remove()
      if (error) { reject(error); return }
      const api = identityApi()
      if (api) resolve(api)
      else reject(new Error('Google sign-in could not load. Use your password instead.'))
    }
    const cancelled = (): void => finish(new DOMException('Google sign-in was cancelled.', 'AbortError'))
    script.onload = () => finish(); script.onerror = () => finish(new Error('Google sign-in could not load. Use your password or try again.'))
    signal.addEventListener('abort', cancelled, { once: true }); document.head.append(script)
  })
}

export interface GoogleButtonHandle { credential: Promise<string>; remove(): void }
/** One real SDK button; the callback is accepted only after its real click reserved the nonce. */
export function renderGoogleButton(api: GoogleId, host: HTMLElement, input: GoogleCredentialRequest, signal: AbortSignal, reserve: () => boolean): GoogleButtonHandle {
  let finish: (credential?: string) => void = () => undefined
  let setupFailed = false
  const credential = new Promise<string>((resolve, reject) => {
    let finished = false, clicked = false
    finish = value => {
      if (finished) return
      finished = true; signal.removeEventListener('abort', cancelled)
      host.replaceChildren(); api.cancel()
      if (value && !signal.aborted) resolve(value)
      else reject(new DOMException('Google sign-in was cancelled.', 'AbortError'))
    }
    const cancelled = (): void => finish()
    signal.addEventListener('abort', cancelled, { once: true })
    try {
      signal.throwIfAborted()
      api.initialize({ client_id: input.clientId, nonce: input.nonce, auto_select: false, button_auto_select: false, callback(reply) {
        if (signal.aborted || finished || !clicked) return
        if (!object(reply) || typeof reply.credential !== 'string' || reply.credential.length < 100 || reply.credential.length > 4096) { finish(); return }
        finish(reply.credential)
      } })
      api.renderButton(host, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', logo_alignment: 'left', width: String(Math.max(200, Math.min(400, host.clientWidth || 280))), click_listener() {
        if (signal.aborted || finished || clicked) return
        // This runs synchronously inside Google's real click, before its chooser blurs this page.
        clicked = reserve()
        if (!clicked) finish()
      } })
    } catch { setupFailed = true; finish() }
  })
  // Idle cancellation has no collector yet. Keep rejection handled without swallowing it for adoption.
  void credential.catch(() => undefined)
  if (setupFailed) throw new Error('Google sign-in could not render. Use your password or try again.')
  return { credential, remove: () => finish() }
}

export type GoogleButtonPhase = 'idle' | 'loading' | 'ready' | 'active' | 'failed'
interface GoogleButtonOwner {
  host(): HTMLElement | null
  foreground(): boolean
  enabled(): boolean
  prepare(signal: AbortSignal): Promise<GooglePreparedAttempt>
  signIn(collect: GoogleCredentialCollector, prepared: GooglePreparedAttempt): Promise<void>
  present(phase: GoogleButtonPhase): void
  onChoose(): void
}
interface ButtonRuntime {
  load(signal: AbortSignal): Promise<GoogleId>
  render(api: GoogleId, host: HTMLElement, input: GoogleCredentialRequest, signal: AbortSignal, reserve: () => boolean): GoogleButtonHandle
  schedule(run: () => void, delay: number): ReturnType<typeof setTimeout>
  clear(timer: ReturnType<typeof setTimeout>): void
}
/** Owns passive readiness separately from the active account flow, including expected popup blur. */
export function createGoogleButton(owner: GoogleButtonOwner, runtime: ButtonRuntime = { load: loadGoogleIdentity, render: renderGoogleButton, schedule: setTimeout, clear: clearTimeout }) {
  let phase: GoogleButtonPhase = 'idle', run = 0, closed = false, failed = false
  let work: AbortController | null = null, lease: GooglePreparedAttempt | null = null, button: GoogleButtonHandle | null = null
  let renewal: ReturnType<typeof setTimeout> | null = null
  let cleanup: Promise<boolean> = Promise.resolve(true)
  const show = (next: GoogleButtonPhase): void => { phase = next; owner.present(next) }
  function stopTimer() { if (renewal !== null) runtime.clear(renewal); renewal = null }
  async function release(): Promise<boolean> {
    stopTimer(); const previous = lease; lease = null
    const previousWork = work; work = null
    const previousButton = button; button = null
    previousButton?.remove(); previousWork?.abort()
    const cancelling = previous ? previous.cancel().then(result => result !== 'unconfirmed') : Promise.resolve(true)
    cleanup = Promise.all([cleanup, cancelling]).then(([before, now]) => before && now)
    return cleanup
  }
  async function prepare() {
    if (closed || failed || phase === 'active' || !owner.enabled() || !owner.foreground()) return
    const epoch = ++run
    show('loading')
    try {
      if (!await release()) throw new Error('An unused Google button could not be closed.')
      if (epoch !== run || closed || !owner.enabled() || !owner.foreground()) { show('idle'); return }
      const currentWork = new AbortController(); work = currentWork
      const api = await runtime.load(currentWork.signal)
      currentWork.signal.throwIfAborted()
      if (epoch !== run || !owner.enabled() || !owner.foreground()) { await release(); if (epoch === run && !closed) show('idle'); return }
      const prepared = await owner.prepare(currentWork.signal)
      if (epoch !== run || currentWork.signal.aborted || closed || !owner.enabled() || !owner.foreground()) { await prepared.cancel(); return }
      lease = prepared
      if (prepared.remainingMs() <= 15_000) throw new Error('The Google button took too long to prepare.')
      const host = owner.host()
      if (!host) throw new Error('The Google form is closed.')
      const signal = AbortSignal.any([currentWork.signal, prepared.signal])
      button = runtime.render(api, host, prepared.request, signal, () => {
        if (phase !== 'ready' || epoch !== run || closed || !owner.enabled() || !prepared.reserve()) return false
        // Reserve and stop passive cleanup before asynchronous guest hold or popup blur.
        stopTimer(); show('active'); owner.onChoose()
        let expired = false
        const authenticated = (): void => { if (prepared.authenticated()) stopTimer() }
        prepared.signal.addEventListener('abort', authenticated, { once: true })
        currentWork.signal.addEventListener('abort', () => prepared.signal.removeEventListener('abort', authenticated), { once: true })
        renewal = runtime.schedule(() => {
          renewal = null
          if (epoch !== run || closed || phase !== 'active') return
          expired = true; failed = true; show('failed'); void release()
        }, prepared.remainingMs())
        const chosenButton = button
        if (!chosenButton) return false
        void owner.signIn(async (input, collectedSignal) => {
          collectedSignal.throwIfAborted()
          if (input.nonce !== prepared.request.nonce || input.clientId !== prepared.request.clientId) throw new Error('The Google button changed.')
          return chosenButton.credential
        }, prepared).then(() => {
          if (epoch !== run || closed || expired) return
          show('idle')
        }).catch(() => {
          if (epoch !== run || closed || expired) return
          failed = true; show('failed')
        }).finally(() => { if (epoch === run) void release() })
        return true
      })
      show('ready')
      renewal = runtime.schedule(() => { renewal = null; if (phase === 'ready') void prepare() }, prepared.remainingMs() - 15_000)
    } catch {
      if (epoch !== run || closed) return
      await release()
      failed = true; show('failed')
    }
  }
  function pauseIdle() {
    if (phase === 'active') return
    run++; stopTimer(); owner.host()?.replaceChildren(); show(failed ? 'failed' : 'idle')
    void release().then(ok => { if (!ok && !closed) { failed = true; show('failed') } })
  }
  return {
    start: () => { void prepare() },
    foregroundChanged() {
      if (phase === 'active') return
      if (!owner.foreground() || !owner.enabled()) { pauseIdle(); return }
      if (lease && lease.remainingMs() <= 15_000) { pauseIdle(); if (!failed) void prepare(); return }
      if (phase === 'idle') void prepare()
    },
    pauseIdle,
    retry() { if (phase === 'active' || closed) return; void cleanup.then(() => { if (closed || phase === 'active') return; failed = false; cleanup = Promise.resolve(true); void prepare() }) },
    cancel() { run++; stopTimer(); show('idle'); void release() },
    dispose() { closed = true; run++; stopTimer(); void release() },
  }
}
