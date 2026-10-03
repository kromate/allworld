// This world's own accounts, from the browser's side. Same-origin JSON POSTs under /world/account/;
// the session itself is an HttpOnly cookie this page can never read. Nothing here talks to an
// identity provider, and nothing here keeps a password: it is an argument of one call, sent once,
// and held by no variable that outlives that call.
//
// Aborting a request does not undo what the server already did with it, so this module does not
// rely on that:
//   - sign-in, sign-up and sign-out run one at a time, in the order they were asked for;
//   - every sign-in and sign-up first asks the server for a fresh attempt (`attempt`, issued only
//     when the form is submitted, alive for 30 seconds, used once). The credentials go only with an
//     attempt that is still current and inside that window. A cancel, a timeout, a newer sign-in or
//     an answer this page cannot read sends `cancel` for that exact attempt; the server ends whatever
//     session that attempt made, and only that one. An attempt that arrives after the visitor
//     cancelled is cancelled at once and never followed by credentials;
//   - until the server confirms every such cancel, this module reports nobody signed in and proves
//     no account: a session the visitor walked away from can never open a world or take a guest;
//   - a code from `issuer` that arrives after a sign-out, cancel or another sign-in is dropped.
import { ERROR_CODES, WorldError } from '../shared/model.ts'
import type { ErrorCode } from '../shared/model.ts'
import type { IdentityIssuer } from './hostedService.ts'
import type { HostedWorldSetup } from './runtime.ts'
import { accountEndpoint } from './worldEndpoint.ts'

/**
 * Who the server's session record names. `email` is the account's own verified address, shown only
 * to the person at this device so they can see which account they are about to use. `name` is a
 * neutral label, not the person's identity.
 */
export interface AccountUser { userId: string; accountId: string; name: string; email: string }

/**
 * `confirmed`: the server recorded it. `unconfirmed`: the server answered that it could not record
 * it; access through it is closed and this browser's session is cleared. `unreached`: no answer, so
 * this browser may still hold a session; it is ended before the next account request.
 */
export type SignOutResult = 'confirmed' | 'unconfirmed' | 'unreached'
/** `none`: nothing had been sent. `confirmed`: the server's receipt. `unconfirmed`: no receipt yet; it is retried before any other account request. */
export type CancelResult = 'none' | 'confirmed' | 'unconfirmed'

export interface GoogleCredentialRequest { clientId: string; nonce: string }
export type GoogleCredentialCollector = (request: GoogleCredentialRequest, signal: AbortSignal) => Promise<string>

export interface AccountApi {
  /** False when the world's endpoint is not this page's own origin: no account request is ever sent then. */
  readonly available: boolean
  /** Who this browser's session names, or null. The server's record, not proof: `issuer` is the authority. */
  me(signal?: AbortSignal): Promise<AccountUser | null>
  googleConfiguration(signal?: AbortSignal): Promise<{ clientId: string } | null>
  signInGoogle(collect: GoogleCredentialCollector): Promise<AccountUser>
  signIn(email: string, password: string): Promise<AccountUser>
  signUp(email: string, password: string): Promise<AccountUser>
  /** Ends this device's session only. Never rejects: the caller has already closed the world here. */
  signOut(): Promise<SignOutResult>
  /** Stop the sign-in under way, if any. Resolves once the server has answered the cancel, or could not. */
  abandon(): Promise<CancelResult>
  /** Retry cancels and a sign-out the server has not confirmed. True when nothing is left owing. */
  settle(): Promise<boolean>
  /** A cancel or sign-out is still unconfirmed: nobody is reported signed in until it is. */
  unsettled(): boolean
  /** POST /world/account/grant, in the shape the hosted session exchange already takes. */
  issuer: IdentityIssuer
  /** Told on sign-in, on sign-out, and when the server says the session is gone. */
  onChange(listener: (user: AccountUser | null) => void): () => void
}

/** Root password policy for a new account. The server checks the same bounds and stays the authority. */
export const ACCOUNT_PASSWORD_MIN = 12
export const ACCOUNT_PASSWORD_MAX = 128
export const PASSWORD_RULE = `Use a password of ${ACCOUNT_PASSWORD_MIN} to ${ACCOUNT_PASSWORD_MAX} characters.`

type AccountPath = '/world/account/google-config' | '/world/account/google' | '/world/account/attempt' | '/world/account/signup' | '/world/account/signin' | '/world/account/me' | '/world/account/grant' | '/world/account/signout' | '/world/account/cancel'
interface Answer { ok: boolean; status: number; value: unknown }
interface Attempt { run: number; stop: AbortController; cancelled: Promise<CancelResult>; settle(result: CancelResult): void }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const isCode = (value: unknown): value is ErrorCode => ERROR_CODES.some(code => code === value)
const stopped = (): DOMException => new DOMException('The account request was cancelled.', 'AbortError')
const UNSETTLED = 'An earlier sign-in on this device is still being cancelled, so no account is used here yet. Check your connection and try again.'
/** Counted as the form counts it: by character, not by code unit. */
const length = (password: string): number => [...password].length
/** An attempt is used only inside the window the server gave it, counted from when this page asked, so a clock that differs from the server's cannot stretch it. */
const ATTEMPT_MS = 30_000

/** The server's fresh attempt: 32 random bytes as 43 base64url characters, and its absolute expiry. */
function issuedAttempt(value: unknown): string {
  if (!record(value) || typeof value.attemptId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.attemptId)
    || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)) throw new WorldError('unavailable', 'The account service returned an invalid reply. Try again.')
  return value.attemptId
}

function userOf(value: unknown): AccountUser {
  if (!record(value) || !text(value.userId, 256) || !text(value.accountId, 256) || !text(value.name, 120)
    || !text(value.email, 254) || !/^[^\s@]+@[^\s@]+$/.test(value.email)) throw new WorldError('unavailable', 'The account service returned an invalid reply. Try again.')
  return { userId: value.userId, accountId: value.accountId, name: value.name, email: value.email }
}

/** The server's own sentence when it sent one; never the request, which may hold a password. */
function refusal(answer: Answer): WorldError {
  const { status, value } = answer
  const code: ErrorCode = record(value) && isCode(value.code) ? value.code
    : status === 400 ? 'invalid' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limited' : 'unavailable'
  const fallback = status === 429 ? 'Too many tries just now. Wait a minute, then try again.' : 'The account service is unavailable. Try again later.'
  return new WorldError(code, record(value) && text(value.message, 400) ? value.message : fallback)
}

function collectGoogle(collect: GoogleCredentialCollector, input: GoogleCredentialRequest, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const stop = (): void => { signal.removeEventListener('abort', stop); reject(stopped()) }
    if (signal.aborted) { stop(); return }
    signal.addEventListener('abort', stop, { once: true })
    Promise.resolve().then(() => collect(input, signal)).then(value => {
      signal.removeEventListener('abort', stop)
      if (signal.aborted) { reject(stopped()); return }
      if (typeof value !== 'string' || value.length < 100 || value.length > 4096) { reject(new WorldError('invalid', 'Google returned an invalid credential. Try again.')); return }
      resolve(value)
    }, () => { signal.removeEventListener('abort', stop); reject(new WorldError('unavailable', 'Google sign-in did not finish. Try again or use your password.')) })
  })
}

export function accountApi(config: HostedWorldSetup): AccountApi {
  // The session cookie is same-origin only and the server allows no cross-origin call, so a page
  // served from anywhere but the world's endpoint has no accounts at all.
  let endpoint: string | null = null
  try { endpoint = accountEndpoint(config) } catch { /* another origin: no accounts here */ }
  const available = endpoint !== null
  const listeners = new Set<(user: AccountUser | null) => void>()
  let generation = 0
  let queue: Promise<unknown> = Promise.resolve()
  let current: Attempt | null = null
  /** Attempts sent and then given up on, whose cancel the server has not confirmed. */
  const owedCancels = new Set<string>()
  /** A sign-out got no answer: this browser may hold a session nobody was told about. */
  let owedSignOut = false

  const tell = (user: AccountUser | null): void => { for (const listener of [...listeners]) listener(user) }
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  /** Resolves with whatever the server answered. Rejects only when there was no answer to read. */
  async function send(path: AccountPath, body: Record<string, string>, signal?: AbortSignal, limit = 10_000): Promise<Answer> {
    if (!endpoint) throw new WorldError('unavailable', 'Accounts are not available on this page.')
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(limit)]) : AbortSignal.timeout(limit)
    let response: Response
    try {
      response = await fetch(`${endpoint}${path}`, {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: bounded,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new WorldError('unavailable', 'The account service could not be reached. Check your connection and try again.')
    }
    let value: unknown
    try { value = await response.json() }
    catch (error) {
      if (signal?.aborted) throw error
      // A refusal with no readable body is still a refusal; a success with none is not an answer.
      if (response.ok) throw new WorldError('unavailable', 'The account service returned an invalid reply. Try again.')
    }
    return { ok: response.ok, status: response.status, value }
  }

  /** Inside the queue only. True only on the server's receipt for this exact attempt. */
  async function cancelAttempt(id: string): Promise<boolean> {
    try {
      const answer = await send('/world/account/cancel', { attemptId: id })
      return answer.ok && record(answer.value) && answer.value.cancelled === true
    } catch { return false }
  }
  /** Inside the queue only. The server clears this browser's session on 200 and on 503, and on nothing else. */
  async function endSession(): Promise<Answer | null> {
    try { const answer = await send('/world/account/signout', {}); owedSignOut = !answer.ok && answer.status !== 503; return answer }
    catch { owedSignOut = true; return null }
  }
  /** Inside the queue only. Retries what the server has not confirmed. */
  async function settleOwed(): Promise<boolean> {
    for (const id of [...owedCancels]) if (await cancelAttempt(id)) owedCancels.delete(id)
    if (owedSignOut) await endSession()
    return owedCancels.size === 0 && !owedSignOut
  }

  function credential(path: '/world/account/signup' | '/world/account/signin' | '/world/account/google', email: string, password: string, collect?: GoogleCredentialCollector): Promise<AccountUser> {
    // Out of bounds: refused here, before any attempt exists, with the same sentence the server uses.
    if (path !== '/world/account/google' && (length(password) > ACCOUNT_PASSWORD_MAX || (path === '/world/account/signup' && length(password) < ACCOUNT_PASSWORD_MIN))) return Promise.reject(new WorldError('invalid', PASSWORD_RULE))
    const creating = path === '/world/account/signup'
    const run = ++generation
    current?.stop.abort()
    let settle: (result: CancelResult) => void = () => undefined
    const attempt: Attempt = { run, stop: new AbortController(), cancelled: new Promise(resolve => { settle = resolve }), settle: result => settle(result) }
    current = attempt
    const live = (): boolean => run === generation && !attempt.stop.signal.aborted
    return serial(async () => {
      let sent = false
      try {
        if (!live()) throw stopped()
        if (!await settleOwed()) throw new WorldError('unavailable', UNSETTLED)
        if (!live()) throw stopped()
        let clientId: string | null = null
        if (path === '/world/account/google') {
          const metadata = await send('/world/account/google-config', {}, attempt.stop.signal)
          if (!metadata.ok) throw refusal(metadata)
          if (!record(metadata.value) || typeof metadata.value.clientId !== 'string' || !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(metadata.value.clientId)) throw new WorldError('unavailable', 'Google sign-in is not available here. Use your password instead.')
          clientId = metadata.value.clientId
          if (!live()) throw stopped()
        }
        // 1. A fresh attempt from the server, asked for now that the form was submitted.
        const askedAt = Date.now()
        let issued: Answer
        try { issued = await send('/world/account/attempt', {}, attempt.stop.signal) }
        catch (error) { if (!live()) throw stopped(); throw error }
        if (!issued.ok) { if (!live()) throw stopped(); throw refusal(issued) }
        const attemptId = issuedAttempt(issued.value)
        if (!live() || Date.now() >= askedAt + ATTEMPT_MS) {
          // Cancelled while it was being issued, or too old to use: no credentials are ever sent with it.
          // It has authenticated nothing, so the cancel is a courtesy and nothing is owed if it fails.
          await cancelAttempt(attemptId)
          if (!live()) throw stopped()
          throw new WorldError('unavailable', 'The sign-in took too long to start. Nothing was sent. Try again.')
        }
        // 2. The credentials, with that attempt only.
        let answer: Answer | null = null
        let failure: unknown
        sent = true
        const deadline = AbortSignal.timeout(Math.max(0, askedAt + ATTEMPT_MS - Date.now()) + 15_000)
        try {
          const signal = AbortSignal.any([attempt.stop.signal, deadline, ...(path === '/world/account/google' ? [AbortSignal.timeout(Math.max(0, askedAt + ATTEMPT_MS - Date.now()))] : [])])
          let body: Record<string, string> = { email, password, attemptId }
          if (path === '/world/account/google') {
            if (!collect || !clientId) throw new WorldError('unavailable', 'Google sign-in is not available here.')
            const idToken = await collectGoogle(collect, { clientId, nonce: attemptId }, signal)
            signal.throwIfAborted()
            body = { idToken, attemptId }
          }
          answer = await send(path, body, signal, 45_000)
        } catch (error) { failure = error }
        let user: AccountUser | null = null
        if (answer?.ok) { try { user = userOf(answer.value) } catch (error) { failure = error } }
        if (live() && user) { attempt.settle('none'); tell(user); return user }
        // Answered and refused (409 included: a cancelled or used attempt): the server made no session.
        if (live() && answer && !answer.ok) { attempt.settle('none'); throw refusal(answer) }
        // Cancelled, superseded, timed out, or no readable answer: the server may hold a session for
        // this attempt. Only its receipt for this attempt's cancel says it does not.
        const confirmed = await cancelAttempt(attemptId)
        if (!confirmed) owedCancels.add(attemptId)
        attempt.settle(confirmed ? 'confirmed' : 'unconfirmed')
        tell(null)
        if (run !== generation) throw stopped()
        // A sign-up the provider finished cannot be taken back: say only what is known.
        const after = creating ? ' The account may already have been created; you can try signing in with it.' : ' You can try again.'
        throw new WorldError('unavailable', confirmed
          ? `The sign-in did not finish, so it was cancelled.${after}`
          : `The sign-in did not finish, and the server has not yet confirmed it was cancelled. No account is used on this device until it does.${after}`)
      } finally {
        if (!sent) attempt.settle('none')
        if (current === attempt) current = null
      }
    })
  }

  return {
    available,
    async me(signal) {
      const run = generation
      const answer = await serial(async () => {
        if (!await settleOwed()) throw new WorldError('unavailable', UNSETTLED)
        return send('/world/account/me', {}, signal)
      })
      signal?.throwIfAborted()
      if (!answer.ok) throw refusal(answer)
      if (run !== generation) throw stopped()
      return answer.value === null ? null : userOf(answer.value)
    },
    async googleConfiguration(signal) {
      const answer = await send('/world/account/google-config', {}, signal)
      if (!answer.ok) throw refusal(answer)
      if (answer.value === null) return null
      if (!record(answer.value) || typeof answer.value.clientId !== 'string' || !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(answer.value.clientId)) throw new WorldError('unavailable', 'The account service returned an invalid reply. Try again.')
      return { clientId: answer.value.clientId }
    },
    signInGoogle: collect => credential('/world/account/google', '', '', collect),
    signIn: (email, password) => credential('/world/account/signin', email, password),
    signUp: (email, password) => credential('/world/account/signup', email, password),
    signOut() {
      generation++
      current?.stop.abort()
      return serial(async () => {
        const answer = await endSession()
        // Best effort: a cancel still owed is retried now too; the sign-out answer is what is reported.
        for (const id of [...owedCancels]) if (await cancelAttempt(id)) owedCancels.delete(id)
        tell(null)
        if (!answer || owedSignOut) return 'unreached'
        return answer.ok && record(answer.value) && answer.value.signedOut === true ? 'confirmed' : 'unconfirmed'
      })
    },
    abandon() {
      generation++
      const attempt = current
      if (!attempt) return Promise.resolve('none')
      attempt.stop.abort()
      return attempt.cancelled
    },
    settle: () => serial(settleOwed),
    unsettled: () => owedCancels.size > 0 || owedSignOut,
    async issuer(input, options) {
      const run = generation
      if (owedCancels.size > 0) throw new WorldError('unauthorized', UNSETTLED)
      const answer = await send('/world/account/grant', { challenge: input.challenge }, options.signal)
      options.signal.throwIfAborted()
      // Asked for before a sign-out, a cancel or another sign-in: the code is for nobody now.
      if (run !== generation || owedCancels.size > 0) throw stopped()
      if (answer.ok) return answer.value
      // The session is gone or refused for good. Busy or unreachable is not that: the world retries.
      if (answer.status === 401) { generation++; tell(null) }
      throw refusal(answer)
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
