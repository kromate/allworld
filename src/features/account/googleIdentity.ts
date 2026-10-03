import type { GoogleCredentialRequest } from '../../platform/account.ts'

interface GoogleId {
  initialize(input: { client_id: string; nonce: string; auto_select: false; callback(reply: unknown): void }): void
  renderButton(host: HTMLElement, input: { type: 'standard'; theme: 'outline'; size: 'large'; text: 'continue_with'; width: number }): void
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

/** Called only from an already mounted, explicitly chosen account form, after transfer capture. */
async function load(signal: AbortSignal): Promise<GoogleId> {
  signal.throwIfAborted()
  const available = identityApi()
  if (available) return available
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    let complete = false
    const timeout = setTimeout(() => finish(new Error('Google sign-in could not load. Try again or use your password.')), 8000)
    function finish(error?: Error) {
      if (complete) return
      complete = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancelled)
      script.onload = null; script.onerror = null
      if (error) { script.remove(); reject(error); return }
      const api = identityApi()
      if (api) { script.remove(); resolve(api) }
      else { script.remove(); reject(new Error('Google sign-in could not load. Use your password instead.')) }
    }
    const cancelled = (): void => finish(new DOMException('Google sign-in was cancelled.', 'AbortError'))
    script.onload = () => finish()
    script.onerror = () => finish(new Error('Google sign-in could not load. Try again or use your password.'))
    signal.addEventListener('abort', cancelled, { once: true })
    document.head.append(script)
  })
}

/** One official Google button and one callback. Late callbacks never leave the cancelled form. */
export async function collectGoogleCredential(host: HTMLElement, input: GoogleCredentialRequest, signal: AbortSignal): Promise<string> {
  const api = await load(signal)
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let finished = false
    function finish(credential?: string) {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', cancelled)
      host.replaceChildren()
      api.cancel()
      if (credential && !signal.aborted) resolve(credential)
      else reject(new DOMException('Google sign-in was cancelled.', 'AbortError'))
    }
    const cancelled = (): void => finish()
    signal.addEventListener('abort', cancelled, { once: true })
    try {
    api.initialize({ client_id: input.clientId, nonce: input.nonce, auto_select: false, callback(reply) {
      if (signal.aborted || finished) return
      if (!object(reply) || typeof reply.credential !== 'string' || reply.credential.length < 100 || reply.credential.length > 4096) { finish(); return }
      finish(reply.credential)
    } })
    api.renderButton(host, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', width: Math.max(200, Math.min(360, host.clientWidth || 280)) })
    } catch { finish() }
  })
}
