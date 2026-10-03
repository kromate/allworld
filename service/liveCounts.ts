import type { CountsDay, CountsHistory, LiveCountsSnapshot, PageView } from '../src/shared/liveCounts.ts'
import { WorldError } from '../src/shared/model.ts'
import type { Connection, World } from './kernel.ts'
import { empty } from './parse.ts'

const DAY = 86_400_000, PRESENCE_MS = 60_000, DISCONNECT_GRACE_MS = 15_000
const HISTORY_DAYS = 90, MAX_EVENTS = 20_000, CLOCK_SKEW_MS = 300_000
interface CountsState {
  since: number
  totalViews: number
  days: Record<string, CountsDay>
  /** Random document retry ids only. No identity, URL, referrer, address or device attributes. */
  events: Record<string, { startedAt: number; expiresAt: number }>
}
interface Peer { memberId: Connection['memberId']; expiresAt: number; owner: boolean; connected: boolean }
export interface LiveCountsService {
  connected(connection: Connection, owner?: boolean): void
  seen(connection: Connection): void
  disconnected(connection: Connection): void
  snapshot(): LiveCountsSnapshot
  view(input: unknown, source: string): { recorded: true; repeated: boolean; snapshot: LiveCountsSnapshot }
}
export function parsePageView(input: unknown): PageView {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => key !== 'eventId' && key !== 'startedAt')
    || !('eventId' in input) || typeof input.eventId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.eventId)
    || !('startedAt' in input) || typeof input.startedAt !== 'number' || !Number.isSafeInteger(input.startedAt)) {
    throw new WorldError('invalid', 'Use one document view event.')
  }
  return { eventId: input.eventId, startedAt: input.startedAt }
}

/** Hosted transport only: call connected after authentication, seen after lease validation. */
export function registerLiveCounts(world: World): LiveCountsService {
  const peers = new Map<number, Peer>()
  const state = (): CountsState => world.slice('liveCounts', () => ({ since: world.now(), totalViews: 0, days: {}, events: {} }))
  world.scoped(() => { state(); world.touch() })
  const healthy = (): void => {
    if (world.superseded || world.saveStats.lastError !== null) throw new WorldError('unavailable', 'World counts are waiting for durable storage.')
  }
  function online(): number {
    const members = new Set<Connection['memberId']>()
    for (const [id, peer] of peers) {
      if (peer.expiresAt <= world.now()) { if (!peer.connected) peers.delete(id) }
      else members.add(peer.memberId)
    }
    return members.size
  }
  function day(data: CountsState): CountsDay {
    const key = new Date(world.now()).toISOString().slice(0, 10)
    return data.days[key] ??= { day: key, views: 0, onlinePeak: 0 }
  }
  function prune(data: CountsState): void {
    for (const [id, event] of Object.entries(data.events)) if (event.expiresAt <= world.now()) delete data.events[id]
    const oldest = new Date(world.now() - (HISTORY_DAYS - 1) * DAY).toISOString().slice(0, 10)
    for (const key of Object.keys(data.days)) if (key < oldest) delete data.days[key]
  }
  function snapshot(): LiveCountsSnapshot {
    healthy()
    const data = state()
    return { scope: 'hosted-world', totalViews: data.totalViews, onlinePlayers: online(), since: data.since, asOf: world.now() }
  }
  const owner = (memberId: Connection['memberId']): boolean => [...peers.values()].some(peer => peer.memberId === memberId && peer.owner && peer.expiresAt > world.now())
  world.register('counts.owner', empty, ({ memberId }) => ({ owner: owner(memberId) }))
  world.register('counts.history', empty, ({ memberId }): CountsHistory => {
    if (!owner(memberId)) throw new WorldError('forbidden', 'Only the verified world owner can read count history.')
    healthy()
    const data = state()
    return { since: data.since, totalViews: data.totalViews, days: Object.values(data.days).sort((a, b) => b.day.localeCompare(a.day)).slice(0, HISTORY_DAYS).map(row => ({ ...row })) }
  })
  function notePeak(): void {
    world.scoped(() => {
      const today = day(state()), count = online()
      if (today.onlinePeak < count) { today.onlinePeak = count; world.touch() }
    })
  }
  let lastPrune = 0
  world.onTick(() => {
    const data = state(), today = day(data), count = online()
    if (today.onlinePeak < count) { today.onlinePeak = count; world.touch() }
    if (world.now() - lastPrune >= 60_000) {
      lastPrune = world.now()
      const before = Object.keys(data.events).length + Object.keys(data.days).length
      prune(data)
      if (before !== Object.keys(data.events).length + Object.keys(data.days).length) world.touch()
    }
  })
  return {
    connected(connection, isOwner = false) { peers.set(connection.id, { memberId: connection.memberId, expiresAt: world.now() + PRESENCE_MS, owner: isOwner, connected: true }); notePeak() },
    seen(connection) { const peer = peers.get(connection.id); if (peer?.connected) peer.expiresAt = world.now() + PRESENCE_MS },
    disconnected(connection) {
      const peer = peers.get(connection.id)
      if (peer) { peer.expiresAt = Math.min(peer.expiresAt, world.now() + DISCONNECT_GRACE_MS); peer.owner = false; peer.connected = false }
    },
    snapshot,
    view(raw, source) {
      const input = parsePageView(raw)
      world.limit('counts:view:global', 300, 60_000)
      world.limit(`counts:view:${source}`, 30, 60_000)
      if (world.superseded) throw new WorldError('unavailable', 'The world service was replaced.')
      const data = state(), previous = data.events[input.eventId]
      if (previous && previous.expiresAt > world.now()) {
        if (previous.startedAt !== input.startedAt) throw new WorldError('invalid', 'The view event changed.')
        world.flush(); healthy()
        return { recorded: true, repeated: true, snapshot: snapshot() }
      }
      if (Math.abs(world.now() - input.startedAt) > CLOCK_SKEW_MS) throw new WorldError('expired', 'This document view event is too old.')
      world.scoped(() => {
        prune(data)
        if (Object.keys(data.events).length >= MAX_EVENTS) throw new WorldError('rate_limited', 'The daily view event capacity is full.')
        if (!Number.isSafeInteger(data.totalViews + 1)) throw new WorldError('unavailable', 'The view total has reached its storage limit.')
        data.events[input.eventId] = { startedAt: input.startedAt, expiresAt: world.now() + DAY }
        data.totalViews++; day(data).views++; world.touch()
      })
      // A failed flush leaves the event owed in memory. Retrying its id persists it once.
      world.flush(); healthy()
      return { recorded: true, repeated: false, snapshot: snapshot() }
    },
  }
}
