// What the threads of the sharded service say to each other (service/cluster.ts).
//
// Three kinds of thread:
//   edge  — owns WebSockets. Knows nothing about the world; relays frames and writes bytes.
//   state — the one World with every module and the saved state. Decides who may enter a room
//           and which shard and instance they join; keeps the register of who is where.
//   shard — runs room instances: positions, movement, proximity chat, voice gating.
//
// Messages are small arrays, gathered for one turn of the event loop and posted together, so a
// busy second is a few hundred posts rather than tens of thousands.
import type { MessagePort } from 'node:worker_threads'
import type { MemberId, RoomKey } from '../src/shared/ids.ts'
import type { Vec2 } from '../src/shared/geo.ts'
import type { RoomRef } from '../src/shared/model.ts'
import type { ServerEvent } from '../src/shared/protocol.ts'

/** Operations an edge sends straight to the room shard. Everything else goes to the state thread. */
export const HOT_OPS: ReadonlySet<string> = new Set(['room.move', 'chat.send', 'voice.set', 'voice.signal'])

export type EdgeToState =
  | ['hello', conn: number, memberId: MemberId, name: string, reviewer: boolean, batch: boolean]
  | ['frame', conn: number, text: string]
  | ['bye', conn: number]
  /** An unsubscribe link was used (an HTTP request with no session). */
  | ['unsubscribe', request: number, token: string, address: string]

export type StateToEdge =
  | ['send', conn: number, text: string]
  /** Which shard the member's room is on, or -1 for none. */
  | ['route', conn: number, shard: number]
  | ['close', conn: number, code: number, reason: string]
  | ['unsubscribed', request: number, status: number, result: string]

export type StateToShard =
  /** The member's record and pending introductions, as the room needs them. Sent before `enter` and whenever it changes. */
  | ['card', memberId: MemberId, text: string]
  | ['enter', token: number, edge: number, conn: number, batch: boolean, memberId: MemberId, ref: RoomRef, instance: number, pos: Vec2, heading: number]
  | ['leave', memberId: MemberId]
  | ['block', blocker: MemberId, blocked: MemberId]
  | ['look', memberId: MemberId]
  /** A friendship or introduction changed for this member: redraw them for the room and the room for them. */
  | ['relations', memberId: MemberId]

export type ShardToState =
  | ['entered', token: number, result: string]
  /** Members who moved in the last second, for the state thread's operation listeners. */
  | ['seen', memberIds: MemberId[]]

export type EdgeToShard =
  | ['f', conn: number, text: string]
  | ['congested', conn: number, congested: boolean]

export type ShardToEdge =
  | ['send', conn: number, text: string]
  /** An answer that may wait for the member's next step. */
  | ['later', conn: number, text: string]
  /**
   * One room instance's step for the members connected through this edge. `nums` holds x, z,
   * heading, moving for each id; `to` is a run of [conn, count, index…]; `events` are the joins and
   * leaves for the few members who have any.
   */
  | ['step', room: RoomKey, ids: MemberId[], nums: Float32Array, to: Uint32Array, events: [conn: number, events: ServerEvent[]][]]

export interface WorkerPorts {
  role: 'edge' | 'state' | 'shard'
  index: number
  /** edge: its port to the state thread. shard: its port to the state thread. */
  state?: MessagePort
  /** state: one port per edge. shard: one port per edge. */
  edges?: MessagePort[]
  /** state: one port per shard. edge: one port per shard. */
  shards?: MessagePort[]
  port: number
  statePath: string
  loadTest: boolean
  maxConnections: number
}

/** Gathers messages for one port and posts them once per turn of the event loop. */
export class Outbox<T extends unknown[]> {
  private items: T[] = []
  private transfers: ArrayBuffer[] = []
  private scheduled = false
  private readonly port: MessagePort
  private readonly flush = (): void => {
    this.scheduled = false
    const items = this.items, transfers = this.transfers
    this.items = []
    this.transfers = []
    this.port.postMessage(items, transfers)
  }

  constructor(port: MessagePort) { this.port = port }

  push(item: T, transfer?: ArrayBuffer[]): void {
    this.items.push(item)
    if (transfer) for (const buffer of transfer) this.transfers.push(buffer)
    if (!this.scheduled) { this.scheduled = true; setImmediate(this.flush) }
  }
}

/** The operation name of a request frame, read without parsing it when it has the usual shape. */
export function opOf(text: string): string | null {
  if (text.startsWith('{"t":"req","id":')) {
    let at = 16
    while (at < text.length) { const code = text.charCodeAt(at); if (code < 48 || code > 57) break; at++ }
    if (at > 16 && text.startsWith(',"op":"', at)) {
      const end = text.indexOf('"', at + 7)
      if (end > 0) return text.slice(at + 7, end)
    }
  }
  try {
    const frame = JSON.parse(text) as { t?: unknown; op?: unknown }
    if (frame.t === 'ping') return 'ping'
    return frame.t === 'req' && typeof frame.op === 'string' ? frame.op : null
  } catch { return null }
}
