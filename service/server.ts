// HTTP + WebSocket transport for the local world service (one process).
// The sharded form of the same service is service/cluster.ts.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { WORLD_PATH } from '../src/shared/protocol.ts'
import type { ClientFrame } from '../src/shared/protocol.ts'
import { createWorld } from './index.ts'
import { prepareVehicleRoads } from './vehicles.ts'
import type { Connection, World } from './kernel.ts'
import { BUILD, STEP_PHASES } from './kernel.ts'
import { LOCAL_ACTORS, actorForToken } from './identity.ts'
import { ensureMember } from './members.ts'
import { unsubscribeByToken } from './comeback.ts'
import { WorldError } from '../src/shared/model.ts'
import { Diagnostics, processTotals } from './diagnostics.ts'
import { filePersistence } from './persist.ts'
import { MOVEMENT, STEP_MS, configureMovement, roomCounts } from './rooms.ts'
import { DEFAULT_MAX_CONNECTIONS, IDLE_SWEEPS, IDLE_SWEEP_MS, LaterQueue, SocketLink, answerUnsubscribe, isLoopback, json, openSessionFrom, unsubscribePage } from './transport.ts'

export { filePersistence } from './persist.ts'

/** Honour an unsubscribe token for a caller at `address`. At most ten attempts a minute per address. */
export function unsubscribe(world: World, token: string, address: string): [status: number, result: { stopped: true; channel: string } | { error: string }] {
  try { world.limit(`unsubscribe:${address}`, 10, 60_000) } catch (error) {
    if (error instanceof WorldError) return [429, { error: 'Too many tries from this address. Wait a minute and try again.' }]
    throw error
  }
  const target = world.scoped(() => unsubscribeByToken(world, token))
  return target ? [200, { stopped: true, channel: target.channel }] : [400, { error: 'This unsubscribe link is not valid. Open the newest message and use its link, or turn the messages off in Settings.' }]
}

export interface WorldServerOptions {
  statePath: string
  /** Allow generated load-test members. Only ever set by service/standalone.ts from WORLD_LOAD_TEST=1. */
  loadTest?: boolean
  /** Refuse new sockets beyond this many. */
  maxConnections?: number
  /** Hold the answer to a state-changing operation until the change is on disk. */
  durableAcks?: boolean
  /** Written into the state file's provenance log. Learned from the HTTP server when not given. */
  port?: number
}
export interface WorldServer { world: World; handle(request: IncomingMessage, response: ServerResponse): boolean; attach(server: Server): void; stop(): void }

export function createWorldServer(options: WorldServerOptions): WorldServer {
  configureMovement()
  // Throws if another live process owns the state file: two writers on one file is how a world gets rolled back.
  const store = filePersistence(options.statePath, { port: options.port ?? null })
  const world = createWorld({ persistence: store, durableAcks: options.durableAcks })
  prepareVehicleRoads(world)
  const diagnostics = new Diagnostics('world')
  const counters = diagnostics.counters
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  const quiet = new Map<WebSocket, number>()
  const ticker = setInterval(() => { if (!world.superseded) world.tick() }, 1000)
  // Each room is sent out every STEP_MS, a tenth of the rooms at a time.
  const later = new LaterQueue(STEP_PHASES)
  let phase = 0
  const stepper = setInterval(() => { world.step(phase); later.flushDue(); phase = (phase + 1) % STEP_PHASES }, STEP_MS / STEP_PHASES)
  const sweeper = setInterval(() => {
    for (const [socket, sweeps] of quiet) {
      if (sweeps >= IDLE_SWEEPS) { counters.idleClosed++; socket.close(4002, 'idle') }
      else quiet.set(socket, sweeps + 1)
    }
  }, IDLE_SWEEP_MS)
  for (const timer of [ticker, stepper, sweeper]) timer.unref()
  let retired = false
  /**
   * Stop serving: no more frames are handled and every member is disconnected, so their App
   * reconnects — to the instance that replaced this one, when there is one. Without this a
   * member stays attached to a World that can no longer save, and everything they do is lost.
   */
  function retire(code: number, reason: string): void {
    if (retired) return
    retired = true
    for (const timer of [ticker, stepper, sweeper]) clearInterval(timer)
    for (const socket of sockets.clients) socket.close(code, reason)
  }
  world.onSuperseded(() => { retire(4009, 'superseded'); console.error('[world] this service instance was replaced by a newer one and has stopped.') })

  sockets.on('connection', (socket: WebSocket) => {
    let connection: Connection | null = null
    quiet.set(socket, 0)
    const link = new SocketLink(socket, counters, later, () => socket.close(4008, 'too slow'))
    const helloTimer = setTimeout(() => { if (!connection) socket.close(4001, 'hello required') }, 8000)
    socket.on('message', data => {
      if (retired) return
      quiet.set(socket, 0)
      let frame: ClientFrame
      const text = String(data)
      counters.framesIn++; counters.bytesIn += text.length
      try { frame = JSON.parse(text) as ClientFrame } catch { return }
      if (frame.t === 'hello') {
        const actor = typeof frame.token === 'string' ? actorForToken(frame.token) : null
        if (!actor) { link.send({ t: 'denied', code: 'unauthorized', message: 'This session is no longer valid. Sign in again.' }); socket.close(4003, 'unauthorized'); return }
        world.scoped(() => ensureMember(world, actor.memberId, actor.name, { reviewer: actor.reviewer }))
        link.batch = Array.isArray(frame.caps) && frame.caps.includes('batch')
        connection = world.connect(actor.memberId, out => link.send(out), () => socket.close(4000, 'replaced'), link)
        return
      }
      if (connection) world.receive(connection, frame)
    })
    socket.on('close', () => { clearTimeout(helloTimer); quiet.delete(socket); if (connection) world.disconnect(connection) })
    socket.on('error', () => socket.close())
  })

  return {
    world,
    handle(request, response) {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(WORLD_PATH) || retired) return false
      if (!isLoopback(request)) { json(response, 403, { error: 'The local world service only answers this machine.' }); return true }
      if (url.pathname === `${WORLD_PATH}/health`) {
        // Diagnostics are for the load harness. Like everything on this server they only answer loopback.
        const wanted = url.searchParams.has('diagnostics')
        json(response, 200, {
          ok: true, build: BUILD, mode: 'local', operations: world.registered().length,
          ...(wanted ? {
            diagnostics: {
              loadTest: options.loadTest === true, connections: world.online(), sockets: sockets.clients.size, maxConnections, process: processTotals(),
              threads: [diagnostics.read(url.searchParams.get('diagnostics') !== 'peek')],
              extra: { ...world.stats(), rooms: roomCounts(world), movement: { stepMs: STEP_MS, ...MOVEMENT } },
            },
          } : {}),
        })
        return true
      }
      if (url.pathname === `${WORLD_PATH}/local-actors` && request.method === 'GET') {
        json(response, 200, { actors: LOCAL_ACTORS.map(({ key, name, reviewer }) => ({ key, name, reviewer })) })
        return true
      }
      if (url.pathname === `${WORLD_PATH}/local-session` && request.method === 'POST') {
        openSessionFrom(request, options.loadTest === true, session => {
          if (!session) { json(response, 400, { error: 'Unknown local test member.' }); return }
          world.scoped(() => ensureMember(world, session.actor.memberId, session.actor.name, { reviewer: session.actor.reviewer }))
          json(response, 200, { token: session.token, memberId: session.actor.memberId, name: session.actor.name })
        })
        return true
      }
      if (url.pathname === `${WORLD_PATH}/comeback/unsubscribe`) {
        // The link in a come-back message. No session: the token is the proof. GET only shows the
        // page; POST unsubscribes (RFC 8058 one-click, or the button on the page).
        const token = (url.searchParams.get('token') ?? '').slice(0, 600)
        if (request.method === 'GET') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          response.end(unsubscribePage(token))
          return true
        }
        if (request.method !== 'POST') { json(response, 405, { error: 'Use POST to unsubscribe.' }); return true }
        request.resume()
        answerUnsubscribe(request, response, token, ...unsubscribe(world, token, request.socket.remoteAddress ?? 'unknown'))
        return true
      }
      json(response, 404, { error: 'Not found' })
      return true
    },
    attach(server) {
      const learnPort = (): void => { const address = server.address(); if (address && typeof address === 'object') store.setPort(address.port) }
      if (server.listening) learnPort(); else server.once('listening', learnPort)
      server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        // A retired instance leaves the request alone: the instance that replaced it answers.
        if (url.pathname !== `${WORLD_PATH}/socket` || retired) return
        if (!isLoopback(request)) { socket.destroy(); return }
        if (sockets.clients.size >= maxConnections) {
          // Full: say so and let the client retry, rather than let everyone already connected slow down.
          counters.refused++
          socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n')
          return
        }
        sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request))
      })
    },
    stop() {
      // Order matters: stop taking frames, write everything, release the file, then let members go.
      const wasServing = !retired
      retired = true
      for (const timer of [ticker, stepper, sweeper]) clearInterval(timer)
      world.close()
      if (wasServing) for (const socket of sockets.clients) socket.close(1012, 'service restarting')
      sockets.close()
      diagnostics.stop()
    },
  }
}
