// Edge of the sharded service: owns WebSockets and nothing else.
//
// An edge checks the session at hello, then relays. Movement, chat and voice frames go straight
// to the shard that holds the member's room; every other frame goes to the state thread. What
// comes back is written to the socket: answers and events as they arrive, movement as one write
// per member per step. An edge keeps no world state, so there can be as many as are needed.
import { createServer } from 'node:http'
import { parentPort, workerData } from 'node:worker_threads'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { MemberId } from '../src/shared/ids.ts'
import { WORLD_PATH } from '../src/shared/protocol.ts'
import type { ClientCapability, ServerEvent } from '../src/shared/protocol.ts'
import { HOT_OPS, Outbox, opOf } from './cluster-wire.ts'
import type { EdgeToShard, EdgeToState, ShardToEdge, StateToEdge, WorkerPorts } from './cluster-wire.ts'
import { Diagnostics } from './diagnostics.ts'
import { LOCAL_ACTORS, actorForToken } from './identity.ts'
import { BUILD, STEP_PHASES } from './kernel.ts'
import type { Moved, MovementStep } from './kernel.ts'
import { IDLE_SWEEPS, IDLE_SWEEP_MS, LaterQueue, SOFT_LIMIT_BYTES, SocketLink, answerUnsubscribe, isLoopback, json, openSessionFrom, unsubscribePage } from './transport.ts'

const STEP_MS = 100
const setup = workerData as WorkerPorts
const diagnostics = new Diagnostics(`edge-${setup.index}`)
const counters = diagnostics.counters
const toState = new Outbox<EdgeToState>(setup.state!)
const toShard = setup.shards!.map(port => new Outbox<EdgeToShard>(port))

interface Conn { socket: WebSocket; link: SocketLink; said: boolean; shard: number; quiet: number; held: boolean }
const conns = new Map<number, Conn>()
const held = new Set<number>()
let nextConn = 1
const later = new LaterQueue(STEP_PHASES)
const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })

sockets.on('connection', (socket: WebSocket) => {
  const id = nextConn++
  const conn: Conn = { socket, link: new SocketLink(socket, counters, later, () => socket.close(4008, 'too slow')), said: false, shard: -1, quiet: 0, held: false }
  conns.set(id, conn)
  const helloTimer = setTimeout(() => { if (!conn.said) socket.close(4001, 'hello required') }, 8000)
  socket.on('message', data => {
    conn.quiet = 0
    const text = String(data)
    counters.framesIn++; counters.bytesIn += text.length
    if (!conn.said) {
      let frame: { t?: unknown; token?: unknown; caps?: unknown }
      try { frame = JSON.parse(text) as typeof frame } catch { return }
      if (frame.t !== 'hello') return
      const actor = typeof frame.token === 'string' ? actorForToken(frame.token) : null
      if (!actor) { conn.link.send({ t: 'denied', code: 'unauthorized', message: 'This session is no longer valid. Sign in again.' }); socket.close(4003, 'unauthorized'); return }
      conn.said = true
      conn.link.batch = Array.isArray(frame.caps) && (frame.caps as ClientCapability[]).includes('batch')
      toState.push(['hello', id, actor.memberId, actor.name, actor.reviewer, conn.link.batch])
      return
    }
    const op = opOf(text)
    if (op === null) return
    if (op === 'ping') { conn.link.sendText('{"t":"pong"}'); return }
    if (conn.shard >= 0 && HOT_OPS.has(op)) toShard[conn.shard]!.push(['f', id, text])
    else toState.push(['frame', id, text])
  })
  socket.on('close', () => { clearTimeout(helloTimer); conns.delete(id); held.delete(id); if (conn.said) toState.push(['bye', id]) })
  socket.on('error', () => socket.close())
})

setup.state!.on('message', (items: StateToEdge[]) => {
  for (const item of items) {
    if (item[0] === 'unsubscribed') { waitingUnsubscribes.get(item[1])?.(item[2], item[3]); waitingUnsubscribes.delete(item[1]); continue }
    const conn = conns.get(item[1])
    if (!conn) continue
    if (item[0] === 'send') conn.link.sendText(item[2])
    else if (item[0] === 'route') { conn.shard = item[2]; conn.held = false; held.delete(item[1]) }
    else conn.socket.close(item[2], item[3])
  }
})

setup.shards!.forEach((port, shard) => {
  port.on('message', (items: ShardToEdge[]) => {
    for (const item of items) {
      if (item[0] === 'send') { conns.get(item[1])?.link.sendText(item[2]); continue }
      if (item[0] === 'later') { conns.get(item[1])?.link.sendLater(item[2]); continue }
      const [, room, ids, nums, to, events] = item
      const moved: Moved[] = ids.map((memberId: MemberId, index) => ({ memberId, x: nums[index * 4]!, z: nums[index * 4 + 1]!, heading: nums[index * 4 + 2]!, moving: nums[index * 4 + 3] === 1 }))
      const step: MovementStep = { room, moved, memo: {} }
      const eventsFor = events.length > 0 ? new Map<number, ServerEvent[]>(events) : null
      for (let at = 0; at < to.length;) {
        const id = to[at++]!, count = to[at++]!
        const conn = conns.get(id)
        if (conn) {
          const indices: number[] = []
          for (let index = 0; index < count; index++) indices.push(to[at + index]!)
          conn.link.sendStep(step, indices, eventsFor?.get(id) ?? [])
          // A socket that is not draining is reported, and the shard stops sending it movement.
          if (!conn.held && conn.link.congested()) { conn.held = true; held.add(id); toShard[shard]!.push(['congested', id, true]) }
        }
        at += count
      }
    }
  })
})

let phase = 0
const stepper = setInterval(() => {
  later.flushDue()
  if (++phase % STEP_PHASES !== 0) return
  // Once a step: has any held socket drained?
  for (const id of held) {
    const conn = conns.get(id)
    if (!conn) { held.delete(id); continue }
    if (conn.link.pending() > SOFT_LIMIT_BYTES / 2) continue
    conn.held = false
    held.delete(id)
    if (conn.shard >= 0) toShard[conn.shard]!.push(['congested', id, false])
  }
}, STEP_MS / STEP_PHASES)

const sweeper = setInterval(() => {
  for (const conn of conns.values()) {
    if (conn.quiet >= IDLE_SWEEPS) { counters.idleClosed++; conn.socket.close(4002, 'idle') }
    else conn.quiet++
  }
}, IDLE_SWEEP_MS)

// ── HTTP: health and local sessions ──
const waitingUnsubscribes = new Map<number, (status: number, result: string) => void>()
let nextUnsubscribe = 1
const waitingDiagnostics = new Map<number, (diagnostics: unknown) => void>()
let nextDiagnostics = 1
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith(WORLD_PATH)) { response.writeHead(404); response.end(); return }
  if (!isLoopback(request)) { json(response, 403, { error: 'The local world service only answers this machine.' }); return }
  if (url.pathname === `${WORLD_PATH}/health`) {
    const body = { ok: true, build: BUILD, mode: 'local-sharded' }
    if (!url.searchParams.has('diagnostics')) { json(response, 200, body); return }
    const id = nextDiagnostics++
    waitingDiagnostics.set(id, result => json(response, 200, { ...body, diagnostics: result }))
    parentPort!.postMessage({ kind: 'diag', id, reset: url.searchParams.get('diagnostics') !== 'peek' })
    return
  }
  if (url.pathname === `${WORLD_PATH}/local-actors` && request.method === 'GET') {
    json(response, 200, { actors: LOCAL_ACTORS.map(({ key, name, reviewer }) => ({ key, name, reviewer })) })
    return
  }
  if (url.pathname === `${WORLD_PATH}/local-session` && request.method === 'POST') {
    // The member record is created on the state thread when the socket says hello.
    openSessionFrom(request, setup.loadTest, session => {
      if (!session) { json(response, 400, { error: 'Unknown local test member.' }); return }
      json(response, 200, { token: session.token, memberId: session.actor.memberId, name: session.actor.name })
    })
    return
  }
  if (url.pathname === `${WORLD_PATH}/comeback/unsubscribe`) {
    const token = (url.searchParams.get('token') ?? '').slice(0, 600)
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(unsubscribePage(token))
      return
    }
    if (request.method !== 'POST') { json(response, 405, { error: 'Use POST to unsubscribe.' }); return }
    request.resume()
    const id = nextUnsubscribe++
    waitingUnsubscribes.set(id, (status, result) => answerUnsubscribe(request, response, token, status, JSON.parse(result) as { stopped: true; channel: string } | { error: string }))
    toState.push(['unsubscribe', id, token, request.socket.remoteAddress ?? 'unknown'])
    return
  }
  json(response, 404, { error: 'Not found' })
})
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (url.pathname !== `${WORLD_PATH}/socket` || !isLoopback(request)) { socket.destroy(); return }
  if (sockets.clients.size >= setup.maxConnections) {
    counters.refused++
    socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n')
    return
  }
  sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request))
})

parentPort!.on('message', (message: { kind: string; id?: number; reset?: boolean; diagnostics?: unknown }) => {
  if (message.kind === 'diag?') {
    parentPort!.postMessage({ kind: 'diag!', id: message.id, sample: diagnostics.read(message.reset !== false), sockets: sockets.clients.size, extra: { held: held.size } })
  } else if (message.kind === 'diag.result') {
    waitingDiagnostics.get(message.id!)?.(message.diagnostics)
    waitingDiagnostics.delete(message.id!)
  } else if (message.kind === 'stop') {
    clearInterval(stepper)
    clearInterval(sweeper)
    server.close()
    parentPort!.postMessage({ kind: 'stopped' })
  }
})
server.listen(setup.port, '127.0.0.1', () => parentPort!.postMessage({ kind: 'ready' }))
