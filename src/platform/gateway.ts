// Client side of the world-service contract: typed calls, pushed events and reconnection.
import { WorldError } from '../shared/model.ts'
import type { ErrorCode } from '../shared/model.ts'
import { ERROR_CODES } from '../shared/model.ts'
import { WORLD_PATH } from '../shared/protocol.ts'
import type { ClientFrame, OpName, Ops, ServerEvent, ServerFrame } from '../shared/protocol.ts'
import type { MemberId } from '../shared/ids.ts'
import { UpdateRequiredError, openHostedWorldSession, renewHostedWorld } from './hostedService.ts'
import type { HostedWorldConfig, IdentityIssuer } from './hostedService.ts'
import { openGuest } from './guestService.ts'
import { worldSocketUrl } from './worldEndpoint.ts'
import { monotonicNow, serverRelativeLifetime } from './sessionTiming.ts'

/** 'update-required': the service runs a newer build of this App. The link has stopped trying; only a reload the member chooses brings it back. */
export type LinkState = 'connecting' | 'online' | 'reconnecting' | 'offline' | 'denied' | 'replaced' | 'update-required'

export interface Gateway {
  readonly kind: 'local-service' | 'hosted-service' | 'guest-service'
  readonly memberId: MemberId | null
  call<K extends OpName>(op: K, input: Ops[K]['in']): Promise<Ops[K]['out']>
  onEvent(listener: (event: ServerEvent) => void): () => void
  /** Fired with the new state, and again with 'online' after every successful reconnect. */
  onState(listener: (state: LinkState, detail: string) => void): () => void
  close(): void
}

const asCode = (code: string): ErrorCode => ((ERROR_CODES as readonly string[]).includes(code) ? (code as ErrorCode) : 'unavailable')
const CALL_TIMEOUT_MS = 12_000

export interface LocalActorInfo { key: string; name: string; reviewer: boolean }

export async function listLocalActors(): Promise<LocalActorInfo[]> {
  const response = await fetch(`${WORLD_PATH}/local-actors`, { signal: AbortSignal.timeout(6000) })
  if (!response.ok) throw new Error(`The local world service answered ${response.status}`)
  return ((await response.json()) as { actors: LocalActorInfo[] }).actors
}

/** Connects to the local world service as one local test member. */
export function connectLocalService(actorKey: string): Gateway {
  return connectService('local-service', async signal => {
    const response = await fetch(`${WORLD_PATH}/local-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: actorKey }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
    })
    if (!response.ok) throw new WorldError(response.status === 400 ? 'unauthorized' : 'unavailable', 'The local world service refused the session.')
    const { token } = (await response.json()) as { token: string }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    return { token, socketUrl: `${scheme}://${location.host}${WORLD_PATH}/socket`, clientDeadline: null }
  })
}

export function connectHostedService(config: HostedWorldConfig, identity: { userId: string; accountId: string }, issue: IdentityIssuer): Gateway {
  return connectService('hosted-service', signal => openHostedWorldSession(config, identity, issue, signal), (challenge, signal) => renewHostedWorld(config, challenge, issue, signal))
}

export function connectGuestService(config: HostedWorldConfig, token: string): Gateway {
  return connectService('guest-service', async signal => {
    await openGuest(config, { token }, signal)
    return { token, socketUrl: worldSocketUrl(config), clientDeadline: null }
  })
}

/**
 * `clientDeadline` is a reading of this page's monotonic clock (`performance.now()`) by which the token
 * must be used, or null for a socket with no lease (local and guest sockets). Never a server epoch.
 */
function connectService(kind: Gateway['kind'], authorize: (signal: AbortSignal) => Promise<{ token: string; socketUrl: string; clientDeadline: number | null }>, renew?: (challenge: string, signal: AbortSignal) => Promise<string>): Gateway {
  const controller = new AbortController()
  const eventListeners = new Set<(event: ServerEvent) => void>()
  const stateListeners = new Set<(state: LinkState, detail: string) => void>()
  const pending = new Map<number, { resolve(data: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  let socket: WebSocket | null = null
  let releaseSocketTimers: (() => void) | null = null
  let memberId: MemberId | null = null
  let nextId = 1
  let attempts = 0
  let closed = false
  let ready: Promise<void> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  /**
   * The current socket's local deadline on this page's monotonic clock, or null for a lease-free
   * socket. Checked before anything is sent, not only by timers: a throttled background tab may run
   * a timer late, but it never sends past the deadline.
   */
  let leaseDeadline: number | null = null
  /** Past the deadline: the socket is closed as expired (the gateway reconnects with a new token). */
  const leaseExpired = (): boolean => {
    if (leaseDeadline === null || leaseDeadline > monotonicNow()) return false
    socket?.close(4001, 'session expired')
    return true
  }

  const setState = (state: LinkState, detail = ''): void => { for (const listener of stateListeners) listener(state, detail) }
  const failPending = (message: string): void => {
    for (const [id, call] of pending) { clearTimeout(call.timer); call.reject(new WorldError('unavailable', message)); pending.delete(id) }
  }

  const open = (): Promise<void> => {
    ready = (async () => {
      setState(attempts === 0 ? 'connecting' : 'reconnecting')
      const session = await authorize(controller.signal)
      controller.signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(session.socketUrl)
        const helloTimer = setTimeout(() => { reject(new WorldError('unavailable', 'The world service did not answer.')); ws.close() }, 10_000)
        // All times here are this page's monotonic clock. Until the initial lease arrives the token's own
        // deadline applies; each lease then counts from when this page asked for it: the moment hello was
        // sent, or the moment renew-begin was sent. Those anchors are taken before sending and never moved.
        let deadline = session.clientDeadline
        leaseDeadline = deadline
        let expiryTimer: ReturnType<typeof setTimeout> | null = null
        let renewTimer: ReturnType<typeof setTimeout> | null = null
        /**
         * Where a leased socket is. A lease frame is accepted only in `awaiting-initial` (exactly once,
         * after hello) or `renew-sent` (after this renewal's code went out). Lease-free sockets stay `free`.
         */
        let phase: 'free' | 'before-hello' | 'awaiting-initial' | 'leased' | 'renew-begun' | 'challenged' | 'renew-sent' = deadline === null ? 'free' : 'before-hello'
        /** The monotonic moment the lease now owed was asked for (hello or renew-begin sent). */
        let anchor = 0
        /** The last accepted lease's raw server expiry. Compared only with the next one, never with this page's clock. */
        let lastExpiry: number | null = null
        const expired = (): boolean => deadline !== null && deadline <= monotonicNow()
        const socketLifetime = new AbortController()
        function armLease(until: number): void {
          if (expiryTimer) clearTimeout(expiryTimer)
          if (renewTimer) clearTimeout(renewTimer)
          deadline = until; leaseDeadline = until
          expiryTimer = setTimeout(() => ws.close(4001, 'session expired'), Math.max(0, until - monotonicNow()))
          if (renew) renewTimer = setTimeout(() => {
            if (closed || socket !== ws || ws.readyState !== WebSocket.OPEN || phase !== 'leased') return
            if (expired()) { ws.close(4001, 'session expired'); return }
            anchor = monotonicNow(); phase = 'renew-begun'
            ws.send(JSON.stringify({ t: 'renew-begin' }))
          }, Math.max(0, until - monotonicNow() - 15_000))
        }
        if (deadline !== null) armLease(deadline)
        releaseSocketTimers = () => { clearTimeout(helloTimer); if (expiryTimer) clearTimeout(expiryTimer); if (renewTimer) clearTimeout(renewTimer); socketLifetime.abort() }
        socket = ws
        let welcomed = false
        // 'batch': movement comes as one frame per room step instead of one event per avatar — about a third of the data.
        ws.onopen = () => {
          // A token whose local deadline has passed is not presented; the gateway asks for a new one.
          if (expired()) { ws.close(4001, 'session expired'); return }
          if (phase === 'before-hello') { anchor = monotonicNow(); phase = 'awaiting-initial' }
          ws.send(JSON.stringify({ t: 'hello', token: session.token, resume: null, caps: ['batch'] } satisfies ClientFrame))
        }
        ws.onmessage = message => {
          if (closed || socket !== ws) return
          // Every inbound frame: a throttled tab may deliver it after the deadline its timer missed.
          if (expired()) { ws.close(4001, 'session expired'); return }
          let raw: unknown
          try { raw = JSON.parse(String(message.data)) } catch { return }
          if (raw && typeof raw === 'object' && 't' in raw) {
            if (raw.t === 'lease') {
              // Exactly one initial lease after hello, and one renewal lease only after that renewal's code
              // was sent; a renewal must move the server's own expiry forward. Each counts from its anchor.
              // Anything else (unsolicited, duplicate, invalid, already used up) ends the socket with no extension.
              const lease = raw as Record<string, unknown>
              const lifetime = serverRelativeLifetime(lease)
              const expiry = lease.expiresAt
              const solicited = phase === 'awaiting-initial' || (phase === 'renew-sent' && lastExpiry !== null && typeof expiry === 'number' && expiry > lastExpiry)
              if (!renew || !solicited || lifetime === null || typeof expiry !== 'number' || anchor + lifetime <= monotonicNow()) { ws.close(); return }
              lastExpiry = expiry; phase = 'leased'; armLease(anchor + lifetime); return
            }
            if (raw.t === 'renew-challenge') {
              if (!renew || phase !== 'renew-begun' || !('challenge' in raw) || typeof raw.challenge !== 'string'
                || !('challengeId' in raw) || typeof raw.challengeId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.challengeId)) { ws.close(); return }
              const challengeId = raw.challengeId
              phase = 'challenged'
              void renew(raw.challenge, AbortSignal.any([controller.signal, socketLifetime.signal])).then(code => {
                if (closed || socket !== ws || ws.readyState !== WebSocket.OPEN || phase !== 'challenged') return
                if (expired()) { ws.close(4001, 'session expired'); return }
                ws.send(JSON.stringify({ t: 'renew', challengeId, code }))
                phase = 'renew-sent'
              }).catch(() => { if (phase === 'challenged') phase = 'leased' /* The original deadline still applies; no unverified extension. */ })
              return
            }
          }
          if (!raw || typeof raw !== 'object' || !('t' in raw)) return
          const frame = raw as ServerFrame
          if (frame.t === 'welcome') { if (closed) return; clearTimeout(helloTimer); welcomed = true; memberId = frame.memberId; attempts = 0; resolve(); setState('online'); return }
          if (frame.t === 'denied') { closed = true; setState('denied', frame.message); reject(new WorldError('unauthorized', frame.message)); ws.close(); return }
          if (frame.t === 'batch') {
            for (const event of frame.events) for (const listener of eventListeners) listener(event)
            for (const [member, x, z, heading, moving] of frame.m) {
              const move: ServerEvent = { type: 'presence.move', room: frame.room, memberId: member, pos: { x, z }, heading, moving: moving === 1 }
              for (const listener of eventListeners) listener(move)
            }
            return
          }
          if (frame.t === 'event') {
            if (frame.event.type === 'session.replaced') { closed = true; setState('replaced', 'This member was opened in another tab.') }
            for (const listener of eventListeners) listener(frame.event)
            return
          }
          if (frame.t === 'res') {
            const call = pending.get(frame.id)
            if (!call) return
            pending.delete(frame.id)
            clearTimeout(call.timer)
            if (frame.ok) call.resolve(frame.data)
            else call.reject(new WorldError(asCode(frame.code), frame.message))
          }
        }
        ws.onclose = () => {
          clearTimeout(helloTimer)
          if (expiryTimer) clearTimeout(expiryTimer)
          if (renewTimer) clearTimeout(renewTimer)
          socketLifetime.abort()
          if (socket !== ws) return
          leaseDeadline = null
          if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
          failPending('The connection dropped before the service answered.')
          if (!welcomed) reject(new WorldError('unavailable', 'Could not reach the world service.'))
          if (closed) return
          scheduleReconnect()
        }
        ws.onerror = () => ws.close()
      })
      if (closed) return
      heartbeat = setInterval(() => { if (socket?.readyState === WebSocket.OPEN && !leaseExpired()) socket.send(JSON.stringify({ t: 'ping' } satisfies ClientFrame)) }, 20_000)
    })()
    ready.catch(error => {
      if (closed) return
      if (error instanceof WorldError && error.code === 'unauthorized') { closed = true; setState('denied', error.message); return }
      // An out-of-date page gets the same answer however often it asks. The session it holds is left as it is.
      if (error instanceof UpdateRequiredError) { closed = true; setState('update-required', error.message); return }
      scheduleReconnect()
    })
    return ready
  }

  const scheduleReconnect = (): void => {
    if (closed || retry) return
    attempts++
    setState(attempts > 4 ? 'offline' : 'reconnecting', 'Trying again…')
    const wait = Math.min(10_000, 600 * 2 ** Math.min(attempts, 4))
    retry = setTimeout(() => { retry = null; void open().catch(() => undefined) }, wait)
  }

  void open().catch(() => undefined)

  return {
    kind,
    get memberId() { return memberId },
    async call<K extends OpName>(op: K, input: Ops[K]['in']): Promise<Ops[K]['out']> {
      try { await ready } catch (error) {
        // Nothing retries after this one, so the caller is told what it is.
        if (error instanceof UpdateRequiredError) throw error
        throw new WorldError('unavailable', 'The world service is not connected. It will retry on its own.')
      }
      const ws = socket
      if (closed || !ws || ws.readyState !== WebSocket.OPEN) throw new WorldError('unavailable', 'The world service is not connected. It will retry on its own.')
      // Nothing is sent on a session whose local deadline has passed, however late a throttled timer runs.
      if (leaseExpired()) throw new WorldError('unavailable', 'The world session expired. It is reconnecting on its own.')
      const id = nextId++
      return new Promise<Ops[K]['out']>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new WorldError('unavailable', 'The world service took too long to answer.')) }, CALL_TIMEOUT_MS)
        pending.set(id, { resolve: data => resolve(data as Ops[K]['out']), reject, timer })
        ws.send(JSON.stringify({ t: 'req', id, op, input } satisfies ClientFrame))
      })
    },
    onEvent(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener) },
    onState(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener) },
    close() {
      closed = true
      controller.abort()
      if (retry) clearTimeout(retry)
      if (heartbeat) clearInterval(heartbeat)
      failPending('The session was closed.')
      releaseSocketTimers?.()
      if (kind !== 'local-service' && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'logout' }))
      socket?.close()
      eventListeners.clear()
      stateListeners.clear()
    },
  }
}
