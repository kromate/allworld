// The only file that knows the account provider. `fetch` only: no SDK, no service-account key, no password store.
// Nothing here logs, and no error carries a request, a reply, a URL or a cause: each of those can hold a secret.

export type ProviderRefusal =
  | 'invalid-credentials'   // wrong password, unknown address, malformed address: one answer
  | 'email-in-use'
  | 'weak-password'
  | 'disabled'
  | 'revoked'               // deleted, password changed, refresh token revoked, or the reply was for someone else
  | 'throttled'
  | 'unavailable'           // network, timeout, 5xx, wrong project, anything not understood
export class ProviderError extends Error {
  readonly refusal: ProviderRefusal
  constructor(refusal: ProviderRefusal) {
    super(`The account provider answered: ${refusal}.`)
    this.refusal = refusal
    this.name = 'ProviderError'
  }
}
/** What the provider proved. `issuer` becomes the world's accountId and `uid` its subjectId. */
export interface ProviderIdentity { issuer: `firebase:${string}`; uid: string; email: string; emailVerified: boolean }
/** Secret-bearing. Stays inside the service; the refresh token is sealed before it reaches state. */
export interface ProviderCredential { identity: ProviderIdentity; refreshToken: string }
export interface AccountProvider {
  readonly issuer: `firebase:${string}`
  signUp(input: { email: string; password: string }, signal: AbortSignal): Promise<ProviderCredential>
  signIn(input: { email: string; password: string }, signal: AbortSignal): Promise<ProviderCredential>
  /** Proves the account still exists, is enabled and has not had its tokens revoked. May return a new refresh token. */
  revalidate(input: { refreshToken: string; expectedIssuer: string; expectedUid: string }, signal: AbortSignal): Promise<ProviderCredential>
}

const TIMEOUT_MS = 8000, REPLY_LIMIT = 16 * 1024
export const REFRESH_TOKEN_LIMIT = 4096
const REFUSALS: Readonly<Record<string, ProviderRefusal>> = {
  INVALID_LOGIN_CREDENTIALS: 'invalid-credentials', EMAIL_NOT_FOUND: 'invalid-credentials', INVALID_PASSWORD: 'invalid-credentials', INVALID_EMAIL: 'invalid-credentials',
  EMAIL_EXISTS: 'email-in-use',
  WEAK_PASSWORD: 'weak-password', PASSWORD_DOES_NOT_MEET_REQUIREMENTS: 'weak-password',
  USER_DISABLED: 'disabled',
  TOKEN_EXPIRED: 'revoked', USER_NOT_FOUND: 'revoked', INVALID_REFRESH_TOKEN: 'revoked',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'throttled', QUOTA_EXCEEDED: 'throttled', RESOURCE_EXHAUSTED: 'throttled',
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const short = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
/** An address the page can name the account by: bounded, one `@`, no spaces. Anything else counts as absent. */
const address = (value: unknown): value is string => short(value, 254) && /^[^\s@]+@[^\s@]+$/.test(value)

export function createFirebaseRestProvider(options: { projectId: string; projectNumber?: string; apiKey: string; fetch?: typeof fetch }): AccountProvider {
  const { projectId, projectNumber, apiKey } = options
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) throw new Error('Invalid Firebase project id.')
  if (projectNumber !== undefined && !/^\d{6,20}$/.test(projectNumber)) throw new Error('Invalid Firebase project number.')
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(apiKey)) throw new Error('Invalid Firebase web API key.')
  const request = options.fetch ?? fetch
  const issuer = `firebase:${projectId}` as const
  const key = `?key=${encodeURIComponent(apiKey)}`

  async function call(url: string, type: string, payload: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    let status: number, raw: unknown
    try {
      const response = await request(url + key, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        headers: { 'content-type': type }, body: payload,
      })
      status = response.status
      const reader = response.body?.getReader()
      if (!reader) throw new Error('empty')
      const chunks: Uint8Array[] = []
      let bytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > REPLY_LIMIT) { await reader.cancel(); throw new Error('large') }
        chunks.push(value)
      }
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch { throw new ProviderError('unavailable') }
    if (status >= 200 && status < 300 && object(raw)) return raw
    const message = object(raw) && object(raw.error) && typeof raw.error.message === 'string' ? raw.error.message : ''
    const named = REFUSALS[/^[A-Z_]+/.exec(message)?.[0] ?? '']
    throw new ProviderError(status === 429 ? 'throttled' : status >= 500 ? 'unavailable' : named ?? 'unavailable')
  }

  /**
   * The ID token came over TLS in the reply to this server's own request, so its signature is not
   * what is trusted here and is not checked. Its claims are read for one thing: to refuse a reply
   * that is for another project or another person than the reply itself names.
   */
  function credential(uid: unknown, idToken: unknown, refreshToken: unknown, replyEmail?: unknown): ProviderCredential {
    if (!short(uid, 128) || !short(idToken, 8192) || !short(refreshToken, REFRESH_TOKEN_LIMIT)) throw new ProviderError('unavailable')
    let claims: unknown
    try { claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) } catch { throw new ProviderError('unavailable') }
    if (!object(claims) || claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}` || claims.sub !== uid) throw new ProviderError('unavailable')
    // The address comes from the provider's own reply about this uid, never from what was typed.
    // Empty when the provider named none: a refresh then keeps the address it verified before.
    const email = address(claims.email) ? claims.email : address(replyEmail) ? replyEmail : ''
    return { identity: { issuer, uid, email, emailVerified: claims.email_verified === true }, refreshToken }
  }
  async function withPassword(method: 'signUp' | 'signInWithPassword', input: { email: string; password: string }, signal: AbortSignal): Promise<ProviderCredential> {
    const raw = await call(`https://identitytoolkit.googleapis.com/v1/accounts:${method}`, 'application/json',
      JSON.stringify({ email: input.email, password: input.password, returnSecureToken: true }), signal)
    const proved = credential(raw.localId, raw.idToken, raw.refreshToken, raw.email)
    // A password sign-in names an account by its address. A reply that does not say which address opens nothing.
    if (!proved.identity.email) throw new ProviderError('unavailable')
    return proved
  }
  return {
    issuer,
    signUp: (input, signal) => withPassword('signUp', input, signal),
    signIn: (input, signal) => withPassword('signInWithPassword', input, signal),
    async revalidate(input, signal) {
      if (input.expectedIssuer !== issuer) throw new ProviderError('revoked')
      const raw = await call('https://securetoken.googleapis.com/v1/token', 'application/x-www-form-urlencoded',
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: input.refreshToken }).toString(), signal)
      // The token service names the project by number. A reply for another project is not an answer about this account.
      if (raw.project_id !== undefined && raw.project_id !== projectId && raw.project_id !== projectNumber) throw new ProviderError('unavailable')
      const fresh = credential(raw.user_id, raw.id_token, raw.refresh_token)
      if (fresh.identity.uid !== input.expectedUid) throw new ProviderError('revoked')
      return fresh
    },
  }
}
