// Room shard of the sharded service: runs the room instances it is given.
//
// Positions, movement fan-out, proximity chat and voice gating happen here, on this thread's own
// core. A shard never decides who may enter a room — the state thread does, and then says so.
// A shard holds no saved state: what it knows about members is the cards the state thread sends.
import { parentPort, workerData } from 'node:worker_threads'
import type { MemberId } from '../src/shared/ids.ts'
import type { Relation } from '../src/shared/model.ts'
import type { ClientFrame, ServerEvent, ServerFrame } from '../src/shared/protocol.ts'
import { Outbox } from './cluster-wire.ts'
import type { EdgeToShard, ShardToEdge, ShardToState, StateToShard, WorkerPorts } from './cluster-wire.ts'
import { Diagnostics } from './diagnostics.ts'
import { STEP_PHASES, World } from './kernel.ts'
import type { Connection, Link, MovementStep } from './kernel.ts'
import { setIntroRelation } from './members.ts'
import { STEP_MS, announce, applyBlock, configureMovement, enterInstance, refreshRelations, registerRoomShard, roomCounts } from './rooms.ts'

const setup = workerData as WorkerPorts
const diagnostics = new Diagnostics(`shard-${setup.index}`)
configureMovement()

const world = new World()
registerRoomShard(world)

// ── Members, as told by the state thread ──
type Card = Record<string, unknown>
const members = world.slice<{ members: Record<string, Card>; reports: unknown[] }>('members', () => ({ members: {}, reports: [] })).members
const introductions = new Map<MemberId, Record<string, Relation>>()
setIntroRelation((_world, viewer, target) => introductions.get(viewer)?.[target] ?? null)

const toState = new Outbox<ShardToState>(setup.state!)
const toEdge = setup.edges!.map(port => new Outbox<ShardToEdge>(port))
const byConn = setup.edges!.map(() => new Map<number, Connection>())
const linkOf = new Map<MemberId, ShardLink>()

// ── Steps on their way to the edges ──
interface Packet { to: number[]; events: [number, ServerEvent[]][] }
const stepsToSend: MovementStep[] = []

class ShardLink implements Link {
  readonly edge: number
  readonly conn: number
  held = false
  constructor(edge: number, conn: number) { this.edge = edge; this.conn = conn }
  send(frame: ServerFrame): void { toEdge[this.edge]!.push(['send', this.conn, JSON.stringify(frame)]) }
  sendText(text: string): void { toEdge[this.edge]!.push(['send', this.conn, text]) }
  sendLater(text: string): void { toEdge[this.edge]!.push(['later', this.conn, text]) }
  congested(): boolean { return this.held }
  sendStep(step: MovementStep, indices: number[], events: ServerEvent[]): void {
    let packets = step.memo.packets as (Packet | undefined)[] | undefined
    if (!packets) { packets = step.memo.packets = []; stepsToSend.push(step) }
    const packet = (packets[this.edge] ??= { to: [], events: [] })
    packet.to.push(this.conn, indices.length)
    for (const index of indices) packet.to.push(index)
    if (events.length > 0) packet.events.push([this.conn, events])
  }
}

/** Hand each finished step to the edges: who moved, once, and for each member which of them to show. */
function sendSteps(): void {
  for (const step of stepsToSend) {
    const ids = step.moved.map(moved => moved.memberId)
    const packets = step.memo.packets as (Packet | undefined)[]
    for (let edge = 0; edge < packets.length; edge++) {
      const packet = packets[edge]
      if (!packet) continue
      const nums = new Float32Array(step.moved.length * 4)
      step.moved.forEach((moved, index) => { nums[index * 4] = moved.x; nums[index * 4 + 1] = moved.z; nums[index * 4 + 2] = moved.heading; nums[index * 4 + 3] = moved.moving ? 1 : 0 })
      const to = Uint32Array.from(packet.to)
      toEdge[edge]!.push(['step', step.room, ids, nums, to, packet.events], [nums.buffer, to.buffer])
    }
  }
  stepsToSend.length = 0
}

// Who moved lately, for the state thread (which never sees movement itself).
const seen = new Set<MemberId>()
world.onOperation(memberId => { seen.add(memberId) })
const reporter = setInterval(() => { if (seen.size > 0) { toState.push(['seen', [...seen]]); seen.clear() } }, 1000)

let phase = 0
const stepper = setInterval(() => { world.step(phase); phase = (phase + 1) % STEP_PHASES; if (stepsToSend.length > 0) sendSteps() }, STEP_MS / STEP_PHASES)

// ── From the state thread ──
setup.state!.on('message', (items: StateToShard[]) => {
  for (const item of items) {
    if (item[0] === 'card') {
      const [record, relations] = JSON.parse(item[2]) as [Card, Record<string, Relation>]
      const known = members[item[1]]
      // Updated in place: rooms hold on to the record they were given.
      if (known) Object.assign(known, record); else members[item[1]] = record
      introductions.set(item[1], relations)
    } else if (item[0] === 'enter') {
      const [, token, edge, conn, batch, memberId, ref, instance, pos, heading] = item
      void batch
      if (world.isOnline(memberId)) forget(memberId)
      const link = new ShardLink(edge, conn)
      const connection = world.attach(memberId, frame => link.send(frame), () => undefined, link)
      byConn[edge]!.set(conn, connection)
      linkOf.set(memberId, link)
      toState.push(['entered', token, JSON.stringify(enterInstance(world, memberId, ref, instance, pos, heading, world.now()))])
    } else if (item[0] === 'leave') {
      forget(item[1])
      delete members[item[1]]
      introductions.delete(item[1])
    } else if (item[0] === 'block') applyBlock(world, item[1], item[2])
    else if (item[0] === 'relations') refreshRelations(world, item[1])
    else announce(world, item[1])
  }
})

function forget(memberId: MemberId): void {
  const link = linkOf.get(memberId)
  if (link) { byConn[link.edge]!.delete(link.conn); linkOf.delete(memberId) }
  world.detach(memberId)
}

// ── From the edges: movement, chat and voice frames ──
setup.edges!.forEach((port, edge) => {
  port.on('message', (items: EdgeToShard[]) => {
    for (const item of items) {
      const connection = byConn[edge]!.get(item[1])
      if (item[0] === 'congested') {
        if (connection) (connection.link as ShardLink).held = item[2]
        continue
      }
      let frame: ClientFrame
      try { frame = JSON.parse(item[2]) as ClientFrame } catch { continue }
      if (connection) { world.receive(connection, frame); continue }
      // The member is not in a room here (they left as this frame was on its way).
      if (frame.t === 'req') toEdge[edge]!.push(['send', item[1], JSON.stringify({ t: 'res', id: frame.id, ok: false, code: 'conflict', message: 'You are not in a room.' })])
    }
  })
})

parentPort!.on('message', (message: { kind: string; id?: number; reset?: boolean }) => {
  if (message.kind === 'diag?') {
    const stats = world.stats()
    parentPort!.postMessage({ kind: 'diag!', id: message.id, sample: diagnostics.read(message.reset !== false), extra: { rooms: roomCounts(world), tick: stats.tick, operations: stats.operations } })
  } else if (message.kind === 'stop') {
    clearInterval(stepper)
    clearInterval(reporter)
    parentPort!.postMessage({ kind: 'stopped' })
  }
})
parentPort!.postMessage({ kind: 'ready' })
