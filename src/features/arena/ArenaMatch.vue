<script setup lang="ts">
// One match: a challenge to answer, a game to play or watch, or the record of how it ended.
// The board is the game's own component; everything around it — players, clocks, the turn, resign,
// draw, rematch, the move list, the people watching and the chat — is the hall's.
//
// The service is the judge. This page shows what it was sent, sends moves with their number so a
// retry can never play twice, and puts a refused move's reason beside the board.
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { COMPUTER_LEVEL_NAME, timeControl } from '../../shared/arena.ts'
import type { ArenaChatLine, ArenaDetail, ArenaMatch, ArenaMatchId, ArenaPlayer } from '../../shared/arena.ts'
import type { MemberId } from '../../shared/ids.ts'
import { WorldError } from '../../shared/model.ts'
import type { PublicMember } from '../../shared/model.ts'
import type { ServerEvent } from '../../shared/protocol.ts'
import { api, app, attempt, messageOf, onAccountReset, onReconnect, onServerEvent, refreshPoints, toast } from '../../state/app.ts'
import { arena, serverNow, setArenaNavigator, setSound, syncClock } from '../../state/arena.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { count, relativeTime } from '../../ui/format.ts'
import { usePlayKeys } from '../play/keys.ts'
import { isAutomaticFriend } from '../creator/creatorView.ts'
import { guestMay, guestRefusal } from '../guest/guestMay.ts'
import ArenaChat from './ArenaChat.vue'
import ArenaHowTo from './ArenaHowTo.vue'
import ArenaPlayerBar from './ArenaPlayerBar.vue'
import ArenaSheet from './ArenaSheet.vue'
import { boardFor } from './arenaGames.ts'
import { hallCue, unlockHallSound } from './arenaSound.ts'
import { AUDIENCE, GAME, HONESTY, clockText, coinLine, gameName, opponentOf, termsOf } from './arenaText.ts'

const route = useRoute()
const router = useRouter()
setArenaNavigator(path => { void router.push(path) })
usePlayKeys()

const matchId = computed(() => String(route.params.id) as ArenaMatchId)
const detail = shallowRef<ArenaDetail | null>(null)
const state = ref<'loading' | 'error' | 'ready'>('loading')
const error = ref('')
const closed = ref('')
let generation = 0

// ── Which of two is newer ──
// Every snapshot and event carries the match's revision: the service counts each change to what the
// match shows. An answer waits until its change is saved, so it can arrive after events that were
// sent later; at the same move and in the same millisecond, only the revision tells them apart.
// The page keeps the newest it has applied and drops what is older.
// A revision is comparable within one connection only: after a reconnect the service may have
// started again from an older saved state. Until the match has been read on the new connection,
// nothing is applied to what the page holds; it is read again instead.
/** The newest revision applied. */
let seen = 0
/** The connection now, and the one the page's state was read on (-1: nothing read yet). */
let life = 0, readIn = -1
/** The newest revision pushed while there was nothing to apply it to. */
let owed = 0
/** Reads of the match that are on their way. */
let reading = 0

const match = computed(() => detail.value?.match ?? null)
const me = computed(() => match.value?.me ?? null)
const playing = computed(() => me.value?.role === 'player' && me.value.seat !== null)
const other = computed(() => (match.value ? opponentOf(match.value) : null))
const board = computed(() => (match.value ? boardFor(match.value.game) : null))
const hasBoard = computed(() => Boolean(match.value && ['active', 'finished', 'aborted'].includes(match.value.status)))
const daily = computed(() => (match.value ? timeControl(match.value.timeControl).daily : false))
const seatNames = computed(() => match.value?.players.map(player => player.name) ?? [])
/** The viewer's own side sits under the board; a watcher sees the first seat there. */
const bottom = computed<ArenaPlayer | null>(() => match.value?.players[me.value?.seat ?? 0] ?? null)
const top = computed<ArenaPlayer | null>(() => match.value?.players.find(player => player.seat !== bottom.value?.seat) ?? null)

async function load(quiet = false): Promise<void> {
  const run = ++generation
  const id = matchId.value
  if (!quiet) { state.value = 'loading'; detail.value = null; closed.value = ''; readIn = -1; seen = 0; owed = 0 }
  reading++
  try {
    const got = await api('arena.watch', { matchId: id })
    if (run !== generation) return
    // Held on its way while newer events were applied: the page already shows what came after it.
    if (detail.value && readIn === life && got.match.rev < seen) return
    syncClock(got.now)
    detail.value = got
    readIn = life
    seen = got.match.rev
    state.value = 'ready'
    closed.value = ''
    // Something newer was pushed before there was anything to apply it to: read once more, now that there is.
    const behind = seen < owed
    owed = 0
    if (behind) void load(true)
  } catch (cause) {
    if (run !== generation) return
    if (quiet && detail.value && !(cause instanceof WorldError && (cause.code === 'forbidden' || cause.code === 'not_found'))) return
    error.value = /^am_[a-z0-9_-]{3,40}$/.test(id) ? messageOf(cause) : 'That game was not found.'
    state.value = 'error'
  } finally {
    reading--
  }
}

function leave(id: ArenaMatchId): void { void api('arena.unwatch', { matchId: id }).catch(() => undefined) }
watch(matchId, (next, previous) => {
  if (previous) leave(previous)
  problem.value = ''; resigning.value = false; again.value = null; unread.value = false
  dropMove()
  void load()
})
let mounted = true
onBeforeUnmount(() => { mounted = false; leave(matchId.value) })
/** An answer that was waited for belongs to this page only while it is still open on the game it was asked on. */
const here = (id: ArenaMatchId): boolean => mounted && id === matchId.value
// A new connection: what the page holds is from the last one until the match has been read again.
// The rematch is read too: it can have been accepted or withdrawn while the link was down.
const stopReconnect = onReconnect(() => { life++; owed = 0; void load(true).then(() => { sendHeld(); void readNext() }) })
onBeforeUnmount(stopReconnect)
// A move chosen by one account is never sent by the next one to use this page.
const stopReset = onAccountReset(dropMove)
onBeforeUnmount(() => { stopReset(); dropMove() })

// ── What the service pushes ──

function adopt(next: ArenaDetail): void {
  const current = detail.value
  if (current && next.match.id !== current.match.id) return
  // The page's state is from before a reconnect, so the two cannot be compared: the read that is due settles it.
  if (current && readIn !== life) { if (!reading) void load(true); return }
  // Older than what the page shows, whatever its move count and its time say.
  if (current && next.match.rev < seen) return
  syncClock(next.now)
  detail.value = next
  readIn = life
  seen = next.match.rev
}

/** A pushed change the page cannot apply (nothing read yet, or not on this connection): it is not dropped, the match is read. */
function owe(rev: number): void {
  owed = Math.max(owed, rev)
  if (!reading) void load(true)
}

function cues(before: ArenaMatch, after: ArenaMatch): void {
  const seat = after.me.seat
  if (before.status === 'active' && after.status !== 'active') { hallCue('end'); void refreshPoints(); return }
  if (seat === null) return
  if (after.turn === seat && before.turn !== seat) hallCue('turn')
  if (after.drawOffer !== null && after.drawOffer !== seat && before.drawOffer === null) hallCue('offer')
}

const stopEvents = onServerEvent((event: ServerEvent) => {
  const current = detail.value
  if (event.type === 'arena.match') {
    // The rematch this member asked for was accepted: go to it.
    if (current && event.matchId === current.match.rematch && event.matchId !== matchId.value && event.match.status === 'active' && event.match.me.role === 'player') {
      void router.push(`/arena/match/${event.matchId}`)
      return
    }
    if (event.matchId !== matchId.value) return
    if (!current || readIn !== life) { owe(event.match.rev); return }
    if (event.match.rev < seen) return
    if (event.from > current.moves.length) { void load(true); return }
    cues(current.match, event.match)
    seen = event.match.rev
    detail.value = {
      ...current, match: event.match, view: event.view ?? current.view, lastMove: event.lastMove,
      moves: [...current.moves.slice(0, event.from), ...event.moves], now: event.now,
    }
    if (event.match.moveCount !== current.match.moveCount) problem.value = ''
    // The same rematch, pushed again: it was answered or it started. A new id is read by the watch below.
    if (event.match.rematch && event.match.rematch === current.match.rematch) void readNext()
    return
  }
  // A match with no board is never pushed: when it is answered, withdrawn or lapses, it is read again.
  if (event.type === 'arena.changed') { if (current?.match.status === 'waiting' && event.matchId === matchId.value) void load(true); return }
  if (event.type === 'arena.chat' && event.matchId === matchId.value) {
    if (!current || readIn !== life) { owe(event.rev); return }
    if (current.chat.some(line => line.id === event.line.id)) return
    // A snapshot from before this line has a lower revision, and is dropped when it arrives.
    seen = Math.max(seen, event.rev)
    detail.value = { ...current, chat: [...current.chat, event.line] }
    if (panel.value !== 'chat' || !panelOpen.value) unread.value = true
    hallCue('chat')
  } else if (current && event.type === 'arena.closed' && event.matchId === matchId.value) closed.value = event.reason
})
onBeforeUnmount(stopEvents)

// ── Clocks ──

const nowTick = ref(serverNow())
let ticker = 0
watch(() => [match.value?.status, daily.value] as const, ([status, slow]) => {
  window.clearInterval(ticker)
  nowTick.value = serverNow()
  if (status === 'active') ticker = window.setInterval(() => { nowTick.value = serverNow() }, slow ? 1000 : 200)
}, { immediate: true })
onBeforeUnmount(() => window.clearInterval(ticker))

function leftOf(player: ArenaPlayer): number {
  const current = match.value
  if (!current || current.status !== 'active' || current.clock.seat !== player.seat || !current.clock.counting || !current.clock.since) return player.clockMs
  return Math.max(0, player.clockMs - (nowTick.value - Date.parse(current.clock.since)))
}
const callsOffIn = computed(() => (match.value?.status === 'active' && match.value.clock.callsOffAt ? Math.max(0, Date.parse(match.value.clock.callsOffAt) - nowTick.value) : null))
const runningSeat = computed(() => (match.value?.status === 'active' && match.value.clock.counting ? match.value.clock.seat : null))
// One warning as the member's own clock drops under ten seconds.
let warned = -1
watch(() => (playing.value && bottom.value && runningSeat.value === bottom.value.seat && !daily.value ? leftOf(bottom.value) : Infinity), left => {
  const move = match.value?.moveCount ?? -1
  if (left < 10_000 && warned !== move) { warned = move; hallCue('low') }
})

const resultOf = (player: ArenaPlayer): 'won' | 'lost' | 'draw' | null => {
  const outcome = match.value?.outcome
  if (!outcome) return null
  return outcome.draw ? 'draw' : outcome.winners.includes(player.seat) ? 'won' : 'lost'
}

// ── Moves ──

const problem = ref('')
const sending = ref(false)
const canMove = computed(() => Boolean(match.value && match.value.status === 'active' && playing.value && match.value.turn === me.value!.seat && !sending.value && !closed.value))
const pause = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms))
/**
 * A move the link could not carry. It is sent once when the link is back, with the number it was
 * chosen at, so a move that did land (only its answer was lost) is never played again. It is dropped
 * when the game ends or moves on, when another game is opened, and when the account changes.
 */
const held = shallowRef<{ id: ArenaMatchId; number: number; move: unknown } | null>(null)
/** Bumped when a move in flight no longer belongs to this page: its retries stop and its answer is not used. */
let moveEpoch = 0
function dropMove(): void { held.value = null; moveEpoch++; sending.value = false }
/** The game on this page is still the one, at the move, the choice was made in. */
function standsAt(id: ArenaMatchId, number: number): boolean {
  const current = match.value
  return Boolean(current && id === matchId.value && current.id === id && current.status === 'active' && current.moveCount === number)
}
watch(() => [match.value?.id, match.value?.status, match.value?.moveCount] as const, () => {
  if (held.value && !standsAt(held.value.id, held.value.number)) held.value = null
})
function sendHeld(): void {
  const waiting = held.value
  held.value = null
  if (waiting && standsAt(waiting.id, waiting.number) && canMove.value) void onMove(waiting.move)
}

async function onMove(move: unknown): Promise<void> {
  const current = match.value
  if (!current || !canMove.value) return
  unlockHallSound()
  const id = current.id, number = current.moveCount, epoch = moveEpoch
  sending.value = true
  problem.value = ''
  held.value = null
  // A lost answer is retried with the same number: if the move did land, the retry changes nothing.
  for (let round = 0; round < 3; round++) {
    try {
      const answer = await api('arena.move', { matchId: id, moveNumber: number, move })
      if (epoch !== moveEpoch) return
      adopt(answer)
      break
    } catch (cause) {
      if (epoch !== moveEpoch) return
      const code = cause instanceof WorldError ? cause.code : 'unavailable'
      if ((code === 'unavailable' || code === 'rate_limited') && round < 2) {
        await pause(700 * (round + 1))
        if (epoch !== moveEpoch) return
        continue
      }
      // The link is down: the move waits for it (the line under the board says so) instead of being lost.
      if (code === 'unavailable' && app.link !== 'online') { if (standsAt(id, number)) held.value = { id, number, move } }
      else problem.value = messageOf(cause)
      if (code === 'conflict' || code === 'unavailable') void load(true)
      break
    }
  }
  sending.value = false
}

// ── Answering, resigning, draws, rematch ──

const busy = ref(false)
async function run<T>(work: () => Promise<T | null>): Promise<T | null> {
  if (busy.value) return null
  busy.value = true
  try { return await work() } finally { busy.value = false }
}
async function respond(accept: boolean): Promise<void> {
  const result = await run(() => attempt('arena.respond', { matchId: matchId.value, accept }, accept ? undefined : 'Challenge declined.'))
  if (result) void load(true)
}
async function cancel(): Promise<void> {
  const result = await run(() => attempt('arena.cancel', { matchId: matchId.value }))
  if (result) void load(true)
}
const resigning = ref(false)
async function resign(): Promise<void> {
  const result = await run(() => attempt('arena.resign', { matchId: matchId.value }))
  resigning.value = false
  if (result) adopt(result)
}
async function draw(action: 'offer' | 'accept' | 'decline'): Promise<void> {
  const result = await run(() => attempt('arena.draw', { matchId: matchId.value, action }, action === 'offer' ? 'Draw offered.' : undefined))
  if (result) adopt(result)
}
/** The rematch as this member sees it. The finished game carries only its id: who asked, and the answer, are the rematch's own. */
const again = shallowRef<ArenaMatch | null>(null)
let nextRead = 0
async function readNext(): Promise<void> {
  const read = ++nextRead
  // Only the players of an ended game are shown a rematch; a watcher may not be able to open it at all.
  const id = over.value && playing.value ? match.value?.rematch ?? null : null
  if (again.value && again.value.id !== id) again.value = null
  if (!id) return
  try {
    const got = await api('arena.get', { matchId: id })
    if (read === nextRead && mounted && match.value?.rematch === id) again.value = got.match
  } catch { /* Not read: the button asks the service, which answers with the rematch as it stands. */ }
}
async function rematch(): Promise<void> {
  const from = matchId.value, asked = nextRead
  const result = await run(() => attempt('arena.rematch', { matchId: from }))
  if (!result || !here(from)) return
  if (result.match.status === 'active') { void router.push(`/arena/match/${result.match.id}`); return }
  // The answer waits until its change is saved: a read of the rematch begun since it was asked is newer, and stands.
  // Kept, the answer also makes a read still on its way from before it the older one.
  if (nextRead === asked) { nextRead++; again.value = result.match }
  void load(true)
}
async function withdrawRematch(): Promise<void> {
  const id = match.value?.rematch
  if (!id) return
  const result = await run(() => attempt('arena.cancel', { matchId: id }, 'Rematch offer withdrawn.'))
  if (result) void load(true)
}
/** The same search again: the game, clock, kind and audience it was asked on. */
async function lookAgain(): Promise<void> {
  const current = match.value
  if (!current) return
  const from = matchId.value
  const made = await run(() => attempt('arena.create', { game: current.game, opponent: { kind: 'queue' }, timeControl: current.timeControl, rated: current.rated, audience: current.audience, communityId: current.communityId }))
  if (made && here(from)) void router.push(`/arena/match/${made.match.id}`)
}
async function playComputer(level: 1 | 2 | 3 = 1): Promise<void> {
  const current = match.value
  if (!current) return
  const from = matchId.value
  const made = await run(() => attempt('arena.create', { game: current.game, opponent: { kind: 'computer', level }, timeControl: current.timeControl, rated: false, audience: 'players', communityId: null }))
  if (made && here(from)) void router.push(`/arena/match/${made.match.id}`)
}
/** After a game against the computer: the next level up, one tap away. */
const harder = computed<2 | 3 | null>(() => {
  const level = other.value?.computer
  return over.value && playing.value && level && level < 3 ? ((level + 1) as 2 | 3) : null
})

// ── What the banner says ──
// The player bars carry names, ratings and clocks, and every board says whose move it is, so the
// hall adds only what they cannot: how a game ended (above the board), and a live line below the
// controls for a move in flight, a player who is away, the first-move deadline and watching.
// Below, so that nothing above or beside the board moves while a thumb is on it.

type Tone = '' | 'amber' | 'sky' | 'leaf' | 'coral'
const banner = computed<{ tone: Tone; text: string; sub?: string } | null>(() => {
  const current = match.value
  if (!current) return null
  if (closed.value) return { tone: 'coral', text: closed.value }
  if (current.status === 'aborted') return { tone: '', text: current.endText ?? 'The game was called off.' }
  if (!current.outcome) return null
  if (!playing.value) return { tone: 'leaf', text: current.outcome.text }
  const mine = current.players[me.value!.seat!]!
  const head = current.outcome.draw ? 'A draw.' : current.outcome.winners.includes(mine.seat) ? 'You won.' : 'You lost.'
  const extras: string[] = []
  if (mine.ratingChange !== null && mine.rating !== null) extras.push(mine.ratingChange === 0 ? `Rating stays ${mine.rating}` : `Rating ${mine.rating} → ${mine.rating + mine.ratingChange}`)
  const paid = coinLine(mine)
  if (paid) extras.push(paid)
  if (current.forFun) extras.push('You two have played today’s five counted games, so this one was for fun')
  return { tone: current.outcome.draw ? 'sky' : current.outcome.winners.includes(mine.seat) ? 'leaf' : 'coral', text: `${head} ${current.outcome.text}`, sub: extras.join(' · ') || undefined }
})
/** `count` is the live first-move countdown: shown, but kept out of the announcement so it is not read every second. */
const live = computed<{ tone: Tone; text: string; sub?: string; count?: string } | null>(() => {
  const current = match.value
  if (!current || current.status !== 'active' || closed.value || current.turn === null) return null
  const first = callsOffIn.value !== null ? { text: 'Make the first move or the game is called off in', count: clockText(callsOffIn.value, false) } : null
  const mover = current.players[current.turn]!
  if (playing.value && current.turn === me.value!.seat) {
    if (sending.value) return { tone: 'amber', text: 'Sending your move…' }
    if (held.value) return { tone: 'amber', text: 'Waiting for the connection.', sub: 'Your move will be sent as soon as it is back.' }
    return first ? { tone: 'amber', ...first } : null
  }
  if (playing.value && mover.member && !mover.connected && !daily.value) return { tone: 'coral', text: `${mover.name} is away.`, sub: 'If they are not back within a minute, the game is yours.' }
  return first ? { tone: 'sky', ...first } : null
})
const watchingLive = computed(() => Boolean(match.value && match.value.status === 'active' && !playing.value))
const offerToMe = computed(() => Boolean(match.value && match.value.status === 'active' && playing.value && match.value.drawOffer !== null && match.value.drawOffer !== me.value!.seat))
const myOffer = computed(() => Boolean(match.value && match.value.status === 'active' && playing.value && match.value.drawOffer === me.value!.seat))
const canOffer = computed(() => Boolean(match.value && match.value.status === 'active' && playing.value && other.value && !other.value.computer && match.value.drawOffer === null))
const over = computed(() => Boolean(match.value && (match.value.status === 'finished' || match.value.status === 'aborted')))

// Where a rematch stands: not asked, asked by the other player, asked by this one, declined, or begun.
watch(() => (over.value && playing.value ? match.value?.rematch ?? null : null), () => { void readNext() }, { immediate: true })
const rematchState = computed<'none' | 'unread' | 'theirs' | 'mine' | 'declined' | 'begun'>(() => {
  const id = match.value?.rematch
  if (!id) return 'none'
  const found = again.value
  if (!found || found.id !== id) return 'unread'
  if (found.status === 'waiting') return found.me.canAccept ? 'theirs' : 'mine'
  if (found.status === 'declined') return 'declined'
  return found.status === 'cancelled' || found.status === 'expired' ? 'none' : 'begun'
})

// A search that ended — stopped, lapsed, or dropped with the link — is said as one, with one tap back into it.
watch(() => (match.value?.open === 'queue' ? match.value.id : null), id => { if (id) arena.searched.add(id) }, { immediate: true })
const searchEnded = computed(() => Boolean(match.value && !hasBoard.value && match.value.status !== 'waiting' && arena.searched.has(match.value.id)))
const endedTitle = computed(() => {
  const status = match.value?.status
  if (searchEnded.value) return status === 'expired' ? 'Nobody was found' : 'Search stopped'
  return status === 'declined' ? 'Challenge declined' : status === 'cancelled' ? 'Challenge withdrawn' : 'Challenge lapsed'
})

// The terms only: the player bars already name both sides (the computer's name carries its level).
const subtitle = computed(() => (match.value ? termsOf(match.value) : undefined))

// ── Moves, chat, watchers ──

type Panel = 'moves' | 'chat' | 'watching'
const panel = ref<Panel>('moves')
// Beside the board in a wide window the list is open; under the board on a phone it starts closed,
// so the board and its controls are the page. The three tabs open and close it.
const panelOpen = ref(window.matchMedia('(min-width: 900px)').matches)
const unread = ref(false)
const chatBox = ref<InstanceType<typeof ArenaChat> | null>(null)
function showPanel(next: Panel): void {
  if (panel.value === next && panelOpen.value) { panelOpen.value = false; return }
  panel.value = next
  panelOpen.value = true
  if (next === 'chat') { unread.value = false; chatBox.value?.toEnd() }
}
const moveList = ref<HTMLElement | null>(null)
watch(() => detail.value?.moves.length, () => { window.requestAnimationFrame(() => { if (moveList.value) moveList.value.scrollTop = moveList.value.scrollHeight }) })

const chatBusy = ref(false)
function addLine(line: ArenaChatLine): void {
  const current = detail.value
  if (current && !current.chat.some(entry => entry.id === line.id)) detail.value = { ...current, chat: [...current.chat, line] }
}
async function say(text: string): Promise<void> {
  chatBusy.value = true
  unlockHallSound()
  const sent = await attempt('arena.chat', { matchId: matchId.value, text, clientId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` })
  chatBusy.value = false
  if (!sent) return
  addLine(sent.line)
  if (readIn === life) seen = Math.max(seen, sent.rev)
}
async function older(): Promise<void> {
  const current = detail.value
  if (!current?.chat.length) return
  const page = await attempt('arena.chatHistory', { matchId: matchId.value, before: current.chat[0]!.id })
  if (page && detail.value) detail.value = { ...detail.value, chat: [...page.lines, ...detail.value.chat], chatMore: page.more }
}
async function setFocus(on: boolean): Promise<void> {
  const result = await attempt('arena.focus', { matchId: matchId.value, on }, on ? 'Watcher chat is hidden for you.' : 'Watcher chat is back.')
  if (!result || !detail.value) return
  // Lines have arrived since this answer was read: the switch is kept, and the list is read again rather than an older one put back.
  if (readIn !== life || result.rev < seen) { detail.value = { ...detail.value, focus: result.focus }; void load(true); return }
  seen = result.rev
  detail.value = { ...detail.value, focus: result.focus, chat: result.chat, chatMore: result.chatMore }
}
// A guest plays, and can read and report what the other player writes, but writing, the watcher
// switch and earlier lines are an account's (guestAccess). Those are left out rather than refused on use.
const chatRefusal = computed(() => guestRefusal('arena.chat'))
const chatClosed = computed(() => chatRefusal.value?.message ?? (match.value?.audience === 'players' ? 'This game is private: only the players can write here.' : 'This chat is not open to you.'))
const canWatchOthers = computed(() => guestMay('arena.live'))

// While the tab is in the background, its title says when it is the member's move.
const hidden = ref(document.hidden)
const onVisibility = (): void => { hidden.value = document.hidden }
document.addEventListener('visibilitychange', onVisibility)
let plainTitle = ''
watch(() => Boolean(hidden.value && match.value && match.value.status === 'active' && playing.value && match.value.turn === me.value!.seat), flag => {
  if (flag) { plainTitle = document.title; document.title = `● Your move · ${gameName(match.value!.game)}` }
  else if (plainTitle) { document.title = plainTitle; plainTitle = '' }
})
onBeforeUnmount(() => { document.removeEventListener('visibilitychange', onVisibility); if (plainTitle) document.title = plainTitle })

// ── Sound, how to play, inviting people to watch ──

const howTo = ref(false)
function toggleSound(): void {
  setSound(!arena.sound)
  if (arena.sound) { unlockHallSound(); window.setTimeout(() => hallCue('turn'), 60) }
}
const sharing = ref(false)
const friends = ref<PublicMember[] | null>(null)
const invited = ref<MemberId[]>([])
const link = computed(() => `${window.location.origin}/arena/match/${matchId.value}`)
const canShareSheet = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
async function openShare(): Promise<void> {
  sharing.value = true
  // Inviting someone to watch is between friends who both accepted; a service-made friendship is left out.
  if (!friends.value) friends.value = guestMay('friends.list') ? ((await attempt('friends.list', {}))?.friends ?? []).filter(friend => !isAutomaticFriend(friend)) : []
}
async function copyLink(): Promise<void> {
  try { await navigator.clipboard.writeText(link.value); toast('Link copied.', 'good') } catch { toast('Copy the link from the box.', 'info') }
}
function shareLink(): void {
  const current = match.value
  if (current) void navigator.share({ title: gameName(current.game), text: `Watch ${seatNames.value.join(' against ')} play ${gameName(current.game)}.`, url: link.value }).catch(() => undefined)
}
async function invite(friend: PublicMember): Promise<void> {
  const sent = await attempt('arena.invite', { matchId: matchId.value, memberId: friend.id }, `${friend.displayName} was invited to watch.`)
  if (sent) invited.value = [...invited.value, friend.id]
}

void load()
</script>

<template>
  <PanelPage :title="match ? gameName(match.game) : 'Game'" :subtitle="subtitle" back="/arena" wide>
    <template #actions>
      <button class="btn icon sm" type="button" :aria-pressed="arena.sound" :aria-label="arena.sound ? 'Hall sounds are on. Switch them off' : 'Hall sounds are off. Switch them on'" :title="arena.sound ? 'Sounds on' : 'Sounds off'" @click="toggleSound">
        <span aria-hidden="true">{{ arena.sound ? '🔔' : '🔕' }}</span>
      </button>
      <button v-if="match" class="btn icon sm" type="button" aria-label="How to play" title="How to play" @click="howTo = true"><span aria-hidden="true">?</span></button>
    </template>

    <StateView v-if="state === 'loading'" state="loading" />
    <div v-else-if="state === 'error' || !match" class="stack">
      <div class="notice coral" role="alert"><div class="grow"><strong>This game cannot be opened.</strong><div>{{ error || 'It may have been removed.' }}</div></div></div>
      <div class="row wrap"><RouterLink class="btn primary" to="/arena">Back to the game hall</RouterLink><button class="btn" type="button" @click="load()">Try again</button></div>
    </div>

    <!-- Not started: a challenge to answer, to wait on, or one that came to nothing -->
    <div v-else-if="!hasBoard" class="stack">
      <div class="card stack" :class="match.status === 'waiting' ? 'tint-amber' : ''">
        <div class="row">
          <span class="icon-chip big" :class="GAME[match.game].tone" aria-hidden="true">{{ GAME[match.game].icon }}</span>
          <div class="grow">
            <template v-if="match.status === 'waiting'">
              <h2 v-if="me?.role === 'invited'">{{ match.players[0]?.name }} challenged you</h2>
              <h2 v-else-if="match.me.canAccept">{{ match.players[0]?.name }} is looking for an opponent</h2>
              <h2 v-else-if="match.open === 'queue'">Looking for someone to play</h2>
              <h2 v-else-if="match.open === 'community'">Open to {{ match.communityName ?? 'a community' }}</h2>
              <h2 v-else>Waiting for {{ match.invited?.displayName ?? 'an answer' }}</h2>
            </template>
            <h2 v-else>{{ endedTitle }}</h2>
            <p class="small muted">{{ gameName(match.game) }} · {{ timeControl(match.timeControl).label }} · {{ match.rated ? 'Rated' : 'Casual' }} · {{ AUDIENCE[match.audience].short }}</p>
          </div>
        </div>
        <template v-if="match.status === 'waiting'">
          <p v-if="match.me.canAccept" class="small">Accept and the game starts at once{{ daily ? '' : ': the clock runs from the first moves' }}.</p>
          <p v-else-if="match.open === 'queue'" class="small"><span class="pulse" aria-hidden="true"></span>You are paired with the next member who asks for the same game. This page opens the board the moment someone is found{{ match.expiresAt ? `; the search stops ${relativeTime(match.expiresAt)}` : '' }}.</p>
          <p v-else-if="match.open === 'community'" class="small">The first member to accept plays you. They see it under “Your games” in the hall.</p>
          <p v-else class="small">{{ match.invited?.displayName }} has been told{{ match.expiresAt ? `. The challenge stays open until ${relativeTime(match.expiresAt)}` : '' }}.{{ daily ? '' : ' A live game starts when you are both here.' }}</p>
          <div class="row wrap">
            <template v-if="match.me.canAccept">
              <button class="btn primary" type="button" :disabled="busy" @click="respond(true)">Accept and play</button>
              <button v-if="me?.role === 'invited'" class="btn" type="button" :disabled="busy" @click="respond(false)">Decline</button>
            </template>
            <template v-else>
              <button class="btn" type="button" :disabled="busy" @click="cancel">{{ match.open === 'queue' ? 'Stop looking' : 'Withdraw the challenge' }}</button>
              <button class="btn" type="button" :disabled="busy" @click="playComputer()">Play the computer meanwhile</button>
            </template>
          </div>
        </template>
        <template v-else>
          <p class="small">{{ match.endText }}</p>
          <div v-if="searchEnded" class="row wrap">
            <button class="btn primary" type="button" :disabled="busy" @click="lookAgain">Look again</button>
            <button class="btn" type="button" :disabled="busy" @click="playComputer()">Play the computer</button>
            <RouterLink class="btn" to="/arena">Game hall</RouterLink>
          </div>
          <div v-else class="row wrap"><RouterLink class="btn primary" to="/arena">Start another game</RouterLink></div>
        </template>
      </div>
      <p class="tiny muted">{{ HONESTY }}</p>
    </div>

    <!-- The game -->
    <div v-else class="wrap">
      <div class="table">
        <div class="play">
          <ArenaPlayerBar v-if="top" class="inline-bar" :player="top" :left-ms="leftOf(top)" :daily="daily" :running="runningSeat === top.seat" :turn="match.turn === top.seat" :me="false" :result="resultOf(top)" :show-clock="true" />

          <div v-if="banner" class="banner notice" :class="banner.tone" role="status" aria-live="polite">
            <div class="grow">
              <strong>{{ banner.text }}</strong>
              <div v-if="banner.sub" class="small">{{ banner.sub }}</div>
            </div>
          </div>

          <div v-if="offerToMe" class="notice amber offer" role="alert">
            <span class="grow"><strong>{{ other?.name }} offers a draw.</strong></span>
            <button class="btn sm primary" type="button" :disabled="busy" @click="draw('accept')">Accept the draw</button>
            <button class="btn sm" type="button" :disabled="busy" @click="draw('decline')">Play on</button>
          </div>

          <div class="board-box">
            <component
              :is="board" v-if="board && detail!.view !== null"
              :view="detail!.view" :seat="me?.seat ?? null" :can-move="canMove" :last-move="detail!.lastMove" :seat-names="seatNames" :problem="problem" :end-text="match.status === 'active' ? null : match.outcome?.text ?? match.endText ?? 'This game has ended.'"
              @move="onMove"
            />
            <p v-else class="notice amber">{{ board ? `${gameName(match.game)} is not installed on the service right now, so the board cannot be shown. The game is kept and will open again.` : `The board for ${gameName(match.game)} is not part of this build yet.` }}</p>
          </div>

          <ArenaPlayerBar v-if="bottom" class="inline-bar" :player="bottom" :left-ms="leftOf(bottom)" :daily="daily" :running="runningSeat === bottom.seat" :turn="match.turn === bottom.seat" :me="playing" :result="resultOf(bottom)" :show-clock="true" :practice="Boolean(top?.computer)" />

          <div class="row wrap controls">
            <template v-if="playing && match.status === 'active'">
              <template v-if="resigning">
                <span class="small grow">Give this game up?</span>
                <button class="btn sm danger" type="button" :disabled="busy" @click="resign">Yes, resign</button>
                <button class="btn sm" type="button" @click="resigning = false">Keep playing</button>
              </template>
              <template v-else>
                <button class="btn sm" type="button" @click="resigning = true"><span aria-hidden="true">🏳️</span>Resign</button>
                <button v-if="canOffer" class="btn sm" type="button" :disabled="busy" @click="draw('offer')">Offer a draw</button>
                <span v-else-if="myOffer" class="chip amber">Draw offered</span>
              </template>
            </template>
            <template v-else-if="over && playing">
              <button v-if="rematchState === 'theirs'" class="btn sm primary" type="button" :disabled="busy" @click="rematch">{{ other?.name }} wants a rematch — accept</button>
              <template v-else-if="rematchState === 'mine'">
                <span class="chip amber">Rematch offered — waiting for {{ other?.name }}</span>
                <button class="btn sm" type="button" :disabled="busy" @click="withdrawRematch">Withdraw</button>
              </template>
              <span v-else-if="rematchState === 'declined'" class="chip">{{ other?.name }} declined the rematch</span>
              <RouterLink v-else-if="rematchState === 'begun'" class="btn sm primary" :to="`/arena/match/${match.rematch}`">Open the rematch</RouterLink>
              <button v-else class="btn sm primary" type="button" :disabled="busy" @click="rematch">Rematch</button>
              <button v-if="harder" class="btn sm" type="button" :disabled="busy" @click="playComputer(harder)">Try {{ COMPUTER_LEVEL_NAME[harder].toLowerCase() }}</button>
              <RouterLink class="btn sm" to="/arena">New game</RouterLink>
            </template>
            <RouterLink v-else-if="over && canWatchOthers" class="btn sm" to="/arena?tab=watch">Watch another game</RouterLink>
            <RouterLink v-else-if="over" class="btn sm" to="/arena">Back to the game hall</RouterLink>
          </div>

          <!-- The region stays in the page for the whole game so a screen reader hears what is put in it. -->
          <div class="live-slot" role="status" aria-live="polite">
            <div v-if="live || watchingLive" class="live notice" :class="live?.tone || 'sky'">
              <div class="grow">
                <strong v-if="live">{{ live.text }}<template v-if="live.count"> <span class="num" aria-hidden="true">{{ live.count }}</span></template></strong>
                <strong v-else>You are watching.</strong>
                <div v-if="live?.sub" class="small">{{ live.sub }}</div>
              </div>
              <span v-if="watchingLive && live" class="chip sky">Watching</span>
            </div>
          </div>
        </div>

        <aside class="side card" aria-label="Players, moves, chat and watchers">
          <!-- A wide window keeps both players and their clocks beside the board, always in view. -->
          <div class="side-bars">
            <ArenaPlayerBar v-if="top" :player="top" :left-ms="leftOf(top)" :daily="daily" :running="runningSeat === top.seat" :turn="match.turn === top.seat" :me="false" :result="resultOf(top)" :show-clock="true" />
            <ArenaPlayerBar v-if="bottom" :player="bottom" :left-ms="leftOf(bottom)" :daily="daily" :running="runningSeat === bottom.seat" :turn="match.turn === bottom.seat" :me="playing" :result="resultOf(bottom)" :show-clock="true" :practice="Boolean(top?.computer)" />
          </div>
          <div class="tabs" role="tablist">
            <button class="tab" type="button" role="tab" :aria-selected="panel === 'moves' && panelOpen" :aria-expanded="panel === 'moves' && panelOpen" @click="showPanel('moves')">Moves<span class="muted num n">{{ detail!.moves.length }}</span></button>
            <button class="tab" type="button" role="tab" :aria-selected="panel === 'chat' && panelOpen" :aria-expanded="panel === 'chat' && panelOpen" @click="showPanel('chat')">Chat<span v-if="unread" class="count" aria-label="New messages">•</span></button>
            <button class="tab" type="button" role="tab" :aria-selected="panel === 'watching' && panelOpen" :aria-expanded="panel === 'watching' && panelOpen" @click="showPanel('watching')">Watching<span class="muted num n">{{ match.watchers.count }}</span></button>
          </div>

          <template v-if="panelOpen">
            <div v-if="panel === 'moves'" class="pane">
              <p v-if="!detail!.moves.length" class="muted small">No moves yet.</p>
              <ol v-else ref="moveList" class="moves" aria-label="Moves so far">
                <li v-for="line in detail!.moves" :key="line.n" :class="{ last: line.n === detail!.moves.length }">
                  <span class="num muted n">{{ line.n }}.</span>
                  <span class="mover truncate">{{ line.seat === me?.seat ? 'You' : seatNames[line.seat] }}</span>
                  <span class="what">{{ line.text }}</span>
                </li>
              </ol>
            </div>

            <ArenaChat
              v-else-if="panel === 'chat'" ref="chatBox" :lines="detail!.chat" :more="detail!.chatMore && guestMay('arena.chatHistory')" :may-chat="match.me.mayChat && !closed && !chatRefusal" :focus="playing && guestMay('arena.focus') ? detail!.focus : null"
              :busy="chatBusy" :closed-text="chatClosed" @send="say" @older="older" @focus="setFocus"
            />

            <div v-else class="pane stack tight">
              <p class="small muted">{{ AUDIENCE[match.audience].about }}<template v-if="match.audience === 'community' && match.communityName"> ({{ match.communityName }})</template></p>
              <p v-if="!match.watchers.count" class="small">Nobody is watching right now.</p>
              <ul v-else class="plain watchers">
                <li v-for="member in match.watchers.first" :key="member.id" class="row"><MemberBadge :member-id="member.id" :look="member.look" :size="30" :online="true" /><span class="truncate">{{ member.displayName }}</span></li>
                <li v-if="match.watchers.count > match.watchers.first.length" class="small muted">and {{ count(match.watchers.count - match.watchers.first.length, 'more') }}</li>
              </ul>
              <button v-if="match.status === 'active' && match.audience !== 'players' && guestMay('arena.invite')" class="btn sm" type="button" @click="openShare">Invite someone to watch</button>
            </div>
          </template>
        </aside>
      </div>
      <!-- The terms of play money sit where a result and its coins are shown; setup and How to play carry them too. -->
      <p v-if="over" class="tiny muted fine">{{ HONESTY }}</p>
    </div>

    <ArenaHowTo v-if="howTo && match" :game="match.game" @close="howTo = false" />

    <ArenaSheet v-if="sharing && match" title="Invite people to watch" @close="sharing = false">
      <p class="small">{{ AUDIENCE[match.audience].about }}<template v-if="match.audience === 'community' && match.communityName"> ({{ match.communityName }})</template> Anyone else who opens the link is told the game is not open to them.</p>
      <div class="row link">
        <input class="input grow" type="text" readonly :value="link" aria-label="Link to this game" @focus="($event.target as HTMLInputElement).select()" />
        <button class="btn" type="button" @click="copyLink">Copy</button>
        <button v-if="canShareSheet" class="btn" type="button" @click="shareLink">Share</button>
      </div>
      <div class="stack tight">
        <h3>Your friends</h3>
        <p v-if="friends === null" class="muted small">Loading…</p>
        <p v-else-if="!friends.length" class="muted small">You have no friends here yet. Share the link instead.</p>
        <ul v-else class="plain invitees">
          <li v-for="friend in friends" :key="friend.id" class="row">
            <MemberBadge :member-id="friend.id" :look="friend.look" :size="32" :online="friend.online" />
            <span class="grow truncate">{{ friend.displayName }}<span class="tiny muted"> · {{ friend.online ? 'here now' : 'away' }}</span></span>
            <span v-if="invited.includes(friend.id)" class="chip leaf">Invited</span>
            <button v-else class="btn sm" type="button" @click="invite(friend)">Invite</button>
          </li>
        </ul>
      </div>
    </ArenaSheet>
  </PanelPage>
</template>

<style scoped>
.wrap { container-type: inline-size; display: flex; flex-direction: column; gap: 10px; }
.table { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr); }
.play { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.board-box { min-width: 0; }
.banner { align-items: center; padding: 8px 12px; min-height: 44px; }
.offer { align-items: center; flex-wrap: wrap; }
.live { align-items: center; min-height: 44px; padding: 8px 12px; }
/* Empty, it takes no room (and no flex gap) but stays a live region. */
.live-slot:empty { position: absolute; }
.controls { gap: 8px; }
/* A watcher of a live game has no controls: the row then takes no room (and no flex gap). */
.controls:empty { display: none; }
.side { display: flex; flex-direction: column; gap: 10px; padding: 10px; min-width: 0; }
.side-bars { display: none; flex-direction: column; gap: 4px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
.side .tab .n { font-size: 0.74rem; font-weight: 600; }
.side .tab .count { background: transparent; color: var(--coral); font-size: 1.2rem; line-height: 1; padding: 0; min-width: 0; }
.pane { min-height: 0; }
.moves { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; font-size: 0.9rem; overscroll-behavior: contain; }
.moves li { display: grid; grid-template-columns: 30px minmax(0, 88px) minmax(0, 1fr); gap: 6px; padding: 4px 6px; border-radius: 8px; align-items: baseline; }
.moves li.last { background: var(--accent-soft); }
.moves .mover { color: var(--ink-2); font-size: 0.82rem; }
.moves .what { font-weight: 650; overflow-wrap: anywhere; }
.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.icon-chip.big { width: 46px; height: 46px; font-size: 1.5rem; border-radius: 14px; }
.pulse { display: inline-block; width: 8px; height: 8px; margin-right: 8px; border-radius: 50%; background: var(--sky); animation: beat 1.4s ease infinite; }
@keyframes beat { 50% { opacity: 0.3; transform: scale(0.8); } }
.link .input { min-width: 0; }
.invitees { max-height: 240px; overflow-y: auto; }
.fine { margin-top: 2px; }

/* A phone: the board takes the full width of the sheet. */
@container (max-width: 520px) {
  .board-box { margin-inline: -10px; }
  .moves { max-height: 180px; }
}
/* A wide window: the board on the left, moves and chat beside it. */
@container (min-width: 760px) {
  .table { grid-template-columns: minmax(0, 1fr) 330px; align-items: start; }
  .side { position: sticky; top: 0; }
  .side-bars { display: flex; }
  .inline-bar { display: none; }
  /* The whole board stays in view: its width is held to what the window's height leaves for it. */
  .board-box { width: 100%; max-width: max(440px, calc(100dvh - 390px)); margin-inline: auto; }
  .moves { max-height: 240px; }
}
</style>
