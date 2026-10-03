// What sits between the kernel and one WebSocket: frame encoding, one write per room step,
// and backpressure. Used by the single-process server and by each edge of the sharded service.
//
// Outgoing frames are encoded here and written straight to the TCP socket. A server-to-client
// WebSocket text frame is a short header followed by the UTF-8 text, with no masking, so the same
// bytes can be reused for every recipient of the same event.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { WebSocket } from 'ws'
import type { ServerEvent, ServerFrame } from '../src/shared/protocol.ts'
import type { Counters } from './diagnostics.ts'
import { openLoadSession, openLocalSession } from './identity.ts'
import type { LocalActor } from './identity.ts'
import type { Link, MovementStep } from './kernel.ts'

/** The App pings every 20 s. A socket silent for five sweeps (75 s) is closed and its member leaves the room. */
export const IDLE_SWEEP_MS = 15_000
export const IDLE_SWEEPS = 5
/**
 * New sockets are refused beyond this many per process (or per edge), so the members already
 * connected keep a working service. One process was measured healthy at 5,000 busy members and
 * saturated near 6,500 (docs/SCALE.md); WORLD_MAX_CONNECTIONS changes it.
 */
export const DEFAULT_MAX_CONNECTIONS = 6000

export const isLoopback = (request: IncomingMessage): boolean => {
  const address = request.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** The page a mail link opens. Opening it changes nothing: mail scanners fetch links, so only the button (a POST) unsubscribes. */
export function unsubscribePage(token: string, done: { channel: string } | null = null, problem: string | null = null): string {
  const body = done
    ? `<h1>You are unsubscribed</h1><p>We will not send you ${done.channel === 'email' ? 'emails' : `${done.channel} messages`} about what you missed. You can turn them back on in Settings.</p>`
    : problem
      ? `<h1>That link did not work</h1><p>${problem}</p>`
      : `<h1>Stop these messages?</h1><p>Press the button to stop messages about what you missed on this channel.</p><form method="post" action="?token=${encodeURIComponent(token)}"><button type="submit">Unsubscribe</button></form>`
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Unsubscribe</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:15vh auto;padding:0 1.25rem;color:#1c2321}h1{font-size:1.4rem}button{font:inherit;padding:.6rem 1.1rem;border:0;border-radius:.5rem;background:#1c2321;color:#fff;cursor:pointer}</style>${body}</html>`
}

/** Send the outcome of an unsubscribe request as a page to a browser, as JSON to anything else. */
export function answerUnsubscribe(request: IncomingMessage, response: ServerResponse, token: string, status: number, result: { stopped: true; channel: string } | { error: string }): void {
  if (!(request.headers.accept ?? '').includes('text/html')) { json(response, status, result); return }
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end('stopped' in result ? unsubscribePage(token, { channel: result.channel }) : unsubscribePage(token, null, result.error))
}

/** Read the actor key from a local-session request and open the session. */
export function openSessionFrom(request: IncomingMessage, loadTest: boolean, done: (session: { token: string; actor: LocalActor } | null) => void): void {
  let body = ''
  request.on('data', chunk => { body += chunk; if (body.length > 2048) request.destroy() })
  request.on('end', () => {
    let key = ''
    try { key = String((JSON.parse(body) as { actor?: unknown }).actor ?? '') } catch { /* fall through */ }
    // Generated load-test members exist only when the service was started for a load test, and only
    // for a request that reached this machine directly (never one relayed by a proxy).
    const direct = isLoopback(request) && !request.headers['x-forwarded-for'] && !request.headers.forwarded
    done(openLocalSession(key) ?? openLoadSession(key, { enabled: loadTest, loopback: direct }))
  })
}

/** Above this many unsent bytes a socket is "not keeping up": it gets no movement until it drains. */
export const SOFT_LIMIT_BYTES = 256 * 1024
/** Above this the member is disconnected: chat and answers are never dropped, so the queue cannot be allowed to grow without end. */
export const HARD_LIMIT_BYTES = 8 * 1024 * 1024

/** Encode one unmasked WebSocket text frame. */
export function textFrame(text: string): Buffer {
  const length = Buffer.byteLength(text)
  const header = length < 126 ? 2 : length < 65_536 ? 4 : 10
  const frame = Buffer.allocUnsafe(header + length)
  frame[0] = 0x81
  if (header === 2) frame[1] = length
  else if (header === 4) { frame[1] = 126; frame.writeUInt16BE(length, 2) }
  else { frame[1] = 127; frame.writeUInt32BE(0, 2); frame.writeUInt32BE(length, 6) }
  frame.write(text, header, 'utf8')
  return frame
}

const centimetres = (value: number): number => Math.round(value * 100) / 100
const milliradians = (value: number): number => Math.round(value * 1000) / 1000

interface StepMemo {
  room?: string
  /** Per moved avatar: the whole `presence.move` event frame, ready to write. */
  frames?: (Buffer | undefined)[]
  /** Per moved avatar: `["memberId",x,z,heading,moving]` for a batched frame. */
  tuples?: (string | undefined)[]
}

/** The `presence.move` event for one moved avatar, as a ready-to-write frame. Built once per step, shared by every recipient. */
export function moveFrame(step: MovementStep, index: number): Buffer {
  const memo = step.memo as StepMemo
  const frames = (memo.frames ??= [])
  let frame = frames[index]
  if (!frame) {
    const moved = step.moved[index]!
    memo.room ??= JSON.stringify(step.room)
    frame = textFrame(`{"t":"event","event":{"type":"presence.move","room":${memo.room},"memberId":${JSON.stringify(moved.memberId)},"pos":{"x":${centimetres(moved.x)},"z":${centimetres(moved.z)}},"heading":${milliradians(moved.heading)},"moving":${moved.moving}}}`)
    frames[index] = frame
  }
  return frame
}

/** The compact form of one moved avatar for a batched frame. Built once per step. */
export function moveTuple(step: MovementStep, index: number): string {
  const memo = step.memo as StepMemo
  const tuples = (memo.tuples ??= [])
  let tuple = tuples[index]
  if (!tuple) {
    const moved = step.moved[index]!
    tuple = `[${JSON.stringify(moved.memberId)},${centimetres(moved.x)},${centimetres(moved.z)},${milliradians(moved.heading)},${moved.moving ? 1 : 0}]`
    tuples[index] = tuple
  }
  return tuple
}

/** One batched frame: everything a member needs from one room step. */
export function batchText(step: MovementStep, indices: number[], events: ServerEvent[]): string {
  const memo = step.memo as StepMemo
  memo.room ??= JSON.stringify(step.room)
  let tuples = ''
  for (let i = 0; i < indices.length; i++) tuples += (i ? ',' : '') + moveTuple(step, indices[i]!)
  return `{"t":"batch","room":${memo.room},"m":[${tuples}],"events":${events.length ? JSON.stringify(events) : '[]'}}`
}

/**
 * Answers that may wait for the member's next room step (movement acknowledgements). A link
 * with one waiting is given a deadline one step away; if no room step has carried the answer by
 * then, `flushDue` writes it on its own. So such an answer is never later than one step.
 */
export class LaterQueue {
  private readonly ring: SocketLink[][]
  private readonly span: number
  private now = 0
  constructor(span: number) { this.span = span; this.ring = Array.from({ length: span + 1 }, () => []) }
  due(link: SocketLink): number { this.ring[(this.now + this.span) % this.ring.length]!.push(link); return this.now }
  /** Call once per phase, after the rooms in that phase were stepped. */
  flushDue(): void {
    this.now++
    const slot = this.ring[this.now % this.ring.length]!
    for (const link of slot) link.flushLater(this.now - this.span)
    slot.length = 0
  }
}

export class SocketLink implements Link {
  /** The member's client understands batched frames (hello caps: ["batch"]). */
  batch = false
  private readonly socket: WebSocket
  private readonly raw: Socket
  private readonly counters: Counters
  private readonly onOverflow: () => void
  private readonly later: LaterQueue
  private waiting: Buffer[] = []
  private waitingSince = 0

  constructor(socket: WebSocket, counters: Counters, later: LaterQueue, onOverflow: () => void) {
    this.socket = socket
    this.raw = (socket as unknown as { _socket: Socket })._socket
    this.counters = counters
    this.later = later
    this.onOverflow = onOverflow
  }

  sendLater(text: string): void {
    if (this.waiting.length === 0) this.waitingSince = this.later.due(this)
    this.waiting.push(textFrame(text))
  }

  /** Write waiting answers if the oldest has waited since `since` or longer. */
  flushLater(since: number): void {
    if (this.waiting.length === 0 || this.waitingSince > since) return
    const parts = this.waiting
    this.waiting = []
    this.write(parts.length === 1 ? parts[0]! : Buffer.concat(parts), parts.length)
  }

  private write(bytes: Buffer, frames: number): void {
    if (this.socket.readyState !== this.socket.OPEN) return
    if (this.raw.writableLength > HARD_LIMIT_BYTES) { this.onOverflow(); return }
    this.counters.framesOut += frames
    this.counters.writes++
    this.counters.bytesOut += bytes.length
    this.raw.write(bytes)
  }

  send(frame: ServerFrame): void { this.write(textFrame(JSON.stringify(frame)), 1) }
  sendText(text: string): void { this.write(textFrame(text), 1) }
  /** Frame bytes that were encoded elsewhere (an edge receives them ready-made). */
  sendBytes(bytes: Buffer, frames: number): void { this.write(bytes, frames) }

  congested(): boolean { return this.raw.writableLength > SOFT_LIMIT_BYTES }
  /** Bytes accepted for this socket that the network has not taken yet. */
  pending(): number { return this.raw.writableLength }

  sendStep(step: MovementStep, indices: number[], events: ServerEvent[]): void {
    // Answers that were waiting go out in the same write, ahead of the step.
    let parts: Buffer[] = []
    let size = 0
    if (this.waiting.length > 0) { parts = this.waiting; this.waiting = []; for (const part of parts) size += part.length }
    if (this.batch) {
      const frame = textFrame(batchText(step, indices, events))
      if (parts.length === 0) { this.write(frame, 1); return }
      parts.push(frame)
      this.write(Buffer.concat(parts, size + frame.length), parts.length)
      return
    }
    // A client that does not know batched frames gets the same events it always did, one frame
    // each, but all of them in a single write.
    for (const event of events) { const frame = textFrame(`{"t":"event","event":${JSON.stringify(event)}}`); parts.push(frame); size += frame.length }
    for (const index of indices) { const frame = moveFrame(step, index); parts.push(frame); size += frame.length }
    this.write(parts.length === 1 ? parts[0]! : Buffer.concat(parts, size), parts.length)
  }
}
