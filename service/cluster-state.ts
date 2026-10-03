// State thread of the sharded service: the one World with every module and the saved state.
//
// It answers every operation that is not movement, chat or voice, exactly as the single-process
// service does. For rooms it keeps the authority and gives away the work: it runs the entry
// rules (travel, home access, table access), chooses the shard and the instance, and remembers
// who is in which room so homes, games and travel can still ask. The room itself runs on a shard.
import { parentPort, workerData } from 'node:worker_threads'
import type { MemberId, RoomKey } from '../src/shared/ids.ts'
import type { Relation } from '../src/shared/model.ts'
import type { ClientFrame, ServerFrame } from '../src/shared/protocol.ts'
import { Outbox } from './cluster-wire.ts'
import type { EdgeToState, ShardToState, StateToEdge, StateToShard, WorkerPorts } from './cluster-wire.ts'
import { Diagnostics } from './diagnostics.ts'
import { createWorld } from './index.ts'
import type { Connection, Link, Reply, RoomHost } from './kernel.ts'
import { ensureMember, exists, record } from './members.ts'
import { filePersistence } from './persist.ts'
import { RELATION_OPS, roomCounts } from './rooms.ts'
import { unsubscribe } from './server.ts'

const setup = workerData as WorkerPorts
const diagnostics = new Diagnostics('state')
const toEdge = setup.edges!.map(port => new Outbox<StateToEdge>(port))
const toShard = setup.shards!.map(port => new Outbox<StateToShard>(port))

interface Session { edge: number; conn: number; batch: boolean; connection: Connection }
const sessions = new Map<MemberId, Session>()
const byConn = setup.edges!.map(() => new Map<number, Session & { memberId: MemberId }>())

// ── Where rooms live ──
// A room goes to the shard with the fewest members when its first member arrives, and stays
// there until it is empty. Every instance of a room is on the same shard.
const placement = new Map<RoomKey, { shard: number; members: number }>()
const shardLoad = toShard.map(() => 0)
const inRoom = new Map<MemberId, { key: RoomKey; shard: number }>()
const sentCards = new Map<MemberId, string>()
const pendingEnters = new Map<number, { memberId: MemberId; key: RoomKey; shard: number; reply: Reply }>()
let nextToken = 1

function place(key: RoomKey): number {
  let placed = placement.get(key)
  if (!placed) {
    let shard = 0
    for (let index = 1; index < shardLoad.length; index++) if (shardLoad[index]! < shardLoad[shard]!) shard = index
    placed = { shard, members: 0 }
    placement.set(key, placed)
  }
  placed.members++
  shardLoad[placed.shard]!++
  return placed.shard
}
function unplace(key: RoomKey): void {
  const placed = placement.get(key)
  if (!placed) return
  shardLoad[placed.shard]!--
  if (--placed.members <= 0) placement.delete(key)
}

// ── What a shard needs to know about a member ──
// The member's own record (name, look, friends, blocks, area) and who they have a pending
// introduction with. It is sent before the member enters and again whenever it changes, so the
// shard draws presence, applies blocks and limits photo faces from the same facts as this thread.
interface IntroSlice { intros: Record<string, { from: MemberId; to: MemberId; status: string }> }
function cardOf(memberId: MemberId): string {
  const relations: Record<string, Relation> = {}
  for (const intro of Object.values(world.peek<IntroSlice>('social')?.intros ?? {})) {
    if (intro.status !== 'pending') continue
    if (intro.from === memberId) relations[intro.to] = 'intro-sent'
    else if (intro.to === memberId) relations[intro.from] = 'intro-received'
  }
  return JSON.stringify([record(world, memberId), relations])
}
function sendCard(memberId: MemberId, shard: number): void {
  if (!exists(world, memberId)) return
  const card = cardOf(memberId)
  if (sentCards.get(memberId) === card) return
  sentCards.set(memberId, card)
  toShard[shard]!.push(['card', memberId, card])
}
/** Resend the card of each of these members who is in a room, if it changed. */
function refreshCards(memberIds: Iterable<MemberId>): void {
  for (const memberId of memberIds) {
    const at = inRoom.get(memberId)
    if (at) sendCard(memberId, at.shard)
  }
}

const host: RoomHost = {
  enter(request) {
    const session = sessions.get(request.memberId)
    if (!session) { request.reply.fail('unavailable', 'The connection dropped before the room was ready.'); return }
    const shard = place(request.key)
    inRoom.set(request.memberId, { key: request.key, shard })
    sentCards.delete(request.memberId)
    sendCard(request.memberId, shard)
    const token = nextToken++
    pendingEnters.set(token, { memberId: request.memberId, key: request.key, shard, reply: request.reply })
    toShard[shard]!.push(['enter', token, session.edge, session.conn, session.batch, request.memberId, request.ref, request.instance, request.pos, request.heading])
  },
  leave(memberId, key) {
    const at = inRoom.get(memberId)
    if (!at) return
    inRoom.delete(memberId)
    sentCards.delete(memberId)
    unplace(key)
    toShard[at.shard]!.push(['leave', memberId])
    const session = sessions.get(memberId)
    if (session) toEdge[session.edge]!.push(['route', session.conn, -1])
  },
  changed(memberId, _key, what) {
    const at = inRoom.get(memberId)
    if (!at) return
    // The facts first, then the instruction that depends on them.
    sendCard(memberId, at.shard)
    if (what === 'look') { toShard[at.shard]!.push(['look', memberId]); return }
    const other = inRoom.get(what.blocked)
    if (other?.shard === at.shard) sendCard(what.blocked, at.shard)
    toShard[at.shard]!.push(['block', memberId, what.blocked])
  },
}

const world = createWorld({ persistence: filePersistence(setup.statePath, { port: setup.port }), roomHost: host })
// Another service has taken the state file over: this one must not carry on as if it were saving.
world.onSuperseded(() => { console.error('[cluster] the state file was taken over by another service; stopping.'); process.exit(1) })
const ticker = setInterval(() => { if (!world.superseded) world.tick() }, 1000)

// Operations after which a member's card may differ. The second member involved, when there is
// one, is named in the input. Anything missed here is caught by the sweep below within seconds.
const CARD_OPS = new Set([
  'member.saveProfile', 'member.savePreferences', 'member.setCurrentArea', 'member.clearCurrentArea', 'member.setBrowsing', 'member.completeOnboarding',
  'member.setFace', 'member.setFaceAudience', 'member.clearFace', 'member.block', 'member.unblock', 'intro.send', 'intro.respond', 'intro.withdraw', 'friends.remove',
])
function afterOperation(memberId: MemberId, frame: Extract<ClientFrame, { t: 'req' }>): void {
  if (!CARD_OPS.has(frame.op)) return
  const affected = new Set<MemberId>([memberId])
  const input = (frame.input ?? {}) as { memberId?: unknown; to?: unknown; introId?: unknown }
  if (typeof input.memberId === 'string') affected.add(input.memberId as MemberId)
  if (typeof input.to === 'string') affected.add(input.to as MemberId)
  if (typeof input.introId === 'string') {
    const intro = world.peek<IntroSlice>('social')?.intros[input.introId]
    if (intro) { affected.add(intro.from); affected.add(intro.to) }
  }
  refreshCards(affected)
  // The facts are on their way; now the instruction that depends on them.
  const at = RELATION_OPS.has(frame.op) ? inRoom.get(memberId) : undefined
  if (at) toShard[at.shard]!.push(['relations', memberId])
}

// Safety net: a tenth of the members in rooms are compared every second, so a change that came
// from somewhere unexpected (an expiry on the tick, a new module) reaches the shard within 10 s.
let sweepCursor = 0
const sweeper = setInterval(() => {
  const members = [...inRoom.keys()]
  const count = Math.ceil(members.length / 10)
  for (let index = 0; index < count; index++) {
    const memberId = members[(sweepCursor + index) % members.length]!
    sendCard(memberId, inRoom.get(memberId)!.shard)
  }
  sweepCursor += count
}, 1000)

// ── Edges ──
function linkFor(edge: number, conn: number): Link {
  const out = toEdge[edge]!
  return {
    sendText(text) { out.push(['send', conn, text]) },
    sendLater(text) { out.push(['send', conn, text]) },
    congested: () => false,
    // No room runs on this thread, so there is no movement to send from here.
    sendStep(_step, _indices, events) { for (const event of events) out.push(['send', conn, `{"t":"event","event":${JSON.stringify(event)}}`]) },
  }
}

setup.edges!.forEach((port, edge) => {
  port.on('message', (items: EdgeToState[]) => {
    for (const item of items) {
      if (item[0] === 'hello') {
        const [, conn, memberId, name, reviewer, batch] = item
        world.scoped(() => ensureMember(world, memberId, name, { reviewer }))
        const out = toEdge[edge]!
        const connection = world.connect(memberId, (frame: ServerFrame) => out.push(['send', conn, JSON.stringify(frame)]), () => out.push(['close', conn, 4000, 'replaced']), linkFor(edge, conn))
        const session = { edge, conn, batch, connection, memberId }
        sessions.set(memberId, session)
        byConn[edge]!.set(conn, session)
      } else if (item[0] === 'frame') {
        const session = byConn[edge]!.get(item[1])
        if (!session) continue
        let frame: ClientFrame
        try { frame = JSON.parse(item[2]) as ClientFrame } catch { continue }
        world.receive(session.connection, frame)
        if (frame.t === 'req') afterOperation(session.memberId, frame)
      } else if (item[0] === 'unsubscribe') {
        const [status, result] = unsubscribe(world, item[2], item[3])
        toEdge[edge]!.push(['unsubscribed', item[1], status, JSON.stringify(result)])
      } else {
        const session = byConn[edge]!.get(item[1])
        if (!session) continue
        byConn[edge]!.delete(item[1])
        world.disconnect(session.connection)
        if (sessions.get(session.memberId) === session) sessions.delete(session.memberId)
      }
    }
  })
})

// ── Shards ──
setup.shards!.forEach(port => {
  port.on('message', (items: ShardToState[]) => {
    for (const item of items) {
      if (item[0] === 'seen') { for (const memberId of item[1]) world.noteOperation(memberId, 'room.move'); continue }
      const [, token, result] = item
      const pending = pendingEnters.get(token)
      if (!pending) continue
      pendingEnters.delete(token)
      const at = inRoom.get(pending.memberId)
      const session = sessions.get(pending.memberId)
      // Tell the edge where the room is before the member hears they are in, so their first step goes to the right place.
      if (session && at && at.key === pending.key && at.shard === pending.shard) toEdge[session.edge]!.push(['route', session.conn, pending.shard])
      pending.reply(JSON.parse(result))
    }
  })
})

parentPort!.on('message', (message: { kind: string; id?: number; reset?: boolean }) => {
  if (message.kind === 'diag?') {
    parentPort!.postMessage({
      kind: 'diag!', id: message.id, sample: diagnostics.read(message.reset !== false), connections: world.online(),
      extra: { ...world.stats(), register: roomCounts(world), placement: { rooms: placement.size, membersPerShard: [...shardLoad] } },
    })
  } else if (message.kind === 'stop') {
    clearInterval(ticker)
    clearInterval(sweeper)
    world.close()
    parentPort!.postMessage({ kind: 'stopped' })
  }
})
parentPort!.postMessage({ kind: 'ready' })
